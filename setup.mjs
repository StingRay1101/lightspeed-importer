/**
 * Guided setup for the Shopify importer.
 *
 *   node setup.mjs
 *
 * Prompts for your Shopify credentials, verifies them, checks the scopes and
 * location names, and can push the secrets to Cloudflare and deploy the worker.
 *
 * Credentials are typed by you, held in memory for the length of this run, and
 * never written to disk, logged, or echoed to the screen.
 */

import readline from 'readline';
import { spawnSync } from 'child_process';

const API_VERSION = '2026-01';
const WORKER_NAME = 'lightpspeedimporter';

const REQUIRED_SCOPES = [
  'read_products', 'write_products',
  'read_inventory', 'write_inventory',
  'read_locations',
  'read_publications', 'write_publications',
];

const OUTLETS = [
  { label: 'Harbour Town', match: ['harbour town', 'harbourtown'] },
  { label: 'Pacific Fair', match: ['pacific fair', 'pacificfair'] },
  { label: 'Southport Showroom', match: ['southport showroom', 'showroom'] },
  { label: 'Southport Warehouse', match: ['southport warehouse', 'warehouse'] },
];

const bold = s => `\x1b[1m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;

const tick = s => console.log(`  ${green('OK')}   ${s}`);
const cross = s => console.log(`  ${red('XX')}   ${s}`);

// Masking only works on a real terminal; forcing it on a pipe swallows the
// input entirely, so the mode follows stdin.
const interactive = Boolean(process.stdin.isTTY);

const rl = readline.createInterface({
  input: process.stdin, output: process.stdout, terminal: interactive,
});

let awaitingInput = false;
rl.on('close', () => {
  if (awaitingInput) {
    console.log(`\n${red('Stopped.')} Input ended before every question was answered.`);
    process.exit(1);
  }
});

// One shared interface: creating a new one per prompt drops buffered input,
// which breaks the moment stdin isn't an interactive terminal.
function ask(query, hidden = false) {
  return new Promise(resolve => {
    awaitingInput = true;
    const done = answer => { awaitingInput = false; resolve(answer.trim()); };
    // Git Bash's MinTTY doesn't report as a TTY, so masking silently stops
    // working there. Say so rather than echoing a secret unannounced.
    if (hidden && !interactive) {
      console.log(dim('  (this terminal cannot hide input — what you type will be visible)'));
    }
    if (hidden && interactive) {
      process.stdout.write(query);
      const echo = rl._writeToOutput;
      rl._writeToOutput = () => {};
      rl.question('', answer => {
        rl._writeToOutput = echo;
        process.stdout.write('\n');
        done(answer);
      });
    } else {
      rl.question(query, done);
    }
  });
}

function fail(message, hint) {
  console.log(`\n${red('Stopped.')} ${message}`);
  if (hint) console.log(dim(`\n${hint}`));
  // Exiting in the same tick as readline's teardown trips a libuv assertion on
  // Windows, so the process is left to wind down on its own instead.
  awaitingInput = false;
  process.exitCode = 1;
  rl.close();
  process.stdin.pause();
  throw new Stop();
}

/** Thrown by fail() purely to unwind; the message is already printed. */
class Stop extends Error {}

process.on('uncaughtException', err => {
  if (!(err instanceof Stop)) {
    console.log(`\n${red('Unexpected error.')} ${err?.message || err}`);
    process.exitCode = 1;
  }
  process.stdin.pause();
});

/** Shopify serves an HTML error page for unknown stores; don't paste it back. */
function describeBody(text) {
  const body = (text || '').trim();
  if (!body) return '';
  if (/^\s*</.test(body) || /<html/i.test(body)) return 'Shopify returned a web page rather than an API response.';
  return body.slice(0, 300);
}

console.log(`\n${bold('Shopify importer setup')}`);
console.log(dim('Nothing you type here is written to disk.\n'));

let shop = await ask('Shop domain (e.g. imagine-fashion.myshopify.com): ');
shop = shop.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
if (!shop.endsWith('.myshopify.com')) {
  fail(`"${shop}" doesn't look like a myshopify domain.`,
    'Use the permanent domain from Settings > Domains, not your custom storefront domain.');
}

const clientId = await ask('Client ID: ');
const clientSecret = await ask('Client secret (hidden): ', true);
if (!clientId || !clientSecret) fail('Both the client ID and secret are required.');

/* ---------------------------------------------------------------- */
/* 1. Exchange credentials for a token                               */
/* ---------------------------------------------------------------- */

console.log(`\n${bold('Checking credentials')}`);

let token, grantedScopes;
try {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const detail = describeBody(await res.text().catch(() => ''));
    fail(`Shopify refused the credentials (HTTP ${res.status}). ${detail}`,
      res.status === 401 || res.status === 400
        ? 'Usually the client ID or secret is wrong, or the app and the store are in different\nShopify organisations. The client credentials grant only works within one organisation.'
        : 'Check the shop domain is right.');
  }

  const data = await res.json();
  token = data.access_token;
  grantedScopes = (data.scope || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token) fail('Shopify returned no access token.');

  tick(`Token issued, valid for ${Math.round((data.expires_in || 0) / 3600)} hours`);
} catch (err) {
  if (err?.code === 'ENOTFOUND') fail(`Could not reach ${shop}. Check the domain.`);
  throw err;
}

