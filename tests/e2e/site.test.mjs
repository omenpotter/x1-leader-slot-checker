// Browser tests against the local Vercel-like server with recorded X1 RPC fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const PORT = 4188; const BASE = `http://localhost:${PORT}`;
const VOTE = '7ZPky9oA5bDzCwpuBk9BshFX3BXNXzN9DjpnRcphNGtn';
const IDENTITY = '9oCgTnLY7akSYPaLmTh6TdcXZ49raaBDMdVePXcwNCGB';
let server; let browser;

test.before(async () => {
  server = spawn(process.execPath, ['scripts/dev-server.mjs'], { env: { ...process.env, PORT: String(PORT), FIXTURE_RPC: '1' }, stdio: 'pipe' });
  await new Promise((r) => server.stdout.on('data', (d) => { if (String(d).includes('dev server')) r(); }));
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); server?.kill(); });

async function page(opts = {}) {
  const ctx = await browser.newContext(opts);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return { p, ctx, errors };
}

test('home: SEO metadata, canonical, single h1, valid JSON-LD', async () => {
  const { p, ctx, errors } = await page();
  const res = await p.goto(BASE + '/');
  assert.equal(res.status(), 200);
  assert.match(await p.title(), /X1 Leader Slot Checker/);
  const meta = await p.evaluate(() => ({
    desc: document.querySelector('meta[name=description]').content,
    canon: document.querySelector('link[rel=canonical]').href,
    robots: document.querySelector('meta[name=robots]').content,
    og: document.querySelector('meta[property="og:image"]').content,
    tw: document.querySelector('meta[name="twitter:card"]').content,
    lang: document.documentElement.lang,
    h1: document.querySelectorAll('h1').length,
    ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent),
  }));
  assert.ok(meta.desc.length >= 120 && meta.desc.length <= 170, `description length ${meta.desc.length}`);
  assert.equal(meta.canon, 'https://x1-leader-slot-checker.vercel.app/');
  assert.match(meta.robots, /^index, follow/);
  assert.equal(meta.tw, 'summary_large_image');
  assert.equal(meta.lang, 'en');
  assert.equal(meta.h1, 1);
  const graph = JSON.parse(meta.ld[0])['@graph'];
  const types = graph.map((n) => n['@type']);
  for (const t of ['Organization', 'WebSite', 'WebApplication', 'WebPage', 'FAQPage']) assert.ok(types.includes(t), t);
  const faq = graph.find((n) => n['@type'] === 'FAQPage');
  const visible = await p.$$eval('.faq summary', (s) => s.map((x) => x.textContent.trim()));
  for (const q of faq.mainEntity) assert.ok(visible.includes(q.name), `FAQ schema question visible on page: ${q.name}`);
  assert.ok(!JSON.stringify(graph).match(/aggregateRating|review/i), 'no ratings or reviews');
  await p.waitForSelector('#net-health[data-state="ok"]');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('server-visible content exists without JavaScript', async () => {
  const { p, ctx } = await page({ javaScriptEnabled: false });
  await p.goto(BASE + '/');
  const text = await p.textContent('main');
  for (const s of ['leader slot', '216,000 slots', 'four consecutive slots', 'Solana Virtual Machine']) assert.ok(text.includes(s), s);
  await ctx.close();
});

test('guide page: TechArticle + breadcrumb, canonical', async () => {
  const { p, ctx } = await page();
  assert.equal((await p.goto(BASE + '/guide')).status(), 200);
  const ld = JSON.parse(await p.textContent('script[type="application/ld+json"]'))['@graph'];
  assert.ok(ld.some((n) => n['@type'] === 'TechArticle' && n.dateModified));
  assert.ok(ld.some((n) => n['@type'] === 'BreadcrumbList'));
  assert.equal(await p.getAttribute('link[rel=canonical]', 'href'), 'https://x1-leader-slot-checker.vercel.app/guide');
  await ctx.close();
});

test('status codes, redirects, robots and sitemap', async () => {
  const r404 = await fetch(BASE + '/does-not-exist');
  assert.equal(r404.status, 404);
  assert.match(await r404.text(), /noindex/);
  assert.equal((await fetch(BASE + '/guide.html', { redirect: 'manual' })).status, 308);
  assert.equal((await fetch(BASE + '/guide/', { redirect: 'manual' })).status, 308);
  const robots = await (await fetch(BASE + '/robots.txt')).text();
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Sitemap: https:\/\/x1-leader-slot-checker\.vercel\.app\/sitemap\.xml/);
  const sm = await (await fetch(BASE + '/sitemap.xml')).text();
  const locs = [...sm.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, ['https://x1-leader-slot-checker.vercel.app/', 'https://x1-leader-slot-checker.vercel.app/guide']);
  const csp = (await fetch(BASE + '/')).headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
});

