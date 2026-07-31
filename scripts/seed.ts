// Seed a local Redmine instance with realistic demo data for theme development.
//
// Usage:
//   REDMINE_API_KEY=<admin api key> deno run --allow-net --allow-env --allow-run scripts/seed.ts
//
// Prerequisites (one-time, from the repo root):
//   docker compose exec -e REDMINE_LANG=en redmine bin/rails redmine:load_default_data
//
// The script is idempotent at the project level: if the main demo project
// already exists it aborts instead of duplicating data. Custom fields cannot
// be created through the REST API, so that single step shells out to
// `docker compose exec redmine bin/rails runner`.

const BASE_URL = Deno.env.get("REDMINE_URL") ?? "http://localhost:3000";
const API_KEY = Deno.env.get("REDMINE_API_KEY");

if (!API_KEY) {
  console.error("REDMINE_API_KEY is not set. Get it from /my/api_key or via:");
  console.error(
    `  docker compose exec redmine bin/rails runner "puts User.find_by_login('admin').api_key"`,
  );
  Deno.exit(1);
}

// deno-lint-ignore no-explicit-any
type Json = any;

async function api(
  method: string,
  path: string,
  body?: Json,
  impersonate?: string,
): Promise<Json> {
  const headers: Record<string, string> = {
    "X-Redmine-API-Key": API_KEY!,
    "Content-Type": "application/json",
  };
  if (impersonate) headers["X-Redmine-Switch-User"] = impersonate;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : await res.json().catch(() => null);
}

async function upload(filename: string, data: Uint8Array): Promise<string> {
  const res = await fetch(
    `${BASE_URL}/uploads.json?filename=${encodeURIComponent(filename)}`,
    {
      method: "POST",
      headers: {
        "X-Redmine-API-Key": API_KEY!,
        "Content-Type": "application/octet-stream",
      },
      body: data,
    },
  );
  if (!res.ok) throw new Error(`upload ${filename} -> ${res.status}`);
  return (await res.json()).upload.token;
}

