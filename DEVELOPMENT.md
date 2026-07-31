# Developing catmine

The workflows for building catmine, iterating on it locally, capturing
screenshots, and keeping it in sync with upstream Opale. For an overview of the
theme see [`README.md`](README.md); for the contribution ground rules (and the
one rule — never edit `src/opale/`) see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Building

```bash
./build -n catmine                    # → dist/catmine/
./build -n catmine -v 1.0.0 package   # → dist/catmine-1.0.0.tar.gz
```

Requires Node.js and git. Without `-b <branch>` the build uses the pinned
submodule commit, which is what you want for reproducible output; passing it
switches the submodule to that branch's tip.

**Windows:** run from Git Bash, or upstream's `npm run lint` breaks. Under npm's
default cmd.exe shell, stylelint expands `src/sass/**/*.scss` recursively and
hits a pre-existing lint error in `plugins/redmine_backlogs/taskboard.scss` that
upstream's Linux `bash` never lints.

```bash
npm_config_script_shell="C:\Program Files\Git\bin\bash.exe" ./build -n catmine
```

## Local development

### Quickstart

```bash
./build -n catmine                  # produce dist/catmine (mounted into the container)
docker compose up -d                # Redmine 7 + Postgres 17 on http://localhost:3000
docker compose exec -e REDMINE_LANG=en redmine bin/rails redmine:load_default_data
docker compose exec redmine bin/rails runner \
  "u = User.find_by_login('admin'); u.update_columns(must_change_passwd: false); \
   Setting.rest_api_enabled = '1'; puts u.api_key"
REDMINE_API_KEY=<key from above> deno task seed   # realistic demo data
```

Log in as `admin` / `admin` and pick **Catmine** under **Administration →
Settings → Display**.

In Git Bash, prefix `docker compose exec` commands that touch container paths
with `MSYS_NO_PATHCONV=1` to stop path mangling.

### The edit loop

