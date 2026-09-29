# Alzeena Fashion Sales Agent

Production-oriented foundation for the Alzeena Fashion AI sales agent. The repository currently contains **Steps 1–13**: the web application, API, infrastructure configuration, PostgreSQL/Prisma data layer, product synchronization, protected business administration, the modular Gemini-backed AI core, persistent multimodal conversation memory, the deterministic Order Engine, human-handover Admin Inbox, and a queued Facebook Messenger channel adapter.

Step 11 adds signed Meta webhooks, event normalization and deduplication, a BullMQ Messenger worker, text/image/voice routing through the existing conversation system, safe outbound delivery, and real Messenger delivery for admin replies. It does not add WhatsApp, Instagram DM, voice replies, campaigns, broadcasts, comment automation, or advanced campaign analytics.

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

## Step 11 Facebook Messenger and Meta Webhooks

Messenger is an isolated channel adapter. The webhook validates Meta's HMAC SHA-256 signature against the exact raw request bytes, normalizes supported Page `messages` events, persists a minimal event log, deduplicates by Meta message ID, queues `messenger-events`, and immediately acknowledges Meta. The Messenger worker invokes the same `ChatService`, image pipeline, Product DB, Order Engine, and Human Handover used by existing channels. Voice attachments are persisted as pending metadata and handed to the dedicated `audio-transcription` worker; audio download and speech-to-text never execute in the webhook request.

Endpoints:

```text
GET  /api/webhooks/facebook
POST /api/webhooks/facebook
GET  /api/admin/integrations/facebook/status
POST /api/admin/test/messenger-event
```

The protected status page is `/admin/integrations/facebook`. It displays only Page ID, Graph API version, webhook/outbound timestamps, and a sanitized last error. Secrets are never returned.

Required server configuration:

```env
FACEBOOK_VERIFY_TOKEN=<a-long-random-value-you-choose>
FACEBOOK_APP_ID=<meta-app-id>
FACEBOOK_APP_SECRET=<meta-app-secret>
FACEBOOK_PAGE_ID=<facebook-page-id>
FACEBOOK_PAGE_ACCESS_TOKEN=<page-access-token>
FACEBOOK_GRAPH_API_VERSION=v25.0
FACEBOOK_SEND_TIMEOUT_MS=15000
MESSENGER_WEBHOOK_RATE_LIMIT_PER_MINUTE=1000
```

Meta's current Messenger documentation identifies Graph API `v25.0` as current and requires a Page access token obtained by a person with the Page `MESSAGE` task plus the `pages_messaging` permission for the Send API. Follow the current official documentation rather than copying old API versions:

- Send API: <https://developers.facebook.com/docs/messenger-platform/reference/send-api/>
- Messenger quick start and webhook payloads: <https://developers.facebook.com/docs/messenger-platform/getting-started/quick-start/>
- Messenger changelog/version: <https://developers.facebook.com/docs/messenger-platform/changelog/>

### Meta setup checklist

1. Create or select a Meta Developer App and add the **Messenger** product.
2. Connect the Facebook Page that the business controls.
3. Generate a Page access token for a person with the Page `MESSAGE` task and ensure the app has the officially required `pages_messaging` permission. Use `pages_manage_metadata` only where Meta's current Page subscription setup requires it.
4. Set the callback to `https://YOUR-HTTPS-HOST/api/webhooks/facebook` and enter the exact `FACEBOOK_VERIFY_TOKEN`.
5. Select the **Page** webhook object and subscribe to the `messages` field. Add other fields only when their event types are implemented.
6. Complete Meta App Review/Advanced Access where Meta requires it for people without roles on the app/Page. Meta's current changelog notes different review behavior when an app is used only with its own Page; verify this in the dashboard for the specific app.
7. Keep App Secret and Page access token only in the backend environment, restart API and worker, and verify `/admin/integrations/facebook`.

### Local Messenger testing

```bash
docker compose up -d postgres redis
npm run db:migrate:deploy
npm run prisma:generate
npm run dev:api
npm run dev:web
npm run dev:messenger-worker
```

Expose port 4000 through a trusted HTTPS development tunnel, without committing a tunnel token. Configure the resulting HTTPS callback in Meta, verify the token, subscribe the Page, then send a message to the Page. The frontend remains on port 3000. The admin-protected fixture endpoint uses the same queue and worker pipeline:

