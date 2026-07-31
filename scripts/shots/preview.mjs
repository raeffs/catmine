// Screenshot and measure the *dev* stylesheet without building the theme.
//
//   docker compose run --rm shots node scripts/shots/preview.mjs out projects/x 1600 '#header'
//
// Args: name [path] [width] [selector]
//
// The shots container hits Redmine directly on the compose network, bypassing
// the dev proxy on the host, so a normal capture or probe always shows the
// last ./build. This reads the
// compiled CSS straight off the mounted repo and injects it in place of the
// theme's own stylesheet, which makes dev-only state measurable in ~30s.
//
// Pass the path without a leading slash (`projects`, not `/projects`): Git Bash
// rewrites leading-slash arguments into Windows paths.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.REDMINE_URL ?? 'http://redmine:3000';
const CSS = readFileSync('/work/src/opale/stylesheets/application.css', 'utf8');
const [name = 'preview', rawPath = '/', width = '1600', selector] = process.argv.slice(2);
const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
const w = Number(width);

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: w, height: 900 } });
await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await p.fill('#username', 'admin');
await p.fill('#password', 'admin');
await p.click('input[type=submit]');
await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 });

await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
await p.evaluate(() => {
  document.querySelectorAll('link[rel=stylesheet]').forEach((l) => {
    if (l.href.includes('/themes/')) l.remove();
  });
});
await p.addStyleTag({ content: CSS });
await p.mouse.move(w - 40, 800);
await p.waitForTimeout(400);

if (selector) {
  const out = await p.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { error: `no element matched ${sel}` };
    const box = (n) => {
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const s = getComputedStyle(el);
    return {
      box: box(el),
      padding: s.padding,
      children: [...el.children].map((c) => ({
        el: c.tagName.toLowerCase() + (c.id ? `#${c.id}` : '') + (c.className ? `.${String(c.className).trim().split(/\s+/)[0]}` : ''),
        box: box(c),
      })),
    };
  }, selector);
  console.log(JSON.stringify(out, null, 2));
}

await p.screenshot({ path: `/work/shots/${name}.png`, clip: { x: 0, y: 0, width: w, height: 900 } });
await b.close();
