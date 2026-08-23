# AUDIT.md

Independent audits performed before v1.0.0 by agents that wrote none of the code:
a security review (OWASP-focused), a code-quality review, and a design/accessibility
review. Every finding is listed below with its disposition. "Fixed" means a code
change landed and the full test suite (91 tests) plus the live end-to-end purchase
script (`scripts/e2e-check.mjs`) were re-run green afterwards.

## Security audit — findings

| # | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| S1 | medium | Raw card-number input persisted in `payments.scenario`, contradicting "never stored" promises | **Fixed** — only a scenario label is stored; digits never leave memory |
| S2 | medium | `trust proxy` set unconditionally → spoofable `X-Forwarded-For` weakened every IP-keyed rate limiter when deployed without a proxy | **Fixed** — enabled only via explicit `TRUST_PROXY=1` |
| S3 | medium | Webhook redelivery of a received-but-unprocessed event was acked as duplicate forever, dropping payment confirmations | **Fixed** — duplicates of unprocessed events are reprocessed; genuinely processed ones still dedupe |
| S4 | medium | CSV export vulnerable to spreadsheet formula injection (=,+,-,@ prefixes) from customer-controlled fields | **Fixed** — dangerous leading characters neutralised |
| S5 | low | CSRF token accepted from query string for uploads put live secrets in URLs | **Fixed** — replaced by time-bound upload tickets bound to the session (~10 min validity) |
| S6 | low | Uploaded SVGs served inline; scripts blocked only by app CSP | **Fixed (accepted residual)** — SVGs are admin-only uploads behind magic-byte checks; media route serves same-origin only under strict CSP. Documented rather than adding a sanitizer dependency for an admin-only surface |
| S7 | low | Seeded admin credentials committed in source | **Accepted with guardrails** — demo convenience documented in README ("change after first login"); `--fresh` seeding now refuses to run in production without `ALLOW_SEED_IN_PROD=1` |
| S8 | low | Registration revealed "email already exists" (enumeration) | **Fixed** — registration responds identically either way; existing owners get a notification email |
| S9 | low | No rate limit on sandbox payment submission → unbounded payments rows / webhook fan-out | **Fixed** — 20 attempts / 10 min per IP+order |
| S10 | low | Guest order redirect leaked customer email into URL | **Fixed** — tracking page asks for the email instead |
| S11 | low | `/readyz` returned raw error messages (filesystem paths) | **Fixed** — generic public body; details logged server-side |
| S12 | info | Single session secret derives all keyed purposes | **Accepted** — every purpose uses a distinct labelled HMAC/scrypt derivation (CSRF, poll tokens, webhook signing, TOTP key); documented here as intentional |
| S13 | info | Payment-status poll token never expired | **Fixed** — tokens are time-bucketed (10-minute windows, current or previous accepted) |

## Code quality audit — findings

| # | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| Q1 | high | Refund amounts double-counted (provider incremented `refunded_cents`, webhook added again) | **Fixed** — webhook is the sole writer; partial refunds now handled honestly (order stays open until cumulative refunds cover the total) |
| Q2 | high | Async route handlers without try/catch could crash the process on unexpected throws | **Fixed** — wrapped with next(err) |
| Q3 | medium | Unbounded in-memory Map for per-account resend throttling | **Fixed** — moved onto the shared DB-backed rate limiter |
| Q4 | medium | SKU generator restarted from a random offset → UNIQUE collisions → 500s | **Fixed** — sequence continues from the database maximum |
| Q5 | medium | Prepared statements recreated per request in hot paths | **Fixed** — hoisted to module scope |
| Q6 | medium | `/readyz` checked the wrong (CWD-relative) mail directory | **Fixed** — uses the configured path |
| Q7 | medium | Tests weaker than their names (tautological assertions, no-op waits, clamp not verified) | **Fixed** — assertions strengthened: typed transition errors, clamped quantity + flash asserted, decline wait polls real state change |
| Q8 | low | Dead exports/fragments across six files (`getSessionById`, `promoteSession`, `txImmediate`, `resetRateLimits`, `getActiveProviderName`, `sum`, catalog default export, unused imports, voided locals) | **Fixed** — removed |
| Q9 | low | Duplicated logic: price parsing, slug generation, brand upsert, order-email resolution, decline-reason text | **Fixed** — single shared helpers now |
| Q10 | low | Redundant queries in customer detail rendering | **Fixed** |
| Q11 | low | Raw driver error messages flashed to users on cancel/transition failures | **Fixed** — generic user copy; details logged |
| Q12 | low | Mojibake in seeded product descriptions and alt text (double-encoded em dashes) | **Fixed** — repaired and byte-verified clean |
| Q13 | low | Email field lacked max length; guest tracking errors returned HTTP 404 for validation failures | **Fixed** — `.max(254)`; tracking now returns 422 on invalid input |
| Q14 | nit | Mid-file import, ignored render options, dead config keys, order-number modulo bias, dangling commas | **Fixed** |

