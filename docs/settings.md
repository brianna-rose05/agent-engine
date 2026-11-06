# Settings: Slack notifications and per-project Anthropic keys

Two things the owner sets in Studio. Both need one-time setup in Slack or in Convex, described below. Settings are
owner-only; the People section on the same page (who can use Studio, and invites) is described in docs/accounts.md.

## Slack notifications

Every notification Studio already makes (a plan or a change waiting for approval, the tech lead needing you, a build
finished or stopped, the spending limit reached, a preview going live, ready to ship) can also be posted to a Slack
channel. The bell and email (`RESEND_API_KEY` + `NOTIFY_EMAIL`) keep working as before.

### Create the webhook (in Slack)

1. Go to <https://api.slack.com/apps> and choose **Create New App**, then **From scratch**. Name it "Studio" and pick
   your workspace.
2. In the app's settings, open **Incoming Webhooks** and switch **Activate Incoming Webhooks** on.
3. Choose **Add New Webhook to Workspace**, pick the channel the messages should go to, and allow it.
4. Copy the webhook URL. It looks like `https://hooks.slack.com/services/T…/B…/…`.

### Save it in Studio

Open **Settings** (bottom of the sidebar; the gear icon on a phone), paste the URL and choose **Save**, then
**Send a test message**. Studio only accepts `https://hooks.slack.com/services/…` URLs.

- The URL is a secret (anyone who has it can post to the channel). It's stored in Convex (the `settings` table) and
  never sent back to the app: Settings shows only its last 4 characters ("…/WXYZ"). To change it, choose **Replace**;
  **Remove** stops all posts.
- Each message is plain text: the notification's title (it names the project), its text, and a link to the project's
  page in Studio. **The link needs `APP_URL` set in Convex** (the same setting email uses, e.g.
  `npx convex env set APP_URL https://your-studio.vercel.app`); without it the message shows the page's path only.
- A notification is posted at most once: it is marked before the post, so a retried or repeated post never sends it
  twice. If Slack refuses or can't be reached, the reason is kept on the notification (`slack.status: "failed"`,
  `slack.error`) and nothing else is affected. It isn't retried.

Code: `web/convex/slack.ts` (rules, message, posting), `web/convex/settings.ts` (the Settings page's functions),
`web/convex/notifications.ts` `notifyFor` (schedules the post), `web/src/app/settings/page.tsx`.

## A project's own Anthropic API key (bring your own key)

By default every agent runs on Studio's key (`ANTHROPIC_API_KEY` in the worker's settings). On a project's **Plan** or
**Setup** page, the owner can paste their own Anthropic API key instead (choose **Use my own key**). From the next run
on (build, retry, change, quick change), every agent of that project (planner, QA, devs, referee, integrator, tech lead,
reviewer, architect, designer) uses that key, so its usage is billed to that Anthropic account. The page says which key
the project runs on: "Your key …abcd" or "Studio's key". **Remove** goes back to Studio's key.

The setup wizard's own AI calls (questions, requirements, stack, design) run in Convex and still use Studio's key.

### One-time setup: STUDIO_KEY_SECRET (in Convex)

Keys are stored encrypted (AES-256-GCM, bound to the project), with an encryption key derived from the
`STUDIO_KEY_SECRET` Convex environment variable. Until it's set, Studio refuses to save a key and says why.

The `Convex backend` workflow (.github/workflows/convex.yml) creates it automatically on the first deploy that finds it
missing (a random value, never printed) and never changes it afterwards. To set it by hand instead, use a long random
value (at least 32 characters):

```bash
cd web
npx convex env set STUDIO_KEY_SECRET "$(openssl rand -base64 32)"
```

(Add `--prod` to set it on the production deployment.) Don't print it or write it down anywhere else: Convex keeps it.

- **Changing or deleting `STUDIO_KEY_SECRET` makes every stored key unreadable.** A project with a stored key then
  refuses to start rather than quietly running on Studio's key: the run ends "failed" with the reason ("this project's
  own Anthropic API key can't be used: …") in the project's feed and in a notification. Paste the key again on the
  project's page, then retry. Shipping and rolling back run no agents, so they don't need a key and go ahead.
- A key is checked when you paste it: it must start with `sk-ant-` and be a plausible length. Whether Anthropic
  accepts it shows on the first run (an agent's error on the board).
- "Build again" makes a new project, which starts on Studio's key: paste the key there too.

### Where the key goes, and where it never goes

- The app only ever gets "is there a key" and its last 4 characters (`projectKeys.status`). `projects.get`,
  `projects.list` and `settings.get` never include it or its ciphertext (tested in `web/tests/project-key.test.ts`).
- Only `engine:projectForWorker` decrypts it, and only the worker can call that (it checks `ENGINE_SECRET`, which the
  worker and the Convex deploy derive from the deploy key). It returns `anthropicKey` (or `anthropicKeyProblem` when a
  stored key can't be decrypted).
- `worker.py` `use_anthropic_key` puts it in `ANTHROPIC_API_KEY` for the run, the variable every `ClaudeCLIAgent`
  reads and passes to its sandbox command's environment (never on a command line or on disk). Studio's key is not used
  by that run.
- It is registered with `engine/redact.py` (Studio's key too), so it's masked as `***` in every event
  (`Emitter.emit`), ship report (`engine/ship.py scrub`), deploy error (`engine/deploy.py Vercel.scrub`), the worker's
  `hide`, and in the worker's printed output (stdout and stderr are wrapped). The worker only prints which key it
  uses ("the project's own key" or "Studio's key"). Tested in `tests/test_project_key.py`.

Code: `web/convex/apiKey.ts` (rules, masking, encryption), `web/convex/projectKeys.ts`, `web/convex/engine.ts`
(`projectForWorker`), `web/src/components/ApiKeyCard.tsx`, `worker.py` (`use_anthropic_key`), `engine/redact.py`.
