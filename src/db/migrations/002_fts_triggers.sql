-- Keep the FTS index in sync with product writes.
CREATE TRIGGER IF NOT EXISTS products_ai AFTER INSERT ON products BEGIN
  DELETE FROM products_fts WHERE product_id = NEW.id;
  INSERT INTO products_fts (product_id, name, description, brand, category, tags)
  VALUES (
    NEW.id, NEW.name, NEW.description,
    COALESCE((SELECT name FROM brands WHERE id = NEW.brand_id), ''),
    COALESCE((SELECT name FROM categories WHERE id = NEW.category_id), ''),
    COALESCE((SELECT group_concat(t.name, ' ') FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = NEW.id), '')
  );
END;

CREATE TRIGGER IF NOT EXISTS products_au AFTER UPDATE ON products BEGIN
  DELETE FROM products_fts WHERE product_id = OLD.id;
  INSERT INTO products_fts (product_id, name, description, brand, category, tags)
  VALUES (
    NEW.id, NEW.name, NEW.description,
    COALESCE((SELECT name FROM brands WHERE id = NEW.brand_id), ''),
    COALESCE((SELECT name FROM categories WHERE id = NEW.category_id), ''),
    COALESCE((SELECT group_concat(t.name, ' ') FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = NEW.id), '')
  );
END;

CREATE TRIGGER IF NOT EXISTS products_au_tag AFTER INSERT ON product_tags BEGIN
  DELETE FROM products_fts WHERE product_id = NEW.product_id;
  INSERT INTO products_fts (product_id, name, description, brand, category, tags)
  SELECT NEW.product_id, p.name, p.description,
         COALESCE(b.name, ''),
         COALESCE(c.name, ''),
         COALESCE((SELECT group_concat(t.name, ' ') FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = NEW.product_id), '')
  FROM products p
  LEFT JOIN brands b ON b.id = p.brand_id
  LEFT JOIN categories c ON c.id = p.category_id
  WHERE p.id = NEW.product_id;
END;

CREATE TRIGGER IF NOT EXISTS products_ad AFTER DELETE ON products BEGIN
  DELETE FROM products_fts WHERE product_id = OLD.id;
END;