## Design & accessibility audit — findings

Contrast was recomputed independently: every claimed pair passes AA in light,
dark and high-contrast themes (ink/paper 16.0:1, muted/paper 6.4:1, accent-ink/accent 7.7:1;
dark-theme pairs 6.6–14.8:1). One failure found and fixed.

| # | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| D1 | high | High-contrast admin theme could never activate (attribute mismatch between selector and where themes are set) | **Fixed** — surface marker moved to `<html>`; selector corrected |
| D2 | high | 16 inline `style=""` attributes across 8 templates silently blocked by the shipped CSP | **Fixed** — all moved to utility classes; templates are CSP-clean |
| D3 | high | Theme script read the surface off `<body>` before it existed, collapsing both surfaces onto one storage key | **Fixed** — surface read from `<html>` |
| D4 | medium | Escaped-quote CSS selectors meant the current checkout step never highlighted | **Fixed** |
| D5 | medium | Category counts rendered at ~1.7:1 contrast | **Fixed** — muted ink token (6.4:1) |
| D6 | medium | No loading skeletons anywhere; 500 page had no retry affordance | **Fixed** — skeleton utility shipped (server-rendered pages are inherently complete on arrival; polling UI uses it), 500 page offers retry |
| D7 | medium | Pay/place buttons didn't disable after submit (double-click UX; server dedupe existed but feedback didn't) | **Fixed** — progressive-enhancement submit disabling |
| D8 | medium | Sortable columns lacked `aria-sort` and direction toggling | **Fixed** — full sort contract on admin orders table |
| D9 | medium | Touch targets < 44px at mobile widths (nav links, tag pills, pagination) | **Fixed** — mobile media query raises targets |
| D10 | medium | Gallery thumbnails were dead fragment links | **Fixed** — keyboard-operable buttons swap the main image with updated alt text |
| D11 | medium | DESIGN.md promised bulk actions that didn't exist | **Fixed** — checkbox bulk archive/activate with live selection count on admin products |
| D12 | low | paid/shipped status pills pixel-identical (lightness claim false) | **Fixed** — distinct hue families per state (amber/green/neutral/blue/red) while labels remain the carrier |
| D13 | low | Unstyled classes rendering browser defaults (.hero/.prose/.recovery-codes etc.) | **Fixed** — styled |
| D14 | low | Hardcoded artboard colour violated token-only rule | **Fixed** — `--artboard` token, intentionally constant across themes and documented |
| D15 | low | OS preference persisted to localStorage on first visit, breaking system-follow | **Fixed** — unsaved preference keeps following the OS |
| D16 | low | Address form error summary not focused; forgot-form error not associated | **Fixed** |
| D17 | low | Admin empty states lacked query echo/filter reset | **Fixed** on orders/products tables |
| D18 | low | Invisible-but-focusable "all categories" radio | **Fixed** — visible choice |
| D19 | nit | Theme toggle had no state; grid spec drift; dashboard pill semantics; CSP `data:` grant unused | **Fixed** |

## Accepted scope rulings (not defects)

- No discount redemption budgets/counters — explicitly excluded during planning
  (see PLAN.md); codes are validated for existence, activity, window and minimum.
- Seeded reviews/social proof deliberately absent (fake-social-proof ban).
- SVG sanitizer dependency not added: uploads are restricted to admins, validated,
  served same-origin under strict CSP; risk accepted and documented.

## Final verification

- Full suite: **91 tests, 91 passing** (`npm test`).
- Live end-to-end purchase (register → verify → browse → cart → checkout incl. tax/discount
  paths → declined payment → retry → paid → history): **12/12 steps**.
- Admin surface smoke check over seeded data (dashboard, orders incl. detail, products incl.
  detail, customers incl. detail, audit log, mailbox): **all OK**.
- Concurrency harness (multi-worker contention for last unit): exactly-one-winner and
  exact-sell-count invariants hold; no overselling.
