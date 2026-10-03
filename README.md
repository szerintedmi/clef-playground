# Clef Playground

A small local playground for Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) decision models (`clef` 27B and `clef-flash` 9B).

- Edit the **state** (plain text, or JSON sent as structured data) and attach up to 4 images (drop, paste, or pick),
  with a selectable **downscale** (Original … 0.25 MP) applied before sending; each image shows its sent size and estimated tokens
- Build **questions** (`noul` yes/no, `choice`, `score`) in a form or as raw JSON
- See answers with per-option probabilities, plus **inference time**, token usage, and **cost**
- Save/load **question sets** and **inputs**; every run is kept in a **history** you can click to restore — all in a local SQLite file (`data/sqlite/clef.sqlite`)

## Setup

```sh
bun install
cp .env.example .env   # fill in CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
bun dev                # http://localhost:3000
```

The API token needs Workers AI permission. It stays on the local Bun server, which proxies requests to
`https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/cloudflare/<model>`.

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
routes with a mocked Cloudflare backend (`src/api.ts`). No credentials needed.

## Notes

- Cost is computed from `usage.input_tokens` at the published unit price ($0.24/M for clef, $0.09/M for clef-flash; see `src/shared.ts`). Cloudflare only publishes an input-token price for these models.
- Inference time is the round trip from the local server to the Cloudflare API.
- `⌘↵` / `Ctrl+Enter` runs the current request.

## License

[MIT](LICENSE)
