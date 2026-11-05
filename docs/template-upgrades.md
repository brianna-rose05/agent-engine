# Template upgrades: new dependency versions and existing projects

The web template (`templates/next-supabase`) owns more than `src/lib`: its `package.json` and `package-lock.json`,
the lint and TypeScript settings, `next.config.ts`, the check scripts and `AGENTS.md` are all template files
(`NextSupabaseStack.template_files()`, everything except `src/app/`). `upgrade_template` (engine/stacks.py) copies
them into an existing project's repo, in one commit on main, at the start of every retry, change, quick change,
rollback and Ship run (worker.py). That is how template fixes reach projects nobody may otherwise edit.

## The November 2026 upgrade: Next 16 and zod 4

| package              | before   | after   | why                                                                 |
| -------------------- | -------- | ------- | ------------------------------------------------------------------- |
| `next`               | 15.5.28  | 16.4.1  | Next 15 bundles postcss 8.4.31 (GHSA-qx2v-qp2m-jg93, GHSA-6g55-p6wh-862q, GHSA-fxqj-rqcc-2cmp, GHSA-r28c-9q8g-f849; fixed in postcss > 8.5.22). The newest 15.5.x (15.5.29) still bundles 8.4.31; the first Next with postcss 8.5.23 is 16.3.0, but 16.0.0 to 16.4.0 carry critical/high Next advisories of their own (GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr, GHSA-p3m5-59mp-jv5r and more). 16.4.1 is the first clean one. |
| `eslint-config-next` | 15.5.28  | 16.4.1  | matches `next`; ships native flat configs                          |
| `zod`                | 3.24.1   | 4.6.6   | GHSA-mrhx-c7xc-m3w5 (memory exhaustion), fixed in 4.6.6             |
| `@eslint/eslintrc`   | ^3       | removed | only `FlatCompat` used it                                           |

React stays 19.1.0 (the App Router uses the React build bundled in Next either way). `npm audit --omit=dev
--audit-level=high` is clean (two low advisories in `@supabase/auth-js` remain), so the security check's
`ACCEPTED` list (`scripts/check-security.mjs`) is now empty. The mechanism stays for the next advisory that only a
major upgrade can fix.

What changed in the template itself:
- `eslint.config.mjs`: `eslint-config-next/core-web-vitals` and `eslint-config-next/typescript` as flat configs,
  without `FlatCompat`. `next lint` no longer exists (nothing here used it). The config now includes React's
  compiler-based hook rules as errors (`react-hooks/set-state-in-effect`, `purity`, `refs`, `immutability`, ...).
- `tsconfig.json`: `"jsx": "react-jsx"` and `.next/dev/types/**/*.ts`, the values Next 16 would otherwise write
  into it on every build.
- `next.config.ts`: Next 16 builds with Turbopack, which never resolves files outside the project root. Local engine
  runs and tests symlink the template's `node_modules` into each project (`build_repo`), so when `node_modules` is a
  symlink the config declares its target's folder as `experimental.turbopackAdditionalRoots`. Deploys and cloud
  sandboxes install a real `node_modules` and are unaffected. `serverExternalPackages` and
  `outputFileTracingIncludes` work unchanged under Turbopack (verified: the migrations and PGlite's `dist` are in
  every route's `.nft.json`).
- `src/lib`, `vitest.config.ts`, `tests/template.test.ts` and the other scripts needed no changes: the template
  only uses `cookies()` (already awaited), `redirect`, `usePathname`, and no zod.
- `AGENTS.md` (engine/stacks.py `VERSION_RULES`): what dev agents must now write: awaited `params`,
  `searchParams`, `cookies()` and `headers()`; `src/proxy.ts` instead of `src/middleware.ts`; `revalidateTag(tag,
  "max")`; the new hook lint rules; zod 4's top-level formats, `{ error }` messages, `.issues`,
  `z.flattenError`, two-argument `z.record`, `z.strictObject` / `z.looseObject`. The integrator may now edit
  `src/proxy.ts` as well as `src/middleware.ts`.

## The risk for existing projects (Pawfect, Tool library)

Before this change, `upgrade_template` would have copied the new `package.json`, lock file, ESLint config and
`AGENTS.md` into every existing project on its next run. Their own code (pages in `src/app`, server modules,
components, tests) was written for Next 15 and zod 3, and could break in ways no template check catches until the
build: synchronous `params` access (removed in 16), Date.now() or setState-in-effect in components (now lint
errors under `--max-warnings=0`), zod 3 APIs (`.errors`, `.flatten()`, `message`, one-argument `z.record`,
`required_error`), `src/middleware.ts` (deprecated). A plain retry or Ship would then fail with nothing in the run
allowed to fix it: dev tasks may not touch template files, and the integrator may only edit `src/app`.

### What upgrade_template does now

`upgrade_template(repo, stack, dependencies=False)`:
- Compares the major versions in the project's `package.json` with the template's
  (`NextSupabaseStack.major_upgrades`). Patch and minor bumps (a security fix inside Next 16) are taken as before.
- When any major is newer in the template, the project is **held back**: the dependency files
  (`NextSupabaseStack.DEPENDENCY_FILES`: `package.json`, `package-lock.json`, `eslint.config.mjs`,
  `tsconfig.json`, `scripts/check-security.mjs`) stay exactly as they are, and its `AGENTS.md` gets the current
  rules with the version-specific ones replaced by "this project stays on next 15.5.28, zod 3.24.1: write code for
  those versions, never edit package.json". Every other template fix (`src/lib`, the other check scripts,
  `next.config.ts`) still lands. The worker logs `template: dependencies held back (next 15 -> 16; ...)`.
