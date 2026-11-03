"""What changes between tech stacks: file layout, stubs, tests, and the commands the engine runs.

The pipeline in engine/project.py is the same for every stack; it asks the stack how to do each step.
    PythonStack        small Python libraries (the original benchmark projects)
    NextSupabaseStack  Next.js + TypeScript + Supabase Postgres web apps (the product's Verified stack)
"""
from __future__ import annotations

import re
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
    module_rule = "a top-level snake_case .py file"
    contract_rule = module_rule
    stub_marker = "NotImplementedError"
    unimplemented_marker = "NotImplementedError"
    nested_files_ok = False
    module_re = re.compile(r"^[a-z_][a-z0-9_]*\.py$")
    contract_re = module_re
    reserved = {"conftest.py", "setup.py", "plan.py"}

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


class NextSupabaseStack(PythonStack):
    """Next.js (App Router, TypeScript) + Supabase Postgres, tested with Vitest against an in-test
    Postgres (PGlite) that applies the project's real migrations."""
    name = "next-supabase"
    module_rule = "a .ts or .tsx file under src/server/, src/components/ or src/app/"
    contract_rule = "a migration supabase/migrations/NNNN_name.sql or a file under src/contracts/"
    stub_marker = "Not implemented"
    unimplemented_marker = "Not implemented"
    nested_files_ok = True
    module_re = re.compile(r"^src/(server|components|app)/[A-Za-z0-9_\-/\[\]().]+\.tsx?$")
    contract_re = re.compile(r"^(supabase/migrations/\d{4}_[a-z0-9_]+\.sql|src/contracts/[A-Za-z0-9_\-]+\.ts)$")
    reserved = {"supabase/migrations/0000_base.sql"}
    template = TEMPLATES / "next-supabase"

    def __init__(self, link_node_modules: bool = True):
        super().__init__("python3")
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

    def slug(self, module: str) -> str:
        stem = re.sub(r"\.tsx?$", "", module.split("src/", 1)[-1])
        return re.sub(r"[^A-Za-z0-9]+", "-", stem).strip("-").lower()

    def ext(self, module: str) -> str:
        return "tsx" if module.endswith(".tsx") else "ts"

    def qa_test_path(self, module: str) -> str:
        return f"tests/acceptance/{self.slug(module)}.test.{self.ext(module)}"

    def dev_test_glob(self, module: str) -> str:
        return f"tests/unit/{self.slug(module)}*.test.ts*"

    def run_tests(self, path: str) -> str:
        return f"NO_COLOR=1 npx vitest run {path}"

    def verify_cmd(self, module: str, test_path: str) -> str:
        # Types for the whole repo (hidden tests included), lint for the module, then its hidden tests.
        return (f"npx tsc --noEmit -p . && npx eslint --max-warnings=0 {module} && "
                f"NO_COLOR=1 npx vitest run {test_path}")

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
     can be tested without a server. No data fetching inside components.
   - Pages (src/app/**/page.tsx) are thin: fetch with server functions, render components.
Everything must type-check (`npx tsc --noEmit`) and every migration must apply to a fresh database."""


AGENTS_MD = """# Team rules (Next.js + Supabase)

- TypeScript strict. Next.js App Router. No new npm dependencies: use what package.json has.
- Database access only through the `Db` interface in src/lib/db.ts, passed in as the first argument.
  Parameterized SQL only ($1, $2...). Wrap multi-step writes in `db.transaction`.
- Business rules fail with `AppError` (src/lib/errors.ts): code + a short, friendly message.
- Contracts are read-only after planning: supabase/migrations/*.sql and src/contracts/*.ts.
- Components take data and callbacks through props; no fetching inside components.
- Tests: Vitest. Use `createTestDb()` / `createUser()` from src/test/db.ts for a real Postgres with the
  migrations applied. Component tests start with `// @vitest-environment jsdom` and use
  @testing-library/react.
- Dev agents may add their own tests as tests/unit/<module>*.test.ts(x).
- Before saying DONE run: npx tsc --noEmit && npx eslint <your file> && npx vitest run
"""

STACKS = {"python": PythonStack, "next-supabase": NextSupabaseStack}
