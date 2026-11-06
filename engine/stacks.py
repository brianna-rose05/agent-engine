"""What changes between tech stacks: file layout, stubs, tests, and the commands the engine runs.

The pipeline in engine/project.py is the same for every stack; it asks the stack how to do each step.
    PythonStack        small Python libraries (the original benchmark projects)
    NextSupabaseStack  Next.js + TypeScript + Supabase Postgres web apps (the product's Verified stack)
"""
from __future__ import annotations

import re
import shlex
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def plain(text: str) -> str:
    """Test output without terminal color codes (CI turns colors on, which breaks parsing)."""
    return ANSI.sub("", text)
TEMPLATES = ROOT / "templates"


def git_init(dest: Path, message: str) -> None:
    for cmd in (["git", "init", "-q", "-b", "main"], ["git", "config", "user.email", "engine@local"],
                ["git", "config", "user.name", "engine"], ["git", "add", "-A"], ["git", "commit", "-qm", message]):
        subprocess.run(cmd, cwd=dest, check=True, capture_output=True)


class PythonStack:
    name = "python"
    parallel = 4
    module_rule = "a top-level snake_case .py file"
    contract_rule = module_rule
    stub_marker = "NotImplementedError"
    unimplemented_marker = "NotImplementedError"
    nested_files_ok = False
    module_re = re.compile(r"^[a-z_][a-z0-9_]*\.py$")
    contract_re = module_re
    reserved = {"conftest.py", "setup.py", "plan.py"}
    migration_re: re.Pattern | None = None       # contracts that are applied in order and never edited again

    def __init__(self, python: str = "python3"):
        self.python = python

    def daytona_options(self) -> dict:
        """Extra DaytonaSandbox arguments for this stack (default: the stock sandbox + pytest)."""
        return {}

    def build_repo(self, dest: Path) -> Path:
        shutil.rmtree(dest, ignore_errors=True)
        dest.mkdir(parents=True)
        (dest / "AGENTS.md").write_text(
            "# Team rules\n- Python 3.11+, standard library only. Top-level modules, no packages.\n"
            "- Contract files listed in plan.json are shared and read-only after planning.\n"
            "- Raise the project's error types with short, user-friendly messages.\n"
            "- Dev agents may add their own tests as tests/test_<module>*.py.\n")
        (dest / "pytest.ini").write_text("[pytest]\npythonpath = .\n")
        (dest / ".gitignore").write_text("__pycache__/\n.pytest_cache/\n")
        git_init(dest, "empty project")
        return dest

    def slug(self, module: str) -> str:
        return module[:-3]

    def qa_test_path(self, module: str) -> str:
        return f"acceptance/test_{self.slug(module)}.py"

    def dev_test_glob(self, module: str) -> str:
        return f"tests/test_{self.slug(module)}*.py"

    def run_tests(self, path: str) -> str:
        return f"{self.python} -m pytest -q -p no:cacheprovider {path}"

    def verify_cmd(self, module: str, test_path: str) -> str:
        return self.run_tests(test_path)

    def plan_check_cmd(self, contracts: list[str], modules: list[str]) -> str:
        import shlex
        return f"{self.python} -c {shlex.quote('import ' + ', '.join(m[:-3] for m in contracts + modules))}"

    def counts(self, output: str) -> dict[str, int]:
        output = plain(output)
        tail = "\n".join(output.strip().splitlines()[-3:])
        n = {k: int(v) for v, k in re.findall(r"(\d+) (passed|failed|errors?)", tail)}
        return {"passed": n.get("passed", 0), "failed": n.get("failed", 0),
                "errors": n.get("error", 0) + n.get("errors", 0)}

    def runner_missing(self, code: int, output: str) -> bool:
        return code in (126, 127) or "No module named pytest" in output

    def collection_failed(self, code: int, output: str) -> bool:
        return code in (2, 3, 4, 5)

    plan_layout = """Write these files at the top level of the repo (no folders):

1. plan.json (format below). Example module names: "lending.py"; contracts: ["models.py"].
2. Every contract file in full: the shared dataclasses and exception types all tasks use.
   Contracts hold types only, no business logic.
3. A stub for every task module: imports, then each public function with type hints, a docstring
   stating exactly what it returns and when it raises, and a body of `raise NotImplementedError`.
   Docstrings are the spec QA tests against, so pin down edge cases, rounding and ordering.

Use Python 3.11+ standard library only. Every file must import cleanly."""

    integration = False      # web apps get a final integrator task that wires pages (NextSupabaseStack)
    required_pages: tuple[str, ...] = ()     # pages the integrator always writes (NextSupabaseStack)

    def template_files(self) -> dict[str, bytes]:
        """Files the template owns in every project (agents may not edit them). Python projects have none."""
        return {}

    def is_ui_module(self, module: str) -> bool:
        return False

    def missing_imports(self, box, test_body: str) -> list[str]:
        """Project files a test imports that don't exist (and that no task will build). Python: not checked."""
        return []