test('lookup by vote account renders schedule, windows, production and explorer links', async () => {
  const { p, ctx, errors } = await page({ viewport: { width: 1280, height: 900 } });
  await p.goto(BASE + '/');
  await p.fill('#pubkey', `  ${VOTE} `);
  await p.press('#pubkey', 'Enter');
  await p.waitForSelector('#results:not([hidden])');
  assert.equal(await p.textContent('#v-identity'), IDENTITY);
  assert.equal(await p.textContent('#v-name'), '248X1SIL');
  assert.equal(await p.textContent('#p-total'), '236');
  assert.match(await p.textContent('#s-caption'), /236 leader slots in 59 windows/);
  assert.match(await p.getAttribute('#v-note a[href*="x1space.xyz/ValidatorDetail"]', 'href'), new RegExp(VOTE));
  assert.match(p.url(), new RegExp(`validator=${VOTE}`));
  assert.equal(await p.getAttribute('meta[name=robots]', 'content'), 'noindex, follow', 'shared validator URLs are noindex');
  await p.click('[data-filter="past"]');
  assert.ok(await p.$('#s-body a[href^="https://x1space.xyz/BlockDetail?slot="]'));
  await p.click('[data-epoch="next"]');
  assert.match(await p.textContent('#s-caption'), /248 leader slots in 62 windows/);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#csv-btn')]);
  assert.match(dl.suggestedFilename(), /^x1-leader-schedule-9oCgTnLY-epoch-450\.csv$/);
  assert.match(await p.textContent('#timeline svg title'), /leader slot/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('shared URL loads the lookup directly', async () => {
  const { p, ctx } = await page();
  await p.goto(`${BASE}/?validator=${IDENTITY}`);
  await p.waitForSelector('#results:not([hidden])');
  assert.equal(await p.inputValue('#pubkey'), IDENTITY);
  await ctx.close();
});

test('invalid input shows an accessible error and makes no API call', async () => {
  const { p, ctx } = await page();
  const api = [];
  p.on('request', (r) => { if (r.url().includes('/api/leader')) api.push(r.url()); });
  await p.goto(BASE + '/');
  await p.fill('#pubkey', 'not-a-validator-0OIl');
  await p.click('#check-btn');
  assert.equal(await p.getAttribute('#pubkey', 'aria-invalid'), 'true');
  assert.match(await p.textContent('#pubkey-error'), /not a valid X1 public key/);
  assert.equal(api.length, 0);
  await ctx.close();
});

test('identity with no leader slots shows an empty state', async () => {
  const { p, ctx } = await page();
  await p.goto(BASE + '/');
  await p.fill('#pubkey', '11111111111111111111111111111111');
  await p.click('#check-btn');
  await p.waitForSelector('#n-empty:not([hidden])');
  assert.match(await p.textContent('#n-empty-title'), /No leader slots/);
  await ctx.close();
});

test('API failure shows error with retry, and retry recovers', async () => {
  const { p, ctx } = await page();
  let fail = true;
  await p.route('**/api/leader*', (route) => (fail ? route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream_error","message":"X1 RPC unavailable"}' }) : route.continue()));
  await p.goto(BASE + '/');
  await p.fill('#pubkey', IDENTITY);
  await p.click('#check-btn');
  await p.waitForSelector('#status[data-tone="error"]');
  assert.match(await p.textContent('#status'), /X1 RPC unavailable/);
  fail = false;
  await p.click('#status .retry');
  await p.waitForSelector('#results:not([hidden])');
  await ctx.close();
});

test('keyboard: skip link, mobile menu toggles and closes with Escape', async () => {
  const { p, ctx } = await page({ ...devices['iPhone 13'] });
  await p.goto(BASE + '/');
  await p.keyboard.press('Tab');
  assert.equal(await p.evaluate(() => document.activeElement.className), 'skip');
  await p.click('.nav-toggle');
  assert.equal(await p.getAttribute('.nav-toggle', 'aria-expanded'), 'true');
  assert.ok(await p.isVisible('#site-nav'));
  await p.keyboard.press('Escape');
  assert.equal(await p.getAttribute('.nav-toggle', 'aria-expanded'), 'false');
  await ctx.close();
});

for (const w of [320, 375, 768, 1024, 1440]) {
  test(`no horizontal overflow at ${w}px`, async () => {
    const { p, ctx } = await page({ viewport: { width: w, height: 800 } });
    await p.goto(`${BASE}/?validator=${IDENTITY}`);
    await p.waitForSelector('#results:not([hidden])');
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `overflow ${over}px`);
    await ctx.close();
  });
}

test('reduced motion disables animation', async () => {
  const { p, ctx } = await page({ reducedMotion: 'reduce' });
  await p.goto(BASE + '/');
  const dur = await p.$eval('.eyebrow .pulse', (e) => getComputedStyle(e).animationDuration);
  assert.ok(parseFloat(dur) < 0.01, dur);
  await ctx.close();
});