Propshaft (Redmine 7's asset pipeline) only re-detects changed assets **at
boot** (per the patch in `config/initializers/10-patches.rb`), so a changed CSS
file is invisible to a running server. The loop that works:

1. **Iterate with live reload:**

   ```bash
   deno task dev
   ```

   This overlays `src/_custom-variables.scss` and `src/custom/` into the
   submodule, runs Opale's grunt watcher (recompiles ~2 s after each save), and
   starts a reverse proxy on `http://localhost:3001`. Browse `:3001`, not
   `:3000`: the proxy forwards everything to Redmine untouched except the theme
   stylesheet, which it answers from the live compile. It also strips caching
   (a plain F5 is authoritative) and swaps the stylesheet when the compile
   timestamp changes. Ctrl-C restores the submodule and exits. Don't run
   `./build` while `deno task dev` is running.

2. **Verify for real, then commit:**

   ```bash
   ./build -n catmine && docker compose restart redmine
   ```

   The restart (~20 to 30 s) makes Redmine recompile assets at boot and serve
   the CSS under a new fingerprint on `:3000`.

### Screenshots

```bash
deno task shots
```

Captures every page the theme styles into `screenshots/` (gitignored), using a
containerised Playwright browser on the compose network.

Preconditions: the stack is up and seeded, `./build -n catmine` has run, the
container has been restarted since, and Catmine is selected. The script checks
all of these except seeding. Don't run a capture while `deno task dev` is
running.

Three env vars narrow or retarget a run:

```bash
docker compose run --rm \
  -e SHOTS_ONLY=home,login -e SHOTS_WIDTH=430 -e SHOTS_SUFFIX=-narrow shots
```

`SHOTS_ONLY` takes comma-separated slugs and errors on an unknown one. A
filtered run appends to `screenshots/` instead of wiping it, so `SHOTS_SUFFIX`
keeps a second viewport's files from overwriting the first's. `SHOTS_WIDTH`
defaults to 1440; height is fixed at 900.

Pages are captured as scroll tiles (`issue-detail-1.png`, `-2.png`, …) rather
than one tall image that would downscale to illegibility; set `fullPage: true`
on an entry when whole-page layout is the question. Adding coverage is a
one-line edit to `scripts/shots/pages.mjs`: an entry takes a `path`, or a
`from: { path, selector, index, suffix }` block that resolves the URL from a
link on another page. `deno task test` checks the catalogue for duplicate slugs
and malformed entries without a browser. No baselines, no diffing.

`RAILS_ENV=development` won't help here: the official `redmine:7` image excludes
the development gem group, so boot dies with `Gem::LoadError: listen is not part
of the bundle`, and detection otherwise runs only at boot anyway.

## Favicon and logo

- **Favicon:** put it at `src/favicon/favicon.ico`, exactly that name, and no
  other visible files in that directory. Redmine links the *first* file it finds
  in the theme's `favicon/` dir (hence the hidden `.gitkeep` placeholder).
- **Logo:** `src/images/logo/logo.png`, wired as described in
  [`src/images/logo/README.md`](src/images/logo/README.md). Needs
  `$use-logo: true` plus the size variables; a logo taller than 40px also needs
  `$header-padding-vertical` raised.

## Updating upstream Opale

```bash
git -C src/opale pull origin master
./build -n catmine && docker compose restart redmine   # visually verify
git add src/opale && git commit -m "Bump opale to <version>"
```

### After bumping the Opale submodule

Three things in `_workarounds.scss` and `_top-menu.scss` are coupled to
upstream's source and won't fail loudly if it changes:

1. The focus-ring rule mirrors the exact selector list Opale applies its
   `form-control-focus` mixin to (`src/opale/src/sass/components/_forms.scss`).
   It wins on specificity, so an input type added upstream would silently revert
   to the un-inverted shadow. Re-diff the list.
2. The `@media print` block enumerates the dark surfaces that survive printing.
   Re-run `grep -rn 'bubble-bg\|panel-bg\|issue-bg' src/opale/src/sass` and
   check each consumer is either hidden by Opale's print styles or listed in our
   block.
3. `_top-menu.scss` restates `margin-right: 0` to beat upstream's `#account > ul
   > li` rule (`components/_top.scss:163-167`), and derives the 40px strip from
   `$line-height-computed` and `$padding-large-vertical` staying 20px and 10px.
   Re-check both.

Also re-run after a bump: the palette swap pushes some upstream
`color.adjust()` lightness/saturation calls out of gamut (Frappé's pastels start
much lighter than Opale's stock colours), emitting `hsl()` with a channel over
100% that browsers drop entirely. Find them by building and searching the
compiled CSS for `hsl(` values above 100%.

## Releasing and deploying

The repo is primary on Forgejo (`code.raeffs.dev/raeffs-dot-dev/catmine`) and
mirrored to GitHub (`github.com/raeffs/catmine`). A Forgejo **push
mirror** replicates commits and tags to GitHub; GitHub releases are the public
download point.

To cut a release, push a `vX.Y.Z` tag to Forgejo. The release workflow checks
out with submodules, runs `./build -n catmine -v <tag> package`, and creates a
**GitHub** release (`raeffs/catmine`) with `catmine-<tag>.tar.gz` and
its `.sha256` attached, authenticating with the `RELEASES_GITHUB_TOKEN` Actions
secret. A tag containing a `-` suffix (e.g. `v0.1.0-rc1`) is published as a
prerelease. A separate workflow lints and builds on every push to `main` and
every PR. Both assume a runner with the `docker` label; adjust `runs-on` for
your instance.

To deploy, unpack the archive into the instance's `themes/` directory and
restart; full consumer instructions live in [`src/README.md`](src/README.md).

## Redmine 7 asset-pipeline gotchas

1. Redmine 7 loads themes from **`themes/`** in the project root, not
   `public/themes/` (Redmine ≤5). The bundled `alternate`/`classic` themes live
   inside the app, but `themes/` is still the right place for custom themes.
2. **Propshaft** content-hashes compiled asset filenames
   (`application-bb23a61b.css`): the file on disk isn't the file the browser
   requests.
3. Asset-update detection (`config.assets.redmine_detect_update`, on by default
   in production) runs **only at boot**. Restart to pick up theme changes. If
   assets are genuinely stuck: `bundle exec rake assets:precompile
   RAILS_ENV=production`, then `assets:clobber` as a last resort.
4. A theme is **CSS + optional JS only** (`javascripts/theme.js`). There's no
   template-override mechanism, so don't attempt markup changes.
