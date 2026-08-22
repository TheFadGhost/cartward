-- Core identity, catalogue, cart, orders, payments, audit schema.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
  email_verified_at INTEGER,
  totp_secret_enc BLOB,
  totp_enabled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                -- sha256 hex of the opaque session token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  awaiting_2fa INTEGER NOT NULL DEFAULT 0,  -- password OK, TOTP challenge outstanding
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('email_verify', 'password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_vt_user_purpose ON verification_tokens(user_id, purpose);

CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_recovery_user ON recovery_codes(user_id);

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,            -- e.g. login:ip:1.2.3.4:w:<windowIndex>
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL,
  category_id TEXT NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_status ON products(status);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE product_tags (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, tag_id)
);

CREATE TABLE variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL UNIQUE,
  option_size TEXT,
  option_colour TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= stock),
  backorderable INTEGER NOT NULL DEFAULT 0,
  weight_grams INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_variants_product ON variants(product_id);

CREATE TABLE product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  alt_text TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_images_product ON product_images(product_id);

CREATE VIRTUAL TABLE products_fts USING fts5(
  product_id UNINDEXED,
  name,
  description,
  brand,
  category,
  tags
);

CREATE TABLE carts (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  cookie_token_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted', 'abandoned')),
  idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_carts_user ON carts(user_id);
CREATE INDEX idx_carts_expiry ON carts(expires_at);

CREATE TABLE cart_items (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_snapshot_cents INTEGER NOT NULL CHECK (unit_price_snapshot_cents >= 0),
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (cart_id, variant_id)
);

CREATE TABLE discount_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value INTEGER NOT NULL CHECK (value > 0),
  min_subtotal_cents INTEGER NOT NULL DEFAULT 0,
  starts_at INTEGER,
  expires_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  guest_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'fulfilled', 'shipped', 'cancelled', 'refunded')),
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  shipping_cents INTEGER NOT NULL CHECK (shipping_cents >= 0),
  tax_cents INTEGER NOT NULL CHECK (tax_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  refund_total_cents INTEGER NOT NULL DEFAULT 0 CHECK (refund_total_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  shipping_method TEXT NOT NULL,
  shipping_address_json TEXT NOT NULL,
  discount_code_id TEXT REFERENCES discount_codes(id) ON DELETE SET NULL,
  idempotency_key TEXT UNIQUE,
  placed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_placed ON orders(placed_at);

CREATE TABLE order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id),
  product_name TEXT NOT NULL,
  variant_label TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0)
);
CREATE INDEX idx_lines_order ON order_lines(order_id);

CREATE TABLE order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail TEXT,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_order ON order_events(order_id, created_at);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'committed', 'released')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_reservations_order ON reservations(order_id);
CREATE INDEX idx_reservations_expiry ON reservations(status, expires_at);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_ref TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('requires_action', 'processing', 'succeeded', 'failed', 'refunded', 'partially_refunded')),
  scenario TEXT,
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_payments_order ON payments(order_id);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,               -- provider event id
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature_valid INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  process_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE (provider, id)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'customer', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_time ON audit_log(created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

CREATE TABLE emails_out (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  template TEXT NOT NULL,
  filename TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