class NextSupabaseStack(PythonStack):
    parallel = 3            # sandboxes are bigger; 3 x 3 GB fits Daytona's default 10 GB account limit
    """Next.js (App Router, TypeScript) + Supabase Postgres, tested with Vitest against an in-test
    Postgres (PGlite) that applies the project's real migrations."""
    name = "next-supabase"
    module_rule = "a .ts or .tsx file under src/server/, src/components/, src/app/ or src/lib/, or src/proxy.ts"
    contract_rule = "a migration supabase/migrations/NNNN_name.sql or a file under src/contracts/"
    stub_marker = "Not implemented"
    unimplemented_marker = "Not implemented"
    nested_files_ok = True
    # src/proxy.ts (Next 16's middleware) and src/middleware.ts (Next 15) may be a task's module too. Regression (Tool
    # library's change 4, Nov 6): a change to what runs before every page had no valid module to plan it in.
    module_re = re.compile(r"^(src/(server|components|app|lib)/[A-Za-z0-9_\-/\[\]().]+\.tsx?|src/(proxy|middleware)\.ts)$")
    contract_re = re.compile(r"^(supabase/migrations/\d{4}_[a-z0-9_]+\.sql|src/contracts/[A-Za-z0-9_\-]+\.ts)$")
    migration_re = re.compile(r"^supabase/migrations/(\d{4})_[^/]+\.sql$")
    reserved = {"supabase/migrations/0000_base.sql", "src/lib/db.ts", "src/lib/errors.ts", "src/lib/db-postgres.ts",
                "src/test/db.ts", "src/app/layout.tsx"}
    template = TEMPLATES / "next-supabase"
    reserved |= {"src/lib/pglite.ts", "src/lib/runtime.ts", "src/lib/auth.ts", "src/lib/session.ts", "src/lib/migrate.ts",
                 "src/lib/owner.ts", "src/lib/studio-bridge.tsx"}
    # The check scripts (the integration check's and the Ship screen's): template files, never a task's.
    reserved |= {"scripts/app-server.mjs", "scripts/check-app.mjs", "scripts/check-security.mjs",
                 "scripts/check-a11y.mjs", "scripts/check-speed.mjs"}
    reserved |= {"scripts/screenshots.mjs"}       # the designer's screenshots (docs/designer.md)

    # ---------------------------------------------------------------- integration
    integration = True

    def is_ui_module(self, module: str) -> bool:
        return module.startswith("src/components/")
    # Pages, server actions, layout and small client wrappers, plus the integrator's own tests. src/proxy.ts is
    # Next 16's name for middleware; src/middleware.ts stays editable for projects still on Next 15.
    integration_scope = ["src/app/*", "src/proxy.ts", "src/middleware.ts", "tests/unit/*"]
    # Pages every web app has, whatever its plan lists: the owner claims the app there (src/lib/owner.ts).
    required_pages = ("/owner-setup",)
    # The root layout renders the template's StudioBridge (src/lib/studio-bridge.tsx), which tells Studio's preview
    # page which page is open when the app is framed there (comment pins). The integrator's check verifies it.
    BRIDGE_IMPORT_RE = re.compile(r"""import\s*\{[^}]*\bStudioBridge\b[^}]*\}\s*from\s*["']@/lib/studio-bridge["']""")
    BRIDGE_RENDER_RE = re.compile(r"<StudioBridge\s*/>")

    def bridge_problem(self, layout: str | None) -> str | None:
        """Why src/app/layout.tsx (its text, None when missing) doesn't render the Studio bridge, or None."""
        if layout is None:
            return "src/app/layout.tsx is missing"
        if not self.BRIDGE_IMPORT_RE.search(layout):
            return 'src/app/layout.tsx must import { StudioBridge } from "@/lib/studio-bridge"'
        if not self.BRIDGE_RENDER_RE.search(layout):
            return "src/app/layout.tsx must render <StudioBridge /> inside <body>"
        return None

    def integration_check_cmd(self, pages: list[str]) -> str:
        """The whole app: types, lint, every test, a production build, and every page answering without a
        server error in local mode (scripts/check-app.mjs), including each page the design requires."""
        routes = " ".join(shlex.quote(r) for r in pages)
        return ("npx tsc --noEmit -p . && npx eslint --max-warnings=0 src/app && NO_COLOR=1 npx vitest run && "
                f"NEXT_TELEMETRY_DISABLED=1 npx next build && node scripts/check-app.mjs {routes}").strip()

    def ship_check_cmds(self, pages: list[str]) -> dict[str, str]:
        """The Ship screen's checks after the integration check's (engine/ship.py CHECKS), by name. Each runs after
        the production build, exits 0 (passed), 10 (passed with warnings) or anything else (failed), and ends its
        output with a short summary. See docs/ship.md."""
        routes = " ".join(shlex.quote(r) for r in pages)
        return {"security": "node scripts/check-security.mjs",
                "accessibility": f"node scripts/check-a11y.mjs {routes}".strip(),
                "speed": f"node scripts/check-speed.mjs {routes}".strip()}

    IMPORT_RE = re.compile(r"""(?:from\s+|import\s*\(\s*|require\(\s*)["']@/([^"']+)["']""")

    def missing_imports(self, box, test_body: str) -> list[str]:
        """Regression (Pawfect build): a QA test did `await import("@/app/api/cron/emails/route")` inside one
        test. No task owned that file, so the feature failed 3 times and blocked 4 others."""
        missing = []
        for spec in sorted(set(self.IMPORT_RE.findall(test_body))):
            base = f"src/{spec}"
            options = [base] if re.search(r"\.(ts|tsx|js|json)$", base) else \
                [base + e for e in (".ts", ".tsx", "/index.ts", "/index.tsx")]
            test = " || ".join(f"test -f {shlex.quote(o)}" for o in options)
            if box.exec(f"{test} && echo yes || echo no").output.strip() != "yes":
                missing.append(base)
        return missing

    def __init__(self, link_node_modules: bool = True):
        super().__init__("python3")  # noqa: integration settings are class attributes above
        self.link_node_modules = link_node_modules

    def daytona_options(self) -> dict:
        from engine.sandboxes.daytona_sandbox import WEB_SETUP, web_params
        return {"setup_cmd": WEB_SETUP, "create_params": web_params()}

    def build_repo(self, dest: Path) -> Path:
        shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(self.template, dest, ignore=shutil.ignore_patterns("node_modules", ".next", "*.tsbuildinfo"))
        (dest / "AGENTS.md").write_text(AGENTS_MD)
        git_init(dest, "scaffold: Next.js + Supabase template")
        if self.link_node_modules and (self.template / "node_modules").exists():
            # Local runs share the template's installed packages; cloud sandboxes run `npm ci` instead.
            (dest / "node_modules").symlink_to(self.template / "node_modules")
        return dest

    # Template files a project later owns: the integrator rewrites the pages and layout.
    PROJECT_OWNED = ("src/app/",)

    def template_files(self) -> dict[str, bytes]:
        out = {"AGENTS.md": AGENTS_MD.encode()}
        listed = subprocess.run(["git", "ls-files"], cwd=self.template, capture_output=True, text=True).stdout.split()
        for rel in listed:
            if not rel.startswith(self.PROJECT_OWNED) and (self.template / rel).is_file():
                out[rel] = (self.template / rel).read_bytes()
        return out

    # Template files that only work with the template's own dependency versions: the dependencies themselves and the
    # lint and TypeScript settings for them. upgrade_template copies these only to a project on the same major versions
    # (docs/template-upgrades.md). The security check is not one of them: it knows the older majors' accepted advisories
    # (ACCEPTED_ON_OLDER_MAJORS), and Ship runs it, so every project must have it. Regression (Tool library's ship,
    # Nov 5): held back, it was missing from a project built before it existed and the security check couldn't start.
    DEPENDENCY_FILES = ("package.json", "package-lock.json", "eslint.config.mjs", "tsconfig.json")

    @staticmethod
    def _major(spec: str) -> str | None:
        m = re.search(r"\d+", spec or "")
        return m.group(0) if m else None

    @staticmethod
    def _deps(package_json: bytes) -> dict[str, str]:
        import json
        try:
            data = json.loads(package_json)
        except ValueError:
            return {}
        return {**(data.get("dependencies") or {}), **(data.get("devDependencies") or {})}

    def major_upgrades(self, repo: Path) -> list[str]:
        """The template's dependencies whose major version is newer than the project's ("next 15 -> 16"), or [] when
        the project is on the template's majors (patch and minor bumps are safe to take) or has no package.json."""
        mine = Path(repo) / "package.json"
        if not mine.exists():
            return []
        ours, theirs = self._deps(mine.read_bytes()), self._deps((self.template / "package.json").read_bytes())
        out = []
        for name, spec in sorted(theirs.items()):
            old, new = self._major(ours.get(name, "")), self._major(spec)
            if old and new and old != new:
                out.append(f"{name} {old} -> {new}")
        return out

    def held_back_agents_md(self, repo: Path) -> str:
        """AGENTS.md for a project whose dependencies stay behind: the current rules, minus the version-specific ones."""
        deps = self._deps((Path(repo) / "package.json").read_bytes())
        versions = ", ".join(f"{n} {deps[n]}" for n in ("next", "react", "zod") if n in deps) or "see package.json"
        return AGENTS_MD.replace(VERSION_RULES, HELD_BACK_RULES.format(versions=versions))

    def slug(self, module: str) -> str:
        stem = re.sub(r"\.tsx?$", "", module.split("src/", 1)[-1])
        return re.sub(r"[^A-Za-z0-9]+", "-", stem).strip("-").lower()

    def ext(self, module: str) -> str:
        return "tsx" if module.endswith(".tsx") else "ts"

    def qa_test_path(self, module: str) -> str:
        return f"tests/acceptance/{self.slug(module)}.test.{self.ext(module)}"

    def dev_test_glob(self, module: str) -> str:
        # Any file under tests/unit/: agents name these their own way (src-lib-pricing, BookingForm...),
        # and a strict per-module pattern rejected 3 of 10 good tasks in the fifth web run. Two tasks
        # picking the same name would surface as a merge conflict, which the engine already handles.
        return "tests/unit/*"

    # Testing Library prints the whole page when a query fails; a short limit keeps the actual error in the
    # feedback. Regression (Pawfect build 7): T10's failure output was a wall of inline-styled HTML.
    VITEST = "DEBUG_PRINT_LIMIT=1500 NO_COLOR=1 npx vitest run"

    def run_tests(self, path: str) -> str:
        return f"{self.VITEST} {path}"

    def verify_cmd(self, module: str, test_path: str) -> str:
        # Types for the whole repo (hidden tests included), lint for the module, then its hidden tests.
        return (f"npx tsc --noEmit -p . && npx eslint --max-warnings=0 {module} && "
                f"{self.VITEST} {test_path}")

    def plan_check_cmd(self, contracts: list[str], modules: list[str]) -> str:
        # Everything type-checks, and every migration applies to a fresh Postgres.
        return "npx tsc --noEmit -p . && NO_COLOR=1 npx vitest run tests/template.test.ts"

    def counts(self, output: str) -> dict[str, int]:
        output = plain(output)
        line = next((l for l in reversed(output.splitlines()) if re.match(r"\s*Tests\s", l)), "")
        n = {k: int(v) for v, k in re.findall(r"(\d+) (passed|failed|skipped)", line)}
        files = next((l for l in reversed(output.splitlines()) if re.match(r"\s*Test Files\s", l)), "")
        file_fail = int(m.group(1)) if (m := re.search(r"(\d+) failed", files)) else 0
        errors = 1 if (file_fail and not n) or "Unhandled Error" in output or "SyntaxError" in output else 0
        return {"passed": n.get("passed", 0), "failed": n.get("failed", 0), "errors": errors}

    def runner_missing(self, code: int, output: str) -> bool:
        return code in (126, 127) or "command not found" in output or "Cannot find module 'vitest" in output

    def collection_failed(self, code: int, output: str) -> bool:
        return "No test files found" in output

    plan_layout = """This is a Next.js (App Router, TypeScript) + Supabase Postgres web app. The repo already has
the template: read AGENTS.md, src/lib/db.ts, src/lib/errors.ts and src/test/db.ts first.

Write these files:

1. plan.json (format below). Contracts and modules are paths, for example
   "contracts": ["supabase/migrations/0001_bookings.sql", "src/contracts/types.ts"],
   modules like "src/server/bookings.ts" (server logic) or "src/components/SlotPicker.tsx" (UI).
   Also add "pages": every page route the app needs, like ["/", "/sign-in", "/book", "/staff/schedule"]
   (no dynamic [segments]). Tasks build server modules and components only; after they all merge, an
   integrator writes these pages, the sign-in screens and the server actions that connect everything.
2. The contracts, in full:
   - SQL migrations (supabase/migrations/0001_<name>.sql, 0002_...): every table, column, constraint and
     index. Plain Postgres; ids are `uuid primary key default gen_random_uuid()`; users are
     `auth.users(id)`. No `create extension`. Enable row level security with policies using auth.uid().
   - src/contracts/*.ts: the shared TypeScript types (row types, inputs, results) every task uses.
     Types only, no logic.
3. A stub for every task module, with the exact exports, full type signatures and a doc comment per
   export stating what it returns and which AppError code it throws when (see src/lib/errors.ts). Bodies
   are `throw new Error("Not implemented");`. Doc comments are the spec QA tests against, so pin down edge
   cases, ordering, rounding and time zones.
   - Server modules export async functions taking `(db: Db, actor: Actor, ...)` (or `(db: Db, ...)` when no
     user is involved). They never read cookies or env; pages pass those in. All SQL is parameterized.
   - UI modules export React components that take everything through props (data and callbacks), so they
     can be tested without a server. No data fetching inside components. Their doc comments must name the
     exact visible text of every button, heading and field label, the empty and error messages, and the
     exact arguments each callback receives: QA tests look elements up by that text, and the dev must
     render it exactly. Regression (Pawfect builds 3-7): the owner setup screens failed in every build
     because tests and code guessed different labels.
   - Pages (src/app/**/page.tsx) are written by the integrator at the end, not by tasks. Sign-in, sign-up
     and sessions come from the template (src/lib/session.ts); server functions take the user id in Actor.
   - The app's owner is its admin (src/lib/owner.ts). Any admin, owner or manager check is
     `await requireOwner(db, actor)` (or `isOwner`) from the template, never a role column: nobody can set a
     role "in the database" or by hand. The owner claims the app on /owner-setup with a setup code (the
     integrator writes that page; don't plan it). Other staff roles, if any, live in the project's own tables
     and are granted by the owner through a server function that calls requireOwner. Migrations never
     reference app_owner. Tests make someone the owner with `await claimOwner(db, actor, "any")`.
   - Template files (everything already in src/lib/, src/test/db.ts, src/app/, scripts/ and
     supabase/migrations/0000_base.sql) are fixed: never edit or list them.
Everything must type-check (`npx tsc --noEmit`) and every migration must apply to a fresh database."""


