import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { tilePlan } from './tiles.mjs';
import { PAGES, selectPages } from './pages.mjs';

Deno.test('a page shorter than the viewport is one tile at the top', () => {
  assertEquals(tilePlan(800, 900), [0]);
});

Deno.test('a page exactly the viewport height is one tile', () => {
  assertEquals(tilePlan(900, 900), [0]);
});

Deno.test('a slightly taller page clamps the second tile to the page end', () => {
  assertEquals(tilePlan(1000, 900), [0, 100]);
});

Deno.test('a very tall page stops at the tile cap', () => {
  assertEquals(tilePlan(5000, 900, 3), [0, 900, 1800]);
});

Deno.test('the final tile is clamped rather than scrolling past the end', () => {
  assertEquals(tilePlan(2000, 900, 3), [0, 900, 1100]);
});

Deno.test('a tile cap of one always yields a single tile', () => {
  assertEquals(tilePlan(5000, 900, 1), [0]);
});

Deno.test('every slug is unique', () => {
  const slugs = PAGES.map((p) => p.slug);
  assertEquals(new Set(slugs).size, slugs.length);
});

Deno.test('every slug is filename safe', () => {
  for (const p of PAGES) {
    assert(/^[a-z0-9-]+$/.test(p.slug), `${p.slug} is not kebab-case`);
  }
});

Deno.test('every entry has a path or a from resolver', () => {
  for (const p of PAGES) {
    assert(p.path || p.from, `${p.slug} has neither path nor from`);
  }
});

Deno.test('every from resolver names a page and a selector', () => {
  for (const p of PAGES.filter((e) => e.from)) {
    assert(p.from?.path, `${p.slug}: from.path is missing`);
    assert(p.from?.selector, `${p.slug}: from.selector is missing`);
  }
});

Deno.test('every path is root relative', () => {
  for (const p of PAGES.filter((e) => e.path)) {
    assert(p.path?.startsWith('/'), `${p.slug}: path must start with /`);
  }
});

Deno.test('every expectStatus is a number', () => {
  for (const p of PAGES.filter((e) => 'expectStatus' in e)) {
    assertEquals(
      typeof p.expectStatus,
      'number',
      `${p.slug}: expectStatus must be a number`,
    );
  }
});

Deno.test('an empty filter selects every page', () => {
  assertEquals(selectPages(PAGES, '').length, PAGES.length);
});

Deno.test('a filter selects only the named pages, in catalogue order', () => {
  const selected = selectPages(PAGES, 'home,login');
  assertEquals(selected.map((p) => p.slug), ['login', 'home']);
});

Deno.test('a filter tolerates whitespace and empty entries', () => {
  assertEquals(selectPages(PAGES, ' home , ,login ').map((p) => p.slug), [
    'login',
    'home',
  ]);
});

Deno.test('an unknown slug is an error naming the slug', () => {
  assertThrows(
    () => selectPages(PAGES, 'home,nosuchpage'),
    Error,
    'nosuchpage',
  );
});
