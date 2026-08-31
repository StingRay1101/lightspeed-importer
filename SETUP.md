# Shopify migration — setup

The importer used to write into Lightspeed X-Series, which then pushed to Shopify
via the "Sell on Shopify" button. It now writes **directly into Shopify** and
Lightspeed is no longer involved.

The front end (`index.html`) is a static page on GitHub Pages. All credentials
live in a Cloudflare Worker (`worker.js`), which is the only thing that talks to
Shopify. Nothing sensitive is ever in the browser.

Work through steps 1–5 in order. Step 6 is the smoke test.

---

## 1. Create the Shopify custom app

In Shopify admin: **Settings → Apps and sales channels → Develop apps → Create an app**.

Name it something like `Product Importer`, then **Configure Admin API scopes** and
tick exactly these:

| Scope | Why it's needed |
|---|---|
| `read_products`, `write_products` | Create products, variants, options, tags, metafields |
| `read_inventory`, `write_inventory` | Set stock at each store |
| `read_locations` | Match your four stores to Shopify locations |
| `read_publications`, `write_publications` | Publish "sold online" products to the Online Store |

Click **Save**, then **Install app**, then **Reveal token once** under Admin API
access token. Copy it — it starts with `shpat_` and Shopify will never show it
again.

> Keep this token out of email and chat. Paste it straight into Cloudflare in
> step 3. If it leaks, uninstall the app and create a new one.

---

## 2. Check your location names

The importer's four stock columns are matched to Shopify locations **by name**.
In **Settings → Locations**, confirm you have locations whose names contain:

- `Harbour Town`
- `Pacific Fair`
- `Southport Showroom`
- `Southport Warehouse`

Matching is case-insensitive and partial, so `Southport Warehouse (Main)` works
fine. If a location is named something else entirely, edit `OUTLET_MATCHERS` near
the top of `worker.js` and add the alias.

Any column that doesn't match still appears in the UI, but its stock is skipped
and you'll get a warning toast at login naming the unmatched stores.

---

## 3. Set the Worker secrets

You chose to **overwrite the existing worker in place**, so the URL that
`index.html` already points at stays the same:

```
https://lightpspeedimporter.sam-58d.workers.dev
```

In the Cloudflare dashboard: **Workers & Pages → lightpspeedimporter → Settings →
Variables and Secrets**. Add these three as **encrypted secrets**:

| Name | Value |
|---|---|
| `PORTAL_PASSWORD` | The staff password (keep the current one so nobody has to relearn it) |
| `SHOPIFY_STORE` | Your `.myshopify.com` domain, e.g. `imagine-fashion.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | The `shpat_...` token from step 1 |

Delete the old Lightspeed secrets once the new sync is working — not before, in
case you need to roll back.

---

## 4. Deploy the worker

Paste the contents of `worker.js` into the Cloudflare editor (**Edit code**) and
click **Deploy**.

If you'd rather use the CLI:

```bash
npx wrangler deploy worker.js --name lightpspeedimporter --compatibility-date 2025-01-01
```

**Before you deploy, copy the current worker code out of the Cloudflare editor
and save it somewhere.** It was never committed to this repo, so pasting over it
is the only copy you'll lose. That saved copy is your rollback.

---

## 5. Create the supplier metafield definitions

Shopify has no supplier field, so Supplier and Supplier Code are stored as
product metafields. The sync works without this step, but adding the definitions
makes the values visible and editable on the product page in admin.

In **Settings → Custom data → Products → Add definition**, create two:

| Name | Namespace and key | Type |
|---|---|---|
| Supplier | `custom.supplier` | Single line text |
| Supplier Code | `custom.supplier_code` | Single line text |

The Supplier box in the importer suggests names it finds on recent products, so
it will look empty on the first run and fill itself in as you go. You can always
type a new supplier.

---

## 6. Test before going live

Use a real product you don't mind deleting.

1. Open the importer and log in. You should see brands and categories populate.
   These now come from your Shopify **vendors** and **product types**.
2. Add one **Stocked Clothing** product with two sizes, set stock at a couple of
   stores, mark it **not** sold online, and sync.
3. In Shopify, check the new product:
   - Status is **Draft** and it isn't published to the Online Store
   - Options are **Colour** and **Size**, one variant per size
   - SKUs match the pattern you expect (`BASE-S`, `BASE-M`; `OS` gets no suffix)
   - Cost per item equals the supply price
   - Inventory shows at the right stores with the right numbers
   - Supplier and Supplier Code appear under Metafields
4. Repeat with **sold online = Yes** and confirm it's **Active** and published.
5. Delete both test products.

---

## What changed for staff

Almost nothing. The form, the quick-add buttons, the tag groups, the size
presets, the stock grid, and the XLSX import all behave exactly as before.

The differences worth mentioning:

- The **"Don't forget Shopify!"** step is gone. Products land in Shopify
  directly, so there's no second manual step in Lightspeed any more.
- **Sold online = Yes** now means the product is created Active and published to
  the Online Store. **No** means it's created as a Draft and left unpublished.
  The 4-digit suffix on non-online names has been kept.
- **Supplier** is now a type-ahead box instead of a fixed dropdown, because
  Shopify keeps no supplier list. Existing suppliers are suggested as you type,
  and you can add new ones by just typing them.
- **Category** writes to the Shopify **Product type** field; **Brand** writes to
  **Vendor**.

---

## Notes for whoever maintains this next

- `worker.js` is now in this repo. The old Lightspeed worker never was, which is
  why it had to be rewritten from scratch rather than ported.
- The worker pins Shopify Admin API `2025-10` (`API_VERSION` at the top of the
  file). Shopify supports each version for about a year, so bump it roughly
  annually and re-run the step 6 checks.
- `ALLOWED_ORIGINS` in `worker.js` controls CORS. Add any new domain the
  importer gets served from, or requests will be blocked by the browser.
- `serve.js` runs the page locally on `http://localhost:8788` for testing before
  pushing to Pages. It isn't used in production.
- `worker.test.mjs` runs the worker against a mocked Shopify API and checks the
  whole payload contract — draft vs active, SKU suffixes, per-size stock, the
  supplier metafields. No network and no credentials needed:

  ```bash
  node worker.test.mjs
  ```

  Run it after any change to `worker.js`.

---

## Deploy order matters

The front end and the worker must change together, and the worker has to go
first:

1. Deploy `worker.js` to Cloudflare (steps 3–4).
2. Only then merge the front end to `main`, which publishes it to GitHub Pages.

Doing it the other way round leaves the new page talking to the old Lightspeed
worker, and every sync fails until you catch up.

During the swap, anyone with the importer already open in a tab is running the
old page. Those stale tabs are refused with *"This importer page is out of date —
please refresh"* rather than being allowed to create products with no stock, so
the worst case is a staff member pressing Ctrl+Shift+R.
