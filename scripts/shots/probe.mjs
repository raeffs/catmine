// Ask the browser what a selector actually computes to, instead of capturing
// and squinting at a PNG.
//
//   docker compose run --rm shots node scripts/shots/probe.mjs '#top-menu'
//   docker compose run --rm shots node scripts/shots/probe.mjs '#header' projects font-size
//
// Args: selector [path] [comma-separated extra properties]
//
// The path may be given with or without a leading slash. Prefer without: Git
// Bash rewrites a leading-slash argument into a Windows path before the
// container ever sees it, turning "/" into "C:/Program Files/Git/".
//
// Prints the element's box, a default set of layout properties, any extra
// properties asked for, and the box of every child. The children are the
// point: gaps between them are what a screenshot makes you guess at, and a
// rule that loses on specificity looks identical to one that was never
// written until you read the computed value.
import { chromium } from 'playwright';

const BASE = process.env.REDMINE_URL ?? 'http://redmine:3000';
const [selector, rawPath = '/', extra = ''] = process.argv.slice(2);
const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

if (!selector) {
  console.error('usage: probe.mjs <selector> [path] [prop,prop,...]');
  process.exit(1);
}

const DEFAULT_PROPS = [
  'display',
  'position',
  'width',
  'height',
  'min-height',
  'padding',
  'margin',
  'align-items',
  'font-size',
  'line-height',
];
const props = [...DEFAULT_PROPS, ...extra.split(',').map((s) => s.trim()).filter(Boolean)];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// Same credentials the capture harness uses; the seeded stack has no other user
// with admin visibility over every page worth probing.
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('#username', 'admin');
await page.fill('#password', 'admin');
await page.click('input[type=submit]');
await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });

await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });

const result = await page.evaluate(
  ([sel, wanted]) => {
    const el = document.querySelector(sel);
    if (!el) return { error: `no element matched ${sel}` };
    const boxOf = (n) => {
      const { x, y, width, height } = n.getBoundingClientRect();
      return { x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) };
    };
    const style = getComputedStyle(el);
    return {
      box: boxOf(el),
      computed: Object.fromEntries(wanted.map((p) => [p, style.getPropertyValue(p)])),
      children: [...el.children].map((c) => ({
        tag: c.tagName.toLowerCase(),
        id: c.id || undefined,
        class: c.className || undefined,
        text: (c.textContent ?? '').trim().slice(0, 40) || undefined,
        box: boxOf(c),
      })),
    };
  },
  [selector, props],
);

await browser.close();

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
console.log(JSON.stringify(result, null, 2));