- `scripts/check-security.mjs` is held back with the dependencies because its `ACCEPTED` list describes exactly
  those versions: a held-back project keeps shipping with its known zod 3 / postcss advisories listed as known
  (as before this upgrade), rather than having every Ship blocked until someone upgrades it.
- `dependencies=True` copies everything, dependency files included. The worker passes it only for a change request
  that opts in (`change.upgradeTemplate`, see below). After that the project is on the template's majors and later
  runs update it normally.

Chosen over "bump only when the project's code still type-checks" because a type check is not enough: the breaking
changes above show up in lint (hook rules), the production build and at runtime (async params, zod parsing), and
running `npm install` plus the whole integration check inside `upgrade_template` would make every retry and Ship
slow and still leave nobody able to fix what it finds. A change request, by contrast, has a planner and dev tasks
that may edit the project's code.

## Upgrading an older project: what the change request must do

1. **Opt in.** The change must reach the worker with `upgradeTemplate: true` on the change (`project.change`).
   The app does not send this flag yet: until it does, set it on the change in Convex, or apply the upgrade by hand
   in a clone of the project repo (`upgrade_template(repo, NextSupabaseStack(link_node_modules=False),
   dependencies=True)`, then push) and file an ordinary change request for step 2.
2. **Plan the code changes**, as change tasks on the modules that need them (dev tasks may edit their module;
   the integrator only `src/app`, `src/proxy.ts`, `src/middleware.ts` and `tests/unit`):
   - Pages and layouts: `params` / `searchParams` typed as Promises and awaited; any `cookies()` / `headers()`
     awaited (the template's `src/lib/session.ts` already is).
   - `src/middleware.ts` renamed to `src/proxy.ts`, exporting `proxy` (only if the project has one).
   - Components flagged by the new hook rules: `npx eslint --max-warnings=0 src` lists them
     (`react-hooks/set-state-in-effect`, `react-hooks/purity` for Date.now()/Math.random() in render,
     `react-hooks/refs`).
   - zod: `z.string().email()` -> `z.email()` (and url/uuid; `z.uuid()` is now strict, `z.guid()` accepts any
     8-4-4-4-12 id), `message` -> `error`, `required_error` / `invalid_type_error` -> an `error` function,
     `err.errors` -> `err.issues`, `err.flatten()` -> `z.flattenError(err)`, `z.record(v)` -> `z.record(z.string(), v)`,
     `.merge(B)` -> `.extend(B.shape)`, `z.nativeEnum` -> `z.enum`.
   - `revalidateTag(tag)` -> `revalidateTag(tag, "max")` (or `updateTag` in a server action).
3. **Verify with the whole-app check** the integrator runs anyway: `npx tsc --noEmit -p .`,
   `npx eslint --max-warnings=0 src/app`, `npx vitest run`, `npx next build`, `node scripts/check-app.mjs <pages>`,
   then Ship's security check (now with an empty `ACCEPTED` list, so `npm audit` must be clean at high).

Cloud sandboxes run `npm ci` from the project's own lock file, so a held-back project keeps building with Next 15
and zod 3 there. Local runs (tests, `run_project.py` without Daytona) share the template's `node_modules`, which is
now Next 16: run an older project in Daytona, or install its own `node_modules`.