# The rules that depend on the template's dependency versions (package.json). A project still on older majors
# (upgrade_template holds its dependencies back, docs/template-upgrades.md) gets HELD_BACK_RULES in their place.
VERSION_RULES = """- TypeScript strict. Next.js 16 App Router, React 19, zod 4. No new npm dependencies: use what package.json has.
- Next.js 16: `params` and `searchParams` are Promises, and so are `cookies()` and `headers()`: always `await` them
  (`export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; }`).
  Middleware is now `src/proxy.ts` exporting `function proxy(request)` (Node runtime), not src/middleware.ts.
  `revalidateTag(tag, "max")` takes a second argument; `revalidatePath(path)` is unchanged. There is no `next lint`:
  lint with `npx eslint`.
- Lint includes React's hook rules (eslint-plugin-react-hooks 7), as errors: never call `setState` directly in a
  useEffect body (derive the value while rendering, or set it in the event handler); never call `Date.now()` or
  `Math.random()` in any component body, server pages included (server code uses `new Date()`; a client component
  gets the time as a prop or reads it in an effect or event handler); never read `ref.current` while rendering;
  never mutate props or state.
- zod 4 (if you validate input with zod): string formats are top-level (`z.email()`, `z.url()`, `z.uuid()`; use
  `z.guid()` for any 8-4-4-4-12 id, since `z.uuid()` rejects made-up ids like 00000000-0000-0000-0000-000000000001).
  Custom messages use `{ error: "..." }` (not `message`, `required_error` or `invalid_type_error`). A ZodError's list is
  `.issues` (`.errors` is gone); use `z.flattenError(err)` instead of `err.flatten()`. `z.record(z.string(), value)`
  needs both arguments; `z.strictObject` / `z.looseObject` replace `.strict()` / `.passthrough()`; `.extend(B.shape)`
  replaces `.merge(B)`; `z.enum(MyEnum)` replaces `z.nativeEnum`.
"""

