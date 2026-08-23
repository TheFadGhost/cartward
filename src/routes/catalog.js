import { Router } from 'express';
import { listProducts, getProductBySlug, listCategories, popularTags, PER_PAGE } from '../services/catalog.js';

const router = Router();

function parseListQuery(query) {
  const page = Math.max(1, Math.trunc(Number(query.page)) || 1);
  const sort = ['relevance', 'newest', 'price_asc', 'price_desc', 'name'].includes(query.sort)
    ? query.sort : 'newest';
  const minPriceRaw = Number(query.min_price);
  const maxPriceRaw = Number(query.max_price);
  return {
    q: typeof query.q === 'string' ? query.q.slice(0, 120) : '',
    category: typeof query.category === 'string' ? query.category.slice(0, 90) : '',
    tag: typeof query.tag === 'string' ? query.tag.slice(0, 90) : '',
    sort: query.q && !query.sort ? 'relevance' : sort,
    inStockOnly: query.in_stock === '1',
    minPrice: Number.isFinite(minPriceRaw) && minPriceRaw >= 0 ? Math.round(minPriceRaw * 100) : null,
    maxPrice: Number.isFinite(maxPriceRaw) && maxPriceRaw > 0 ? Math.round(maxPriceRaw * 100) : null,
    page,
  };
}

function buildQueryString(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v !== null && v !== undefined && v !== false) usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

router.get('/', (req, res) => {
  const parsed = parseListQuery(req.query);
  const result = listProducts(parsed);
  const categories = listCategories();
  const tags = popularTags();

  // Pagination window preserving filters.
  const baseParams = { ...parsed, page: undefined };
  const pageUrl = (p) => '/' + buildQueryString({ ...baseParams, page: p });

  res.render('products/index', {
    title: parsed.q ? `“${parsed.q}” — search results` : 'Shop',
    ...parsed,
    result,
    categories,
    tags,
    pageUrl,
    activeCategory: categories.find((c) => c.slug === parsed.category) ?? null,
    hasFilters: !!(parsed.q || parsed.category || parsed.tag || parsed.inStockOnly || parsed.minPrice || parsed.maxPrice),
  });
});

router.get('/products/:slug', (req, res, next) => {
  try {
    const product = getProductBySlug(req.params.slug);
    if (!product || product.status !== 'active') {
      return res.status(404).render('error', {
        title: 'Product not found',
        message: "That product isn't in the shop (or is no longer available).",
        statusCode: 404,
      });
    }
    return res.render('products/show', {
      title: product.name,
      product,
      csrfToken: req.csrfToken(),
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/about', (req, res) => {
  res.render('about', { title: 'About' });
});

router.get('/shipping-returns', (req, res) => {
  res.render('shipping-returns', { title: 'Shipping & returns' });
});

router.get('/contact', (req, res) => {
  res.render('contact', { title: 'Contact' });
});

export default router;
