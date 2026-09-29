# Alzeena Fashion Sales Agent

Production-oriented foundation for the future Alzeena Fashion AI sales agent. The repository currently contains **Steps 1–4**: the web application, API, infrastructure configuration, PostgreSQL/Prisma data layer, local product-feed synchronization, and protected Knowledge Base/business settings management.

Step 4 adds focused admin pages and protected APIs for AI instructions and non-sensitive business settings. It does not call an AI model or add messaging, orders, conversations, handover workflows, or a full analytics dashboard.

## Architecture

```text
.
├── apps/
│   ├── api/                    # Fastify API
│   │   └── src/
│   │       ├── config/         # Typed environment and logger configuration
│   │       ├── errors/         # Application error primitives
│   │       ├── infrastructure/ # Redis, BullMQ, and dependency lifecycle
│   │       ├── routes/         # HTTP routes
│   │       └── types/          # Framework type augmentation
│   └── web/                    # Next.js + React + Tailwind frontend
├── packages/
│   └── database/               # Prisma schema and shared Prisma client
├── compose.yml                 # Local PostgreSQL and Redis
├── .env.example                # Safe configuration template
└── tsconfig.base.json          # Shared TypeScript rules
```

Future modules (AI/Gemini, Facebook Messenger, orders, image/voice processing, conversations, and human handover) should be introduced as isolated API modules and/or workers. Product synchronization and admin Knowledge Base/settings management remain separate modules so dynamic catalogue data is never mixed into manually authored AI instructions.

## Step 2 database models

- `Category` and `SubCategory` normalize website taxonomy for later filtering.
- `Product` stores an internal UUID separately from its unique website product ID.
- `ProductVariation` belongs to a product and de-duplicates source variations by website variation ID.
- `KnowledgeBase` supports versioned instruction text and activation state; a PostgreSQL partial unique index permits at most one active main record. No UI or AI usage exists yet.
- `Setting` stores non-sensitive business configuration as key/value text.
- `SystemLog` provides structured levels, event types, JSONB metadata, and timestamp indexes.

Prices use PostgreSQL `DECIMAL(12,2)`, not floating point. Sensitive values remain environment variables and must not be stored in `Setting` or `SystemLog`.

## Step 3 product synchronization

```text
Manual API request → product-sync queue → Redis → standalone worker
                                              ↓
Alzeena Product Feed → validated adapter → per-product transaction → PostgreSQL
                                                               ↓
                                             local search and availability services
```

The observed live feed is a single JSON array. The adapter also supports Laravel-style `data`, `links`, `meta`, `current_page`, `last_page`, and `next_page_url` pagination if the upstream format changes. It rejects cross-origin pagination URLs, enforces a page limit and request timeout, and retries only network failures, timeouts, HTTP 408/429, and HTTP 5xx responses.

Products and variations are upserted by their unique website IDs. Missing variations are retained but marked inactive with zero stock. Products absent from a complete, error-free feed are retained and marked `presentInFeed = false`; the source `productStatus` is preserved separately. Unknown product status values fail closed for availability.

### Start API and worker

Use separate terminals after PostgreSQL, Redis, migrations, and Prisma Client are ready:

```bash
npm run dev:api
npm run dev:worker
```

Set a strong `ADMIN_PASSWORD` of at least 12 characters in `.env`. Queue a synchronization job:

```bash
curl -X POST http://localhost:4000/api/admin/product-sync \
  -H "x-admin-password: $ADMIN_PASSWORD"
```

Inspect persisted synchronization status:

```bash
curl http://localhost:4000/api/admin/product-sync/status \
  -H "x-admin-password: $ADMIN_PASSWORD"
```

Search the local database—the endpoint never calls the external feed:

```bash
curl "http://localhost:4000/api/products/search?q=TX170"
curl "http://localhost:4000/api/products/search?q=Argentina"
```

Inspect stock and pre-order availability:

```bash
curl http://localhost:4000/api/products/6238/availability
```

Run parser/business-rule unit tests with `npm test`. With local infrastructure running, execute two live, idempotency-checking syncs and verify product 6238, variations, search, and availability with:

```bash
npm run verify:product-sync
```

## Step 4 Knowledge Base and settings

Admin pages:

- `http://localhost:3000/admin/knowledge-base`
- `http://localhost:3000/admin/settings`

The pages ask for `ADMIN_PASSWORD`, retain it only in the browser tab's `sessionStorage`, and send it to the backend in the `x-admin-password` header. There is no public Knowledge Base endpoint. Browser requests use the Next.js `/backend-api` proxy, so database/Redis credentials and the upstream product feed URL are not exposed.

Protected backend endpoints:

```text
GET /api/admin/knowledge-base
PUT /api/admin/knowledge-base
GET /api/admin/settings
PUT /api/admin/settings
```

Example Knowledge Base update:

```bash
curl -X PUT http://localhost:4000/api/admin/knowledge-base \
  -H "content-type: application/json" \
  -H "x-admin-password: $ADMIN_PASSWORD" \
  --data '{"content":"Your complete AI instruction text"}'
```

