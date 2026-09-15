# API Reference

Base URL (local dev): `http://localhost:3000`

**Response envelope** — every endpoint returns one of:

```json
{ "status": true,  "result": { ... }, "message": "optional" }
{ "status": false, "error": "human-readable message", "code": "ERROR_CODE" }
```

**Auth**: protected endpoints require `Authorization: Bearer <jwt>` (from
`POST /auth/login`). Missing/invalid token → `401 {"status":false,"error":"Missing bearer token"|"Invalid or expired token","code":"UNAUTHORIZED"}`.

**Money fields** are always strings with 8 decimals, e.g. `"12.50000000"`. Parse as
decimal strings, never floats.

**Idempotency** (`POST /transfer`, `POST /marketplace/listings/:id/buy`): send a unique
`idempotency_key` (any string ≤100 chars, e.g. `crypto.randomUUID()`) per *user intent*,
generated **before** the request is sent and reused on retry of the same intent. If the
request is retried after a timeout, the API returns the original result with
`result.idempotent_replay: true` instead of executing twice. Without it, a network retry
can double-spend.

---

## Auth

### POST /auth/register
Create an account. A wallet (with a shareable 8-char `wallet_id`) is created
automatically in the same transaction. No token returned — call `/auth/login`.

- Auth: none
- Body: `{ "email": string (valid email, required), "username": string (3–30 chars, letters/digits/underscore, required), "password": string (8–100 chars, required) }`
- 201:
```json
{ "status": true,
  "result": {
    "user": { "id": "uuid", "email": "a@b.dev", "username": "alice", "createdAt": "2026-09-15T19:12:51.114Z" },
    "wallet": { "wallet_id": "PzLZfFwR", "balance": "0.00000000" } },
  "message": "Registration successful" }
```
- 400 validation: `{ "status": false, "error": "Validation failed", "message": "Password must be at least 8 characters", "code": "VALIDATION_ERROR_PASSWORD", "field": "password" }`
- 409: `{ "error": "Email address is already registered", "code": "CONFLICT" }` (or `"Username is already taken"`)

### POST /auth/login
- Auth: none
- Body: `{ "email": string, "password": string }`
- 200:
```json
{ "status": true,
  "result": { "token": "eyJhbGciOi...", "user": { "id": "uuid", "email": "...", "username": "...", "createdAt": "..." } },
  "message": "Login successful" }
```
- 401: `{ "error": "Invalid email or password", "code": "INVALID_CREDENTIALS" }`

---

## Wallet

### GET /wallet
Current user's wallet.

- Auth: **yes**
- 200: `{ "status": true, "result": { "wallet_id": "PzLZfFwR", "balance": "92.50000000" } }`

### POST /wallet/mint
Demo-only top-up from the system treasury. Defaults to 100, capped at 10,000 per call.

- Auth: **yes**
- Body: `{ "amount": number | numeric string }` — optional
- 200:
```json
{ "status": true,
  "result": { "transaction": { "id": "uuid", "type": "mint", "status": "completed" }, "amount": "100.00000000", "balance_after": "100.00000000" },
  "message": "Minted" }
```
- 400: `{"error":"Amount must be positive"}` / `{"error":"Mint amount exceeds the demo limit of 10000.00000000"}`

### GET /wallet/lookup/:wallet_id
Read-only recipient lookup for the transfer confirmation screen (show
"Sending to @username" **before** the user commits the transfer).

- Auth: **yes**
- 200: `{ "status": true, "result": { "wallet_id": "9er7yjCg", "username": "grace_123" } }`
- 404: `{ "error": "Wallet not found", "code": "NOT_FOUND" }`

---

## Transfer

### POST /transfer
Peer-to-peer transfer, identified by the **recipient's wallet_id** (never email/username).

- Auth: **yes**
- Body:
```json
{ "recipient_wallet_id": "9er7yjCg",
  "amount": 7.5,
  "idempotency_key": "uuid-or-any-unique-string" }
```
  - `amount`: positive number or numeric string, ≤8 decimals
  - `idempotency_key`: required, unique per intent — **always generate client-side and reuse on retry**
- 200 (new or replay — same shape):
```json
{ "status": true,
  "result": {
    "idempotent_replay": false,
    "transaction": { "id": "uuid", "type": "transfer", "status": "completed", "amount": "7.50000000", "idempotency_key": "...", "created_at": "..." },
    "sender":   { "wallet_id": "NZZpYkzb", "balance_after": "92.50000000" },
    "recipient": { "wallet_id": "9er7yjCg", "username": "grace_123" } },
  "message": "Transfer successful" }
```
- 400: `"Insufficient balance"` / `"Cannot transfer to yourself"` / `"Cannot transfer to a system wallet"` (`ESCROW00`, `MINT0000`) / `"Amount must be positive"` / validation
- 404: `"Wallet not found"` (unknown recipient_wallet_id)
- 401: invalid token