```bash
curl -X POST http://localhost:4000/api/admin/test/messenger-event \
  -H "content-type: application/json" \
  -H "x-admin-password: $ADMIN_PASSWORD" \
  --data '{"senderId":"test-user-001","pageId":"YOUR_PAGE_ID","messageId":"test-message-001","text":"Messi polo কত?"}'
```

The test fixture does not bypass AI, conversation, order, or handover logic. Actual webhook tests must use `X-Hub-Signature-256`; production signature validation cannot be disabled. Messenger delivery retries only known temporary network, timeout, rate-limit, transient Meta, and HTTP 5xx failures. A retry with an already-created local response performs delivery only and never repeats AI/order processing.

Apply `20260929233000_facebook_messenger` and run the dedicated worker before enabling the webhook. Facebook media URLs are passed immediately to the existing bounded image/audio download pipelines and are not exposed through public APIs or stored as raw webhook payloads.

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
| `MAX_IMAGE_SIZE_MB` | Legacy maximum downloaded or uploaded image size | Used by direct API |
| `IMAGE_MAX_FILE_SIZE`, `IMAGE_MAX_DIMENSION` | Queued image byte and dimension limits | Used by image worker |
| `IMAGE_REQUEST_TIMEOUT_MS` | Timeout for public image URL downloads | Used |
| `VISION_PROVIDER`, `VISION_MODEL`, `VISION_TIMEOUT` | Server-only multimodal provider configuration | Used by image worker |
| `IMAGE_MATCH_CANDIDATES` | Maximum local Product DB candidates | Used |
| `IMAGE_RETENTION_HOURS` | Optional retained provider image window for admin debugging | Used |
| `IMAGE_MATCH_HIGH_THRESHOLD` | Automatic product-selection confidence threshold | Used |
| `IMAGE_MATCH_MEDIUM_THRESHOLD` | Candidate/clarification confidence threshold | Used |
| `MAX_AUDIO_SIZE_MB` | Maximum downloaded or uploaded audio size | Used |
| `MAX_AUDIO_DURATION_SECONDS` | Maximum accepted/detected audio duration | Used |
| `AUDIO_REQUEST_TIMEOUT_MS` | Audio download and transcription timeout | Used |
| `VOICE_TRANSCRIPTION_LOW_CONFIDENCE` | Clarification threshold when a provider supplies confidence | Used |
| `STT_PROVIDER`, `STT_MODEL` | Server-only speech provider and model | Used by audio worker |
| `STT_TIMEOUT`, `STT_MAX_FILE_SIZE`, `STT_MAX_DURATION` | STT timeout (seconds), byte-size ceiling (MB), and duration ceiling | Used by audio worker |
| `AUDIO_RETENTION_HOURS` | Optional best-effort provider-audio retention for admin debugging; `0` deletes/unlinks immediately | Used by audio worker |
| `AUDIO_DEBOUNCE_MS` | Short merge window for consecutive voice notes | Used by audio worker |
| `AUDIO_RATE_LIMIT_PER_MINUTE` | Per-customer voice-note safety limit | Used by Messenger worker |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | Server-only Page token for Messenger Send API | Used |
| `FACEBOOK_APP_SECRET`, `FACEBOOK_VERIFY_TOKEN` | Webhook signature and verification secrets | Used |
| `FACEBOOK_APP_ID`, `FACEBOOK_PAGE_ID` | Meta application/Page identifiers | Used |
| `META_GRAPH_API_VERSION`, `FACEBOOK_SEND_TIMEOUT_MS` | Central Graph version and outbound timeout | Used |
| `APP_URL`, `WEBHOOK_URL` | Environment-specific application and public webhook URLs | Used |
| `MESSENGER_PROVIDER`, `MESSENGER_CREDENTIAL_ENCRYPTION_KEY` | Meta/mock provider and optional encrypted per-page credential storage | Used |
| `MESSENGER_DEBOUNCE_MS`, `MESSENGER_TECHNICAL_LOG_RETENTION_DAYS` | Text burst window and technical-log retention | Used |
| `MESSENGER_WEBHOOK_RATE_LIMIT_PER_MINUTE` | Signed webhook IP safety limit | Used |
| `WEBSITE_API_BASE_URL` | Alzeena website API base URL | Used by worker |
| `PRODUCT_FEED_TIMEOUT_MS` | Per-request feed timeout | Used by worker |
| `PRODUCT_FEED_RETRIES` | Temporary-failure retry count | Used by worker |
| `PRODUCT_FEED_MAX_PAGES` | Pagination safety limit | Used by worker |

