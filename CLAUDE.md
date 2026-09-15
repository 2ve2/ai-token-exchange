# AI Token Exchange — agent guide

Bun-first tooling defaults:

- Use `bun <file>` instead of `node`/`ts-node`; `bun run <script>` instead of `npm run`
- Use `bun install` and `bunx <pkg>` instead of npm/npx equivalents
- Use `bun test` instead of jest/vitest
- Bun auto-loads `.env` — never use dotenv

## API (apps/api)

- Runtime: Bun + Hono (`src/app.ts` builds the app, `src/server.ts` is the only
  `Bun.serve` entry point). Don't add express or a second server.
- **PostgreSQL driver: postgres.js (`postgres` package) — this is deliberate.**
  `Bun.sql` does not support interactive transactions, and the entire
  locking/concurrency model depends on `SELECT ... FOR UPDATE` inside
  `db.transaction(...)`. Do not migrate to `Bun.sql` or `pg`.
  See "Concurrency model" in `apps/api/README.md` before touching any code that
  moves balances.
- All money is exact decimal strings (`"12.50000000"`) — use `src/lib/money.ts`
  helpers, never floats or `Number` arithmetic on balances.
- Every balance change must go through the double-entry ledger (transactions +
  ledger_entries). Never `UPDATE wallets` outside `src/lib/tx.ts` helpers
  (`lockWallets` / `updateWalletBalance`).
- Style: Biome (tabs, double quotes) — `bun run check` in apps/api must stay clean,
  as must `bun run typecheck`.

## Tests (apps/api/tests)

Integration tests run against the real Neon DB and (for AI tests) a live Ollama:

```sh
cd apps/api
bun run test              # all suites
bun run test:ai-failure   # provider-failure refund proof (dead provider URL)
```

`--preload ./tests/setup.ts` sets `NODE_ENV=test` (cheap bcrypt rounds).

## Frontend (apps/web — not yet built)

The frontend is **Next.js** (see `FRONTEND_HANDOFF.md` and `apps/api/API.md` for the
endpoint contract). Do not use Bun HTML imports or Bun's bundler for apps/web.

## Reference docs

- `apps/api/README.md` — architecture, ledger design, concurrency model
- `apps/api/API.md` — every endpoint, request/response shapes, error codes
- `FRONTEND_HANDOFF.md` — Next.js quickstart against this backend
