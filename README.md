# Cartward

A complete demonstration e-commerce application — storefront, checkout with sandbox
payments, order lifecycle and an operator admin panel — built as a realistic reference
implementation for developers.

**This is a demonstration application. Payments run exclusively through a bundled mock
provider: no real payment processor is ever contacted and no card data of any kind is
stored or transmitted. The codebase is not hardened for production use.**

## What it demonstrates

- **Authentication done properly**: Argon2id password hashing (OWASP parameters),
  email verification, single-use expiring password-reset tokens that revoke sessions,
  DB-backed sessions with opaque tokens (hashed at rest), rotation on privilege change,
  optional TOTP two-factor with one-time recovery codes, rate limiting on every
  credential endpoint.
- **Catalogue**: products with variants (size/colour) carrying their own SKU, price and
  stock; categories and tags; FTS5 search with filters, sorting and pagination;
  deterministic generated product artwork (clearly fictional — no real brands).
- **Cart**: guest carts persisted by cookie and merged into the account on login;
  quantity limits enforced against live stock; price snapshots taken at add time with
  a clear notice when prices change at checkout.
- **Checkout**: address validation with per-field errors, pluggable shipping/tax rules,
  discount codes, and idempotent atomic order placement that reserves stock inside the
  same transaction — a double-click or retried request cannot create two orders.
- **Payments (sandbox only)**: provider abstraction plus a mock provider simulating
  success, decline and delayed outcomes. Webhooks are signed (HMAC-SHA256 over the raw
  body with a timestamp), verified timing-safely, and processed idempotently — duplicate,
  out-of-order and replayed deliveries are handled honestly. No real payment credentials
  exist anywhere in the system.
- **Order lifecycle**: pending → paid → fulfilled → shipped, plus cancelled/refunded,
  enforced by a state machine that rejects invalid transitions. Customers can track
  guest orders by number+email and cancel while pending.
- **Inventory correctness**: availability is `stock - reserved`; reservations commit on
  payment success and release on cancellation, payment failure or expiry. A multi-worker
  concurrency harness proves exactly-one-winner semantics on the last unit.
- **Admin panel** (server-side role checks on every route): dashboard with orders/day
  chart and revenue conventions stated on-screen, product/variant CRUD with image upload
  (magic-byte validated) and audited inventory adjustments, order search with CSV export,
  state transitions and webhook-confirmed refunds, customer lookup, audit log, dev
  mailbox viewer for captured emails.
- **Emails**: a capture provider writes RFC 822 messages to disk as `.eml` files. Mail
  is never really sent.

## Run it

Requires Node.js 20+. Everything is local SQLite; there are no external services.

```sh
npm install
npm run seed          # synthetic catalogue + demo accounts (add --fresh to rebuild)
npm start             # http://localhost:3000
```

The first boot generates a strong session secret at `data/.session-secret`
(gitignored). Webhook deliveries target `APP_BASE_URL`, so set it if you change ports:

```sh
APP_BASE_URL=http://localhost:4000 PORT=4000 npm start
```

Run the test suite:

```sh
npm test              # 91 tests incl. concurrency + authorization matrix
```

### Demo accounts (created by the seed)

| Account | Password | Notes |
| --- | --- | --- |
| `admin@cartward.test` | `cartward-admin-demo` | Admin panel at `/admin`. Change this password after first login. |
| `casey@example.test` | `casey-cart-demo-pass` | Customer with seeded order history |

Override with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` before seeding. Re-seeding
(`--fresh`) wipes all data and refuses to run when `NODE_ENV=production` unless
`ALLOW_SEED_IN_PROD=1`.

### Sandbox payment scenarios

At payment, type any 16-digit number. These behave specially (nothing is stored):

| Card number | Behaviour |
| --- | --- |
| `4242 4242 4242 4242` | Approved immediately |
| `4000 0000 0000 0341` | Approves after a long pause (timeout demo) |
| `4000 0000 0000 0002` | Declined — card declined |
| `4000 0000 0000 9995` | Declined — insufficient funds |
| `4000 0000 0000 0069` | Declined — expired card |
| `4000 0000 0000 0010` | Fails after a long pause (timeout demo) |

Checkboxes next to the form let you trigger duplicate deliveries, invalid-signature
webhooks and out-of-order refund notices — the admin order timeline records exactly how
each was handled. Discount codes from the seed: `WELCOME10`, `TAKE5OFF`, and an expired
one (`EXPIRED2024`) to see rejection handling.

## Security measures actually implemented

- Argon2id (m=19456 KiB, t=2, p=1) password hashing; length-over-composition policy
  with a common-password deny-list.
- Opaque 256-bit session tokens stored only as SHA-256 hashes; idle (7d) + absolute
  (30d) expiry enforced server-side; token rotation on login and 2FA completion;
  global revocation on password reset and "sign out everywhere".
- HttpOnly / SameSite=Lax / Secure-in-production cookies.
- CSRF protection on every state-changing request: HMAC-bound synchronizer tokens for
  sessions, signed double-submit for guests, time-bound tickets for multipart uploads.
- Single-use expiring verification/reset tokens hashed at rest; reset revokes all
  sessions; enumeration-safe responses for login, registration and password reset.
- TOTP secrets encrypted at rest (AES-256-GCM); recovery codes hashed and single-use.
- Strict CSP (`script-src 'self'`, no inline styles/scripts anywhere), security headers
  via Helmet, HSTS in production.
- Parameterised SQL throughout; whitelisted sort fragments; sanitized FTS queries;
  EJS output escaped (`<%- %>` used only for partial includes).
- Server-side role checks on every `/admin` route; ownership checks on every
  customer order route; signed, expiring poll tokens.
- Rate limiting (DB-backed fixed windows) on register, login, password reset,
  verification resend, TOTP attempts, order placement, cancellation, tracking and
  payment attempts.
- Webhooks authenticated by timestamped HMAC-SHA256 with replay window, deduplicated
  by event id, reprocessed on redelivery of unprocessed events, with auto-refund when
  settlement lands on a cancelled order.
- Upload validation by magic bytes with size caps, server-generated filenames and
  path-containment checks.
- Full details and the pre-release audit ledger are in [AUDIT.md](AUDIT.md);
  design decisions in [DESIGN.md](DESIGN.md); scope rulings in [PLAN.md](PLAN.md).

## Architecture note

Single-process Express app, server-rendered EJS, better-sqlite3 (WAL mode). Migrations
apply automatically whenever the database opens. Business logic lives in services under
`src/services/`; routes stay thin. Money is integer minor units everywhere — floats are
rejected by the money module. The purchase pipeline is: cart → pricing rules (shipping /
tax / discount plugins) → transactional placement reserving stock → mock payment
provider → signed webhooks → state-machine transitions with inventory commit/release.
Progressive enhancement only: every flow works without JavaScript.

## License

[MIT](LICENSE)