Only variables needed by implemented steps are validated at process startup. Reserved secrets remain unused and must not be populated until their corresponding feature is implemented.

## Step 12 production reliability and operations

Step 12 adds central safe errors and request IDs, structured/redacted logs, bounded dependency calls, circuit breakers, shared BullMQ policy/monitoring, worker heartbeats, queue recovery controls, API rate limiting, richer health checks, operational analytics, and the System admin pages. It deliberately does not add any Step 13 channel or campaign features.

### Correlation, errors, and logs

- Clients may send `x-request-id` using 8–128 safe alphanumeric/`._:-` characters. Invalid values are replaced with a UUID; every response repeats the ID.
- Errors use `{ "success": false, "error": { "code", "message", "requestId" } }`. Unexpected production errors never expose stacks or upstream details.
- Pino emits JSON outside development. Authorization/cookies, admin credentials, API keys/tokens, database/Redis URLs, phone, and address fields are redacted. Search by `requestId`, queue `jobId`, conversation, or event type.
- `SystemLog` keeps its compatible `type` field and adds indexed `event`, `module`, `requestId`, `conversationId`, and `customerId` dimensions. Apply migration `20260929190000_production_reliability` before deployment.

### Queues, retries, and recovery

Queues are `product-sync`, `messenger-events`, `ai-processing`, `order-processing`, and `notifications`. Default jobs use three attempts, exponential backoff starting at two seconds, and bounded completed/failed retention. Product validation/feed-shape failures and permanent Messenger errors use BullMQ `UnrecoverableError`; temporary network/rate-limit/server failures retry. Messenger processing remains globally ordered and has a 60-second distributed conversation lock. Durable database event IDs prevent webhook duplicates; persisted outbound IDs prevent duplicate AI generation on delivery retry. Order submission retains its database compare-and-set lock, unique submission reference/external ID, and never automatically retries an unknown external outcome.

Run workers separately from the API:

```bash
npm run start:worker --workspace=@alzeena/api
npm run start:messenger-worker --workspace=@alzeena/api
npm run start:messenger-send-worker --workspace=@alzeena/api
npm run start:audio-worker --workspace=@alzeena/api
npm run start:image-worker --workspace=@alzeena/api
npm run start:followup-worker --workspace=@alzeena/api
```

BullMQ persists waiting/delayed/failed work in Redis and recovers stalled work after restart. Stop with SIGTERM and allow the API/workers to drain. The workers publish expiring Redis heartbeats. Visit `/admin/system/jobs` to inspect counts and retained failures; failed jobs can be explicitly retried or removed. Never retry an order whose external outcome is unknown without reconciliation.

### Health and dashboards

- `GET /health` is public, bounded to two seconds per dependency, and returns only API/PostgreSQL/Redis state and uptime. Use it for liveness/readiness.
- `GET /api/admin/system/health` requires `x-admin-password` and includes queue counts, worker heartbeats, product sync freshness, circuit state, memory, and uptime.
- `GET /api/admin/system/analytics` returns basic Today/7/30-day customer, conversation, order, and error counts.
- `/admin/system` is the protected operations dashboard; `/admin/system/jobs` is queue failure management.

A missing heartbeat means that worker is stopped or cannot reach Redis. A stale product sync means the local catalogue may no longer reflect the Product API; keep the local database as the runtime product source and restore sync rather than querying upstream per chat.

### Limits and dependency protection

All non-webhook API routes have a Redis-backed 300 requests/minute/IP safety limit and return the standard HTTP 429 error. The signed Messenger webhook retains its separate configurable limiter and quick queue-only acknowledgement. AI test traffic has its tighter `AI_TEST_RATE_LIMIT_PER_MINUTE` limit. Conversation history, model products/output tokens, Gemini timeout, image/audio bytes and duration, request bodies, redirects, and public URL destinations are bounded. Media downloads reject private/reserved hosts (including after redirects), validate signatures/MIME, stream with a hard byte ceiling, and remain in memory only.

