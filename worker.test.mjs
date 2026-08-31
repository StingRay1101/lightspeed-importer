// Contract tests for worker.js against a mocked Shopify Admin API.
// Run with:  node worker.test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'worker.js'), 'utf8');
const tmp = path.join(process.env.TEMP || '.', 'worker.smoke.mjs');
fs.writeFileSync(tmp, src);
const worker = (await import('file://' + tmp.replace(/\\/g, '/'))).default;

// Dev Dashboard credentials: the worker must exchange these for a 24h token.
const env = {
  PORTAL_PASSWORD: 'pw',
  SHOPIFY_STORE: 'test.myshopify.com',
  SHOPIFY_CLIENT_ID: 'client-id',
  SHOPIFY_CLIENT_SECRET: 'client-secret',
};

const calls = [];
const tokenRequests = [];
let authHeaders = [];

globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/admin/oauth/access_token')) {
    tokenRequests.push(Object.fromEntries(new URLSearchParams(opts.body)));
    return new Response(
      JSON.stringify({ access_token: 'shpua_issued', scope: 'write_products', expires_in: 86399 }),
      { status: 200 }
    );
  }
  authHeaders.push(opts.headers['X-Shopify-Access-Token']);
  const body = JSON.parse(opts.body);
  const q = body.query;
  calls.push({ query: q, variables: body.variables });

  const reply = d => new Response(JSON.stringify({ data: d }), { status: 200 });

  if (q.includes('query ReferenceData')) {
    return reply({
      shop: { name: 'Imagine Fashion', currencyCode: 'AUD' },
      productTypes: { edges: [{ node: 'Dresses' }, { node: 'Tops' }] },
      productVendors: { edges: [{ node: 'Zaffiro' }] },
      locations: {
        nodes: [
          { id: 'gid://shopify/Location/1', name: 'Harbour Town', isActive: true },
          { id: 'gid://shopify/Location/2', name: 'Pacific Fair', isActive: true },
          { id: 'gid://shopify/Location/3', name: 'Southport Showroom', isActive: true },
          { id: 'gid://shopify/Location/4', name: 'Southport Warehouse', isActive: true },
        ],
      },
      publications: { nodes: [{ id: 'gid://shopify/Publication/9', name: 'Online Store' }] },
    });
  }
  if (q.includes('query Suppliers')) {
    return reply({ products: { nodes: [{ metafield: { value: 'Zaffiro' } }, { metafield: null }] } });
  }
  if (q.includes('mutation ProductCreate')) {
    return reply({ productCreate: { product: { id: 'gid://shopify/Product/100', title: body.variables.product.title, handle: 'h', status: body.variables.product.status }, userErrors: [] } });
  }
  if (q.includes('query ProductVariants')) {
    return reply({ product: { variants: { nodes: [{ id: 'gid://shopify/ProductVariant/500', sku: null, inventoryItem: { id: 'gid://shopify/InventoryItem/900' } }] } } });
  }
  if (q.includes('mutation VariantsCreate')) {
    return reply({ productVariantsBulkCreate: {
      productVariants: body.variables.variants.map((v, i) => ({
        id: 'gid://shopify/ProductVariant/' + (600 + i),
        sku: v.inventoryItem.sku,
        inventoryItem: { id: 'gid://shopify/InventoryItem/' + (700 + i) },
        selectedOptions: v.optionValues.map(o => ({ name: o.optionName, value: o.name })),
      })), userErrors: [] } });
  }
  if (q.includes('mutation VariantsUpdate')) {
    return reply({ productVariantsBulkUpdate: {
      productVariants: [{ id: 'gid://shopify/ProductVariant/500', sku: body.variables.variants[0].inventoryItem.sku, inventoryItem: { id: 'gid://shopify/InventoryItem/900' } }],
      userErrors: [] } });
  }
  if (q.includes('mutation InventoryActivate')) return reply({ inventoryBulkToggleActivation: { inventoryItem: { id: 'x' }, userErrors: [] } });
  if (q.includes('mutation InventorySet')) return reply({ inventorySetQuantities: { inventoryAdjustmentGroup: { createdAt: 'now' }, userErrors: [] } });
  if (q.includes('mutation Publish')) return reply({ publishablePublish: { userErrors: [] } });

  throw new Error('Unmocked query: ' + q.slice(0, 120));
};

const post = (action, payload) => new Request('https://w.dev', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Portal-Password': 'pw', 'Origin': 'https://importer.imaginefashion.com.au' },
  body: JSON.stringify({ action, payload }),
});

let failures = 0;
const check = (label, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond ? '' : '  <- ' + detail));
  if (!cond) failures++;
};

/* ---------- auth ---------- */
const bad = await worker.fetch(new Request('https://w.dev', {
  method: 'POST', headers: { 'X-Portal-Password': 'wrong' }, body: '{}',
}), env);
check('wrong password rejected with 401', bad.status === 401, bad.status);

