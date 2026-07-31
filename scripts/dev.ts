// Development watch loop for the catmine theme, with live reload.
//
// Usage (from the repo root):
//   deno task dev
//
// What it does:
//   1. Overlays src/_custom-variables.scss and src/custom/ into the opale
//      submodule and injects the `@use "custom-variables";` line, exactly
//      like ./build does.
//   2. Runs an initial Sass compile, then `npm run watch` (grunt) inside
//      src/opale so every save recompiles src/opale/stylesheets/application.css.
//   3. Re-syncs both whenever any .scss under src/ or src/custom/ changes,
//      which triggers the grunt watcher.
//   4. Serves a reverse proxy on http://localhost:3001 that forwards
//      everything to Redmine on :3000 except:
//        - the Propshaft-digested theme stylesheet, answered with an @import
//          pointing at the live compile;
//        - /__catmine/*, the proxy's own endpoints (live assets, the compile
//          version, the reload script).
//      Every proxied response has its caching stripped, so a plain reload on
//      :3001 is always authoritative, and every HTML response gets the reload
//      script injected in flight.
//
// Redmine is never restarted: the digest URL it resolved at boot still gets
// requested, the proxy just answers it differently. Nothing is written to
// dist/, so a hard kill leaves nothing planted and nothing can leak into a
// release build. With this stopped, :3000 still serves the last built theme
// as a normal, styled page.
//
// Environment:
//   CATMINE_DEV_PORT  port for the proxy (default 3001)
//   REDMINE_URL       upstream Redmine origin (default http://localhost:3000)
//
// Do not run ./build while this is running - the build's cleanup step would
// rip the overlay out from under the watcher.

import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { copy } from "jsr:@std/fs@1";
import {
  DEV_PREFIX,
  importStub,
  injectReloadScript,
  isThemeStylesheet,
  RELOAD_SCRIPT,
  scrubRequestHeaders,
  scrubResponseHeaders,
} from "./dev/proxy.ts";

const repoRoot = dirname(dirname(fromFileUrl(import.meta.url)));
const opaleDir = join(repoRoot, "src", "opale");
const customVars = join(repoRoot, "src", "_custom-variables.scss");
const overlayTarget = join(opaleDir, "src", "sass", "_custom-variables.scss");
const customDir = join(repoRoot, "src", "custom");
const overlayCustomDir = join(opaleDir, "src", "sass", "custom");
const applicationScss = join(opaleDir, "src", "sass", "application.scss");
const compiledCss = join(opaleDir, "stylesheets", "application.css");
const distThemeDir = join(repoRoot, "dist", "catmine");

const PORT = Number(Deno.env.get("CATMINE_DEV_PORT") ?? "3001");
const UPSTREAM = (Deno.env.get("REDMINE_URL") ?? "http://localhost:3000").replace(/\/$/, "");
const USE_LINE = '@use "custom-variables";';

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function run(cmd: string, args: string[], cwd?: string): Promise<boolean> {
  const out = await new Deno.Command(cmd, { args, cwd }).output();
  return out.success;
}

// The overlay is a file plus a directory. The directory is removed rather
// than copied over, so a partial deleted from src/custom/ does not linger in
// the submodule and keep compiling.
async function syncOverlay(): Promise<void> {
  await Deno.copyFile(customVars, overlayTarget);
  await Deno.remove(overlayCustomDir, { recursive: true }).catch(() => {});
  await copy(customDir, overlayCustomDir);
}

if (!(await exists(join(opaleDir, "package.json")))) {
  console.error("src/opale is missing - run: git submodule update --init");
  Deno.exit(1);
}
if (!(await exists(customVars))) {
  console.error("src/_custom-variables.scss not found.");
  Deno.exit(1);
}
if (!(await exists(customDir))) {
  console.error("src/custom/ not found.");
  Deno.exit(1);
}
// The theme still has to be installed and selected in Redmine's settings -
// otherwise there is no <link> for the proxy to intercept. It no longer has
// to be a recent build.
if (!(await exists(distThemeDir))) {
  console.error(
    "dist/catmine does not exist - run ./build -n catmine once first,\n" +
      "and make sure Catmine is the selected theme in Redmine.",
  );
  Deno.exit(1);
}

// --- Teardown (registered first so cleanup() is available everywhere) ------
let watcherProcess: Deno.ChildProcess | undefined;
let cleaningUp = false;

async function cleanup(): Promise<never> {
  if (cleaningUp) Deno.exit(1);
  cleaningUp = true;
  console.log("\n==> Cleaning up");
  try {
    watcherProcess?.kill();
  } catch { /* already gone */ }
  await Deno.remove(overlayTarget).catch(() => {});
  await Deno.remove(overlayCustomDir, { recursive: true }).catch(() => {});
  await run("git", ["-C", opaleDir, "restore", "."]);
  Deno.exit(0);
}

