# Alzeena Fashion Sales Agent

Production-oriented foundation for the Alzeena Fashion AI sales agent. The repository currently contains **Steps 1–10**: the web application, API, infrastructure configuration, PostgreSQL/Prisma data layer, product synchronization, protected business administration, the modular Gemini-backed AI core, persistent multimodal conversation memory, the deterministic Order Engine, and a human-handover Admin Inbox.

Step 10 adds structured handovers, an enforced AI/human ownership lock, assignment, unread state, internal notifications, local outbound-delivery abstraction, searchable conversation context, and protected human replies. It does not add Facebook/Meta transport, webhooks, WhatsApp, voice replies, browser push, WebSockets, payments, or analytics.

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

Future channels and capabilities (Facebook Messenger transport, orders, voice replies, and a human inbox) should be introduced as isolated modules. The AI provider, orchestration, prompt construction, local product context, persistent memory, and admin-managed instructions remain separate so providers and channels can change independently.

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

## Step 5 AI core and Gemini

```text
Caller → AIService → intent/cost router
                    ├─ KnowledgeBaseService
                    ├─ SettingsService
                    ├─ ProductContextService → local PostgreSQL catalogue/availability
                    ├─ RuleResponseService (safe simple requests, no Gemini cost)
                    └─ PromptBuilder → AIProvider → GeminiProvider
                                           ↓
                              validated structured response
```

The integration uses Google's official `@google/genai` SDK and `responseJsonSchema` structured output. Gemini is isolated behind the `AIProvider` interface, and `createAIService()` is reusable by future channels. Greetings, delivery charges, direct product lookup, prices, stock and sizes use deterministic local rules where safe. Complex policy, recommendation, and general questions use Gemini.

The protected, rate-limited development endpoint is:

```text
POST /api/ai/test
```

Example:

```bash
curl -X POST http://localhost:4000/api/ai/test \
  -H "content-type: application/json" \
  -H "x-admin-password: $ADMIN_PASSWORD" \
  --data '{
    "message": "APL26 Messi polo ache?",
    "language": "auto",
    "conversationHistory": []
  }'
```

The legacy Step 5 test endpoint accepts caller-provided history capped before prompting. The Step 6 persistent endpoint described below retrieves its own bounded history. Product searches call PostgreSQL, never the external product feed. Model output is schema-validated, safely extracted from JSON/code fences when practical, and retried once after malformed output. Provider/configuration failures return a short human-assistance fallback instead of crashing.

AI logs contain intent, provider/model, latency, search flag, product count, handover flag and message length. They do not contain API keys, passwords, tokens, or raw customer messages.

## Step 6 customer and conversation memory

`Customer`, `Conversation`, and `Message` records preserve channel-neutral identities and bounded recent context. A `(platform, platformUserId)` identity maps to one customer. Customers may have many historical conversations, while a partial PostgreSQL index permits only one `active` conversation for each customer/channel. Closed and human-handover conversations are never reused as active.

The persistent flow is:

```text
platform identity → find/create customer → reuse/create active conversation
                                      → save user message → bounded memory context
                                      → existing AIService → save assistant message
```

Assistant message metadata records referenced website product IDs. They are hints only: every follow-up reloads current price, stock, sizes, pre-order state, and availability from local PostgreSQL. Multiple possible references produce a short clarification instead of a guess. `CONVERSATION_HISTORY_LIMIT` controls recent messages loaded per turn and defaults to 20.

Protected endpoints:

```text
POST /api/ai/chat
GET  /api/admin/customers
GET  /api/admin/customers/:id
GET  /api/admin/conversations
GET  /api/admin/conversations/:id
```

Example persistent request:

```bash
curl -X POST http://localhost:4000/api/ai/chat \
  -H "content-type: application/json" \
  -H "x-admin-password: $ADMIN_PASSWORD" \
  --data '{
    "customer": {"platform":"test","platformUserId":"user-001","name":"Rahim"},
    "channel": "test",
    "message": "Messi polo কত?"
  }'
```

