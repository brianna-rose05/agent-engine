# The designer: screenshots of every page before the app merges

Every automated check on a web app is about whether it works: types, lint, tests, a production build, every page
answering. None of them looks at it. A page can pass all of that and still run off the side of a phone, hide its
heading under the nav bar, or come out as raw unstyled HTML. Until now nothing caught that before the owner did.

Now a designer looks at the integrator's work before it merges. It runs on Sonnet, a different model from a Haiku dev
(on a Sonnet project it is still a separate run that never saw the integrator's session), so no agent grades its own
work. It reads screenshots: the CLI agent opens PNG files with its Read tool and sees the image.

## When it runs
- Only for the integrator (task `INT`), in a new build, a retry ("Build saved features" included) and a change
  request. Never for feature tasks, QA, quick changes, or the reviewer, architect and tech lead tasks.
- Only after an integration attempt has passed its whole-app check (types, lint, every test, `next build`, every page
  answering). An attempt that fails its check is never looked at.
- Not when the spending limit doesn't allow it: the attempt merges without a design review (`skipped: true`,
  reason "the spending limit didn't allow a design review").
- Not when no screenshot can be taken (no Chromium, the app didn't start): it merges without one (`skipped: true`, with
  the reason). A working app is never held back by the screenshot step.

## Screenshots
The template's `scripts/screenshots.mjs` (a template file, reserved in engine/stacks.py, so no agent may edit it)
runs in the integrator's own sandbox, after the attempt's work is committed and while the production build is still
there:

```
node scripts/screenshots.mjs /book /my-bookings      <- the pages the plan requires; static pages in src/app are found
```

- It starts the built app in local mode the way `scripts/check-app.mjs` does (no `DATABASE_URL`: an in-process
  Postgres, no real data touched), and opens every static page in Playwright Chromium at desktop 1280x800 and phone
  390x844.
- It saves `review/screens/<page>-<width>.png` (`/` is `home`, `/staff/schedule` is `staff-schedule`) and
  `review/screens/manifest.json`: `{shots: [{route, width, height, file, title, page_height, cut,
  horizontal_scroll}], skipped: [{route, reason}], seconds}`.
- The phone window is a plain 390 px wide window, not an emulated phone: a phone browser zooms out to fit a page that
  is too wide, which would hide the very problem we look for. Content wider than the screen is cut off at the right
  edge, as a visitor sees it, and `horizontal_scroll` flags the page.
- Each shot is the top of the page, at most 2400 px tall (`cut: true` when the page is longer).
- Exit codes: 0 shots taken; 1 the app didn't start or no page could be shot; 2 the app isn't built; 3 no browser.

**The limit: it sees what a signed-out visitor sees.** It never signs in and the local database is empty, so the
designer reviews the public pages (home, sign-in, sign-up, owner setup, anything else that renders without a session)
and pages that render without data. A page that redirects a signed-out visitor (to sign-in) is listed under
`skipped` and not shot: the page it lands on is shot on its own. Dynamic routes (`[id]`) are never visited. Signed-in
pages with data are left to the owner's own review on the preview; signing in with a seeded local account is the next
step if this proves too narrow.

**Playwright and Chromium.** The template doesn't depend on Playwright. When it can't find it (in the project, in
`~/.cache/studio-playwright`, or installed globally), the script installs `playwright@1.63.0` into
`~/.cache/studio-playwright` (never into the project or its `node_modules`), then `playwright install --with-deps
chromium`, falling back to the browser alone when system packages can't be installed (no root). It prints how long
that took. Measured in this container: 2 s to install the package, 29 s for Chromium and its system packages (already
present), 5-7 s for the screenshots of a small app. A fresh Daytona sandbox that needs the system packages too is
likely 1-3 minutes, once per sandbox; the step's timeout is 15 minutes. `--no-install` turns the install off.

Nothing in `review/` is ever merged: the attempt's work was committed before the screenshots were taken, and the
sandbox is thrown away after the review.

## What it sees and decides
It runs in the same sandbox, as `INT-design` (`INT-design2` for its second look), with its own rules
(`DESIGNER_RULES` in engine/agents/prompt.py) and instructions (`DESIGNER_SPEC` in engine/designer.py):
- every screenshot's path, page, width and title, with "scrolls sideways" or "cut at 2400 px" when the manifest says
  so, and the pages that weren't shot with why;
