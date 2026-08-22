-- Checkout draft state lives on the cart row (address + chosen shipping + code).
ALTER TABLE carts ADD COLUMN checkout_address_json TEXT;
ALTER TABLE carts ADD COLUMN checkout_shipping_method TEXT;
ALTER TABLE carts ADD COLUMN checkout_discount_code TEXT;