Send the same identity again to reuse its active conversation, or set `"newConversation": true` to close the active conversation and start another. A supplied `conversationId` is accepted only when it is active and belongs to the resolved customer.

Admin pages are available at `/admin/ai-test`, `/admin/customers`, and `/admin/conversations`. The AI test page shows the conversation ID, history, intent, confidence, and handover state, and can explicitly begin a new conversation.

## Step 7 product photo recognition

The image pipeline remains channel-neutral:

```text
image URL or inline upload → signature/size/MIME validation → safe bounded fetch
                           → exact caption-code lookup when possible
                           → Gemini Vision clue extraction when needed
                           → deterministic local Product DB matching
                           → current local price/stock/size/pre-order facts
                           → existing AIService and conversation memory
```

Supported formats are JPEG, PNG, and WebP. Images are held only in bounded in-memory buffers and are not permanently stored. Public URL fetching rejects credentials, private/reserved addresses, unsafe ports, unsupported content, oversized streams, and excessive redirects. Inline base64 input supports the admin upload console. Repeated URLs and image hashes are cached briefly in-process to avoid unnecessary downloads and Vision calls.

Gemini extracts visible clues such as names, codes, colors, text, designs, sizes, and observed price text. An observed image price is never treated as current. Product selection and all commerce facts come from the synchronized local PostgreSQL catalogue. High-confidence matches are selected, medium-confidence candidates trigger clarification where necessary, and low-confidence results do not guess.

Protected image endpoint:

```text
POST /api/ai/analyze-image
```

Example URL analysis:

```bash
curl -X POST http://localhost:4000/api/ai/analyze-image \
  -H "content-type: application/json" \
  -H "x-admin-password: $ADMIN_PASSWORD" \
  --data '{
    "imageUrl":"https://example.com/product.webp",
    "caption":"এটার দাম কত?"
  }'
```

`POST /api/ai/chat` also accepts an `image` object with either `url` or base64 `data`, optional `mimeType`, and a channel-neutral `source`. Identified product IDs and compact match metadata are stored on the image message, allowing later questions such as “এইটার XL আছে?” to resolve without relying on model memory. The `/admin/ai-test` page supports image upload, URL input, preview, match reasons, current price, sizes, stock, and follow-up conversation testing.

No database migration is required for Step 7 because the Step 6 `MessageType.IMAGE` and JSON metadata fields already support image messages. Configure `GEMINI_API_KEY`, apply existing migrations, and synchronize the local product catalogue before end-to-end visual testing. Exact product codes in captions can still resolve without a Vision call.

## Step 8 voice-message understanding

The channel-neutral voice flow reuses the existing AI core:

```text
audio URL or inline upload → MIME/signature/size/duration validation
                           → protected bounded fetch and temporary buffer
                           → SpeechToTextService → Gemini audio adapter
                           → original-language transcription
                           → verified local product-code normalization
                           → conversation context and existing AIService
                           → persisted text response
```

Supported inputs are OGG/Opus, MP3/MPEG, WAV, WebM, MP4, and M4A. Audio is not permanently stored. Message metadata retains only the detected MIME type, duration when available, source, transcription, language, confidence, and locally verified product codes/product IDs. URL and transcription caches are bounded and process-local.

`SpeechToTextProvider` keeps transcription replaceable. The current adapter uses the existing `GeminiProvider` client and structured JSON output; controllers depend only on `VoiceUnderstandingService` and `SpeechToTextService`. Bangla, Banglish, English, and mixed speech are transcribed without translation.

Protected transcription endpoint:

```text
POST /api/ai/transcribe
```

Example:

```bash
curl -X POST http://localhost:4000/api/ai/transcribe \
  -H "content-type: application/json" \
  -H "x-admin-password: $ADMIN_PASSWORD" \
  --data '{
    "audioUrl":"https://example.com/voice.ogg",
    "mimeType":"audio/ogg"
  }'
```

