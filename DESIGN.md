# DESIGN.md

Cartward's design system: two surfaces with different jobs, built from one token set.

**Point of view.** The storefront should feel like a considered independent shop — restrained,
product-forward, editorial. Warm paper neutrals, ink text, hairline rules, generous whitespace,
a single deep-moss accent, serif display type for voice and a workmanlike sans for UI. Products
do the talking; the chrome stays quiet and honest. The admin is a different room entirely: a
serious internal tool — dense tables, compact controls, functional color used only for state,
no decoration. We reject the generic bootstrap-shop look and the neon startup look with equal
force: no purple-blue gradients, no glassmorphism, no emoji as icons or category markers, no
default framework indigo, no drop shadows on every card (hairline borders instead), no stock
photos of models, no countdown timers, no animated count-ups on money, no fake urgency ("only
2 left!" appears only when inventory literally says so) and no fake social proof.

## Surfaces

1. **Storefront** (shopper): catalogue, product detail, cart, checkout, account, order history.
   Job: make products look good and make checkout feel trustworthy through clarity.
2. **Admin** (operator): dashboard, products, inventory, orders, customers, audit log.
   Job: dense, fast, scannable.

## Typography

System stacks only — keeps CSP strict (`script-src 'self'`), works offline, no font-loading reflow.

- Display (storefront headings): `Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif`
- UI/body (both surfaces): `-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`

| Token | Storefront | Admin |
| --- | --- | --- |
| Base size | 16px | 13px |
| Scale | 14 / 16 / 18 / 22 / 28 / 38 / 50 | 11 / 12 / 13 / 15 / 18 / 24 |
| Line height body | 1.6 | 1.45 |

## Spacing

4px grid. Storefront steps: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96.
Admin is tighter: 2 / 4 / 8 / 12 / 16 / 20 / 24 / 32.

## Colour tokens

Themes are **pure token overrides**: `[data-theme="dark"]` etc. swap variable values; components
never hardcode colours. Storefront ships light + dark (system-preference default, manual toggle).
Admin ships light + dark + high-contrast. Theme is applied by a synchronous first-in-head script
(`/js/theme.js`) before first paint — no flash of the wrong theme.

Roles (light values shown; each theme overrides):

| Token role | Light | Purpose |
| --- | --- | --- |
| `--paper` | `#faf7f2` warm paper | Page background |
| `--surface` | `#ffffff` | Cards, panels |
| `--ink` | `#1f1b16` | Primary text (≥ 12.9:1 on paper) |
| `--ink-muted` | `#63594c` | Metadata, captions (≥ 4.9:1) |
| `--line` | `#e4ddd2` | Hairline borders |
| `--accent` | `#3f5a3c` deep moss | Links, primary buttons, focus |
| `--accent-ink` | `#ffffff` | Text on accent (5.7:1) |
| `--danger`/`-bg` | `#a13333` / `#fbeeee` ≥4.5:1 | Errors, declined payment |
| `--warn`/`-bg` | `#8a5a12` / `#fdf3e0` | Low stock (only when literally true), price-change notices |
| `--success`/`-bg` | `#2f6a3f` / `#ecf5ee` | In stock, paid |
| `--info`/`-bg` | `#3d5a66` / `#eaf1f3` | Backorder, fulfilled/shipped |

Dark themes shift to near-black paper (`#171512`), raised surfaces, and re-tuned tints so every
pair still clears AA. High-contrast admin theme: pure black-on-white direction, stronger borders,
no muted greys below AA-large.

**Deuteranopia rule:** status colour is never the sole carrier — every stock/order status renders
as a labelled pill whose text carries the meaning ("Out of stock", "Refunded") with distinct
lightness separation verified between states; hues are reinforcement only.

**Product imagery on dark themes:** every product image is drawn on its own opaque warm-paper
artboard inside a fixed frame — images are never transparent, so a white-background photo never
floats on a dark page. Verified in both storefront themes.

## Price typography

- Money is rendered server-side from integer minor cents via `Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })`.
- All prices use `font-variant-numeric: tabular-nums`; alignment is right-aligned in tables, left in prose contexts but always tabular.
- Prices are static text: no count-up animation ever.
- Tax treatment, stated once per surface: storefront prices exclude tax; checkout itemizes
  subtotal → discount → shipping → estimated tax → total before the pay button.
- Sale presentation: current price + struck original, no percentage theatrics.

## Product imagery

- Aspect ratio policy: all product art is **1:1 square**, enforced by `aspect-ratio: 1` frames;
  nothing reflows while loading because frames reserve space.
- Seeded art is deterministic generated SVG (original abstract compositions per product — clearly
  fictional, no real brands or photography). Admin uploads accept png/jpg/webp/svg with
  magic-byte validation; originals stored under gitignored `data/uploads/`, served via an
  image route that only resolves registered IDs.
- Multiple sizes: image records carry width/height; SVG serves any size crisply, raster
  variants get `srcset` entries when generated sizes exist.
- Alt text pattern: "{Product name} by {brand}" (+ variant context where relevant); decorative
  chrome uses empty alt.

## Storefront patterns

- **Product grid:** responsive auto-fit minmax(240px, 1fr); card = framed image, brand eyebrow
  (small caps), title clamped to 2 lines (full wrap on detail h1), price line tabular, one honest
  stock note if applicable. Card hover lifts border colour, not shadow.
- **Detail page:** gallery left (thumbnails keyboard-operable), buy box right: title, price,
  variant pills, quantity stepper, stock state, add-to-cart. Long titles wrap fully; layout
  reserves space so variant switches don't jump.
- **Variant selection:** real radio inputs styled as pills — keyboard operable, visible focus,
  out-of-stock variants disabled with "(out of stock)" text; backorder variants selectable with
  explicit "Backordered — ships in 2–3 weeks" note.
- **Stock presentation:** pill + label; "Low stock — N left" only when inventory literally ≤ 5.

## Checkout design

Three numbered steps, each its own page segment with persistent summary:

1. **Contact & address** — labels above fields; autocomplete attributes set (`email`, `name`,
   `street-address`, `address-level2`, `address-level1`, `postal-code`, `country`); validation on
   blur + submit (never per keystroke); errors sit directly beneath their field, linked via
   `aria-describedby`, plus an error summary box at top anchored to first invalid field; errors
   announced via `role="alert"`.
2. **Delivery method** — radio list with name, estimate ("3–5 business days"), price; selected by best-value default.
3. **Review & pay** — itemized totals (subtotal, discount, shipping, tax, total), address recap with edit links, sandbox notice stating it's a mock processor with the test-card hint, idempotent submit (button disables after click; server dedupes by key regardless).

The **order summary stays visible** (sticky aside on desktop, collapsed disclosure above the form
on mobile). Trust comes from clarity: plain step names, itemized money, honest sandbox labelling,
visible focus rings, full keyboard path — no trust badges, no seals.

Payment failure returns to step 3 with the provider's human-readable reason inline and the cart intact.

## Admin design

- Density: table rows ~36px, cell padding 8px, base 13px; filters as a left-aligned toolbar row
  above each table with result count right-aligned; bulk actions appear in the same toolbar once
  checkboxes select rows, showing live selection count.
- Tables: numeric columns right-aligned tabular-nums; sortable columns carry `aria-sort` and an
  arrow indicator; column widths stable across refresh (no layout shift); status pills labelled.
- Dashboard: inline-SVG bar chart of orders/day (trailing 30 days) with an accessible data-table
  fallback; revenue convention stated on-screen: net of refunds, cancelled excluded;
  percentile convention: p50/p95 order value over non-cancelled paid+ orders, trailing 30 days;
  chart and axis label contrast ≥ AA in every admin theme.
- Keyboard: `/` focuses the admin search box; `Esc` closes dialogs; shortcuts documented in the footer.

## State matrix (both surfaces)

| State | Storefront | Admin |
| --- | --- | --- |
| Empty | Friendly copy + link back to catalogue ("Your cart is empty") | "No products yet" + create CTA |
| Loading | Skeleton blocks (static under reduced motion) | Skeleton rows matching final geometry |
| Error | Retryable panel with plain-language message | Same, plus request ID for logs |
| No results | Query echo + filter reset link | Filter chips shown active |
| Out of stock | Disabled variant/add button, labelled pill | Red-tinted stock cell, editable anyway |
| Payment failed | Inline reason + retry preserving cart | Order shows failed payment event in timeline |
| No orders | Account page explains + shop link | Empty table state |

## Accessibility contract

- WCAG AA contrast everywhere including muted metadata and chart labels, all themes.
- Every input has a real `<label>`; errors associated programmatically; `aria-live="polite"` for cart updates.
- Entire purchase flow completable by keyboard; focus rings visible on all interactive elements (`:focus-visible`).
- Touch targets ≥ 44px at mobile widths on storefront.
- `prefers-reduced-motion: reduce` disables transforms/animations globally.
- Forms use correct `autocomplete` attributes; admin tables use real `<table>` semantics.