function daysFromNow(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const step = (msg: string) => console.log(`\n==> ${msg}`);

// ---------------------------------------------------------------------------
// 0. Sanity checks
// ---------------------------------------------------------------------------
step("Checking instance state");

const trackers: Json[] = (await api("GET", "/trackers.json")).trackers;
if (trackers.length === 0) {
  console.error("No trackers found - default data is not loaded. Run:");
  console.error(
    "  docker compose exec -e REDMINE_LANG=en redmine bin/rails redmine:load_default_data",
  );
  Deno.exit(1);
}

const existing = (await api("GET", "/projects.json?limit=100")).projects;
if (existing.some((p: Json) => p.identifier === "catmine-demo")) {
  console.log("Project 'catmine-demo' already exists - nothing to do.");
  Deno.exit(0);
}

const statuses: Json[] = (await api("GET", "/issue_statuses.json"))
  .issue_statuses;
const priorities: Json[] =
  (await api("GET", "/enumerations/issue_priorities.json")).issue_priorities;
const activities: Json[] =
  (await api("GET", "/enumerations/time_entry_activities.json"))
    .time_entry_activities;
const roles: Json[] = (await api("GET", "/roles.json")).roles;

const tracker = Object.fromEntries(trackers.map((t) => [t.name, t.id]));
const status = Object.fromEntries(statuses.map((s) => [s.name, s.id]));
const priority = Object.fromEntries(priorities.map((p) => [p.name, p.id]));
const role = Object.fromEntries(roles.map((r) => [r.name, r.id]));

// ---------------------------------------------------------------------------
// 1. Custom fields + instance settings (not available via REST API)
// ---------------------------------------------------------------------------
step("Creating custom fields via rails runner (REST API cannot)");

const runnerScript = `
  Setting.text_formatting = 'common_mark'
  Setting.cross_project_issue_relations = '1'
  unless IssueCustomField.find_by_name('Severity')
    f = IssueCustomField.new(name: 'Severity', field_format: 'list',
      possible_values: %w[Minor Major Critical], is_for_all: true,
      is_filter: true, visible: true)
    f.tracker_ids = Tracker.pluck(:id)
    f.save!
  end
  unless IssueCustomField.find_by_name('Customer')
    f = IssueCustomField.new(name: 'Customer', field_format: 'string',
      is_for_all: true, is_filter: true, searchable: true, visible: true)
    f.tracker_ids = Tracker.pluck(:id)
    f.save!
  end
  puts 'custom fields ok'
`;
try {
  const cmd = new Deno.Command("docker", {
    args: ["compose", "exec", "-T", "redmine", "bin/rails", "runner", runnerScript],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success) {
    console.warn(new TextDecoder().decode(out.stderr));
    console.warn("WARN: custom field creation failed - continuing without.");
  }
} catch {
  console.warn("WARN: docker not available - skipping custom fields.");
}

const customFields: Json[] = (await api("GET", "/custom_fields.json"))
  .custom_fields ?? [];
const severityId = customFields.find((f: Json) => f.name === "Severity")?.id;
const customerId = customFields.find((f: Json) => f.name === "Customer")?.id;

// ---------------------------------------------------------------------------
// 2. Users
// ---------------------------------------------------------------------------
step("Creating users");

const userDefs = [
  { login: "alice", firstname: "Alice", lastname: "Keller" },
  { login: "bob", firstname: "Bob", lastname: "Tanner" },
  { login: "carol", firstname: "Carol", lastname: "Meier" },
];
const userIds: Record<string, number> = {};
const knownUsers = (await api("GET", "/users.json?limit=100")).users;
for (const u of userDefs) {
  const found = knownUsers.find((k: Json) => k.login === u.login);
  if (found) {
    userIds[u.login] = found.id;
    continue;
  }
  const created = await api("POST", "/users.json", {
    user: {
      ...u,
      mail: `${u.login}@example.test`,
      password: "password1234",
    },
  });
  userIds[u.login] = created.user.id;
  console.log(`  user ${u.login} (#${created.user.id})`);
}
const assignees = Object.values(userIds);

// ---------------------------------------------------------------------------
// 3. Projects, memberships, versions, categories
// ---------------------------------------------------------------------------
step("Creating projects");

const modules = [
  "issue_tracking",
  "time_tracking",
  "wiki",
  "calendar",
  "gantt",
  "news",
  "documents",
  "files",
  "boards",
];

async function createProject(
  identifier: string,
  name: string,
  description: string,
  parentId?: number,
): Promise<number> {
  const res = await api("POST", "/projects.json", {
    project: {
      name,
      identifier,
      description,
      is_public: true,
      parent_id: parentId,
      enabled_module_names: modules,
      tracker_ids: Object.values(tracker),
    },
  });
  console.log(`  project ${identifier} (#${res.project.id})`);
  return res.project.id;
}

const demoId = await createProject(
  "catmine-demo",
  "Catmine Demo",
  "Primary demo project used to exercise every page the theme has to style.",
);
const apiSubId = await createProject(
  "catmine-demo-api",
  "Catmine Demo - API",
  "Backend subproject.",
  demoId,
);
const uiSubId = await createProject(
  "catmine-demo-ui",
  "Catmine Demo - UI",
  "Frontend subproject.",
  demoId,
);
const sandboxId = await createProject(
  "catmine-sandbox",
  "Catmine Sandbox",
  "Secondary project so cross-project views have something to show.",
);

step("Adding memberships");
const memberRoles = [role["Manager"], role["Developer"]].filter(Boolean);
for (const pid of [demoId, apiSubId, uiSubId, sandboxId]) {
  for (const uid of assignees) {
    await api("POST", `/projects/${pid}/memberships.json`, {
      membership: { user_id: uid, role_ids: memberRoles },
    });
  }
}

step("Creating versions and categories");
// All versions start open so issues can be assigned; 0.9 is closed at the end.
const versionIds: number[] = [];
for (
  const [name, date] of [
    ["0.9", daysFromNow(-30)],
    ["1.0", daysFromNow(14)],
    ["1.1", daysFromNow(45)],
  ]
) {
  const v = await api("POST", `/projects/${demoId}/versions.json`, {
    version: { name, due_date: date, status: "open", sharing: "descendants" },
  });
  versionIds.push(v.version.id);
}
const categoryIds: number[] = [];
for (const name of ["Backend", "Frontend", "Documentation"]) {
  const c = await api("POST", `/projects/${demoId}/issue_categories.json`, {
    issue_category: { name },
  });
  categoryIds.push(c.issue_category.id);
}

// ---------------------------------------------------------------------------
// 4. Issues
// ---------------------------------------------------------------------------
step("Creating issues");

const longDescription = `## Steps to reproduce

1. Open the issue list with the sidebar filters expanded
2. Group the results by *assignee* and sort by priority
3. Resize the window below the tablet breakpoint

## What happens

The context menu overlaps the pagination controls and the group headers lose
their background. See the attached screenshot for the exact rendering.

| Browser | Version | Affected |
| ------- | ------- | -------- |
| Firefox | 128     | yes      |
| Chrome  | 126     | yes      |
| Safari  | 17      | no       |

## Relevant log excerpt

\`\`\`
ActionView::Template::Error (undefined method 'name' for nil:NilClass)
  app/views/issues/index.html.erb:42
\`\`\`

The regression was introduced when the sidebar became collapsible. A possible
fix is to scope the \`.contextual\` float inside \`#content\` only.
`;

interface IssueDef {
  project: number;
  subject: string;
  tracker: number;
  priority?: number;
  status?: number;
  assignee?: number;
  due?: string;
  start?: string;
  description?: string;
  version?: number;
  category?: number;
  estimated?: number;
  done?: number;
  parent?: number;
  cf?: { id: number; value: string }[];
}

const pri = (name: string) => priority[name];
const trk = (name: string) => tracker[name];

const subjects: [string, string, string][] = [
  // [tracker, priority, subject]
  ["Bug", "Urgent", "Login fails with 500 after session timeout"],
  ["Bug", "High", "Gantt bars overflow the chart area on narrow screens"],
  ["Bug", "Normal", "Wiki TOC links scroll past the sticky header"],
  ["Bug", "Low", "Typo on the account settings page"],
  ["Bug", "Immediate", "Data loss when two users edit the same wiki page concurrently and the conflict resolution dialog silently discards the older revision"],
  ["Feature", "High", "Add dark mode toggle"],
  ["Feature", "Normal", "Export issue list as PDF with custom columns"],
  ["Feature", "Normal", "Keyboard shortcuts for issue navigation"],
  ["Feature", "Low", "Show avatars in the activity stream"],
  ["Support", "Normal", "How do I bulk-move issues between projects?"],
  ["Support", "High", "LDAP sync stopped importing new accounts"],
  ["Bug", "Normal", "Calendar tooltip clipped at month boundaries"],
  ["Feature", "Urgent", "SSO"],
  ["Bug", "High", "Attachment thumbnails render rotated for portrait photos"],
  ["Feature", "Normal", "Per-project default assignee"],
  ["Bug", "Low", "Footer year is hardcoded"],
  ["Support", "Low", "Where are custom queries stored?"],
  ["Bug", "Normal", "Search results highlight wrong term when query contains an umlaut"],
  ["Feature", "High", "REST endpoint for saved queries"],
  ["Bug", "Normal", "Time report subtotal row misaligned when grouped by two criteria"],
];

const issueIds: number[] = [];
let i = 0;
for (const [t, p, subject] of subjects) {
  const overdue = i % 5 === 2;
  const closed = i % 6 === 4;
  const inProgress = !closed && i % 3 === 1;
  const def: IssueDef = {
    project: [demoId, demoId, apiSubId, uiSubId, sandboxId][i % 5],
    subject,
    tracker: trk(t),
    priority: pri(p),
    assignee: i % 4 === 3 ? undefined : assignees[i % 3],
    // Overdue issues get a due date after their start date but in the past.
    start: daysFromNow(-25 + i),
    due: overdue ? daysFromNow(-25 + i + 2 + (i % 3)) : daysFromNow(7 + i),
    status: closed
      ? status["Closed"]
      : inProgress
      ? status["In Progress"]
      : undefined,
    estimated: i % 3 === 0 ? 4 + (i % 5) * 2 : undefined,
    done: inProgress ? ((i * 10) % 90) : closed ? 100 : 0,
    version: i % 4 === 0 && [demoId, apiSubId, uiSubId].includes(
        [demoId, demoId, apiSubId, uiSubId, sandboxId][i % 5],
      )
      ? versionIds[i % versionIds.length]
      : undefined,
    category: [demoId].includes([demoId, demoId, apiSubId, uiSubId, sandboxId][i % 5])
      ? categoryIds[i % categoryIds.length]
      : undefined,
    description: i % 7 === 0 ? longDescription : `Demo issue for theme styling: ${subject}.`,
    cf: severityId && customerId
      ? [
        { id: severityId, value: ["Minor", "Major", "Critical"][i % 3] },
        { id: customerId, value: ["ACME Corp", "Globex", "Initech"][i % 3] },
      ]
      : undefined,
  };
  const payload: Json = {
    issue: {
      project_id: def.project,
      subject: def.subject,
      tracker_id: def.tracker,
      priority_id: def.priority,
      assigned_to_id: def.assignee,
      start_date: def.start,
      due_date: def.due,
      estimated_hours: def.estimated,
      done_ratio: def.done,
      fixed_version_id: def.version,
      category_id: def.category,
      description: def.description,
      custom_fields: def.cf,
    },
  };
  const created = await api("POST", "/issues.json", payload);
  const id = created.issue.id;
  issueIds.push(id);
  if (def.status) {
    await api("PUT", `/issues/${id}.json`, {
      issue: { status_id: def.status, done_ratio: def.done },
    });
  }
  i++;
}
console.log(`  ${issueIds.length} top-level issues`);

// Subtasks under the first feature issue, to exercise the issue hierarchy.
const parentForSubtasks = issueIds[5];
for (const s of ["Design tokens", "Toggle component", "Persist preference"]) {
  const created = await api("POST", "/issues.json", {
    issue: {
      project_id: demoId,
      subject: `Dark mode: ${s}`,
      tracker_id: trk("Feature"),
      parent_issue_id: parentForSubtasks,
      assigned_to_id: assignees[issueIds.length % 3],
      start_date: daysFromNow(-5),
      due_date: daysFromNow(10),
    },
  });
  issueIds.push(created.issue.id);
}

// Close the oldest version now that issues reference it, so the roadmap
// shows a completed milestone.
await api("PUT", `/versions/${versionIds[0]}.json`, {
  version: { status: "closed" },
});

// Relations, so the issue detail page shows the relations block.
await api("POST", `/issues/${issueIds[0]}/relations.json`, {
  relation: { issue_to_id: issueIds[1], relation_type: "relates" },
}).catch(() => console.warn("  WARN: relation skipped"));
await api("POST", `/issues/${issueIds[2]}/relations.json`, {
  relation: { issue_to_id: issueIds[3], relation_type: "blocks" },
}).catch(() => console.warn("  WARN: relation skipped"));

// ---------------------------------------------------------------------------
// 5. Attachments and threaded notes
// ---------------------------------------------------------------------------
step("Attaching files and adding notes");

// 1x1 red PNG, enough for Redmine to treat it as an image attachment.
const pngBytes = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const logBytes = new TextEncoder().encode(
  ["2026-07-22 09:14:03 ERROR undefined method 'name' for nil", "backtrace:",
    "  app/views/issues/index.html.erb:42", "  app/controllers/issues_controller.rb:87"].join("\n"),
);

for (const issueId of issueIds.slice(0, 3)) {
  const pngToken = await upload("screenshot.png", pngBytes);
  const logToken = await upload("production.log", logBytes);
  await api("PUT", `/issues/${issueId}.json`, {
    issue: {
      notes: "Attaching a screenshot and the relevant log excerpt.",
      uploads: [
        { token: pngToken, filename: "screenshot.png", content_type: "image/png" },
        { token: logToken, filename: "production.log", content_type: "text/plain" },
      ],
    },
  });
}

const noteBodies = [
  "I can reproduce this on a clean install. Marking as confirmed.",
  "This is caused by the collapsed sidebar rule:\n\n```css\n#sidebar.collapsed .contextual { float: none; }\n```\n\nRemoving the float fixes it but breaks the wiki page toolbar.",
  "> Removing the float fixes it but breaks the wiki page toolbar.\n\nThe toolbar has its own `.contextual` - we can scope the override to `#content > .contextual` instead.",
  "Scoped fix pushed, please retest with cache disabled.",
];
for (const issueId of issueIds.slice(0, 4)) {
  for (const [n, notes] of noteBodies.entries()) {
    await api(
      "PUT",
      `/issues/${issueId}.json`,
      { issue: { notes } },
      userDefs[n % userDefs.length].login,
    ).catch(async () =>
      // X-Redmine-Switch-User needs admin; fall back to plain notes.
      await api("PUT", `/issues/${issueId}.json`, { issue: { notes } })
    );
  }
}

// ---------------------------------------------------------------------------
// 6. Wiki pages
// ---------------------------------------------------------------------------
step("Creating wiki pages");

const wikiHome = `# Catmine Demo Wiki

{{toc}}

## Purpose

This wiki exists so every text-formatting construct the theme styles is
visible on one realistic page.

## Architecture overview

The demo application consists of three services:

| Service | Language | Port | Notes |
| ------- | -------- | ---- | ----- |
| api     | Ruby     | 3000 | Rails, serves the REST API |
| worker  | Ruby     | -    | Sidekiq background jobs |
| ui      | TypeScript | 5173 | Vite dev server |

## Configuration example

\`\`\`yaml
production:
  adapter: postgresql
  database: redmine
  username: redmine
  pool: 10
\`\`\`

## Inline formatting

This paragraph has **bold**, *italic*, \`inline code\`, ~~strikethrough~~,
a [link to the issues list](/projects/catmine-demo/issues), and a footnote-like
reference to [[Deployment]].

> Blockquotes should be visually distinct from body text, including when they
> span multiple lines and contain \`inline code\`.
`;

const wikiDeploy = `# Deployment

{{toc}}

## Checklist

1. Tag the release
2. Wait for CI to attach the package
3. Unpack into \`themes/\`

## Rollback

\`\`\`bash
cd /var/www/redmine/themes
rm -rf catmine && tar xzf catmine-previous.tar.gz
\`\`\`

Unordered variant:

- config backup
- database backup
  - schema
  - data
- asset clobber
`;

await api("PUT", `/projects/${demoId}/wiki/Wiki.json`, {
  wiki_page: { text: wikiHome, comments: "Seeded demo page" },
});
await api("PUT", `/projects/${demoId}/wiki/Deployment.json`, {
  wiki_page: { text: wikiDeploy, parent_title: "Wiki", comments: "Seeded demo page" },
});
await api("PUT", `/projects/${sandboxId}/wiki/Wiki.json`, {
  wiki_page: { text: "# Sandbox\n\nMinimal wiki page.", comments: "Seeded" },
});

// ---------------------------------------------------------------------------
// 7. Time entries
// ---------------------------------------------------------------------------
step("Creating time entries");

const devActivity = activities.find((a: Json) => a.name === "Development") ??
  activities[0];
const designActivity = activities.find((a: Json) => a.name === "Design") ??
  activities[0];

let entries = 0;
for (const [n, issueId] of issueIds.slice(0, 10).entries()) {
  const body = {
    time_entry: {
      issue_id: issueId,
      hours: 0.5 + (n % 4) * 1.25,
      spent_on: daysFromNow(-n * 2),
      activity_id: (n % 2 === 0 ? devActivity : designActivity).id,
      comments: n % 3 === 0 ? "Investigation and fix" : "Implementation",
      user_id: assignees[n % 3],
    },
  };
  // user_id needs admin; retry without it if the instance rejects it.
  await api("POST", "/time_entries.json", body).catch(async () => {
    delete body.time_entry.user_id;
    await api("POST", "/time_entries.json", body);
  });
  entries++;
}
console.log(`  ${entries} time entries`);

// ---------------------------------------------------------------------------
// 8. News
// ---------------------------------------------------------------------------
step("Creating news");
await api("POST", `/projects/${demoId}/news.json`, {
  news: {
    title: "Demo environment seeded",
    summary: "Everything on this instance is generated by scripts/seed.ts.",
    description:
      "Reseed at any time by resetting the database volume and re-running the script.",
  },
}).catch(() => console.warn("  WARN: news creation not supported, skipped"));

console.log("\nDone. Log in at " + BASE_URL + " (admin / admin).");