HELD_BACK_RULES = """- TypeScript strict. Next.js App Router. No new npm dependencies: use what package.json has.
- This project stays on the dependency versions in its package.json ({versions}), older than the current template's:
  write code for those versions, and never edit package.json or package-lock.json. Moving it to the template's
  versions is a separate change (docs/template-upgrades.md).
"""

AGENTS_MD = """# Team rules (Next.js + Supabase)

""" + VERSION_RULES + """- Database access only through the `Db` interface in src/lib/db.ts, passed in as the first argument.
  Parameterized SQL only ($1, $2...). Wrap multi-step writes in `db.transaction`.
- Business rules fail with `AppError` (src/lib/errors.ts): code + a short, friendly message.
- Contracts are read-only after planning: supabase/migrations/*.sql and src/contracts/*.ts.
- Components take data and callbacks through props; no fetching inside components.
- Tests: Vitest. Use `createTestDb()` / `createUser()` from src/test/db.ts for a real Postgres with the
  migrations applied. Component tests start with `// @vitest-environment jsdom` and use
  @testing-library/react.
- Dev agents may add their own tests under tests/unit/, named after their module
  (e.g. src/server/booking.ts -> tests/unit/server-booking.test.ts). Nothing else outside their module.
- Before saying DONE run: npx tsc --noEmit && npx eslint <your file> && npx vitest run <your tests>
- Always `vitest run`, never bare `vitest` (that watches for changes and never exits). No dev servers.
- Sign-in is the template's: src/lib/session.ts (getAuth, getActor, requireActor) and src/lib/runtime.ts
  (getDb). Server functions never handle passwords or cookies; pages and server actions do.
- The app's owner is its admin: src/lib/owner.ts (isOwner, requireOwner, getOwnerId, ownerSetupState,
  claimOwner). Every admin/owner/manager check uses `requireOwner(db, actor)` or `isOwner(db, actor)`, never a
  role column a person would have to set by hand. The owner claims the app once on /owner-setup with the setup
  code Studio gives them (APP_SETUP_CODE). Other staff roles, if the app has any, live in the project's own
  tables and are granted by the owner in the app. In tests (local mode) `await claimOwner(db, actor, "any")`
  makes that user the owner.
- The app runs without any accounts in local mode (no DATABASE_URL): an in-process Postgres with the
  migrations applied, and local logins. `node scripts/check-app.mjs /route ...` (after `npx next build`)
  starts it and checks every page answers without a server error.
- The root layout (src/app/layout.tsx) renders `<StudioBridge />` from src/lib/studio-bridge.tsx (a template file)
  inside <body>. When the app is shown inside Studio's preview it tells Studio which page is open, and nothing else.
  Keep it whenever the layout is rewritten.
- Previews run on a real, durable Postgres: the app applies new migrations on its first request there. So
  migrations are plain Postgres that also runs on PGlite, and once merged they are never edited: change the
  schema with a new, higher-numbered migration.
"""