Suggested flow: `GET /wallet/lookup/:id` → user confirms @username → `POST /transfer`.

---

## Marketplace

Listings are token-for-token: buyer pays `amount × price_per_token` credits and receives
`amount` credits of tokens. Whole-lot purchases only (no partial fills). Creating a
listing **escrows** the tokens immediately (they leave the seller's balance); cancelling
releases them back.

### GET /marketplace/listings
Public feed of active listings, cheapest first.

- Auth: **no** (public)
- Query: `limit` (1–100, default 20), `offset` (default 0)
- 200:
```json
{ "status": true,
  "result": {
    "listings": [
      { "id": "uuid", "amount": "20.00000000", "price_per_token": "0.50000000", "status": "active", "created_at": "...", "seller_username": "alice" }
    ],
    "total": 42, "limit": 20, "offset": 0 } }
```

### POST /marketplace/listings
Create a listing (escrows `amount` from your balance immediately).

- Auth: **yes**
- Body: `{ "amount": 20, "price_per_token": 0.5 }` — both positive, ≤8 decimals
- 201:
```json
{ "status": true,
  "result": { "listing": { "id": "uuid", "amount": "20.00000000", "price_per_token": "0.50000000", "status": "active", "created_at": "..." }, "seller_balance_after": "80.00000000" },
  "message": "Listing created" }
```
- 400: `"Insufficient balance"` / `"Amount must be positive"` / `"Price per token must be positive"`

### POST /marketplace/listings/:id/buy
Buy an active listing. Atomic — if another buyer wins the race you get 409 and nothing is charged.

- Auth: **yes**
- Body: `{ "idempotency_key": "..." }` — optional here but **recommended** (same rules as /transfer)
- 200:
```json
{ "status": true,
  "result": {
    "idempotent_replay": false,
    "transaction": { "id": "uuid", "type": "purchase", "status": "completed", "created_at": "..." },
    "listing": { "id": "uuid", "amount": "30.00000000", "price_per_token": "0.50000000", "status": "fulfilled", "created_at": "..." },
    "buyer":   { "wallet_id": "AbQnHLwX", "balance_after": "115.00000000" },
    "seller":  { "wallet_id": "MBnKR8Fy", "username": "sel_123" },
    "payment": "15.00000000", "token_amount": "30.00000000" },
  "message": "Purchase successful" }
```
- 400: `"Insufficient balance"` (listing stays active and retryable) / `"Cannot buy your own listing"`
- 404: `"Listing not found"`
- 409: `"Listing is no longer available"` (already fulfilled or cancelled)

### POST /marketplace/listings/:id/cancel
Seller-only. Releases escrowed tokens back to the seller.

- Auth: **yes** (must be the listing's seller)
- Body: none
- 200:
```json
{ "status": true,
  "result": { "listing": { "id": "uuid", "amount": "10.00000000", "price_per_token": "0.90000000", "status": "cancelled", "created_at": "..." }, "seller_balance_after": "85.00000000" },
  "message": "Listing cancelled" }
```
- 403: `"You can only cancel your own listing"`
- 409: `"Listing is no longer available"` (already bought/cancelled — including losing a race against a concurrent buy)

---

## AI Proxy

### POST /ai/generate
Proxies a prompt to a local Ollama model and bills exact token usage.

- Auth: **yes**
- Body: `{ "prompt": string (1–8000 chars), "model": string }`
  - Available models (per-1k-token credit price): `qwen2.5:3b` (0.01), `phi3:latest` (0.008), `qwen2.5:1.5b-instruct-q4_K_M` (0.005)
- 200:
```json
{ "status": true,
  "result": {
    "request_id": "uuid",
    "model": "qwen2.5:3b",
    "response": "blue",
    "tokens": { "prompt": 36, "completion": 2, "total": 38 },
    "billing": { "hold": "0.00609000", "cost": "0.00038000", "refunded": "0.00571000", "clamped": false, "balance_after": "99.99962000" },
    "transaction": { "id": "uuid", "type": "ai_usage", "status": "completed" } },
  "message": "Generation complete" }
```
  Billing model: a hold is reserved before the call, the unused part is refunded after —
  `cost` is what you actually paid.
- 400: unknown model (message lists available models) / validation
- 402: `{ "error": "Insufficient balance", "code": ... }` — **the provider is never called in this case**
- 502: `{"error":"AI provider failed — your reserved 0.00581000 credits were refunded (balance: 199.99962000)"}` — provider down/timeout; the hold is fully refunded

### GET /ai/usage
Paginated AI usage history for the current user.

- Auth: **yes**
- Query: `limit` (1–100, default 20), `offset`
- 200:
```json
{ "status": true,
  "result": {
    "usage": [
      { "id": "uuid", "model": "qwen2.5:3b", "tokens_used": 38, "cost": "0.00038000", "status": "completed", "request_id": "uuid", "created_at": "..." }
    ],
    "total": 1, "limit": 20, "offset": 0 } }
```
