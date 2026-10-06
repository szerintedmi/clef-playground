# Clef Playground

A small local playground for Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) decision models (`clef` 27B and `clef-flash` 9B), and OpenAI's
[Decisions API](https://developers.openai.com/api/docs/guides/decisions) (`gpt-6-luna`) for side-by-side comparison.

- Edit the **state** (plain text, or JSON sent as structured data) and attach up to 4 images (drop, paste, or pick),
  with a selectable **downscale** (Original … 0.25 MP) applied before sending; each image shows its sent size and estimated tokens
- Build **questions** (`noul` yes/no, `choice`, `score`) in a form or as raw JSON
- See answers with per-option probabilities, plus **inference time**, token usage, and **cost**
- Save/load **question sets** and **inputs**; every run is kept in a **history** you can click to restore — all in a local SQLite file (`data/sqlite/clef.sqlite`)

## Setup

```sh
bun install
cp .env.example .env   # fill in CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN and/or OPENAI_API_KEY
bun dev                # http://localhost:3100
```

The API token needs Workers AI permission. It stays on the local Bun server, which proxies requests to
`https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/cloudflare/<model>`.
OpenAI models go to `https://api.openai.com/v1/decisions` with `OPENAI_API_KEY`. Each provider only needs its own
credentials.

### OpenAI Decisions API

The UI and history use Clef's request/answer shape for every model. For `gpt-6-luna` the server translates it
(`src/openai.ts`):

- `noul` → `predicate`. The optional yes/no criteria are added to the instructions as "Yes means: …" / "No means: …".
- `choice` → `choices: [{value, description}]`. `score` → `levels: [{label}]`.
- State and images are sent as one user message: an `input_text` part (JSON state is serialized) plus one
  `input_image` data-URL part per image.
- Answers become Clef-shaped again (probability arrays → maps keyed by value or level index). The raw OpenAI response
  is what history stores.

## Database migrations

The schema lives in numbered SQL files in `migrations/`. Pending ones are applied automatically when the server
starts (each in a transaction, recorded in `schema_migrations`).

```sh
bun run db:new add_run_notes   # creates migrations/000N_add_run_notes.sql — write your SQL there
bun run db:migrate             # apply pending migrations now (optional; startup does this too)
bun run db:status              # list applied / pending migrations
```

Migrations are forward-only: don't edit one that has been applied, add a new one instead.

## Tests

```sh
bun test
```

Covers the question editor logic and formatting (`src/web/lib.ts`), the SQLite store (in-memory), and the API
routes with mocked Cloudflare and OpenAI backends (`src/api.ts`), and the Decisions API translation (`src/openai.ts`). No credentials needed.

## Notes

- Cost is computed from `usage.input_tokens` at the published unit price ($0.24/M for clef, $0.09/M for clef-flash,
  $0.10/M for gpt-6-luna; see `src/shared.ts`). Both providers charge for input tokens only. OpenAI also has no
  cache or output-token charges.
- The per-image token estimate follows Clef's image processor, so it's hidden for OpenAI models. Their reported
  `usage` is what counts.
- Inference time is the round trip from the local server to the Cloudflare API.
- `⌘↵` / `Ctrl+Enter` runs the current request.

## License

[MIT](LICENSE)