STACKS = {"python": PythonStack, "next-supabase": NextSupabaseStack}


MIDDLEWARE_FN_RE = re.compile(r"\bexport\s+(default\s+)?(async\s+)?function\s+middleware\b")


def rename_middleware_for_next16(repo: Path) -> list[str]:
    """Next 16 renamed middleware to proxy: src/middleware.ts exporting `middleware` becomes src/proxy.ts exporting
    `proxy` (same body, same `config`). Done here, mechanically, once a project's package.json is on Next 16 or
    newer, because no agent can do it: a rename spans two files. Returns the removed paths ([] when nothing to do).
    Regression (Tool library's change 4, Nov 6): the planner found nothing else to change for Next 16, but had no
    valid way to plan this rename and failed three times."""
    import json
    old, new = repo / "src/middleware.ts", repo / "src/proxy.ts"
    if not old.is_file() or new.exists():
        return []
    try:
        major = int(re.search(r"\d+", json.loads((repo / "package.json").read_text())["dependencies"]["next"]).group(0))
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return []
    if major < 16:
        return []
    text = old.read_text()
    renamed = MIDDLEWARE_FN_RE.sub(lambda m: f"export {m.group(1) or ''}{m.group(2) or ''}function proxy", text)
    if renamed == text and "export default" not in text:
        return []              # not a shape we recognise: leave it (Next 16 still runs middleware.ts, deprecated)
    new.write_text(renamed)
    old.unlink()
    print("template: src/middleware.ts renamed to src/proxy.ts for Next 16")
    return ["src/middleware.ts"]


