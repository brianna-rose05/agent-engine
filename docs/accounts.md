# Accounts: Studio sign-in for more than one person

Studio started with one owner who unlocks it with a passphrase. Now people can have their own accounts, each
with a role, while the passphrase keeps working exactly as before, so the owner can never be locked out.

- **The owner passphrase** (`OWNER_PASSPHRASE` in Convex) always acts as role **owner**. Nothing about it changed:
  the gate's "Use the owner passphrase instead" link takes it, and every call accepts it.
- **Accounts** sign in with email and password. There is no open sign-up: an owner invites each person.

Code: `web/convex/accounts.ts` (sign-in, invites, people), `web/convex/owner.ts` (`requireRole`),
`web/convex/credentials.ts` (hashing, tokens, rate limit, input rules). Tests: `web/tests/accounts.test.ts`.

## Roles

| Role | Can |
|---|---|
| viewer | Read: projects, plans, boards, channels, history, preview pins, quick changes, notifications. Nothing that changes a project. |
| editor | Everything a viewer can, plus start projects and the setup wizard, approve or send back plans and changes, request changes and quick changes, answer the tech lead, retry, rebuild, build saved features, ship, roll back (checkpoints and production), pins. |
| owner | Everything, plus people and invites, settings (Slack), a project's Anthropic API key, spending limits, and the owner setup codes of generated apps. |

### Every function, mapped

Every public Convex function that takes `key` checks a role first (`requireRole(ctx, key, role)` in queries and
mutations, `requireRoleInAction` in actions). A test scans `web/convex` to keep it that way.

| Minimum role | Functions |
|---|---|
| none (anyone with the link) | `projects.checkKey` (says who `key` is; never throws), `accounts.signIn`, `accounts.inviteInfo`, `accounts.acceptInvite`, `accounts.signOut` (deletes only the caller's own session) |
| viewer | `projects.list`, `projects.get`, `quick.forProject`, `comments.forProject`, `projectKeys.status` (which key, last 4 characters only), `notifications.recent`, `notifications.markRead`, `notifications.markAllRead` |
| editor | `projects.create`, `projects.retryFailed`, `projects.answerAndRetry`, `projects.requestChange`, `projects.rebuild`, `projects.decide`, `projects.buildSaved`, `quick.requestQuickChange`, `comments.add`, `comments.update`, `comments.resolve`, `comments.remove`, `comments.sendComments`, `ship.shipNow`, `ship.rollbackProduction`, `checkpoints.rollbackTo`, wizard: `wizard.answer`, `wizard.lockQuestions`, `wizard.editStory`, `wizard.editFeature`, `wizard.lockRequirements`, `wizard.lockStack`, `wizard.chooseLook`, `wizard.lockDesign` and the actions `wizard.generateQuestions`, `wizard.generateRequirements`, `wizard.addStory`, `wizard.recommendStack`, `wizard.generateDesign` |
| owner | `projects.setBudget`, `projects.ensureSetupCodes`, `settings.get`, `settings.setSlackWebhook`, `settings.removeSlackWebhook`, `settings.testSlack`, `projectKeys.set`, `projectKeys.remove`, `accounts.people`, `accounts.createInvite`, `accounts.setRole`, `accounts.removePerson`, `accounts.revokeInvite` |
| engine secret (unchanged) | `engine.projectForWorker`, `engine.record`: the worker's `ENGINE_SECRET` paths, not accounts |

Two choices worth knowing:

- **Marking notifications read** is allowed for viewers. Read state is shared (one bell for everyone), and it
  changes nothing about a project; without it a viewer's bell could never be cleared.
- **`projects.get` hides the owner setup codes** (`setupCodes: {}`) from editors and viewers: whoever enters one
  becomes the admin of the generated app, so they stay with owners like the API key does.

Errors say what's missing: "You can look but not change things. Ask the owner for edit access." (editor
needed), "Only the owner can do this." (owner needed), "Please sign in again." (unknown or expired session),
"Wrong passphrase." (anything else).

## How it works

- **`key`** is still the one argument every call carries: the passphrase or a session token (it starts with
  `sst_`). The browser keeps it in localStorage (`studio.owner`), as it kept the passphrase.
- **Passwords**: PBKDF2-SHA256 through Web Crypto, 210,000 rounds, a random 16-byte salt per person, stored as
  `pbkdf2-sha256$<rounds>$<salt>$<hash>`. At least 10 characters. Hashing runs in actions (`signIn`,
  `acceptInvite`), which have time for it.
- **Sessions**: a random 32-byte token, given to the browser once; the `sessions` table keeps only its SHA-256.
  A session lasts 30 days. Signing out deletes it; removing a person deletes all of theirs.
- **Rate limit**: 10 failed sign-ins per email in 15 minutes, then sign-in for that email waits until the
  window ends (table `signInAttempts`). A successful sign-in clears the counter. A wrong email and a wrong
  password get the same message and take the same time.
- **Invites**: an owner enters an email and a role on **Settings > People**. Studio shows the link
  (`/join?token=...`) once, to copy. The token is random, only its SHA-256 is stored, it works once and for 7
  days. A new invite for the same email replaces the old link. Owners can revoke open invites, change roles and
  remove people (an account can't demote or remove itself; another owner or the passphrase can).
- **Invite email** (optional): when `RESEND_API_KEY` and `APP_URL` are set in Convex, Studio also emails the link
  to the invited address with the same Resend sender as notification emails (`NOTIFY_FROM`).
- **Who did what**: projects, change requests, quick changes and pins made by an account record `{id, name}`
  (`createdBy` on the project, `by` on the others) and show "by Name" in their lists. The passphrase records
  nothing, as before.
- **What never leaves the backend**: password hashes, token hashes and tokens. `accounts.people` returns names,
  emails, roles and dates; `accounts.inviteInfo` returns only the email, role and whether the link still works.

## In the app

- The gate shows **Sign in** (email and password); **Use the owner passphrase instead** switches to the passphrase.
- The sidebar footer shows your name and role, with **Sign out**.
- Viewers see actions turned off with "Ask the owner for edit access" and a banner on each project. Editors see
  owner-only things (spending limit, API key, settings) as read-only.
- **Settings > People** (owners): everyone with an account, open invites, and the invite form.

## Setup

Nothing new is required: the passphrase works as it did, and the new tables are created on the next Convex deploy.
For invite emails, set `RESEND_API_KEY` (already used for notification emails) and `APP_URL` (the Studio URL,
e.g. `https://studio.example.com`) in Convex.
