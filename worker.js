/**
 * Imagine Fashion — Product Importer worker (Shopify Admin API).
 *
 * Replaces the previous Lightspeed X-Series worker. The action contract the
 * front end speaks is unchanged apart from `create_variant_attribute`, which
 * Shopify does not need (options are declared inline on the product).
 *
 * Required secrets (wrangler secret put <NAME>):
 *   PORTAL_PASSWORD        staff password for the importer
 *   SHOPIFY_STORE          e.g. imagine-fashion.myshopify.com
 *   SHOPIFY_CLIENT_ID      Dev Dashboard app client ID
 *   SHOPIFY_CLIENT_SECRET  Dev Dashboard app client secret
 *
 * A store that still has a pre-2026 admin-created custom app can instead set
 * SHOPIFY_ADMIN_TOKEN to that app's permanent token and omit the id/secret.
 *
 * Required Admin API scopes:
 *   write_products, read_products, write_inventory, read_inventory,
 *   read_locations, write_publications
 */

const API_VERSION = '2026-01';

const ALLOWED_ORIGINS = [
  'https://importer.imaginefashion.com.au',
  'https://stingray1101.github.io',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
];

// Shopify has no "outlet" concept; these map the importer's four fixed stock
// columns onto whatever the store's locations happen to be called. Matching is
// case-insensitive and substring-based so minor renames don't break the sync.
const OUTLET_MATCHERS = [
  { key: 'ht', label: 'Harbour Town',        match: ['harbour town', 'harbourtown'] },
  { key: 'pf', label: 'Pacific Fair',        match: ['pacific fair', 'pacificfair'] },
  { key: 'ss', label: 'Southport Showroom',  match: ['southport showroom', 'showroom'] },
  { key: 'sw', label: 'Southport Warehouse', match: ['southport warehouse', 'warehouse'] },
];

const SUPPLIER_NAMESPACE = 'custom';
const SUPPLIER_KEY = 'supplier';
const SUPPLIER_CODE_KEY = 'supplier_code';

/* ------------------------------------------------------------------ */
/* HTTP plumbing                                                       */
/* ------------------------------------------------------------------ */

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Portal-Password',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

/* ------------------------------------------------------------------ */
/* Shopify Admin GraphQL                                               */
/* ------------------------------------------------------------------ */

class ShopifyError extends Error {}

// Shopify stopped issuing permanent tokens when admin-created custom apps were
// retired on 1 Jan 2026. Dev Dashboard apps exchange a client id and secret for
// a token that lasts 24 hours, so it is fetched on demand and cached in the
// isolate rather than stored as a secret.
let cachedToken = null;