`POST /api/ai/chat` accepts an `audio` object with either a public `url` or base64 `data`, optional MIME type/duration, and a channel-neutral source. Written `message` text can accompany the voice as additional context. Successful transcriptions become the user message content; the original transcription remains in metadata. Low-confidence or failed transcription produces a clarification response without calling the sales AI or inventing text.

Spoken code normalization is deliberately conservative. Candidates such as “TX one seventy” are converted only when the resulting code is confirmed against the local Product database. Transcription itself never supplies price, stock, size, availability, or pre-order facts.

The `/admin/ai-test` page now supports audio upload, audio URL playback, transcription language/confidence, AI response, and follow-up memory. Conversation details display an audio indicator and saved transcription; no temporary server path is exposed.

No database migration is required for Step 8 because the existing `MessageType.AUDIO` and JSON metadata support voice messages. Configure `GEMINI_API_KEY`, apply existing migrations, and synchronize products before end-to-end testing.

## Step 9 Order Engine and Website Order API

The Order Engine is a dedicated backend module. Conversation and admin controllers call `OrderService`; neither controllers nor model output can construct or send a raw website order. Product IDs, real website variation IDs, effective prices, status, stock, pre-order state, delivery charges, quantities, and totals are resolved or calculated from the current local database with Prisma decimals.

The persisted flow is:

```text
text/image/voice product context → validated draft and items → collect only missing fields
  → refresh price + validate stock → complete summary → persisted explicit confirmation
  → atomic one-request submission claim → Alzeena Website Order API
  → success with external ID | known safe failure | unknown outcome (retry blocked)
```

A short confirmation such as “জি” is recognized only for an order already in `awaiting_confirmation` after a complete summary. Broad phrases such as “দেন” or “একটা চাই” never submit an order. Stock is checked before confirmation and again before submission. Active pre-order variations may be ordered with zero stock; normal products cannot exceed current stock. A price change requires a new summary and confirmation.

Protected administration is available at `/admin/orders` and `/admin/orders/:id`. Backend endpoints are:

```text
GET  /api/admin/orders
GET  /api/admin/orders/:id
POST /api/admin/orders/:id/retry
```

Retry is an explicit admin action and is enabled only for a safely known failure after full revalidation. Timeout, network, HTTP 5xx, malformed-response, and uncertain local persistence outcomes are marked unknown and cannot be blindly retried. A unique submission reference and atomic claim prevent concurrent duplicate requests.

Apply `20260929213000_order_engine` before using orders, then regenerate Prisma Client:

```bash
npm run db:migrate:deploy
npm run prisma:generate
```

Configure delivery charges, Website API base URL, page ID, delivery-company ID, UTM source, and UTM campaign through protected Business Settings. `ORDER_API_TIMEOUT_MS` is environment-controlled. No API credential or customer password is logged; the normalized customer phone is sent as the website API password only because that external contract requires it.

## Step 10 Human Handover and Admin Inbox

The backend owns handover decisions. An AI response with `requiresHuman: true`, or the configured number of consecutive uncertain responses, creates a structured `ConversationHandover`, changes the conversation to `human`, and creates an internal admin notification. While human-owned, customer messages are persisted and marked unread, but Gemini, image recognition, voice transcription, and automatic AI replies are not invoked.

The protected responsive inbox is available at:

```text
http://localhost:3000/admin/inbox
```

It provides database-backed search, pagination, pending/assigned/active/closed filters, customer context, text/image/voice history, transcription, current product facts, related orders, handover details, assignment, local human replies, return-to-AI, close, and reopen actions. It uses the existing `x-admin-password` authentication and the single local actor identity `admin`; no second authentication system was introduced.

Protected APIs:

```text
GET  /api/admin/inbox
GET  /api/admin/conversations/:id
POST /api/admin/conversations/:id/messages
POST /api/admin/conversations/:id/take
POST /api/admin/conversations/:id/assign
POST /api/admin/conversations/:id/release
POST /api/admin/conversations/:id/return-to-ai
POST /api/admin/conversations/:id/close
POST /api/admin/conversations/:id/reopen
POST /api/admin/conversations/:id/handover
GET  /api/admin/handovers
POST /api/admin/handovers/:id/resolve
```