/* ---------- token exchange ---------- */
calls.length = 0;
let res = await worker.fetch(post('get_reference_data', {}), env);
let ref = await res.json();
check('client credentials exchanged for a token', tokenRequests.length === 1, tokenRequests.length);
check('grant_type is client_credentials',
  tokenRequests[0]?.grant_type === 'client_credentials', JSON.stringify(tokenRequests[0]));
check('client id and secret sent',
  tokenRequests[0]?.client_id === 'client-id' && tokenRequests[0]?.client_secret === 'client-secret',
  JSON.stringify(tokenRequests[0]));
check('issued token used on API calls',
  authHeaders.length > 0 && authHeaders.every(h => h === 'shpua_issued'), JSON.stringify(authHeaders));

/* ---------- reference data ---------- */
check('reference data returns 200', res.status === 200, res.status);
check('categories come from productTypes', ref.categories?.[0]?.name === 'Dresses', JSON.stringify(ref.categories));
check('brands come from productVendors', ref.brands?.[0]?.name === 'Zaffiro', JSON.stringify(ref.brands));
check('suppliers de-duplicated from metafields', JSON.stringify(ref.suppliers) === '[{"name":"Zaffiro"}]', JSON.stringify(ref.suppliers));
check('all four outlets mapped to locations', ref.outlets.every(o => o.locationId) && ref.outlets.length === 4, JSON.stringify(ref.outlets));
check('no unmatched outlets reported', ref.unmatchedOutlets.length === 0, JSON.stringify(ref.unmatchedOutlets));
check('Online Store publication found', ref.onlineStorePublicationId === 'gid://shopify/Publication/9', ref.onlineStorePublicationId);

const outlets = Object.fromEntries(ref.outlets.map(o => [o.key, o.locationId]));

/* ---------- stale client rejected ---------- */
let out;
calls.length = 0;
res = await worker.fetch(post('sync_product', {
  // old Lightspeed shape: no `contract`, stock under `inventory`
  name: 'Old Tab Product', sku: 'X', retail_price: 10,
  inventory: [{ outlet_id: 'abc', current_amount: 5 }],
}), env);
out = await res.json();
check('stale browser tab refused before creating anything',
  res.status === 502 && /out of date/.test(out.error), JSON.stringify(out));
check('stale request touched Shopify zero times', calls.length === 0, calls.length);

/* ---------- simple product (sample, not online) ---------- */
calls.length = 0;
res = await worker.fetch(post('sync_product', {
  contract: 2,
  name: 'Top Sample - 4821', sku: 'IF-TOP-001',
  retail_price: 129.95, supply_price: 40,
  brand_name: 'Zaffiro', type_name: 'Tops',
  supplier_name: 'Zaffiro', supplier_code: 'SUP-001',
  tags: ['sample'], sell_online: false, online_publication_id: 'gid://shopify/Publication/9',
  outlets, stock: { ht: 1, pf: 2, ss: 0, sw: 3 },
}), env);
out = await res.json();
check('simple product syncs', res.status === 200 && out.data?.id, JSON.stringify(out));

const createVars = calls.find(c => c.query.includes('ProductCreate')).variables.product;
check('not-online product is DRAFT', createVars.status === 'DRAFT', createVars.status);
check('vendor set from brand', createVars.vendor === 'Zaffiro', createVars.vendor);
check('productType set from category', createVars.productType === 'Tops', createVars.productType);
check('supplier metafields attached', createVars.metafields.length === 2
  && createVars.metafields[0].key === 'supplier'
  && createVars.metafields[1].key === 'supplier_code', JSON.stringify(createVars.metafields));
check('simple product declares no options', createVars.productOptions === undefined, JSON.stringify(createVars.productOptions));

const upd = calls.find(c => c.query.includes('VariantsUpdate')).variables.variants[0];
check('sku lands on inventoryItem', upd.inventoryItem.sku === 'IF-TOP-001', JSON.stringify(upd.inventoryItem));
check('supply price becomes unit cost', upd.inventoryItem.cost === '40.00', upd.inventoryItem.cost);
check('retail price formatted', upd.price === '129.95', upd.price);
check('variant is taxable (GST)', upd.taxable === true, upd.taxable);
check('inventory tracked', upd.inventoryItem.tracked === true, upd.inventoryItem.tracked);

const invSet = calls.find(c => c.query.includes('InventorySet')).variables.input;
check('stock set at all 4 locations', invSet.quantities.length === 4, invSet.quantities.length);
check('stock quantities correct', JSON.stringify(invSet.quantities.map(q => q.quantity)) === '[1,2,0,3]', JSON.stringify(invSet.quantities));
check('draft product not published', !calls.some(c => c.query.includes('Publish')), 'publish was called');