async function getAccessToken(env) {
  // A legacy custom app created before the cutoff still has a permanent token.
  if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;

  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const res = await fetch(`https://${env.SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new ShopifyError(
      `Shopify would not issue an access token (HTTP ${res.status}). Check ` +
      'SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET, and that the app and the ' +
      'store belong to the same Shopify organisation.' +
      (detail ? ` Shopify said: ${detail}` : '')
    );
  }

  const data = await res.json();
  if (!data.access_token) throw new ShopifyError('Shopify returned no access token.');

  // Expire a minute early so a long sync cannot run past the deadline mid-flight.
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(60, (data.expires_in || 86399) - 60) * 1000,
  };
  return cachedToken.value;
}

async function shopify(env, query, variables = {}) {
  const url = `https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`;

  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await getAccessToken(env),
      },
      body: JSON.stringify({ query, variables }),
    });

    // Shopify rate limits with 429, and occasionally 5xx under load.
    if (res.status === 429 || res.status >= 500) {
      lastError = `Shopify returned HTTP ${res.status}`;
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      continue;
    }

    // A cached token can be revoked or expire early; drop it and try once more
    // before giving up.
    if (res.status === 401) {
      cachedToken = null;
      if (attempt === 0 && !env.SHOPIFY_ADMIN_TOKEN) continue;
      throw new ShopifyError('Shopify rejected the access token.');
    }

    if (res.status === 403) {
      throw new ShopifyError(
        'Shopify refused the request. The app is probably missing an access scope — ' +
        'check the scopes on the app version in the Dev Dashboard and approve the change on the store.'
      );
    }

    const payload = await res.json().catch(() => null);
    if (!payload) throw new ShopifyError('Shopify returned a response that was not JSON.');

    if (payload.errors?.length) {
      const throttled = payload.errors.some(e => e.extensions?.code === 'THROTTLED');
      if (throttled && attempt < 3) {
        await new Promise(r => setTimeout(r, 900 * (attempt + 1)));
        continue;
      }
      throw new ShopifyError(payload.errors.map(e => e.message).join('; '));
    }

    return payload.data;
  }

  throw new ShopifyError(lastError || 'Shopify request failed after several retries.');
}

/** Mutations report business-rule failures in `userErrors`, not HTTP status. */
function assertNoUserErrors(result, label) {
  const errs = result?.userErrors || [];
  if (errs.length) {
    const detail = errs
      .map(e => (e.field ? `${[].concat(e.field).join('.')}: ${e.message}` : e.message))
      .join('; ');
    throw new ShopifyError(`${label} failed — ${detail}`);
  }
}

/* ------------------------------------------------------------------ */
/* Reference data                                                      */
/* ------------------------------------------------------------------ */

const REFERENCE_QUERY = `
  query ReferenceData {
    shop { name currencyCode }
    productTypes(first: 250) { edges { node } }
    productVendors(first: 250) { edges { node } }
    locations(first: 50, includeInactive: false) {
      nodes { id name isActive shipsInventory }
    }
    publications(first: 25) { nodes { id name } }
  }
`;

/**
 * Shopify keeps no supplier list, so recent products are scanned for the
 * supplier metafield to rebuild the picker's suggestions. Best effort: an
 * empty list just means staff type the name in free-form.
 */
async function fetchSuppliers(env) {
  try {
    const data = await shopify(
      env,
      `query Suppliers($ns: String!, $key: String!) {
        products(first: 250, sortKey: UPDATED_AT, reverse: true) {
          nodes { metafield(namespace: $ns, key: $key) { value } }
        }
      }`,
      { ns: SUPPLIER_NAMESPACE, key: SUPPLIER_KEY }
    );
    const names = data.products.nodes
      .map(n => (n.metafield?.value || '').trim())
      .filter(Boolean);
    return [...new Set(names)]
      .sort((a, b) => a.localeCompare(b))
      .map(name => ({ name }));
  } catch {
    return [];
  }
}

function resolveOutlets(locations) {
  return OUTLET_MATCHERS.map(outlet => {
    const hit = locations.find(loc => {
      const name = loc.name.toLowerCase();
      return outlet.match.some(m => name.includes(m));
    });
    return {
      key: outlet.key,
      label: outlet.label,
      locationId: hit ? hit.id : null,
      locationName: hit ? hit.name : null,
    };
  });
}

async function getReferenceData(env) {
  const data = await shopify(env, REFERENCE_QUERY);

  const locations = data.locations.nodes;
  const outlets = resolveOutlets(locations);
  const onlineStore = data.publications.nodes.find(p => /online store/i.test(p.name));

  return {
    shop: data.shop.name,
    currency: data.shop.currencyCode,
    // Names kept identical to the Lightspeed payload so the front end's
    // existing rendering keeps working unchanged.
    categories: data.productTypes.edges
      .map(e => e.node)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .map(name => ({ name, display_name: name })),
    brands: data.productVendors.edges
      .map(e => e.node)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .map(name => ({ name })),
    suppliers: await fetchSuppliers(env),
    outlets,
    unmatchedOutlets: outlets.filter(o => !o.locationId).map(o => o.label),
    allLocations: locations.map(l => ({ id: l.id, name: l.name })),
    onlineStorePublicationId: onlineStore ? onlineStore.id : null,
  };
}

/* ------------------------------------------------------------------ */
/* Product creation                                                    */
/* ------------------------------------------------------------------ */

const PRODUCT_CREATE = `
  mutation ProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id title handle status }
      userErrors { field message }
    }
  }
`;

const PRODUCT_VARIANTS_QUERY = `
  query ProductVariants($id: ID!) {
    product(id: $id) {
      variants(first: 100) { nodes { id sku inventoryItem { id } } }
    }
  }