/* ---------------------------------------------------------------- */
/* 2. Check scopes                                                   */
/* ---------------------------------------------------------------- */

const missing = REQUIRED_SCOPES.filter(s => !grantedScopes.includes(s));
if (missing.length) {
  cross(`Missing scopes: ${missing.join(', ')}`);
  fail('The app does not have every scope the importer needs.',
    'Add them to the app version in the Dev Dashboard, release it, then approve the\nupdated scopes on the store. Granting them without approving does nothing.');
}
tick(`All ${REQUIRED_SCOPES.length} required scopes granted`);

/* ---------------------------------------------------------------- */
/* 3. Read the store                                                 */
/* ---------------------------------------------------------------- */

console.log(`\n${bold('Checking the store')}`);

const gql = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
  body: JSON.stringify({
    query: `{
      shop { name currencyCode }
      locations(first: 50, includeInactive: false) { nodes { id name } }
      publications(first: 25) { nodes { id name } }
      productTypes(first: 5) { edges { node } }
      productVendors(first: 5) { edges { node } }
    }`,
  }),
});

const payload = await gql.json();
if (payload.errors?.length) {
  fail(`Shopify rejected the query: ${payload.errors.map(e => e.message).join('; ')}`,
    `This usually means API version ${API_VERSION} no longer accepts one of these fields.\nCheck https://shopify.dev/docs/api/usage/versioning and update API_VERSION in worker.js.`);
}

const { shop: shopInfo, locations, publications, productTypes, productVendors } = payload.data;
tick(`Connected to ${bold(shopInfo.name)} (${shopInfo.currencyCode})`);

const onlineStore = publications.nodes.find(p => /online store/i.test(p.name));
if (onlineStore) tick('Online Store sales channel found');
else cross('No "Online Store" publication — products marked sold online will not be published');

tick(`${productTypes.edges.length ? productTypes.edges.length + '+' : 'No'} product types, ` +
     `${productVendors.edges.length ? productVendors.edges.length + '+' : 'no'} vendors ` +
     dim('(these fill the Category and Brand dropdowns)'));

/* ---------------------------------------------------------------- */
/* 4. Match locations to the four stock columns                      */
/* ---------------------------------------------------------------- */

console.log(`\n${bold('Matching your stores to Shopify locations')}`);

const unmatched = [];
for (const outlet of OUTLETS) {
  const hit = locations.nodes.find(l =>
    outlet.match.some(m => l.name.toLowerCase().includes(m)));
  if (hit) tick(`${outlet.label.padEnd(22)} -> ${hit.name}`);
  else { cross(`${outlet.label.padEnd(22)} -> no match`); unmatched.push(outlet.label); }
}

if (unmatched.length) {
  console.log(`\n${dim('Locations in this store:')}`);
  for (const l of locations.nodes) console.log(dim(`  - ${l.name}`));
  console.log(`\n${red('Stock for the unmatched stores will be skipped.')}`);
  console.log(dim('Either rename the location in Shopify, or add an alias to OUTLET_MATCHERS\nnear the top of worker.js.'));
  const go = await ask('\nCarry on anyway? (y/N): ');
  if (go.toLowerCase() !== 'y') process.exit(1);
}

/* ---------------------------------------------------------------- */
/* 5. Push to Cloudflare                                             */
/* ---------------------------------------------------------------- */

console.log(`\n${bold('Cloudflare')}`);
console.log(dim(`This sets the secrets on worker "${WORKER_NAME}" and deploys worker.js.`));
console.log(dim('You will be asked to log in to Cloudflare in a browser if you are not already.'));
console.log(red('\nBefore you continue: copy the current worker code out of the Cloudflare'));
console.log(red('editor and save it. It is the only copy of the Lightspeed integration.'));

const deploy = await ask('\nSet secrets and deploy now? (y/N): ');
if (deploy.toLowerCase() !== 'y') {
  console.log(`\n${green('Credentials verified.')} Nothing was changed.`);
  console.log('Re-run this script when you are ready to deploy, or follow SETUP.md by hand.');
  rl.close();
  process.exit(0);
}

const portalPassword = await ask('Staff portal password (hidden): ', true);
if (!portalPassword) fail('The portal password is required — staff use it to log in.');

function putSecret(name, value) {
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--name', WORKER_NAME], {
    input: value, encoding: 'utf8', shell: true,
  });
  if (r.status !== 0) {
    fail(`Could not set ${name}.\n${(r.stderr || r.stdout || '').slice(0, 500)}`,
      'If this is an auth error, run:  npx wrangler login');
  }
  tick(`${name} set`);
}

console.log('');
putSecret('PORTAL_PASSWORD', portalPassword);
putSecret('SHOPIFY_STORE', shop);
putSecret('SHOPIFY_CLIENT_ID', clientId);
putSecret('SHOPIFY_CLIENT_SECRET', clientSecret);

console.log(`\n${bold('Deploying worker.js')}`);
const dep = spawnSync('npx', [
  'wrangler', 'deploy', 'worker.js', '--name', WORKER_NAME,
  '--compatibility-date', '2025-01-01',
], { stdio: 'inherit', shell: true });

if (dep.status !== 0) fail('Deploy failed. See the output above.');

console.log(`\n${green('Done.')}`);
console.log('Reload the importer. The header should show your store name instead of');
console.log('"Shopify", with no location warning. Then run the throwaway-product test');
console.log('in SETUP.md step 6 before letting staff back in.\n');