Gemini retries one temporary failure before safe fallback and has a circuit breaker. Product API uses bounded exponential retries plus a circuit breaker. Facebook and Order API calls are timeout-bound and circuit protected. Order calls are intentionally not blindly retried because a timeout can have an unknown creation outcome. Deterministic local product/order calculations remain authoritative; AI never calculates price, stock, delivery, or order validity.

### Production deployment checklist

1. Provision backed-up PostgreSQL and persistent Redis; restrict both to the private network and enable TLS where supported.
2. Set `NODE_ENV=production`, HTTPS `FRONTEND_URL`, strong `ADMIN_PASSWORD`, `DATABASE_URL`, and `REDIS_URL`. Add Gemini/Facebook credentials only server-side. Startup validates complete Facebook credential sets without printing values.
3. Apply Prisma migrations, then build once: `npm run prisma:generate && npm run db:migrate:deploy && npm run typecheck && npm run build`.
4. Start one API process and the product/Messenger workers under a supervisor with SIGTERM grace. Scale only after reviewing queue global concurrency and conversation ordering.
5. Verify `/health`, `/admin/system`, worker heartbeats, queue counts, product-sync freshness, and a signed test webhook. Confirm secrets do not appear in browser bundles or logs.
6. Configure HTTPS, proxy body/time limits, firewall rules, log retention/alerts, database point-in-time backups, and Redis persistence. Alert on degraded health, missing heartbeat, open circuit, failed queue growth, stale product sync, and order `UNKNOWN` states.
7. Test restore procedures regularly. For restart: stop ingress/workers gracefully, back up, deploy/migrate, start API, then workers, and watch failed/stalled counts.

Troubleshooting: check the response `x-request-id` in structured logs; inspect `/admin/system` and `/admin/system/jobs`; verify Redis persistence/connectivity for missing work; restart a missing worker; resolve credentials or upstream health for open circuits; wait for cooldown before a probe; and reconcile unknown orders against the Order Engine before any manual retry. Do not paste secrets or raw customer addresses/phones into tickets.

## Step 13 Admin operations console

The responsive admin console is organized around Dashboard, Inbox, Customers, Orders, Products, Knowledge Base, Settings, and System. It reuses the one-admin-password model: the credential remains in tab-scoped `sessionStorage`, is sent only in `x-admin-password`, can be cleared with Logout, is timing-safe on the API, and invalid attempts are limited to 10/IP/minute in addition to the global API limit. Future roles can be represented by filtering the central navigation configuration without changing pages; Step 13 intentionally does not add multi-role RBAC.

### Admin routes

- `/admin` — backend-filtered Today, Yesterday, 7-day, 30-day, or custom dashboard statistics and dependency status.
- `/admin/inbox` — paginated/searchable channel inbox, 15-second polling, AI/human lifecycle controls, media display, customer/order/product context, database quick replies, and Messenger-backed human text delivery.
- `/admin/customers` and `/admin/customers/:id` — paginated search, activity totals, conversations, orders, and recent message history.
- `/admin/orders` and `/admin/orders/:id` — paginated filters/search and server-calculated order detail/submission state.
- `/admin/products` and `/admin/products/:id` — read-only synced catalogue search, stock filters, product/variation detail, and sync timestamps. Website product data cannot be edited here.
- `/admin/knowledge-base` — single large editor with immutable version history, preview, and confirmed restore-as-new-version.
- `/admin/settings` — delivery/order settings, environment-controlled read-only AI configuration, and quick reply CRUD.
- `/admin/settings/facebook` — masked connection health and explicit Graph API connection test; tokens are never returned.
- `/admin/system`, `/admin/system/jobs`, and `/admin/system/logs` — health/queues, paginated retained failures, authorized stack detail, and sanitized structured logs.

Apply migration `20260929220000_admin_dashboard` to create and seed `quick_replies`. Dashboard/customers/orders/products/logs/jobs queries paginate and filter in PostgreSQL or Redis; the browser does not fetch entire datasets. Messenger image attachment sending is not offered because the current Step 11 outbound delivery provider supports text only; inbound images/audio are previewed safely. Full WebSockets remain future work, while inbox polling and isolated loading functions provide a replaceable real-time boundary.

## Step 16 queued voice/audio understanding

