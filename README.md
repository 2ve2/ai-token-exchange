# AI Token Exchange

A digital wallet platform where users hold internal **AI credit** balances, transfer them
peer-to-peer, trade them on a marketplace, and spend them on AI API calls proxied through
the backend (local Ollama models).

Built as a portfolio project demonstrating a **double-entry ledger** with real financial
integrity guarantees: DB-level check constraints, pessimistic row locking with
deadlock-free ordering, optimistic versioning, idempotency, and atomic escrow.

## Tech stack

| Layer | Tech |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| API framework | Hono |
| ORM | Drizzle ORM + drizzle-kit |
| Database | PostgreSQL (Neon), TCP via postgres.js |
| Auth | JWT (HS256, `hono/jwt`), bcrypt password hashing |
| AI provider | Ollama (local, zero-cost: qwen2.5:3b) |
| Validation | Zod |
| Lint/format | Biome |
| Tests | `bun test` (integration tests against the real DB) |
| Frontend | Next.js — **not started yet** (`apps/web`, see `FRONTEND_HANDOFF.md`) |

## Monorepo structure

```
ai-token-exchange/
├── apps/
│   ├── api/          # Bun + Hono backend (complete) — see apps/api/README.md
│   └── web/          # Next.js frontend (placeholder, to be built)
├── packages/
│   └── shared/       # placeholder for types shared between api & web
├── bun.lock
└── package.json      # bun workspaces: apps/*, packages/*
```

## Local setup

Prerequisites: [Bun](https://bun.sh) ≥ 1.4, a [Neon](https://neon.tech) PostgreSQL project
(free tier works), and [Ollama](https://ollama.com) running locally for the AI endpoints.

```sh
git clone <repo-url> && cd ai-token-exchange
bun install

# configure the API
cd apps/api
cp .env.example .env
#   DATABASE_URL   – from your Neon dashboard (pooler URL, sslmode=require)
#   JWT_SECRET     – generate: openssl rand -hex 32
#   OLLAMA_BASE_URL – keep default if Ollama runs on localhost:11434

# create the schema + seed system accounts (escrow & treasury wallets)
bun run db:migrate

# pull the model used by the AI proxy
ollama pull qwen2.5:3b

# start the dev server (hot reload) on :3000
bun run dev
```

Health checks: `GET /` (liveness) and `GET /health` (pings the database).

## Running tests

Tests are integration tests — they run against your real Neon database and (for AI tests)
a live Ollama. They create throwaway users and clean up nothing, so point them at a dev
database.

```sh
cd apps/api
bun run test              # transfer, marketplace, ai (skips failure case)
bun run test:ai-failure   # provider-failure refund proof (forces a dead provider URL)
bun run typecheck         # tsc --noEmit
bun run check             # biome lint + format
```

Test-time behavior: `NODE_ENV=test` (set via `--preload ./tests/setup.ts`) uses cheap
bcrypt rounds so auth-heavy tests stay fast.

## Documentation

- [`apps/api/README.md`](apps/api/README.md) — backend architecture, ledger design, folder layout
- [`apps/api/API.md`](apps/api/API.md) — **every endpoint**, request/response shapes, error codes
- [`FRONTEND_HANDOFF.md`](FRONTEND_HANDOFF.md) — quickstart for building the Next.js frontend
