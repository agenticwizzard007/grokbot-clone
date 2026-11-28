# Artifacts

Saved bot outputs appear in a searchable library across the signed-in account's bots and explicitly shared artifacts. The existing `#reports` and bot-scoped report links remain valid. `/artifacts/:id` opens a particular artifact after authentication, including return navigation after provider sign-in.

Sharing grants an existing account on the same server access to one immutable artifact. Owners can add or remove members and choose view or comment access. Both roles can preview and download; only owners can change membership or use delivery actions. Copying a link grants no access and adding a member sends no notification. The owner can share the copied link themselves. Deployment tenant fences still apply: this does not enable collaboration between isolated per-user tenant deployments.

Collaboration is a persisted discussion, refreshed every 15 seconds while the page is visible. Comments use a request ID to deduplicate retries. Saved artifact bytes remain immutable; this feature does not implement live document editing. Members and comments are stored in SQLite with cascading artifact/user ownership.

HTML previews are sandboxed without scripts or same-origin access and use a restrictive CSP. Markdown, code, text, and raster images have previews; unsupported formats and text over 1 MB offer download. The original integrity-checked download path supports explicitly authorized collaborators. Delivery history, recipients, retry, and reconciliation remain owner-only.

Run `npm run test:artifacts` for account/access tests and the real-server browser journey. The latter creates isolated local test accounts and records desktop, mobile, and dark-theme screenshots in `.context/artifacts/`. Run `npm run typecheck` and `npm run build -w web` for compile checks.
