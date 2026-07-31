// Pure request/response helpers for the dev reverse proxy in ../dev.ts.
//
// These are deliberately free of I/O and side effects: scripts/dev.ts writes
// the overlay and spawns grunt at import time, so anything the tests need to
// reach has to live outside it.

/** Path prefix the proxy owns. Everything else is forwarded to Redmine. */
export const DEV_PREFIX = '/__catmine';

// Redmine 6 serves the theme through Propshaft under a content digest that is
// resolved once at boot - e.g. /assets/themes/catmine/application-58f0e05b.css.
// Matching the pathname (never the query) is what lets the reload script bust
// the cache by appending ?t= to the very same URL.
const THEME_STYLESHEET = /^\/assets\/themes\/catmine\/application-[0-9a-f]+\.css$/;

export function isThemeStylesheet(pathname: string): boolean {
  return THEME_STYLESHEET.test(pathname);
}

// The compiled CSS holds relative refs (../webfonts/tabler-icons.woff2) that
// Propshaft would normally rewrite to digested paths. Serving the file itself
// at the intercepted URL would resolve those against /assets/themes/catmine/
// and 404. An @import moves the resolution base to the imported file instead,
// so ../webfonts/... lands under DEV_PREFIX/theme/ where the proxy serves it.
export function importStub(version: string): string {
  return `@import url("${DEV_PREFIX}/theme/stylesheets/application.css?t=${version}");\n`;
}

const CONDITIONAL_REQUEST_HEADERS = [
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-unmodified-since',
  'if-range',
];

export function scrubRequestHeaders(headers: Headers, proxyOrigin: string): Headers {
  const out = new Headers(headers);
  // Without this Redmine answers 304 and the browser keeps its stale copy.
  for (const name of CONDITIONAL_REQUEST_HEADERS) out.delete(name);
  // Deno's fetch decompresses transparently, so ask for identity rather than
  // having to reason about a body that no longer matches its content-encoding.
  out.set('accept-encoding', 'identity');
  // `host` is a forbidden header for fetch - Deno drops it and sends the
  // upstream's own - so Redmine would build absolute URLs against :3000. That
  // is not just the Location header: the back_url embedded in a login redirect
  // would walk the browser off the proxy on the first sign-in. Rack reads
  // X-Forwarded-Host, which puts every generated URL back on the proxy.
  out.delete('host');
  const proxy = new URL(proxyOrigin);
  out.set('x-forwarded-host', proxy.host);
  out.set('x-forwarded-proto', proxy.protocol.replace(':', ''));
  return out;
}

const RESPONSE_VALIDATORS = ['etag', 'last-modified', 'expires'];

export function scrubResponseHeaders(
  headers: Headers,
  upstreamOrigin: string,
  proxyOrigin: string,
): Headers {
  const out = new Headers(headers);
  out.delete('content-encoding');
  out.delete('content-length');
  for (const name of RESPONSE_VALIDATORS) out.delete(name);
  // Redmine's digested assets are immutable-cached, which is what makes a
  // plain reload show stale chrome. On the dev port nothing is cached at all.
  out.set('cache-control', 'no-store');
  // Belt and braces behind X-Forwarded-Host: if a Redmine ever ignored that
  // (trusted-proxy config), at least plain redirects stay on the proxy.
  const location = out.get('location');
  if (location?.startsWith(upstreamOrigin)) {
    out.set('location', proxyOrigin + location.slice(upstreamOrigin.length));
  }
  return out;
}

const RELOAD_TAG = `<script src="${DEV_PREFIX}/reload.js"></script>`;

export function injectReloadScript(html: string): string {
  const at = html.lastIndexOf('</body>');
  if (at === -1) return html + RELOAD_TAG;
  return html.slice(0, at) + RELOAD_TAG + html.slice(at);
}

// Served at DEV_PREFIX/reload.js and injected into every HTML response.
// It bumps the real <link> rather than appending a second stylesheet, so the
// theme keeps its original position in the cascade and stays same-origin.
export const RELOAD_SCRIPT = `/* catmine dev live reload - injected in flight by scripts/dev.ts.
 * Never written to disk, so it cannot leak into a release build. */
(() => {
  'use strict';
  const VERSION_URL = '${DEV_PREFIX}/version';
  const THEME_LINK = 'link[href*="/assets/themes/catmine/application-"]';
  let version = null;

  const bump = (v) => {
    const link = document.querySelector(THEME_LINK);
    if (!link) return;
    const url = new URL(link.getAttribute('href'), location.href);
    url.searchParams.set('t', v);
    link.setAttribute('href', url.pathname + url.search);
  };

  const tick = () => {
    fetch(VERSION_URL, { cache: 'no-store' })
      .then((res) => res.text())
      .then((v) => {
        v = v.trim();
        if (!v || v === version) return;
        // The first reading is the CSS the page already loaded; only a later
        // change is worth a swap.
        if (version !== null) bump(v);
        version = v;
      })
      .catch(() => {})
      .finally(() => setTimeout(tick, 1000));
  };
  tick();
})();
`;
