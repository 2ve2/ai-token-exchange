# Frontend Handoff — Next.js (apps/web)

Everything you need to start the frontend from scratch against this backend.

## Backend base URL

Local dev: `http://localhost:3000` (start it with `cd apps/api && bun run dev`).
Full endpoint reference: [`apps/api/API.md`](apps/api/API.md) — read it first.

Auth is **Bearer token** (no cookies): send `Authorization: Bearer <token>` from
`POST /auth/login` on every protected call. Store the JWT client-side (memory +
refresh-on-load via a silent re-login, or localStorage for a demo — your call).

## Get a test JWT in 30 seconds

```sh
curl -s -X POST http://localhost:3000/auth/register -H "Content-Type: application/json" \
  -d '{"email":"me@test.dev","username":"me","password":"password123"}'

curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" \
  -d '{"email":"me@test.dev","password":"password123"}'
# → result.token
```

Then top up: `curl -X POST http://localhost:3000/wallet/mint -H "Authorization: Bearer $TOKEN" -d '{}' -H "Content-Type: application/json"`

## Suggested reading order through API.md (matches page build order)

1. **Auth first** — `/auth/register`, `/auth/login`. Pages: register, login, auth guard/layout.
2. **Wallet** — `/wallet`, `/wallet/mint`, `/wallet/lookup/:id`. Pages: dashboard.
   The dashboard must show the user's own `wallet_id` prominently with a copy-to-clipboard
   button — that's how users receive transfers. Add a "Top up (demo)" button → `/wallet/mint`.
3. **Transfer** — `/wallet/lookup/:id` + `/transfer`. Page: send flow. UX flow: user pastes
   a wallet_id → **lookup shows "Sending to @username"** → user confirms → POST /transfer.
   **Always send an `idempotency_key`** (generate a UUID when the user opens the form, reuse it on retry).
4. **Marketplace** — `GET /marketplace/listings` (public), `POST /marketplace/listings`,
   `/:id/buy`, `/:id/cancel`. Pages: market feed, create-listing form, my-listings.
   Show `price_per_token` and computed total cost (`amount × price_per_token`).
5. **AI** — `/ai/generate`, `/ai/usage`. Pages: playground, usage history.
   Model picker from the fixed list in API.md; show `tokens` + `billing.cost` after each call.

## Known backend limitations to design around

- **Marketplace is token-for-token**: prices are in credits per token (a `price_per_token`
  of 0.5 means the buyer pays 0.5 credits per token received). No separate "cash" currency.
- **Whole-lot purchases only** — no partial fills. Buy button buys the entire listing amount.
- **Escrow UX**: creating a listing immediately removes `amount` from the seller's balance
  (escrow). The balance shown on the dashboard is *available* balance. Cancelling returns it.
- **409 on races**: another user can buy a listing between page load and click — handle
  409 `"Listing is no longer available"` gracefully (refresh the feed).
- **Money is decimal strings** (`"12.50000000"`) — never parse as float; format for display.
- **Mint is demo-only**, capped at 10,000 per call — fine to expose as a "Top up" button.
- **AI models are fixed** (three local Ollama models listed in API.md); unknown model → 400.
  402 = top up and retry; 502 = provider issue, refund already applied automatically.
- **No pagination on /wallet** (single object). Marketplace, usage, and transfers-of-record
  support `limit`/`offset`.
- **Transfers identify recipients by `wallet_id` only** — no email/username search. The
  lookup endpoint exists specifically for the confirm-before-send UX.
