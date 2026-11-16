# M-Pesa checkout, done right

A reference M-Pesa STK Push checkout (Safaricom Daraja) that handles what most integrations get wrong.

Most M-Pesa integrations work in the sandbox and break in production, because the sandbox only ever succeeds. Real customers cancel the prompt, mistype their PIN, run out of balance or ignore the prompt. Real callbacks arrive twice, arrive late, or never arrive. This project handles every one of those cases, and ships a **failure simulator** so you can watch it do so.

```
$ npm run demo

scenario            final status  credited  callbacks  why
------------------  ------------  --------  ---------  -------------------------------------------------
success             paid          1         1          The service request is processed successfully.
cancelled           failed        0         1          Cancelled on the phone
timeout             failed        0         1          Phone not reachable or prompt timed out
wrong-pin           failed        0         1          Wrong M-Pesa PIN
insufficient-funds  failed        0         1          Insufficient M-Pesa balance
duplicate-callback  paid          1         3          The service request is processed successfully.
lost-callback       paid          1         0          Paid
late-callback       paid          1         1          Paid
amount-mismatch     review        0         1          Amount mismatch: expected 1000, callback says 999
push-rejected       failed        0         0          STK push rejected: Invalid PhoneNumber

4 order(s) credited, each exactly once. Nothing credited without Safaricom confirming it.
```

## What it guarantees

| Problem in the wild | What this does |
|---|---|
| Customer double-clicks "Pay", or the app retries on a slow network | `Idempotency-Key` on every request: one prompt, one payment row |
| Safaricom sends the same callback several times | A compare-and-set in the database: exactly one callback settles the payment, and the rest are logged as duplicates |
| The callback never arrives (deploy, downtime, network) | A reconciler asks Daraja (STK Query) about anything still pending |
| The callback arrives after the reconciler already settled it | Fills in the M-Pesa receipt number. No second credit |
| Someone POSTs a fake "success" (or a fake "cancelled") to your callback URL | Callbacks are unsigned, so the URL carries a secret and **every callback is confirmed by STK Query** before it counts |
| The browser says "payment done" | Ignored. The frontend polls `GET /payments/:id`, and only the server decides |
| The callback amount differs from the order | Held for human review, never fulfilled |
| The customer pays the same order twice from two prompts | A database constraint allows one paid payment per order. The second goes to review with "refund this one" |
| No answer from Safaricom after 10 minutes | Goes to **review**, not "failed": the customer may have paid |
| Error codes nobody understands | 1032, 1037, 2001 and 1 are mapped to messages a customer can act on |

Every callback is stored verbatim in `callback_log`. That's your audit trail when finance asks "did this customer pay?"

## Run it

Needs Node 24+. There are no runtime dependencies. It uses `node:http`, `node:sqlite` and `node:test`.

```bash
npm install        # dev tools only (TypeScript types)
npm test           # 27 tests, no network, no credentials
npm run demo       # the table above
npm start          # HTTP server on :3000, simulator mode
```

Try the server in simulator mode:

```bash
curl -X POST localhost:3000/payments -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: try-1' -d '{"orderId":"A1","phone":"0712345670","amount":100}'
```

The **last digit of the phone number** picks the simulated outcome:

| Digit | Scenario |
|---|---|
| 0 | success |
| 1 | cancelled (1032) |
| 2 | timeout (1037) |
| 3 | wrong PIN (2001) |
| 4 | insufficient balance (1) |
| 5 | duplicate callback |
| 6 | lost callback |
| 7 | late callback |
| 8 | amount mismatch |
| 9 | STK push rejected |

`POST /simulator/respond/:checkoutRequestId` plays the customer answering on their phone.

## Live mode (Daraja sandbox or production)

Set `MPESA_MODE=sandbox` or `MPESA_MODE=production`. The app then reads `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, `DARAJA_SHORTCODE`, `DARAJA_PASSKEY` and, for a Till, `DARAJA_TILL` from the process environment. Inject them at runtime from your secret manager. Don't keep them in files in the repo. Also set:

- `PUBLIC_BASE_URL`: the HTTPS address Safaricom can reach
- `CALLBACK_TOKEN`: a long random string that becomes part of the callback URL
- `DB_PATH`: where the SQLite file lives

The client never logs request headers or response bodies from the OAuth call.

## API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/payments` | Body `{orderId, phone, amount}`, header `Idempotency-Key`. Sends the STK prompt |
| `GET` | `/payments/:id` | What the frontend polls: `pending`, `paid`, `failed` or `review`, plus a customer-safe message |
| `POST` | `/mpesa/callback/:token` | Safaricom's callback. Always answers `{"ResultCode":0}` so retries stop |
| `GET` | `/health` | Liveness |

## Layout

```
src/payments.ts           the rules: idempotency, verification, settlement, reconciliation
src/store.ts              SQLite schema and the compare-and-set updates
src/daraja/http-client.ts Daraja OAuth (cached), STK Push, STK Query
src/daraja/simulator.ts   the failure simulator
src/server.ts             HTTP layer
test/                     27 tests: every row of the table above has one
```

## Scope

This covers STK Push (Lipa na M-Pesa Online). C2B confirmation and validation, B2C payouts, reversals and Ratiba standing orders are separate Daraja products and are not included. It's a reference implementation: adapt the storage and the `onPaid` hook to your stack.

## Need this in your product?

I integrate M-Pesa and card payments into existing apps (Node, Python/Django, Bubble and others) at fixed prices. Reach me through my GitHub profile.

MIT licensed.
