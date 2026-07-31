// Scroll offsets for capturing a page as viewport-sized tiles.
//
// Full-page screenshots of a long page are downscaled to illegibility by the
// time an agent reads them, so a tall page is captured as a few full-resolution
// tiles instead. The last tile is clamped to the page end so it never shows a
// blank strip below the content.
export function tilePlan(pageHeight, viewportHeight, maxTiles = 3) {
  if (pageHeight <= viewportHeight) return [0];
  const count = Math.min(Math.ceil(pageHeight / viewportHeight), maxTiles);
  const maxOffset = pageHeight - viewportHeight;
  return Array.from(
    { length: count },
    (_, i) => Math.min(i * viewportHeight, maxOffset),
  );
}
