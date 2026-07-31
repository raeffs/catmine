# catmine: a Redmine theme

A customized build of the [Opale Redmine theme](https://github.com/gagnieray/opale)
targeting Redmine 7.

## Installation

1. Unpack the release archive into the `themes/` directory in the root of
   your Redmine installation:

   ```bash
   tar xzf catmine-<version>.tar.gz -C /path/to/redmine/themes/
   mv /path/to/redmine/themes/catmine-<version> /path/to/redmine/themes/catmine
   ```

   You should end up with `themes/catmine/stylesheets/application.css`.

2. Restart Redmine so the asset pipeline picks up the new files. If styles
   still look stale, run:

   ```bash
   bundle exec rake assets:precompile RAILS_ENV=production
   ```

3. In Redmine, go to **Administration → Settings → Display** and select
   **Catmine** as the theme.

## Licenses

- Content of the `stylesheets` directory is released under the
  [GNU Affero General Public License v3.0 or later](https://www.gnu.org/licenses/agpl-3.0).
- The `webfonts` directory bundles font families under their own licences:
  **Tabler Icons** under the
  [MIT License](https://github.com/tabler/tabler-icons/blob/main/LICENSE); and
  **Lexend** and **Fantasque Sans Mono**, both under the
  [SIL Open Font License 1.1](https://openfontlicense.org) (full texts in
  `webfonts/LICENSE-Lexend.txt` and `webfonts/LICENSE-FantasqueSansMono.txt`).
