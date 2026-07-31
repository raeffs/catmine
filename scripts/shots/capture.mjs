// Capture a screenshot of every page in the catalogue.
//
// Runs inside the `shots` compose service, which provides the Playwright
// browser and reaches Redmine by service name on the internal network.
// Entry point: `deno task shots` from the repo root.
import { chromium } from 'playwright';
import { mkdir, rm } from 'node:fs/promises';
import { tilePlan } from './tiles.mjs';
import { PAGES, selectPages } from './pages.mjs';

const BASE = process.env.REDMINE_URL ?? 'http://redmine:3000';
const OUT = process.env.SHOTS_OUT ?? '/work/screenshots';
const VIEWPORT = { width: Number(process.env.SHOTS_WIDTH || 1440), height: 900 };
// Comma-separated slugs, narrowing the sweep while iterating on one
// component. A filtered run also skips the wipe below, so it tops up
// screenshots/ instead of emptying it.
const ONLY = process.env.SHOTS_ONLY ?? '';
// Appended to every output stem, so a run at a second viewport does not
// overwrite the first run's files.
const SUFFIX = process.env.SHOTS_SUFFIX ?? '';

// Redmine takes roughly 25 seconds to boot, and `depends_on` only waits for the
// container to start, not for Rails to answer.
async function waitForRedmine(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/login`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Redmine did not answer at ${BASE} within ${timeoutMs / 1000}s. ` +
      `Is the stack up? Run: docker compose up -d`,
  );
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin');
  await page.click('input[type=submit]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
    timeout: 15_000,
  });
}

// Without this check a misconfigured run silently produces a full set of
// stock-theme screenshots, which look plausible until you compare them.
async function assertTheme(page) {
  const classes = await page.evaluate(() => document.body.className);
  if (!classes.split(/\s+/).includes('theme-Catmine')) {
    throw new Error(
      `The Catmine theme is not active (body class: "${classes}").\n` +
        `  - select Catmine in Administration > Settings > Display, and\n` +
        `  - run ./build -n catmine && docker compose restart redmine`,
    );
  }
}

async function resolveFrom(page, { path, selector, index = 0, suffix = '' }) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  const hrefs = await page.$$eval(
    selector,
    (els) => els.map((e) => e.getAttribute('href')),
  );
  if (hrefs.length === 0) {
    throw new Error(`no link matched "${selector}" on ${path}`);
  }
  const href = index < 0 ? hrefs.at(index) : hrefs[index];
  if (!href) {
    throw new Error(
      `no link at index ${index} for "${selector}" on ${path} ` +
        `(${hrefs.length} matched)`,
    );
  }
  return href.replace(BASE, '') + suffix;
}

// Returns { files, clipped, capturedPx, totalPx }. `clipped` is true when the
// tiles do not reach the bottom of the page (the tile cap was hit).
async function capture(page, entry) {
  const path = entry.from ? await resolveFrom(page, entry.from) : entry.path;
  const response = await page.goto(`${BASE}${path}`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });

  // A 404, a 500, or a redirect to /login after a mid-run session expiry all
  // otherwise produce a plausible screenshot and a silent "ok" line.
  const status = response?.status();
  const statusOk = entry.expectStatus
    ? status === entry.expectStatus
    : status < 400;
  if (!statusOk) throw new Error(`${path} returned HTTP ${status}`);

  const settledPath = new URL(page.url()).pathname;
  if (settledPath.startsWith('/login') && !path.startsWith('/login')) {
    throw new Error(`${path} redirected to /login - session was lost mid-run`);
  }

  if (entry.media === 'print') await page.emulateMedia({ media: 'print' });
  try {
    if (entry.fullPage) {
      await page.screenshot({ path: `${OUT}/${entry.slug}${SUFFIX}.png`, fullPage: true });
      return { files: 1, clipped: false };
    }
    const height = await page.evaluate(() =>
      document.documentElement.scrollHeight
    );
    const offsets = tilePlan(height, VIEWPORT.height, entry.maxTiles ?? 3);
    for (const [i, y] of offsets.entries()) {
      await page.evaluate((offset) => window.scrollTo(0, offset), y);
      await page.waitForTimeout(150);
      const name = offsets.length === 1
        ? `${entry.slug}${SUFFIX}.png`
        : `${entry.slug}${SUFFIX}-${i + 1}.png`;
      await page.screenshot({ path: `${OUT}/${name}` });
    }
    const lastOffset = offsets[offsets.length - 1];
    const capturedPx = Math.min(lastOffset + VIEWPORT.height, height);
    const clipped = capturedPx < height;
    return { files: offsets.length, clipped, capturedPx, totalPx: height };
  } finally {
    if (entry.media === 'print') await page.emulateMedia({ media: 'screen' });
  }
}

await waitForRedmine();
const entries = selectPages(PAGES, ONLY);
// A full sweep starts from an empty directory so deleted catalogue entries
// cannot leave stale files behind. A filtered run must not, or re-shooting
// one page would destroy the other thirty - so gate on the filter being
// empty, not on it happening to match every slug.
if (ONLY === '') {
  await rm(OUT, { recursive: true, force: true });
}
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
});
const failures = [];

// One failing page must not cost the whole sweep, so each entry is isolated.
async function run(page, entries) {
  for (const entry of entries) {
    try {
      const { files: n, clipped, capturedPx, totalPx } = await capture(
        page,
        entry,
      );
      const clipNote = clipped
        ? `, clipped: ${capturedPx} of ${totalPx}px`
        : '';
      console.log(
        `  ok    ${entry.slug} (${n} file${n === 1 ? '' : 's'}${clipNote})`,
      );
    } catch (err) {
      failures.push([entry.slug, err.message]);
      console.log(`  FAIL  ${entry.slug}: ${err.message}`);
    }
  }
}

const page = await context.newPage();
await run(page, entries.filter((e) => e.auth === false));

await login(page);
await assertTheme(page);
await run(page, entries.filter((e) => e.auth !== false));

await browser.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${entries.length} pages failed:`);
  for (const [slug, message] of failures) console.error(`  ${slug}: ${message}`);
  process.exit(1);
}
console.log(`\nAll ${entries.length} pages captured to screenshots/`);