Each Knowledge Base save creates a new active version and retains the prior version as inactive. Content must be non-empty and is limited to 100,000 characters. System logs contain only action/version/length metadata—not the Knowledge Base text.

Settings are strictly allow-listed. Delivery charges are validated as non-negative BDT amounts; environment secrets such as Gemini/Meta keys and the admin password cannot be read or updated through these APIs. Future AI context code can import `getActiveKnowledgeBase()` and `getBusinessSettings()` without coupling to HTTP routes.

Run `npm run db:seed` after updating to Step 4. It installs the starter Knowledge Base only when content is absent or still equals the old test placeholder, and initializes the known setting values without overwriting later admin edits.

## Prerequisites

- Node.js 20.9 or newer (Node.js 22 LTS recommended)
- npm 10 or newer
- Docker with Docker Compose, **or** locally installed PostgreSQL 16+ and Redis 7+

## Install

```bash
npm install
cp .env.example .env
npm run prisma:generate
```

Review `.env` before starting. Development credentials in `.env.example` match `compose.yml` and are for local use only. Never commit `.env` or real credentials.

## Start PostgreSQL and Redis

With Docker Compose:

```bash
docker compose up -d postgres redis
docker compose ps
```

To stop the services:

```bash
docker compose down
```

To also delete local database and Redis volumes, use `docker compose down -v` (this permanently removes local data).

Without Docker, create a PostgreSQL database and user matching `DATABASE_URL`, start Redis, and set `DATABASE_URL` and `REDIS_URL` in `.env`.

## Initialize and verify the database

Generate Prisma Client and apply all committed migrations, including `initial_business_schema` and `product_feed_sync_state`:

```bash
npm run prisma:generate
npm run db:migrate
```

The equivalent direct Prisma command from the repository root is `npx prisma migrate dev`; the root package configuration points it to the workspace schema. `npm run db:migrate` runs the same development migration workflow. For a non-development environment, apply committed migrations without creating new ones:

```bash
npm run db:migrate:deploy
```

Load the idempotent Step 2 test data and verify its required values:

```bash
npm run db:seed
npm run db:verify
```

The verification checks product `6238`, its M/L/XL/XXL stock, pre-order status, the active Knowledge Base, and the initial settings. The seed contains placeholder business settings; review them before any production use.

Open the data browser with:

```bash
npm run db:studio
```

Future schema changes should be created with a descriptive migration name:

```bash
npm run db:migrate -- --name descriptive_migration_name
```

## Run locally

Use two terminals from the repository root.

Backend:

```bash
npm run dev:api
```

The API listens on `http://localhost:4000` by default. It validates configuration and establishes PostgreSQL and Redis connections before accepting traffic.

Frontend:

```bash
npm run dev:web
```

The web app listens on `http://localhost:3000` by default.

## Health endpoint

After PostgreSQL, Redis, and the backend are running:

```bash
curl -i http://localhost:4000/health
```

A healthy response has HTTP status `200` and resembles:

```json
{
  "status": "ok",
  "service": "alzeena-api",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "dependencies": {
    "database": "up",
    "redis": "up"
  }
}
```

## Quality checks and production build

```bash
npm run typecheck
npm run build
```

Run the compiled backend with `npm run start --workspace=@alzeena/api`. Run the production frontend with `npm run start --workspace=@alzeena/web` after building.

## Environment variables

| Variable | Purpose | Step 1 usage |
| --- | --- | --- |
| `NODE_ENV` | Runtime mode | Used |
| `API_HOST`, `API_PORT` | API bind address and port | Used |
| `LOG_LEVEL` | Structured API log level | Used |
| `FRONTEND_URL` | Allowed browser origin for API CORS | Used |
| `NEXT_PUBLIC_API_BASE_URL` | Browser-visible API URL | Reserved |
| `DATABASE_URL` | PostgreSQL connection string | Used |
| `REDIS_URL` | Redis connection string | Used |
| `ADMIN_PASSWORD` | Header credential for protected manual sync operations | Used |
| `GEMINI_API_KEY` | Future Gemini integration | Reserved |
| `META_PAGE_ACCESS_TOKEN` | Future Meta integration | Reserved |
| `META_APP_SECRET` | Future Meta integration | Reserved |
| `META_VERIFY_TOKEN` | Future webhook verification | Reserved |
| `WEBSITE_API_BASE_URL` | Alzeena website API base URL | Used by worker |
| `PRODUCT_FEED_TIMEOUT_MS` | Per-request feed timeout | Used by worker |
| `PRODUCT_FEED_RETRIES` | Temporary-failure retry count | Used by worker |
| `PRODUCT_FEED_MAX_PAGES` | Pagination safety limit | Used by worker |

Only variables needed by implemented steps are validated at process startup. Reserved secrets remain unused and must not be populated until their corresponding feature is implemented.