Messenger audio ingestion creates the ordinary inbound `Message` plus one linked `AudioTranscription` lifecycle record, enqueues only identifiers on `audio-transcription`, and returns control to the Messenger worker. The audio worker securely downloads and validates bounded audio, transcribes through `SpeechToTextProvider`, preserves the original transcript and nullable provider confidence, stores normalization separately, and clears the provider URL by default. No audio BLOB or internal file path is stored.

Completed consecutive voice notes are merged after a short debounce and enter the same `ChatService`, Product DB, Knowledge Base, Order Engine, customer memory, follow-up, and handover orchestration as text/image messages. Each original transcript remains on its own lifecycle record. Temporary dependency failures use three exponential retries; permanent validation failures do not retry. Repeated failures can hand over to an admin, while customer responses stay non-technical. Start `audio-transcription.worker.ts` separately and apply migration `20260930023000_voice_audio_understanding` before enabling voice processing. Admin Inbox shows status, language, duration, retained playback, and an admin-only re-transcribe action while the source remains available.

## Step 17 queued image/product understanding

Messenger image webhooks persist an ordinary image `Message` plus a linked `ImageProcessing` lifecycle, then enqueue identifier-only work on `image-analysis` before acknowledging. The standalone worker performs SSRF-safe bounded download, signature/MIME/dimension validation, SHA-256 fingerprinting, structured vision/OCR through `VisionProvider`, and local Product DB candidate matching. Gemini never supplies live commerce facts: current price, stock, sizes, and orderability are reloaded from the Product DB before the unified `ChatService` and Order Engine run.

Structured extraction supports screenshots, product names/codes, nullable OCR confidence, visual attributes, size charts, and numbered multi-product images. `ImageProductMatcher` currently uses exact code/name and attribute scoring with a configurable candidate limit; it is replaceable by a future embedding-backed matcher without deploying vector infrastructure now. Medium/low matches clarify instead of guessing. Image/OCR text is explicitly untrusted and cannot override system rules.

Images are not stored as database BLOBs. Messenger buffers bypass the URL cache, temporary data is released after processing, and provider URLs are removed by default or retained briefly with `IMAGE_RETENTION_HOURS`. Admin Inbox exposes preview, extraction, candidates, selected match, timings, re-analysis, manual correction, and feedback history. Apply `20260930043000_image_product_understanding` and run `start:image-worker` before enabling queued image handling.

## Step 18 production Messenger pipeline

The production path is signature verification → event/message deduplication → fast queue acknowledgement → modality worker/unified `ChatService` → `messenger-outgoing` → `MessengerSendWorker` → `MetaGraphClient`. Text burst jobs use `MESSENGER_DEBOUNCE_MS`; image and audio retain their dedicated queues. Incoming and outgoing work uses page-aware, TTL-backed conversation locks. Every outgoing response has a database idempotency key and is checked for a newer customer message, human takeover, page AI status, and emergency stop before sending. Delivery, read, echo, and postback webhooks are normalized separately and never become duplicate customer messages.

Page tokens may remain environment-only or be stored encrypted with AES-256-GCM when `MESSENGER_CREDENTIAL_ENCRYPTION_KEY` is configured. Admin APIs return only a masked token hint. `META_GRAPH_API_VERSION` controls all Graph requests through `MetaGraphClient`; production forbids the mock provider. Apply `20260930120000_production_messenger` and run both `start:messenger-worker` and `start:messenger-send-worker`.

For local webhook testing, set `APP_URL` and optionally `WEBHOOK_URL` to an HTTPS tunnel (for example Cloudflare Tunnel or ngrok) ending at `/api/webhooks/facebook`; never hardcode the tunnel hostname. Use a development Meta app/page and token, or `MESSENGER_PROVIDER=mock`. Do not load production tokens in development. Production configuration requires HTTPS, valid webhook verification/signature secrets, authenticated admin routes, secret redaction, and a non-mock provider.

Admin operations include page AI enable/disable, global emergency stop, failed-send review/retry/cancel, sanitized webhook events, correlation traces, and `/admin/system/messenger-health`. Incoming customer messages are retained when AI is paused. Technical processed/ignored webhook logs are cleaned according to `MESSENGER_TECHNICAL_LOG_RETENTION_DAYS`; customer conversations and orders are not deleted by this policy.
