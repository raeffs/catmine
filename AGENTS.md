# catmine

## Issue tracker

Issues live on Redmine: https://projects.raeffs.dev/projects/catmine

## Feedback Loop

Fast feedback is key to reproduce bugs and verify fixes:

- Start Redmine if not running: `docker compose up -d` (starts Redmine at http://localhost:3000)
- Start the Dev Server: `deno task dev` (starts live-reload Proxy at http://localhost:3001)
- Edit `src/custom/*.scss` and verify
- Ask the User to manually verify if not sure
