import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import pg from 'pg';
import { execute, keyCommand, startEngine } from '../api/runtime.ts';
import type { ListingResponse } from '@idx-kit/client';

const origin = 'http://127.0.0.1:4321';
const property = '/properties/lst_demo_0001';
let directory: string, secret: string, engine: Awaited<ReturnType<typeof startEngine>> | undefined;
let site: Awaited<ReturnType<typeof startSite>>;
let db: pg.Client;
async function startSite(base = 'http://127.0.0.1:8787', port = 4321) {
  const child = spawn(process.execPath, ['start.mjs'], {
    cwd: 'examples/demo-site', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, IDX_ENGINE_URL: base, IDX_SECRET_KEY: secret, HOST: '127.0.0.1', PORT: String(port) }
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const exited = once(child, 'exit');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    if (await fetch(`http://127.0.0.1:${port}/`).then(r => r.ok, () => false)) {
      return { logs: () => logs, async stop() { child.kill('SIGTERM'); await exited; } };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
  throw new Error('Site did not start: ' + logs);
}
async function raw(request: APIRequestContext, path: string, status = 200, base = origin) {
  const response = await request.get(base + path);
  expect(response.status()).toBe(status);
  expect(response.headers()['cache-control']).toBe('no-store');
  const body = await response.text();
  expect(body + JSON.stringify(response.headers())).not.toContain(secret);
  expect(body).not.toMatch(/<script\b/i);
  return body;
}
test.describe.serial('SSR property pages through the public engine', () => {
  test.beforeAll(async () => {
    directory = await mkdtemp(`${tmpdir()}/idx18-`);
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await execute('npm', ['run', '--silent', 'demo:seed']);
    secret = (await keyCommand(directory, 'create', 'site_demo_primary', 'listings:read')).secret;
    engine = await startEngine();
    site = await startSite();
  });
  test.afterAll(async () => {
    await site?.stop();
    await engine?.stop();
    await db?.end();
    await rm(directory, { recursive: true, force: true });
  });

  test('raw HTML includes facts, original illustration, ordered disclosures and feed time', async ({ request, page }) => {
    const html = await raw(request, property);
    for (const text of ['active', '$425,000.00', '101 Imaginary Lantern Lane', 'Invented synthetic house illustration; no real property',
      '/media/synthetic-house-001.svg', 'Synthetic Example Brokerage. Invented listing attribution.',
      'Original synthetic data for IDX Kit. These properties do not exist.', '2026-11-01T00:00:00.000Z']) expect(html).toContain(text);
    await page.goto(property);
    await expect(page.locator('[data-fact="bedrooms"]')).toHaveText('1');
    expect(await page.locator('[data-block]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-block'))))
      .toEqual(['synthetic_broker', 'synthetic_notice']);
    await expect(page.locator('[data-placement="afterListing"] [data-block]')).toHaveText('Synthetic Example Brokerage. Invented listing attribution.');
    await expect(page.locator('article header')).toHaveCount(0);
    await expect(page.locator('header')).toHaveText('IDX Kit demoSynthetic properties for demonstration.');
    for (const n of ['001', '002', '003']) expect(await raw(request, `/media/synthetic-house-${n}.svg`)).toContain('>SYNTHETIC</text>');
    await raw(request, '/missing-page', 404);
    await raw(request, '/media/missing.svg', 404);
  });

  test('null facts and a withheld address remain neutral in raw HTML and every context', async ({ request, page }) => {
    const fixtures = JSON.parse(await readFile('fixtures/listings.json', 'utf8'));
    const hidden = fixtures[1].source.Address;
    const html = await raw(request, '/properties/lst_demo_0002');
    expect(html).not.toContain(hidden.line1);
    expect(html).not.toContain('Hidden Stardust');
    await page.goto('/properties/lst_demo_0002');
    for (const fact of ['address', 'bedrooms']) await expect(page.locator(`[data-fact="${fact}"]`)).toHaveText('Not available');
    expect(await page.title()).not.toContain(hidden.line1);
    expect(await page.locator('meta, img').evaluateAll(nodes => nodes.map(n => n.outerHTML).join(''))).not.toContain(hidden.line1);
    await raw(request, '/properties/lst_demo_0004');
    await page.goto('/properties/lst_demo_0004');
    await expect(page.locator('[data-fact="price"]')).toHaveText('Not available');
    await db.query("UPDATE idx.listings SET status=NULL, price=NULL, currency=NULL, address=NULL, bedrooms=NULL, images=NULL WHERE id='lst_demo_0001'");
    try {
      await raw(request, property);
      await page.goto(property);
      for (const fact of ['status', 'price', 'address', 'bedrooms']) await expect(page.locator(`[data-fact="${fact}"]`)).toHaveText('Not available');
      await expect(page.locator('[data-images] > p')).toHaveText('Not available');
    } finally { await execute('npm', ['run', '--silent', 'demo:seed']); }
  });

  test('closed listing has the exact disclaimer and attribution without valuation presentation', async ({ request, page }) => {
    const fixtures = JSON.parse(await readFile('fixtures/listings.json', 'utf8'));
    const record = fixtures[2];
    const html = await raw(request, '/properties/lst_demo_0003');
    expect(html).toContain(record.pageBlocks[0].text);
    expect(html).toContain(record.blocks[0].text);
    await page.goto('/properties/lst_demo_0003');
    await expect(page.locator('footer [data-block="closed_information"]')).toHaveText(record.pageBlocks[0].text);
    // The complete page text is accounted for by chrome, permitted facts, freshness and disclosures.
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    expect(text).toBe(['Skip to content IDX Kit demo Synthetic properties for demonstration. Property Status closed Price $425,000.00',
      'Address 103 Make Believe Meadow Way, Example Springs, NC, 00000, US Bedrooms 3', record.blocks[0].text,
      'Feed refreshed: Oct 31, 2026, 8:00:00 PM EDT', 'Original synthetic data for IDX Kit. These properties do not exist.',
      record.pageBlocks[0].text].join(' '));
  });

  test('missing, withdrawn, wrong-Site, expired and newly withdrawn listings fail closed', async ({ request }) => {
    for (const id of ['unknown', 'lst_demo_0006', 'lst_demo_0024']) {
      expect(await raw(request, `/properties/${id}`, 404)).toContain('Listing not found');
    }
    // Give this Site access to the expired feed only for the expiration check.
    await db.query("INSERT INTO idx.data_licenses VALUES ('site_demo_primary','feed_demo_expired')");
    try { expect(await raw(request, '/properties/lst_demo_0023', 503)).toContain('Listing temporarily unavailable'); }
    finally { await db.query("DELETE FROM idx.data_licenses WHERE site_id='site_demo_primary' AND feed_id='feed_demo_expired'"); }
    await raw(request, property);
    await db.query("UPDATE idx.listings SET entire_listing_display=false WHERE id='lst_demo_0001'");
    try { await raw(request, property, 404); }
    finally { await db.query("UPDATE idx.listings SET entire_listing_display=true WHERE id='lst_demo_0001'"); }
  });

  test('both display contexts preserve placement, order, escaping, icons and prominence', async ({ page, request }) => {
    const block = (id: string, placement: string, prominence: string) => ({ id, placement, prominence,
      text: `Synthetic <b>${id}</b> & notice`, image: { url: '/media/synthetic-house-001.svg', alt: `Synthetic ${id} icon` } });
    const listingBlocks = [block('a', 'adjacent', 'medianListingText'), block('b', 'afterListing', 'largestListingText'), block('c', 'pageFooter', 'normal')];
    const pageBlocks = [block('d', 'adjacent', 'normal'), block('e', 'afterListing', 'medianListingText'), block('f', 'pageFooter', 'largestListingText')];
    await db.query("UPDATE idx.listings SET display_blocks=$1, page_blocks=$2, status='future-status' WHERE id='lst_demo_0001'", [JSON.stringify(listingBlocks), JSON.stringify(pageBlocks)]);
    try {
      const html = await raw(request, property);
      expect(html).toContain('&lt;b&gt;a&lt;/b&gt; &amp; notice');
      await page.goto(property);
      await expect(page.locator('[data-fact="status"]')).toHaveText('future-status');
      await expect(page.locator('[data-block] b')).toHaveCount(0);
      for (const placement of ['adjacent', 'afterListing', 'pageFooter']) {
        const expected = [...listingBlocks, ...pageBlocks].filter(b => b.placement === placement);
        const blocks = page.locator(`[data-placement="${placement}"] [data-block]`).filter({ has: page.locator('img') });
        expect(await blocks.evaluateAll(nodes => nodes.map(n => n.getAttribute('data-block')))).toEqual(expected.map(b => b.id));
        for (const b of expected) {
          await expect(page.locator(`[data-block="${b.id}"]`)).toHaveClass(b.prominence);
          await expect(page.locator(`[data-block="${b.id}"] img`)).toHaveAttribute('alt', b.image.alt);
        }
      }
      const sizes = await page.locator('article h1, article dt, article dd, [data-block]').evaluateAll(nodes =>
        nodes.map(n => ({ largest: n.classList.contains('largestListingText'), size: parseFloat(getComputedStyle(n).fontSize) })));
      for (const item of sizes.filter(s => s.largest)) expect(item.size).toBe(Math.max(...sizes.map(s => s.size)));
    } finally { await execute('npm', ['run', '--silent', 'demo:seed']); }
  });

  test('unknown rules or placement or prominence in either context suppress all listing facts', async ({ request }) => {
    for (const column of ['display_blocks', 'page_blocks']) {
      for (const field of ['placement', 'prominence']) {
        const block = { id: 'future', text: 'Do not render this disclosure alone', placement: 'adjacent', prominence: 'normal', [field]: 'future' };
        await db.query(`UPDATE idx.listings SET ${column}=$1 WHERE id='lst_demo_0001'`, [JSON.stringify([block])]);
        try {
          const html = await raw(request, property, 503);
          expect(html).not.toContain('101 Imaginary');
          expect(html).not.toContain(block.text);
        } finally { await execute('npm', ['run', '--silent', 'demo:seed']); }
      }
    }
    await db.query("UPDATE idx.feeds SET rules_version='future' WHERE id='feed_demo_primary'");
    try { expect(await raw(request, property, 503)).not.toContain('101 Imaginary'); }
    finally { await execute('npm', ['run', '--silent', 'demo:seed']); }
  });

  for (const width of [1280, 375]) test(`no-JS landmarks, readable text and keyboard focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const browserRequests: string[] = [];
    page.on('request', r => browserRequests.push(r.url() + JSON.stringify(r.headers())));
    await page.goto(property);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Property');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator('article p, article dd').evaluateAll(nodes => nodes.every(n => parseFloat(getComputedStyle(n).fontSize) >= 16))).toBe(true);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    expect(await page.locator(':focus').evaluate(n => getComputedStyle(n).outlineStyle)).toBe('solid');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'IDX Kit demo', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(origin + '/');
    expect(browserRequests.join('')).not.toContain(secret);
    expect(browserRequests.every(r => r.startsWith(origin + '/'))).toBe(true);
  });

  test('startup refuses missing v1 or listingDetail and renderer refuses future page rules', async ({ request }) => {
    const sample: ListingResponse = await fetch('http://127.0.0.1:8787/api/v1/listings/lst_demo_0001', {
      headers: { Authorization: `Bearer ${secret}` }
    }).then(r => r.json());
    let versions: unknown[] = [];
    const stub = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api' ? { data: { supportedVersions: versions }, meta: {} } : sample));
    });
    stub.listen(8788, '127.0.0.1');
    await once(stub, 'listening');
    try {
      for (const value of [[], [{ major: 'v1', capabilities: [] }]]) {
        versions = value;
        const result = await execute(process.execPath, ['start.mjs'], { cwd: 'examples/demo-site',
          env: { ...process.env, IDX_ENGINE_URL: 'http://127.0.0.1:8788', IDX_SECRET_KEY: secret }, timeout: 10_000 })
          .then(() => { throw new Error('Unsupported engine was accepted'); }, error => error);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('requires a reachable engine with API v1 and listingDetail');
        expect(result.stderr).not.toContain(secret);
      }
      versions = [{ major: 'v1', capabilities: ['listingDetail'] }];
      const futureSite = await startSite('http://127.0.0.1:8788', 4322);
      try {
        for (const display of [sample.display, sample.data.display]) {
          Object.assign(display, { rulesVersion: 'future' });
          expect(await raw(request, property, 503, 'http://127.0.0.1:4322')).not.toContain('101 Imaginary');
          Object.assign(display, { rulesVersion: '1' });
        }
      } finally { await futureSite.stop(); expect(futureSite.logs()).not.toContain(secret); }
    } finally { await new Promise<void>(resolve => stub.close(() => resolve())); }
  });

  test('stopped engine gives a safe error page and captured site logs contain no key', async ({ request }) => {
    await engine!.stop();
    engine = undefined;
    const html = await raw(request, property, 502);
    expect(html).toContain('Unable to load this listing');
    for (const value of ['127.0.0.1', 'http://', 'ECONNREFUSED', 'Error:', ' at ', 'postgres', 'Authorization']) expect(html).not.toContain(value);
    expect(site.logs()).not.toContain(secret);
  });
});
