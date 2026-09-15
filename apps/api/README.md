# @ai-token-exchange/api

Bun + Hono backend implementing the wallet, ledger, marketplace, and AI proxy services.

## The ledger (why the system is shaped this way)

Every balance change is a **double-entry movement** between two real wallets:

```
wallets ──< ledger_entries >── transactions
```

- `transactions` = the business event (`mint | transfer | purchase | sale | ai_usage |
  escrow_lock | escrow_release`), with `status` (`pending | completed | failed`) and an
  optional unique `idempotency_key`.
- `ledger_entries` = the actual money movements of that event. Each entry has a
  `direction` (`debit`/`credit`), an `amount`, and — crucially — `balance_after`, so the
  wallet's entire history is replayable and auditable.
- `wallets` = cached current balance + `version` (optimistic lock).

Invariants enforced at the database level:

- `CHECK (balance >= 0)` on wallets — no negative balances, ever
- `CHECK (amount > 0)` on ledger entries and listings — no zero/negative movements
- `UNIQUE (wallet_id)`, `UNIQUE (email)`, `UNIQUE (username)`, `UNIQUE (idempotency_key)`

### Concurrency model

1. **Pessimistic locking**: every flow locks all affected wallets with
   `SELECT ... FOR UPDATE` **in globally sorted row-id order** (`lib/tx.ts` →
   `lockWallets`), so any two flows — even opposite-direction transfers — acquire locks
   in the same order and cannot deadlock.
2. **Optimistic versioning**: balance writes are guarded by
   `WHERE version = <locked version>` and bump `version`; a zero-row update aborts the
   transaction (belt-and-suspenders under the row lock).
3. **Idempotency**: `POST /transfer` and `/marketplace/listings/:id/buy` accept an
   `idempotency_key`. A replay returns the original result; concurrent duplicates are
   caught by the unique constraint, and the loser re-reads and returns the winner's result.
4. **Atomic claims**: marketplace buy/cancel use a guarded
   `UPDATE ... WHERE status = 'active'` — exactly one racer wins, everyone else gets 409.

### System accounts

Two system-owned wallets are seeded by migration (fixed UUIDs, unloginable password
hashes, excluded from user transfers):

| wallet_id  | Purpose |
|---|---|
| `ESCROW00` | Holds tokens locked in active marketplace listings |
| `MINT0000` | Treasury — source for demo mints, counterparty for AI billing holds |

### AI billing: reserve → generate → settle

Actual token cost is unknowable before generation, so `/ai/generate` works like a
credit-card auth hold:

1. **Reserve** a generous hold (`pending` `ai_usage` txn: debit user, credit treasury).
   Insufficient balance → `402` **before** the provider is called.
2. **Generate** via Ollama (non-streaming) and meter real tokens
   (`prompt_eval_count + eval_count`).
3. **Settle**: refund the unused hold with a reversing entry, mark the reserve
   `completed`, write an `ai_usage_logs` row.
4. **Failure**: the full hold is refunded via a reversing entry and the reserve is
   marked `failed` — nobody pays for a failed generation.

Money math is exact: `lib/money.ts` does all arithmetic on scaled `bigint`
(8 decimal places), never floats. All API money fields are canonical 8-decimal strings.

## Folder structure

```
src/
├── app.ts               # Hono app: middleware, error handler, route mounting
├── server.ts            # Bun.serve entry point
├── config/env.ts        # zod-validated environment (fail-fast at boot)
├── constants/           # error messages, system accounts, model price map
├── db/
│   ├── index.ts         # drizzle client (postgres.js, SSL, pool)
│   ├── schema/          # one file per domain + relations + barrel export
│   └── migrations/      # generated SQL (committed) + seed migrations
├── lib/
│   ├── auth.ts          # bcrypt hashing, JWT sign/verify
│   ├── database-errors.ts # PG error code mapping + cause-chain unwrapping
│   ├── money.ts         # exact 8-decimal arithmetic on scaled bigint
│   ├── response-helpers.ts # standard { status, result, message, error, code } shape
│   ├── tx.ts            # lockWallets / updateWalletBalance shared tx helpers
│   └── wallet-id.ts     # nanoid generator (8-char, unambiguous alphabet)
├── middleware/
│   ├── auth.ts          # Bearer JWT → loads user → c.set("user")
│   └── error-handler.ts # central onError: HTTPException/Zod/PG-error mapping
├── routes/              # thin HTTP layer (validate → service → respond)
├── services/            # business logic; all ledger writes live here
└── types/               # Hono AppEnv, zod request schemas
tests/                   # integration tests (real DB, real Ollama)
```

Services are object literals (`export const xService = { ... }`), routes stay thin, and
every JSON response uses the shared envelope from `lib/response-helpers.ts`:

```json
{ "status": true,  "result": { }, "message": "optional" }
{ "status": false, "error": "message", "code": "ERROR_CODE", "message": "optional detail" }
```

## Auth

- **Bearer tokens** (no cookies): `Authorization: Bearer <jwt>`.
- JWT is HS256, signed with `JWT_SECRET`, payload `{ sub: <user uuid>, iat, exp }`,
  7-day expiry, issued by `POST /auth/login` and `POST /auth/register` (register returns
  no token — login after registering).
- `authMiddleware` verifies the token, loads the user from the DB (deleted users are
  rejected with 401), and attaches it as `c.get("user")`.
- Passwords: bcrypt, cost 12 (cost 4 under `NODE_ENV=test`).
- The two system accounts have unusable password hashes and can never log in.

## Scripts

```sh
bun run dev          # hot-reload dev server
bun run start        # production server
bun run db:generate  # generate migration from schema changes
bun run db:migrate   # apply migrations
bun run db:studio    # drizzle studio
bun run test         # integration tests
bun run test:ai-failure
bun run typecheck    # tsc --noEmit
bun run check        # biome lint + format
```
