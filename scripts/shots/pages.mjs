// Catalogue of the pages a screenshot run captures. Adding coverage is a
// one-line edit here; this file deliberately contains no logic.
//
//   slug      output filename stem (required, unique, kebab-case)
//   path      URL path to capture (required unless `from` is given)
//   from      resolve the path from a link on another page:
//             { path, selector, index = 0, suffix = '' }
//             a negative index counts from the end of the match list
//   auth      false to capture logged out (default true)
//   fullPage  true for one tall image instead of scroll tiles (default false)
//   maxTiles  cap on the number of scroll tiles (default 3)
//   media     'print' to render with print styles (default 'screen')
//   expectStatus  HTTP status the navigation must return (default: any < 400)

const DEMO = '/projects/catmine-demo';

const ISSUE_LINKS = {
  path: `${DEMO}/issues?sort=id`,
  selector: 'table.issues td.id a',
};

export const PAGES = [
  // Unauthenticated.
  { slug: 'login', path: '/login', auth: false },

  // Global.
  { slug: 'home', path: '/' },
  { slug: 'projects', path: '/projects' },
  { slug: 'my-page', path: '/my/page' },
  { slug: 'my-account', path: '/my/account' },
  { slug: 'search', path: '/search?q=wiki' },
  {
    slug: 'user-profile',
    from: {
      path: `${DEMO}/settings/members`,
      selector: '#tab-content-members a[href^="/users/"]',
    },
  },

  // Project.
  { slug: 'project-overview', path: DEMO },
  { slug: 'project-activity', path: `${DEMO}/activity` },
  { slug: 'project-settings', path: `${DEMO}/settings` },
  { slug: 'roadmap', path: `${DEMO}/roadmap` },
  {
    slug: 'version',
    from: { path: `${DEMO}/roadmap`, selector: 'a[href^="/versions/"]' },
  },
  { slug: 'news', path: `${DEMO}/news` },
  { slug: 'documents', path: `${DEMO}/documents` },
  { slug: 'files', path: `${DEMO}/files` },
  { slug: 'boards', path: `${DEMO}/boards` },
  { slug: 'time-entries', path: `${DEMO}/time_entries` },
  { slug: 'time-report', path: `${DEMO}/time_entries/report` },

  // Wiki.
  { slug: 'wiki', path: `${DEMO}/wiki` },
  { slug: 'wiki-deployment', path: `${DEMO}/wiki/Deployment` },
  { slug: 'wiki-index', path: `${DEMO}/wiki/index` },

  // Issues. The first issue carries attachments, threaded notes from three
  // users and a relation, so it exercises the most components; the last one
  // shows the minimal layout.
  { slug: 'issue-list', path: `${DEMO}/issues?set_filter=1` },
  {
    slug: 'issue-list-grouped',
    path: `${DEMO}/issues?set_filter=1&group_by=status`,
  },
  { slug: 'issue-detail', from: ISSUE_LINKS },
  { slug: 'issue-detail-plain', from: { ...ISSUE_LINKS, index: -1 } },
  { slug: 'issue-edit', from: { ...ISSUE_LINKS, suffix: '/edit' } },
  { slug: 'issue-new', path: `${DEMO}/issues/new` },
  { slug: 'issue-summary', path: `${DEMO}/issues/report` },
  { slug: 'gantt', path: `${DEMO}/issues/gantt` },
  { slug: 'calendar', path: `${DEMO}/issues/calendar` },
  // A missing record inside the app layout, not Rails' bare error page -
  // exercises the themed chrome around a 404 rather than dead unstyled markup.
  { slug: 'error-404', path: '/issues/99999999', expectStatus: 404 },

  // Admin.
  { slug: 'admin', path: '/admin' },
  { slug: 'admin-settings-display', path: '/settings?tab=display' },
  { slug: 'admin-users', path: '/users' },
  { slug: 'admin-roles-permissions', path: '/roles/permissions' },

  // Print. The theme's @media print block was written against the Sass source
  // and has never been looked at.
  { slug: 'issue-detail-print', from: ISSUE_LINKS, media: 'print' },
];

// Narrows a run to a few slugs while iterating on one component. Catalogue
// order is preserved rather than the caller's, so the unauthenticated pages
// still come first. An unknown slug is an error, not a silent empty run -
// a typo would otherwise look like a clean pass.
/**
 * @param {typeof PAGES} pages
 * @param {string} only
 * @returns {typeof PAGES}
 */
export function selectPages(pages, only) {
  const wanted = only.split(',').map((s) => s.trim()).filter(Boolean);
  if (wanted.length === 0) return pages;
  const known = new Set(pages.map((p) => p.slug));
  const missing = wanted.filter((s) => !known.has(s));
  if (missing.length > 0) {
    throw new Error(`unknown slug(s): ${missing.join(', ')}`);
  }
  const set = new Set(wanted);
  return pages.filter((p) => set.has(p.slug));
}
