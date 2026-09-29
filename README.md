# Alzeena Fashion Sales Agent

Production-oriented foundation for the future Alzeena Fashion AI sales agent. This repository currently contains **Step 1 only**: the web application, API, PostgreSQL/Prisma, Redis/BullMQ configuration, environment validation, logging, and health checks.

No sales, AI, messaging, product, order, conversation, handover, or administration features are implemented yet.

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

Future modules (AI/Gemini, Facebook Messenger, product sync, orders, image/voice processing, conversations, human handover, and knowledge base) should be introduced as isolated API modules and/or workers. `createQueue` in `apps/api/src/infrastructure/queue.ts` is the generic BullMQ extension point. No feature queue or worker is created in this step.

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

## Initialize the database

The Step 1 Prisma schema intentionally has no domain models. Generate the client and synchronize the database connection with:

```bash
npm run prisma:generate
npm run db:push
```

When future schema changes need versioned migrations, use:

```bash
npm run db:migrate -- --name descriptive_migration_name
```

Prisma Studio can be opened with `npm run db:studio`.

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
| `ADMIN_PASSWORD` | Future admin authentication | Reserved |
| `GEMINI_API_KEY` | Future Gemini integration | Reserved |
| `META_PAGE_ACCESS_TOKEN` | Future Meta integration | Reserved |
| `META_APP_SECRET` | Future Meta integration | Reserved |
| `META_VERIFY_TOKEN` | Future webhook verification | Reserved |
| `WEBSITE_API_BASE_URL` | Future existing-site integration | Reserved |

Only variables needed by Step 1 are validated at API startup. Reserved secrets remain unused and must not be populated until their corresponding feature is implemented.