def upgrade_template(repo: Path, stack: PythonStack, dependencies: bool = False) -> list[str]:
    """Bring an existing project's template files up to the current template, in one commit on main (pushed when
    the repo has a remote). Returns the files changed. Regression (first live preview): Pawfect was built before the
    template shipped its migrations with serverless builds, so its preview failed with ENOENT on every page, and no
    agent may edit template files to fix it.

    A new major version of a dependency (Next 15 -> 16, zod 3 -> 4) can break the project's own code, which no check
    here would see. So when the template's majors are newer than the project's, its dependency files
    (NextSupabaseStack.DEPENDENCY_FILES) stay as they are and its AGENTS.md keeps it on its own versions; everything
    else is updated. `dependencies=True` (a change request that opts in, docs/template-upgrades.md) copies them too."""
    repo = Path(repo)
    files = stack.template_files()
    held = [] if dependencies or not files else getattr(stack, "major_upgrades", lambda r: [])(repo)
    if held:
        for rel in stack.DEPENDENCY_FILES:
            files.pop(rel, None)
        files["AGENTS.md"] = stack.held_back_agents_md(repo).encode()
        print(f"template: dependencies held back ({'; '.join(held)}): see docs/template-upgrades.md")
    changed = []
    for rel, body in files.items():
        dest = repo / rel
        if not dest.exists() or dest.read_bytes() != body:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(body)
            changed.append(rel)
    removed = rename_middleware_for_next16(repo)
    if removed:
        changed += ["src/proxy.ts"]
    if not changed:
        return []
    run = lambda *a: subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True)  # noqa: E731
    run("add", "--", *changed)
    if removed:
        run("rm", "-q", "--cached", "--", *removed)
    if run("commit", "-qm", "Update template files\n\n" + "\n".join(changed)).returncode:
        run("checkout", "--", *changed)
        return []
    if run("remote").stdout.strip():
        run("push", "-q", "origin", "main")
    return changed
