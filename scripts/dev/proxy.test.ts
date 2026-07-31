import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  DEV_PREFIX,
  importStub,
  injectReloadScript,
  isThemeStylesheet,
  RELOAD_SCRIPT,
  scrubRequestHeaders,
  scrubResponseHeaders,
} from './proxy.ts';

Deno.test('the digested theme stylesheet is recognised', () => {
  assert(isThemeStylesheet('/assets/themes/catmine/application-58f0e05b.css'));
});

Deno.test('the matcher takes a pathname, so a query string must be stripped first', () => {
  // The reload script busts the cache by appending ?t=, so the matcher only
  // ever sees the pathname - but pin the contract, since passing a full URL
  // would silently stop intercepting every reload after the first.
  assert(!isThemeStylesheet('/assets/themes/catmine/application-58f0e05b.css?t=1'));
  assert(
    isThemeStylesheet(
      new URL('http://x/assets/themes/catmine/application-58f0e05b.css?t=1').pathname,
    ),
  );
});

Deno.test('another theme is not intercepted', () => {
  assert(!isThemeStylesheet('/assets/themes/opale/application-58f0e05b.css'));
});

Deno.test('redmine own assets are not intercepted', () => {
  assert(!isThemeStylesheet('/assets/responsive-194751d3.css'));
  assert(!isThemeStylesheet('/assets/themes/catmine/theme-8e38258f.js'));
  assert(!isThemeStylesheet('/assets/themes/catmine/tabler-icons-f9c16d3f.woff2'));
});

Deno.test('the import stub points at the dev theme path and carries the version', () => {
  assertEquals(
    importStub('1750000000000'),
    `@import url("${DEV_PREFIX}/theme/stylesheets/application.css?t=1750000000000");\n`,
  );
});

Deno.test('conditional request headers are stripped so redmine cannot answer 304', () => {
  const out = scrubRequestHeaders(
    new Headers({ 'if-none-match': 'W/"abc"', 'if-modified-since': 'x', cookie: 'session=1' }),
    'http://localhost:3001',
  );
  assertEquals(out.get('if-none-match'), null);
  assertEquals(out.get('if-modified-since'), null);
  assertEquals(out.get('cookie'), 'session=1');
});

Deno.test('the upstream request asks for an unencoded body', () => {
  const out = scrubRequestHeaders(
    new Headers({ 'accept-encoding': 'gzip, br' }),
    'http://localhost:3001',
  );
  assertEquals(out.get('accept-encoding'), 'identity');
});

Deno.test('the proxy origin is forwarded so redmine builds urls against it', () => {
  // Without this, the back_url Redmine embeds in the login redirect points at
  // :3000 and signing in walks the browser off the proxy.
  const out = scrubRequestHeaders(new Headers(), 'http://localhost:3001');
  assertEquals(out.get('x-forwarded-host'), 'localhost:3001');
  assertEquals(out.get('x-forwarded-proto'), 'http');
});

Deno.test('response validators are stripped and caching is disabled', () => {
  const out = scrubResponseHeaders(
    new Headers({
      etag: 'W/"abc"',
      'last-modified': 'x',
      expires: 'y',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': 'text/css',
    }),
    'http://localhost:3000',
    'http://localhost:3001',
  );
  assertEquals(out.get('etag'), null);
  assertEquals(out.get('last-modified'), null);
  assertEquals(out.get('expires'), null);
  assertEquals(out.get('cache-control'), 'no-store');
  assertEquals(out.get('content-type'), 'text/css');
});

Deno.test('content encoding and length are dropped because deno decompresses', () => {
  const out = scrubResponseHeaders(
    new Headers({ 'content-encoding': 'gzip', 'content-length': '42' }),
    'http://localhost:3000',
    'http://localhost:3001',
  );
  assertEquals(out.get('content-encoding'), null);
  assertEquals(out.get('content-length'), null);
});

Deno.test('a redirect back to the upstream origin is rewritten to the proxy', () => {
  const out = scrubResponseHeaders(
    new Headers({ location: 'http://localhost:3000/my/page?x=1' }),
    'http://localhost:3000',
    'http://localhost:3001',
  );
  assertEquals(out.get('location'), 'http://localhost:3001/my/page?x=1');
});

Deno.test('a relative redirect and a foreign origin are left alone', () => {
  const rel = scrubResponseHeaders(
    new Headers({ location: '/login' }),
    'http://localhost:3000',
    'http://localhost:3001',
  );
  assertEquals(rel.get('location'), '/login');
  const foreign = scrubResponseHeaders(
    new Headers({ location: 'https://example.com/' }),
    'http://localhost:3000',
    'http://localhost:3001',
  );
  assertEquals(foreign.get('location'), 'https://example.com/');
});

Deno.test('the reload script is injected before the closing body tag', () => {
  const out = injectReloadScript('<html><body><p>hi</p></body></html>');
  assertEquals(
    out,
    `<html><body><p>hi</p><script src="${DEV_PREFIX}/reload.js"></script></body></html>`,
  );
});

Deno.test('the last closing body tag wins', () => {
  const out = injectReloadScript('<body><pre>&lt;/body&gt;</pre></body>');
  assert(out.endsWith(`<script src="${DEV_PREFIX}/reload.js"></script></body>`));
});

Deno.test('html without a closing body tag still gets the script', () => {
  assertStringIncludes(injectReloadScript('<p>fragment</p>'), `${DEV_PREFIX}/reload.js`);
});

Deno.test('the reload script polls the version endpoint', () => {
  assertStringIncludes(RELOAD_SCRIPT, `${DEV_PREFIX}/version`);
});