`;

const VARIANTS_BULK_CREATE = `
  mutation VariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(
      productId: $productId
      variants: $variants
      strategy: REMOVE_STANDALONE_VARIANT
    ) {
      productVariants { id sku inventoryItem { id } selectedOptions { name value } }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_UPDATE = `
  mutation VariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku inventoryItem { id } }
      userErrors { field message }
    }
  }
`;

const INVENTORY_ACTIVATE = `
  mutation InventoryActivate($inventoryItemId: ID!, $updates: [InventoryBulkToggleActivationInput!]!) {
    inventoryBulkToggleActivation(inventoryItemId: $inventoryItemId, inventoryItemUpdates: $updates) {
      inventoryItem { id }
      userErrors { field message }
    }
  }
`;

const INVENTORY_SET = `
  mutation InventorySet($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { field message }
    }
  }
`;

const PUBLISH = `
  mutation Publish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

function money(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function supplierMetafields(payload) {
  const fields = [];
  if (payload.supplier_name) {
    fields.push({
      namespace: SUPPLIER_NAMESPACE,
      key: SUPPLIER_KEY,
      type: 'single_line_text_field',
      value: String(payload.supplier_name),
    });
  }
  if (payload.supplier_code) {
    fields.push({
      namespace: SUPPLIER_NAMESPACE,
      key: SUPPLIER_CODE_KEY,
      type: 'single_line_text_field',
      value: String(payload.supplier_code),
    });
  }
  return fields;
}

/** Activates each inventory item at every mapped outlet, then sets quantities. */
async function applyInventory(env, inventoryTargets, outletMap) {
  const locationIds = [...new Set(Object.values(outletMap).filter(Boolean))];
  if (!locationIds.length) return;

  for (const target of inventoryTargets) {
    const activate = await shopify(env, INVENTORY_ACTIVATE, {
      inventoryItemId: target.inventoryItemId,
      updates: locationIds.map(locationId => ({ locationId, activate: true })),
    });
    assertNoUserErrors(activate.inventoryBulkToggleActivation, 'Enabling stock tracking');
  }

  const quantities = [];
  for (const target of inventoryTargets) {
    for (const [key, locationId] of Object.entries(outletMap)) {
      if (!locationId) continue;
      quantities.push({
        inventoryItemId: target.inventoryItemId,
        locationId,
        quantity: Math.max(0, parseInt(target.stock[key], 10) || 0),
      });
    }
  }
  if (!quantities.length) return;

  const result = await shopify(env, INVENTORY_SET, {
    input: {
      name: 'available',
      reason: 'correction',
      ignoreCompareQuantity: true,
      quantities,
    },
  });
  assertNoUserErrors(result.inventorySetQuantities, 'Setting stock levels');
}

async function publishOnline(env, productId, publicationId) {
  if (!publicationId) return;
  const result = await shopify(env, PUBLISH, {
    id: productId,
    input: [{ publicationId }],
  });
  assertNoUserErrors(result.publishablePublish, 'Publishing to Online Store');
}

/** Simple product: no options, one variant. Samples, jewellery, accessories. */
async function syncSimpleProduct(env, payload) {
  const created = await shopify(env, PRODUCT_CREATE, {
    product: {
      title: payload.name,
      vendor: payload.brand_name || undefined,
      productType: payload.type_name || undefined,
      tags: payload.tags || [],
      status: payload.sell_online ? 'ACTIVE' : 'DRAFT',
      metafields: supplierMetafields(payload),
    },
  });
  assertNoUserErrors(created.productCreate, 'Creating product');
  const product = created.productCreate.product;

  // productCreate's payload does not reliably include the default variant, so
  // it is read back before being updated in place.
  const detail = await shopify(env, PRODUCT_VARIANTS_QUERY, { id: product.id });
  const defaultVariant = detail.product.variants.nodes[0];
  if (!defaultVariant) throw new ShopifyError('Shopify did not create a default variant.');

  const updated = await shopify(env, VARIANTS_BULK_UPDATE, {
    productId: product.id,
    variants: [{
      id: defaultVariant.id,
      price: money(payload.retail_price),
      taxable: true,
      inventoryPolicy: 'DENY',
      inventoryItem: {
        sku: payload.sku,
        cost: money(payload.supply_price),
        tracked: true,
      },
    }],
  });
  assertNoUserErrors(updated.productVariantsBulkUpdate, 'Setting price and SKU');

  const inventoryItemId = updated.productVariantsBulkUpdate.productVariants[0].inventoryItem.id;
  await applyInventory(env, [{ inventoryItemId, stock: payload.stock || {} }], payload.outlets || {});

  if (payload.sell_online) await publishOnline(env, product.id, payload.online_publication_id);

  return { id: product.id, handle: product.handle, title: product.title };
}

/** Stocked clothing: one colour, many sizes. */
async function syncVariantProduct(env, payload) {
  const sizes = payload.variants.map(v => v.size);

  const created = await shopify(env, PRODUCT_CREATE, {
    product: {
      title: payload.name,
      vendor: payload.brand_name || undefined,
      productType: payload.type_name || undefined,
      tags: payload.tags || [],
      status: payload.sell_online ? 'ACTIVE' : 'DRAFT',
      metafields: supplierMetafields(payload),
      productOptions: [
        { name: 'Colour', position: 1, values: [{ name: payload.colour }] },
        { name: 'Size', position: 2, values: sizes.map(name => ({ name })) },
      ],
    },
  });
  assertNoUserErrors(created.productCreate, 'Creating product');
  const product = created.productCreate.product;

  const bulk = await shopify(env, VARIANTS_BULK_CREATE, {
    productId: product.id,
    variants: payload.variants.map(v => ({
      optionValues: [
        { optionName: 'Colour', name: payload.colour },
        { optionName: 'Size', name: v.size },
      ],
      price: money(v.retail_price),
      taxable: true,
      inventoryPolicy: 'DENY',
      inventoryItem: {
        sku: v.sku,
        cost: money(payload.supply_price),
        tracked: true,
      },
    })),
  });
  assertNoUserErrors(bulk.productVariantsBulkCreate, 'Creating size variants');

  // Variants come back in creation order, but they are matched on SKU so a
  // reordered response can never misassign stock to the wrong size.
  const bySku = new Map(
    bulk.productVariantsBulkCreate.productVariants.map(v => [v.sku, v.inventoryItem.id])
  );
  const targets = payload.variants
    .map(v => ({ inventoryItemId: bySku.get(v.sku), stock: v.stock || {} }))
    .filter(t => t.inventoryItemId);

  await applyInventory(env, targets, payload.outlets || {});

  if (payload.sell_online) await publishOnline(env, product.id, payload.online_publication_id);

  return { id: product.id, handle: product.handle, title: product.title };
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

const CONTRACT_VERSION = 2;

/**
 * A browser tab left open from before the Shopify cutover sends the old
 * Lightspeed payload, whose stock lived under `inventory` rather than `stock`.
 * That shape would otherwise sync a product with no stock at all, so it is
 * refused outright.
 */
function assertCurrentClient(payload) {
  if (payload.contract !== CONTRACT_VERSION) {
    throw new ShopifyError(
      'This importer page is out of date. Please refresh (Ctrl+Shift+R) and sync again.'
    );
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== 'POST') {
      return json(request, { error: 'Method not allowed.' }, 405);
    }

    // Either a Dev Dashboard client id/secret pair, or a legacy custom app's
    // permanent token, is enough to authenticate.
    const hasCredentials =
      env.SHOPIFY_ADMIN_TOKEN || (env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET);

    if (!env.PORTAL_PASSWORD || !env.SHOPIFY_STORE || !hasCredentials) {
      return json(request, { error: 'Worker is missing required secrets. See SETUP.md.' }, 500);
    }

    if (request.headers.get('X-Portal-Password') !== env.PORTAL_PASSWORD) {
      return json(request, { error: 'Unauthorised.' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(request, { error: 'Invalid JSON body.' }, 400);
    }

    const { action, payload = {} } = body;

    try {
      switch (action) {
        case 'ping':
          return json(request, { ok: true });

        case 'get_reference_data':
          return json(request, await getReferenceData(env));

        // Retained so an un-refreshed browser tab running the old front end
        // fails gracefully rather than throwing an opaque router error.
        case 'create_variant_attribute':
          return json(request, { data: { id: null, deprecated: true } });

        case 'sync_product':
          assertCurrentClient(payload);
          return json(request, { data: await syncSimpleProduct(env, payload) });

        case 'sync_variant_product':
          assertCurrentClient(payload);
          return json(request, { data: await syncVariantProduct(env, payload) });

        default:
          return json(request, { error: `Unknown action "${action}".` }, 400);
      }
    } catch (err) {
      const message = err instanceof ShopifyError ? err.message : 'Unexpected worker error.';
      if (!(err instanceof ShopifyError)) console.error(err);
      return json(request, { error: message }, 502);
    }
  },
};