- the brief: the "## Pages" section (each page's route, name and purpose) and the "## Look and feel" section (the
  Look the owner chose in the setup wizard's Design step: name, description, palette, font, corners). The wizard's
  `composeSpec` (web/convex/wizard.ts) writes both into the project description the planner gets;
  `design_brief` (engine/designer.py) takes just those sections. A description without them (made before the wizard)
  is passed on whole, cut to 4000 characters.

It writes `review/INT-design.json`:

```json
{"verdict": "approve" or "changes",
 "comments": ["<page> (<width>): <the specific visual problem, where, and how to fix it>", ...]}
```

It may ask for changes **only** for clear visual defects: content overflowing or cut off, horizontal scroll on the
phone, overlapping elements, unreadable contrast, missing styling (raw unstyled HTML), a broken or empty layout, text
that contradicts the page's purpose. **Never for taste**: colours, fonts, spacing, wording or layout choices that
work, even where they differ from the Look. When unsure, it approves. An approval may carry comments as notes.

## What happens next
- **approve**: the attempt counts as passed and merges.
- **changes** (its first look): the attempt counts as failed with the reason "the designer requested changes". The
  integrator gets **exactly one more try**, whatever tries it had left, with feedback that starts "Your previous
  attempt passed the whole-app check, but the designer (a different model) looked at screenshots..." and lists the
  comments. The integrator's spec already asks for pages that fit a 390 px phone and use the brief's look.
- That try passes its check: the designer looks again, told what it asked for the first time.
  - approve: it merges.
  - **changes again: it merges anyway**, and the comments are kept as **design warnings** (`warnings: true`). The
    owner sees them on the board and the Ship screen and decides.
- That try fails its check (or errors, or the spending limit stops it): **the attempt the designer reviewed merges
  after all**, with its comments as design warnings (a `design_review` with `warnings: true` on that attempt and a
  `reason` saying why). A design comment never costs the owner a working app.
- **A broken review never blocks anything.** If the designer crashes, writes no file, or writes one that isn't valid,
  the attempt merges and the event says `designer_error: true` with a reason.

## Events (task-scoped, task id = INT)
- `task_status {status: "design_review", attempt}` while it looks (the app: "Designer reviewing", board column
  Checking)
- `design_review {verdict, comments, attempt, warnings?, designer_error?, skipped?, reason?}`
- then that attempt's `attempt_finished` (passed, or failed with "the designer requested changes" and the comments as
  its output), and `merging`/`merged` or the extra try
- the designer's own cost: `attempt_finished` on task `INT-design` (never queued, so never a card; the app and
  Convex add its cost to the project's total), and it counts toward the spending limit.

## In the app
- The feed has a Designer with its own avatar (a palette) and colour (indigo, `--color-design`): "Designer looked at
  every page on desktop and phone and approved the pages.", "Designer asked for changes to the pages: <first
  comment>", "Designer still sees problems in the pages; they merge anyway, with design warnings: ...", "Design review
  skipped (<reason>)...", or a line saying the review couldn't run.
- The integration card shows the designer's avatar while it looks. The board drawer shows its verdicts as messages
  between the tries they are about, each comment with its page and a phone or desktop tag.
- The Ship screen's "What's in this version" shows the design warnings the last build left (read-only): they never
  block shipping, and a quick change can fix them.

## Using it from the Ship screen
`review_design` (engine/designer.py) is the whole step as one function: screenshots, then the designer, in any sandbox
where the app is built. It never raises. To add a "design" check to the Ship screen's list:

```python
from engine.designer import design_brief, review_design
# in engine/ship.py run_checks, after the "pages" check passed (the box has the production build):
v = review_design(box, designer_agent(budget), brief=design_brief(project["description"]), routes=pages,
                  task_id="SHIP")
# v: {verdict, comments, warnings?, designer_error?, skipped?, reason?, cost_usd, turns, seconds, claim, screens}
```

- Report it as `ship_check {name: "design", label: "Design review"}`; a "changes" verdict is best reported as passed
  with the comments as its detail (the same "warnings, never blocking" rule as the build), and skipped/designer_error
  as passed with the reason.
- Add `{name: "design", label: "Design review"}` to `SHIP_CHECKS` in web/convex/ship.ts and to `CHECKS` in
  engine/ship.py (and keep `check_commands` from splitting it out of the integration check command).
- `run_ship_mode` in worker.py needs the project's description for the brief, and a `designer_agent` (Sonnet).
- Count its `cost_usd` toward the project, as the build does.

## Where it lives
- engine/designer.py: `review_design`, `make_designer`, `take_screenshots`, `design_brief`, `DESIGNER_SPEC`,
  `parse_design_review`, `normalize_design_review`, `DESIGN_CHANGES`.
- engine/engine.py: the design step in the attempt loop (`_design_review`, `_merge_design_fallback`).
- engine/interfaces.py: `Task.review_design`.
- engine/project.py: `integration_task(designer=..., budget=...)` (only the integrator gets the hook), and the
  `designer` argument of `run_project`, `resume_project` and `change_project`.
- engine/agents/prompt.py: `DESIGNER_RULES`. engine/stacks.py: scripts/screenshots.mjs is reserved.
- templates/next-supabase/scripts/screenshots.mjs.
- worker.py: `designer_agent` (Sonnet), passed to all three flows.
- web/src/lib/designer.ts, `design_review` in web/src/lib/reduce.ts, web/src/components/Designer.tsx, the board
  drawer, the Ship page's "What's in this version"; tests in web/tests/designer.test.ts and tests/test_designer.py.