/* ---------- variant product (stocked, online) ---------- */
calls.length = 0;
res = await worker.fetch(post('sync_variant_product', {
  contract: 2,
  name: 'Black Wrap Dress', colour: 'Black',
  brand_name: 'Zaffiro', type_name: 'Dresses',
  supply_price: 55, supplier_name: 'Zaffiro', supplier_code: 'SUP-002',
  tags: ['occasion: work', 'fabric: linen'],
  sell_online: true, online_publication_id: 'gid://shopify/Publication/9',
  outlets,
  variants: [
    { size: 'S', sku: 'IF-DR-9-S', retail_price: 249, stock: { ht: 1, pf: 0, ss: 2, sw: 5 } },
    { size: 'M', sku: 'IF-DR-9-M', retail_price: 249, stock: { ht: 3, pf: 1, ss: 0, sw: 4 } },
    { size: 'L', sku: 'IF-DR-9-L', retail_price: 249, stock: { ht: 0, pf: 0, ss: 0, sw: 0 } },
  ],
}), env);
out = await res.json();
check('variant product syncs', res.status === 200 && out.data?.id, JSON.stringify(out));

const vCreate = calls.find(c => c.query.includes('ProductCreate')).variables.product;
check('online product is still DRAFT', vCreate.status === 'DRAFT', vCreate.status);
check('two options declared', vCreate.productOptions.length === 2, JSON.stringify(vCreate.productOptions));
check('Colour option is single-valued', vCreate.productOptions[0].name === 'Colour'
  && vCreate.productOptions[0].values.length === 1, JSON.stringify(vCreate.productOptions[0]));
check('Size option carries all sizes', vCreate.productOptions[1].name === 'Size'
  && JSON.stringify(vCreate.productOptions[1].values.map(v => v.name)) === '["S","M","L"]', JSON.stringify(vCreate.productOptions[1]));
check('structured tags passed through', JSON.stringify(vCreate.tags) === '["occasion: work","fabric: linen"]', JSON.stringify(vCreate.tags));

const bulk = calls.find(c => c.query.includes('VariantsCreate')).variables.variants;
check('one variant per size', bulk.length === 3, bulk.length);
check('each variant maps Colour + Size', bulk.every(v => v.optionValues.length === 2
  && v.optionValues[0].optionName === 'Colour' && v.optionValues[1].optionName === 'Size'), JSON.stringify(bulk[0].optionValues));
check('per-size SKUs preserved', JSON.stringify(bulk.map(v => v.inventoryItem.sku)) === '["IF-DR-9-S","IF-DR-9-M","IF-DR-9-L"]', JSON.stringify(bulk.map(v => v.inventoryItem.sku)));

const vInv = calls.find(c => c.query.includes('InventorySet')).variables.input;
check('3 sizes x 4 locations = 12 stock rows', vInv.quantities.length === 12, vInv.quantities.length);
check('stock matched to correct size by SKU',
  JSON.stringify(vInv.quantities.slice(0, 4).map(q => q.quantity)) === '[1,0,2,5]'
  && JSON.stringify(vInv.quantities.slice(4, 8).map(q => q.quantity)) === '[3,1,0,4]', JSON.stringify(vInv.quantities.map(q => q.quantity)));
check('activation called once per variant',
  calls.filter(c => c.query.includes('InventoryActivate')).length === 3,
  calls.filter(c => c.query.includes('InventoryActivate')).length);
check('online product published to Online Store', calls.some(c => c.query.includes('Publish')), 'publish not called');

/* ---------- error surfacing ---------- */
calls.length = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({
  data: { productCreate: { product: null, userErrors: [{ field: ['title'], message: 'Title is required' }] } },
}), { status: 200 });
res = await worker.fetch(post('sync_product', { contract: 2, name: '', outlets, stock: {} }), env);
out = await res.json();
check('Shopify userErrors surface as readable message',
  res.status === 502 && /Title is required/.test(out.error), JSON.stringify(out));
globalThis.fetch = realFetch;

/* ---------- token caching and refresh ---------- */
const before = tokenRequests.length;
await worker.fetch(post('get_reference_data', {}), env);
check('cached token reused instead of re-exchanged', tokenRequests.length === before, tokenRequests.length - before);

// A revoked token should be dropped and re-fetched once, not surfaced as an error.
let issuedCalls = 0;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/admin/oauth/access_token')) {
    tokenRequests.push({ refreshed: true });
    return new Response(JSON.stringify({ access_token: 'shpua_fresh', expires_in: 86399 }), { status: 200 });
  }
  issuedCalls++;
  if (issuedCalls === 1) return new Response('unauthorised', { status: 401 });
  return new Response(JSON.stringify({ data: { shop: { name: 'S', currencyCode: 'AUD' },
    productTypes: { edges: [] }, productVendors: { edges: [] },
    locations: { nodes: [] }, publications: { nodes: [] } } }), { status: 200 });
};
const refreshedBefore = tokenRequests.length;
res = await worker.fetch(post('get_reference_data', {}), env);
check('401 triggers one token refresh and retry',
  res.status === 200 && tokenRequests.length === refreshedBefore + 1,
  `status ${res.status}, refreshes ${tokenRequests.length - refreshedBefore}`);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