`MessageDeliveryService` isolates outbound delivery from the inbox. Step 10 uses only `TestMessageDeliveryProvider`, which records a local successful delivery result in human-message metadata. No Messenger or WhatsApp request is made. A later channel provider can implement the same interface.

Set `AI_MAX_CONSECUTIVE_FAILURES` (default `2`) and `INBOX_PAGE_SIZE` (default `25`) if the defaults need adjustment. Apply `20260929223000_human_handover_inbox` and regenerate Prisma Client before starting:

```bash
npm run db:migrate:deploy
npm run prisma:generate
```

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

| Variable | Purpose | Status |
| --- | --- | --- |
| `NODE_ENV` | Runtime mode | Used |
| `API_HOST`, `API_PORT` | API bind address and port | Used |
| `LOG_LEVEL` | Structured API log level | Used |
| `FRONTEND_URL` | Allowed browser origin for API CORS | Used |
| `NEXT_PUBLIC_API_BASE_URL` | Backend URL used by the Next.js server proxy | Used |
| `DATABASE_URL` | PostgreSQL connection string | Used |
| `REDIS_URL` | Redis connection string | Used |
| `ADMIN_PASSWORD` | Header credential for protected admin/sync/AI test operations | Used |
| `GEMINI_API_KEY` | Gemini API credential; optional for rule-only responses | Used by AI provider |
| `GEMINI_MODEL` | Configurable Gemini model name | Used by AI provider |
| `GEMINI_TEMPERATURE` | Gemini generation temperature | Used by AI provider |
| `GEMINI_MAX_OUTPUT_TOKENS` | Gemini response token ceiling | Used by AI provider |
| `GEMINI_TIMEOUT_MS` | Gemini request timeout | Used by AI provider |
| `AI_MAX_HISTORY_MESSAGES` | Recent caller-provided messages sent to the model | Used |
| `AI_MAX_PRODUCTS` | Maximum relevant local products in model context | Used |
| `AI_TEST_RATE_LIMIT_PER_MINUTE` | Per-process protected AI endpoint rate limit | Used |
| `CONVERSATION_HISTORY_LIMIT` | Maximum recent persisted messages loaded into memory | Used |
| `MAX_IMAGE_SIZE_MB` | Maximum downloaded or uploaded image size | Used |
| `IMAGE_REQUEST_TIMEOUT_MS` | Timeout for public image URL downloads | Used |
| `IMAGE_MATCH_HIGH_THRESHOLD` | Automatic product-selection confidence threshold | Used |
| `IMAGE_MATCH_MEDIUM_THRESHOLD` | Candidate/clarification confidence threshold | Used |
| `MAX_AUDIO_SIZE_MB` | Maximum downloaded or uploaded audio size | Used |
| `MAX_AUDIO_DURATION_SECONDS` | Maximum accepted/detected audio duration | Used |
| `AUDIO_REQUEST_TIMEOUT_MS` | Audio download and transcription timeout | Used |
| `VOICE_TRANSCRIPTION_LOW_CONFIDENCE` | Clarification threshold for uncertain transcription | Used |
| `META_PAGE_ACCESS_TOKEN` | Future Meta integration | Reserved |
| `META_APP_SECRET` | Future Meta integration | Reserved |
| `META_VERIFY_TOKEN` | Future webhook verification | Reserved |
| `WEBSITE_API_BASE_URL` | Alzeena website API base URL | Used by worker |
| `PRODUCT_FEED_TIMEOUT_MS` | Per-request feed timeout | Used by worker |
| `PRODUCT_FEED_RETRIES` | Temporary-failure retry count | Used by worker |
| `PRODUCT_FEED_MAX_PAGES` | Pagination safety limit | Used by worker |

Only variables needed by implemented steps are validated at process startup. Reserved secrets remain unused and must not be populated until their corresponding feature is implemented.
