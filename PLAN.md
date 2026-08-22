# PLAN.md

Cartward build plan, scope rulings, and feature accept/reject log.

## Mission

A complete demonstration e-commerce application — auth, catalogue, cart, sandbox payments,
order lifecycle, admin panel — for developers who want a realistic reference implementation
of a working storefront, not a toy tutorial app. Sandbox payments only; never production-hardened.

## Stack ruling

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 20+ / Express 4 | Ubiquitous, readable reference code |
| Database | SQLite via better-sqlite3 (WAL) | Synchronous transactions make atomic stock reservation demonstrable; zero external services |
| Full-text search | SQLite FTS5 | In-process, no extra infra |
| Passwords | @node-rs/argon2 — Argon2id m=19456 KiB, t=2, p=1 (OWASP minimum) | Vetted algorithm at recommended parameters |
| TOTP | otpauth | Vetted RFC 6238 implementation |
| Webhook signatures | Node crypto HMAC-SHA256, timing-safe compare | Standard primitive, not hand-rolled |
| Sessions | Opaque 256-bit CSPRNG tokens (crypto.randomBytes), SHA-256 hashed at rest, DB-backed | Same construction as vetted session libs; nothing invented |
| Templates | EJS, server-rendered | No client build step; CSP stays strict |
| Validation | zod | Vetted schema validation with good error messages |
| Tests | node:test + supertest | Zero-dependency runner shipped with Node |

Money is integer minor units (cents) end to end. Never floats.

## Milestones / releases

- **v0.1.0** — register → login → browse/search → cart → guest merge → checkout → mock payment (incl. decline) → order appears in history; admin can see it. Concurrency + idempotency tests green.
- **v0.2.0** — admin panel complete: product/variant CRUD, image upload, inventory audit trail, refunds, customer lookup, dashboard, order search/export.
- **v0.3.0** — discount codes, dev mailbox viewer, health endpoints, structured logs, order event timeline, trust pages, theme work complete.
- **v1.0.0** — clean independent security audit, design audit, full regression from clean clone; AUDIT.md zero findings.

## Feature rulings

Accepted items become first-class FEATURES under the same loop and audit as core scope.

### Accepted

| Feature | Size | Reason |
| --- | --- | --- |
| Customer order history with status timeline | M | Completes the end-to-end story; state machine deserves a shopper-facing surface |
| Guest order tracking (order # + email) | S | Most demo purchases are guests; post-purchase visibility expected |
| Multiple images per product + gallery | M | Catalogue realism; alt-text accessibility win |
| Stock signals surfaced honestly (out-of-stock disabled, low-stock badge only when literally true) | S | Inventory data already exists; missing shopper-facing half |
| Payment-decline recovery (human-readable reason, retry preserving cart) | S | Without it the decline demo looks broken instead of trustworthy |
| Delivery estimates per shipping method | S | Cheapest trust signal; presentation over existing rule metadata |
| Shopper-initiated cancellation while pending | S | Expected self-service; exercises state machine from customer side |
| Empty/loading/error/no-results state system | S | Prevents brittle-feeling demo; required by DESIGN.md |
| Inline form validation with humane copy | S | Surfacing per-field validation is what makes checkout feel safe |
| Static trust pages (about, contact, shipping & returns) | S | What small independents actually have; pure content |
| Discount codes (percent/fixed, expiry, valid/invalid/expired states) | M | Exercises the pricing-rule seam; capped scope, no budgets/stacking |
| Admin order search + CSV export | M | First thing an operator reaches for; thin layer over existing tables |
| Order event timeline incl. stuck-order explainer (payment timeout, duplicate webhook ignored) | M | Flagship operational-honesty feature showcasing the mock failure modes |
| Audit trail extended beyond inventory (logins, product edits, refunds, overrides) | M | Reuses the audit pattern; proves the state machine isn't silently bypassable |
| Health/readiness endpoints (`/healthz`, `/readyz`) | S | Tiny, standard, honest deploy-readiness semantics |
| Structured logs with request IDs | S | Makes idempotency/webhook-duplicate stories traceable |
| Scenario-rich one-command seed | M | The repo's entire first impression; every admin screen demos something |
| Test ergonomics kit (factories, frozen clock, payment-scenario harness) | M | Reference implementations live or die on clone→test-green |
| Dev mailbox viewer (admin-only, lists captured emails) | S | Turns disk-capture from a folder of files into a demonstrable loop |
| Limited admin keyboard shortcuts (`/` focuses search, Esc closes dialogs) | S | Cheap operator win; documented in admin footer |

### Rejected

| Feature | Reason |
| --- | --- |
| Customer-written reviews + moderation queue | Moderation pipeline is a second product; seeded display reviews would read as fake social proof |
| "You may also like" cross-sell module | Recommendation engine — banned second product |
| Wishlist | Isolated entity with no interplay with checkout, stock, or orders; demo value ≈ 0 |
| Cart reservation countdown timer | Manufactures urgency; contradicts reserve-at-order-creation design |
| Command palette / vim-style admin navigation | Drifts toward an admin-framework side product; fails the storefront-value test |
| Onboarding wizard / setup checklist | `/readyz` plus scenario-rich seed make it redundant |
| Standalone docs pack (architecture guide, plugin guide) | README architecture note carries it; separate guides rot |
| Multi-vendor, subscriptions, multi-currency i18n tax, live carriers, real payments | Banned second products, non-negotiable |

## Build loop protocol

Per feature: implement → run → test → fix → commit → push. Done means the full purchase
flow passes through it. Each improvement round must name the concrete defect it fixes;
after 6 consecutive rounds with no new named defect, log in BLOCKERS.md and move on.
Regression gate: any change touching pricing, tax, stock, or order state re-runs those
suites plus a full purchase (including declined payment and cancellation) before acceptance.
