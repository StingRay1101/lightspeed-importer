# Shopify migration — setup

The importer used to write into Lightspeed X-Series, which then pushed to Shopify
via the "Sell on Shopify" button. It now writes **directly into Shopify** and
Lightspeed is no longer involved.

The front end (`index.html`) is a static page on GitHub Pages. All credentials
live in a Cloudflare Worker (`worker.js`), which is the only thing that talks to
Shopify. Nothing sensitive is ever in the browser.

Work through steps 1–5 in order. Step 6 is the smoke test.

---

## 1. Create the Shopify app

Shopify retired admin-created custom apps on **1 January 2026**. You can no
longer create one under *Settings → Apps and sales channels → Develop apps*, and
the permanent `shpat_` tokens they issued are no longer handed out. Existing apps
created before that date still work.

So there are two routes:

- **If the store already has a pre-2026 custom app** with a working Admin API
  token and the scopes below, reuse it. Set `SHOPIFY_ADMIN_TOKEN` in step 3 and
  skip the client id/secret.
- **Otherwise** create an app in the **Dev Dashboard**, which is the current
  path. It issues a token that lasts 24 hours; the worker fetches and refreshes
  it automatically, so this is invisible in day-to-day use.

For the Dev Dashboard route, go to <https://dev.shopify.com>, open the
organisation that owns the store, and create an app named something like
`Product Importer`. Then open its **API access / scopes** and grant exactly
these:

| Scope | Why it's needed |
|---|---|
| `read_products`, `write_products` | Create products, variants, options, tags, metafields |
| `read_inventory`, `write_inventory` | Set stock at each store |
| `read_locations` | Match your four stores to Shopify locations |
| `read_publications`, `write_publications` | Publish "sold online" products to the Online Store |

Release a version with those scopes, then **install the app on the store** and
approve the scope request. Nothing works until the store has approved it.

Finally, from the app's **Client credentials** section copy the **Client ID** and
**Client secret**. These go into Cloudflare in step 3.

> The client secret is a long-lived credential — treat it like a password. Keep
> it out of email and chat, and paste it straight into Cloudflare. If it leaks,
> rotate it in the Dev Dashboard.

**The client credentials grant only works when the app and the store are in the
same Shopify organisation.** If the app was created in a different organisation
you'll get an error at token exchange, and the fix is to recreate the app under
the organisation that owns the store.

### Check the credentials before touching Cloudflare

Worth doing, so that if something is wrong you know it's the app and not the
worker. Capture the secret without it landing in your shell history:

```bash
read -rsp "Client ID: " CID && echo && read -rsp "Client secret: " CSEC && echo "ok"
```

Exchange them for a token, replacing `YOUR-STORE`:

```bash
curl -s -X POST "https://YOUR-STORE.myshopify.com/admin/oauth/access_token" -d "grant_type=client_credentials" -d "client_id=$CID" -d "client_secret=$CSEC"
```

You should get back an `access_token`, a `scope` list, and `expires_in: 86399`.
Check the scope list actually contains all eight scopes — if it's short, the
store hasn't approved the latest app version.

Then confirm the token can read what the importer needs:

```bash
TOKEN=$(curl -s -X POST "https://YOUR-STORE.myshopify.com/admin/oauth/access_token" -d "grant_type=client_credentials" -d "client_id=$CID" -d "client_secret=$CSEC" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p') && curl -s -X POST "https://YOUR-STORE.myshopify.com/admin/api/2026-01/graphql.json" -H "X-Shopify-Access-Token: $TOKEN" -H "Content-Type: application/json" -d '{"query":"{ shop { name } locations(first:10){nodes{id name}} publications(first:10){nodes{id name}} }"}'
```

A good response names your shop, lists your locations, and includes a publication
called "Online Store". This one query exercises the three scopes that most often
get missed, so an `ACCESS_DENIED` here names the field that failed and tells you
which scope to add.

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
| `SHOPIFY_STORE` | Your `.myshopify.com` domain, e.g. `imagine-fashion.myshopify.com` — no `https://` |
| `SHOPIFY_CLIENT_ID` | Client ID from step 1 |
| `SHOPIFY_CLIENT_SECRET` | Client secret from step 1 |

If you're reusing a pre-2026 custom app instead, set `SHOPIFY_ADMIN_TOKEN` to its
permanent token and omit the client id and secret. The worker takes whichever
pair it finds, preferring the permanent token.

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
- The worker pins Shopify Admin API `2026-01` (`API_VERSION` at the top of the
  file), which Shopify supports until **16 January 2027**. Bump it before then
  and re-run the step 6 checks. Each version gets about 12 months, so this is
  roughly an annual chore. Don't drift onto an unsupported version — calls start
  failing outright rather than degrading.
- Access tokens from the Dev Dashboard last 24 hours. The worker exchanges the
  client id and secret for one on demand, caches it in memory, and expires it a
  minute early; a rejected token is dropped and re-fetched once automatically.
  There is nothing to rotate manually and no token stored at rest.
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