Deno.addSignalListener("SIGINT", () => void cleanup());
if (Deno.build.os === "windows") {
  Deno.addSignalListener("SIGBREAK", () => void cleanup());
}

// --- 1. Overlay ------------------------------------------------------------
console.log("==> Overlaying custom variables into src/opale");
await syncOverlay();
const scss = await Deno.readTextFile(applicationScss);
if (!scss.startsWith(USE_LINE)) {
  await Deno.writeTextFile(applicationScss, `${USE_LINE}\n${scss}`);
}

// --- 2. npm install + initial compile + grunt watch ------------------------
if (!(await exists(join(opaleDir, "node_modules")))) {
  console.log("==> Installing npm dependencies in src/opale (first run)");
  if (!(await run("npm", ["install", "--silent"], opaleDir))) {
    console.error("npm install failed");
    await cleanup();
  }
}

console.log("==> Initial Sass compile");
if (!(await run("npx", ["grunt", "css"], opaleDir))) {
  console.error("Initial compile failed - check src/_custom-variables.scss and src/custom/");
  await cleanup();
}

console.log("==> Starting grunt watch (npm run watch) in src/opale");
watcherProcess = new Deno.Command("npm", {
  args: ["run", "watch"],
  cwd: opaleDir,
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
watcherProcess.status.then((s) => {
  if (!cleaningUp) {
    console.error(`grunt watch exited unexpectedly (code ${s.code})`);
    cleanup();
  }
});

// --- 3. Re-sync the custom sass on change ----------------------------------
(async () => {
  let pending: number | undefined;
  // Both paths are watched non-recursively and src/ is watched for the entry
  // file only: a recursive watch on src/ would cover src/opale, which grunt
  // rewrites on every compile, and each compile would retrigger the sync.
  const watcher = Deno.watchFs([join(repoRoot, "src"), customDir], {
    recursive: false,
  });
  for await (const event of watcher) {
    if (!event.paths.some((p) => p.endsWith(".scss"))) continue;
    clearTimeout(pending);
    pending = setTimeout(async () => {
      if (await exists(customVars)) {
        await syncOverlay();
        console.log("==> Synced custom sass into src/opale");
      }
    }, 100);
  }
})();

// --- 4. Reverse proxy ------------------------------------------------------
const contentTypes: Record<string, string> = {
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json",
};

async function compiledVersion(): Promise<string> {
  const stat = await Deno.stat(compiledCss).catch(() => null);
  return String(stat?.mtime?.getTime() ?? 0);
}

// The submodule holds opale's own webfonts (tabler-icons); this repo's live in
// src/webfonts and only reach the submodule's sibling directory at ./build
// time. Falling back to src/ keeps every self-hosted face resolving.
async function serveThemeAsset(pathname: string): Promise<Response> {
  const rel = pathname.slice(`${DEV_PREFIX}/theme/`.length).replaceAll("..", "");
  const ext = rel.slice(rel.lastIndexOf("."));
  try {
    const body = await Deno.readFile(join(opaleDir, rel))
      .catch(() => Deno.readFile(join(repoRoot, "src", rel)));
    return new Response(body, {
      headers: {
        "content-type": contentTypes[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

async function forward(req: Request, url: URL): Promise<Response> {
  const res = await fetch(UPSTREAM + url.pathname + url.search, {
    method: req.method,
    headers: scrubRequestHeaders(req.headers, url.origin),
    body: req.body,
    redirect: "manual",
  });
  const headers = scrubResponseHeaders(res.headers, UPSTREAM, url.origin);
  if ((res.headers.get("content-type") ?? "").includes("text/html")) {
    return new Response(injectReloadScript(await res.text()), {
      status: res.status,
      headers,
    });
  }
  return new Response(res.body, { status: res.status, headers });
}

Deno.serve({ port: PORT, onListen: () => {} }, async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (isThemeStylesheet(path)) {
    return new Response(importStub(await compiledVersion()), {
      headers: { "content-type": "text/css", "cache-control": "no-store" },
    });
  }
  if (path === `${DEV_PREFIX}/version`) {
    return new Response(await compiledVersion(), {
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
    });
  }
  if (path === `${DEV_PREFIX}/reload.js`) {
    return new Response(RELOAD_SCRIPT, {
      headers: { "content-type": "text/javascript", "cache-control": "no-store" },
    });
  }
  if (path.startsWith(`${DEV_PREFIX}/theme/`)) return await serveThemeAsset(path);

  return await forward(req, url);
});

console.log(`==> Proxy ready: open http://localhost:${PORT} (upstream ${UPSTREAM})`);
console.log("==> Edit src/_custom-variables.scss or src/custom/*.scss and save. Ctrl-C to stop.");
