"""The Ship screen's security, accessibility and speed scripts (templates/next-supabase/scripts, docs/ship.md).

The pure parts run with node alone. The end-to-end tests build a copy of the template with a few deliberately bad
pages and run the scripts against it (about a minute); they need the template's node_modules, and the browser
part needs Playwright's Chromium (skipped where it can't start; the no-browser fallback is tested either way)."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from engine.ship import WARN_EXIT
from engine.stacks import NextSupabaseStack

TEMPLATE = NextSupabaseStack.template
SCRIPTS = TEMPLATE / "scripts"
HAS_NODE = shutil.which("node") is not None
HAS_MODULES = (TEMPLATE / "node_modules" / "next").exists()
needs_node = pytest.mark.skipif(not HAS_NODE, reason="node isn't installed")
needs_app = pytest.mark.skipif(not (HAS_NODE and HAS_MODULES), reason="the template's node_modules aren't installed")
# Built from pieces so this file doesn't look like it holds a key.
KEY_HEADER = "-----" + "BEGIN RSA " + "PRIVATE KEY-----"
DB_URL = "postgresql://app:" + "s3cr3t-Pw-9x" + "@db.prod.example.net:5432/app"


def node(script: str, cwd: Path, env: dict | None = None) -> str:
    """Runs an ES module snippet; the scripts' folder is importable as ./scripts/... via an absolute URL."""
    r = subprocess.run(["node", "--input-type=module", "-e", script], cwd=cwd, capture_output=True, text=True,
                       timeout=120, env={**os.environ, **(env or {})})
    assert r.returncode == 0, r.stderr
    return r.stdout


def mod(name: str) -> str:
    return (SCRIPTS / name).resolve().as_uri()


# -------------------------------------------------------------------- pure parts
@needs_node
def test_secret_patterns_find_keys_and_passwords_but_not_placeholders(tmp_path):
    text = "\n".join([
        "const ok = 1;",
        KEY_HEADER,
        f'const url = "{DB_URL}";',
        'const local = "postgres://postgres:postgres@localhost:5432/app";',
        'const example = "postgresql://user:${PASSWORD}@db.example.net/app";',
        "const gh = 'ghp_" + "A" * 36 + "';",
        "const aws = 'AKIA" + "ABCDEFGHIJKLMNOP" + "';",
        "const fine = 'sk-ant-';",
    ])
    out = json.loads(node(f'import {{ findSecrets }} from "{mod("check-security.mjs")}";'
                          f"console.log(JSON.stringify(findSecrets({json.dumps(text)})));", tmp_path))
    assert out == [{"line": 2, "kind": "private key"}, {"line": 3, "kind": "database URL with a password"},
                   {"line": 6, "kind": "GitHub token"}, {"line": 7, "kind": "AWS access key"}]


@needs_node
def test_audit_blocks_on_new_high_advisories_and_lists_the_templates_known_ones(tmp_path):
    def vuln(name, severity, ghsa, title="t"):
        return {"name": name, "severity": severity,
                "via": [{"name": name, "severity": severity, "title": title, "url": f"https://github.com/advisories/{ghsa}"}]}
    report = {"vulnerabilities": {
        "zod": vuln("zod", "high", "GHSA-mrhx-c7xc-m3w5", "memory"),       # accepted below: listed, not counted
        "evil": vuln("evil", "critical", "GHSA-xxxx-1111-aaaa", "RCE"),
        "meh": vuln("meh", "moderate", "GHSA-yyyy-2222-bbbb"),
        "tiny": vuln("tiny", "low", "GHSA-zzzz-3333-cccc"),
        "wrapper": {"name": "wrapper", "severity": "critical", "via": ["evil"]},   # transitive: counted once
    }, "metadata": {}}
    accepted = {"GHSA-mrhx-c7xc-m3w5": "zod 3: fixed only in zod 4"}
    script = (f'import {{ ACCEPTED, readAudit }} from "{mod("check-security.mjs")}";'
              "const r = (s, a) => console.log(JSON.stringify(readAudit(s, a)));"
              f"r({json.dumps(json.dumps(report))}, {json.dumps(accepted)}); r({json.dumps(json.dumps(report))});"
              "r(''); r(JSON.stringify({error: {code: 'ENOTFOUND', summary: 'request to registry failed'}}));"
              "console.log(JSON.stringify(ACCEPTED));")
    full, unaccepted, empty, offline, shipped = [json.loads(x) for x in node(script, tmp_path).splitlines()]
    assert full["blocking"] == ["critical evil: RCE (GHSA-xxxx-1111-aaaa)"]
    assert full["warnings"] == ["moderate meh: t (GHSA-yyyy-2222-bbbb)"] and full["lows"] == 1
    assert len(full["known"]) == 1 and "zod" in full["known"][0]
    assert "unreachable" in empty and offline == {"unreachable": "request to registry failed"}
    # The template ships with no accepted advisories (Next 16 / zod 4, docs/template-upgrades.md): the mechanism stays,
    # and an advisory nobody accepted blocks like any other.
    assert shipped == {}
    assert "high zod: memory (GHSA-mrhx-c7xc-m3w5)" in unaccepted["blocking"] and unaccepted["known"] == []


@needs_node
def test_security_check_accepts_older_majors_advisories_only_on_those_majors(tmp_path):
    """Regression (Tool library's ship, Nov 5): the script was held back with a Next 15 project's dependencies, so a
    project built before it existed had none and the check couldn't start. Now one file serves every project."""
    pkgs = [{"dependencies": {"next": "15.5.28", "zod": "3.24.1"}}, {"dependencies": {"next": "16.4.1", "zod": "^4.6.6"}}]
    script = (f'import {{ acceptedFor }} from "{mod("check-security.mjs")}";'
              + "".join(f"console.log(JSON.stringify(Object.keys(acceptedFor({json.dumps(json.dumps(p))}))));" for p in pkgs)
              + "console.log(JSON.stringify(Object.keys(acceptedFor(''))));")
    old, new, none = [json.loads(x) for x in node(script, tmp_path).splitlines()]
    assert "GHSA-mrhx-c7xc-m3w5" in old and "GHSA-qx2v-qp2m-jg93" in old and len(old) == 5
    assert new == [] and none == []


@needs_node
def test_unguarded_mutations_are_found_and_guarded_ones_are_not(tmp_path):
    app = tmp_path / "src" / "app"
    files = {
        "api/open/route.ts": "export async function POST() { return Response.json({}); }",
        "api/read/route.ts": "export async function GET() { return Response.json({}); }",
        "api/safe/route.ts": 'import { requireActor } from "@/lib/session";\nexport async function DELETE() { await requireActor(); }',
        "book/actions.ts": '"use server";\nexport async function book() {}',
        "admin/actions.ts": '"use server";\nimport { requireOwner } from "@/lib/owner";\nexport async function wipe() {}',
        "page.tsx": "export default function P() { return null; }",
    }
    for rel, body in files.items():
        (app / rel).parent.mkdir(parents=True, exist_ok=True)
        (app / rel).write_text(body)
    out = json.loads(node(f'import {{ unguardedMutations }} from "{mod("check-security.mjs")}";'
                          "console.log(JSON.stringify(unguardedMutations()));", tmp_path))
    assert [x.split(":")[0] for x in sorted(out)] == ["src/app/api/open/route.ts", "src/app/book/actions.ts"]


@needs_node
def test_speed_counts_the_pages_js_without_legacy_polyfills_and_judges_it(tmp_path):
    chunks = tmp_path / ".next" / "static" / "chunks"
    chunks.mkdir(parents=True)
    (chunks / "main-1.js").write_bytes(os.urandom(4000))              # random bytes barely compress
    (chunks / "polyfills-2.js").write_bytes(os.urandom(4000))
    html = ('<script src="/_next/static/chunks/main-1.js" async=""></script>'
            '<script src="/_next/static/chunks/polyfills-2.js" noModule=""></script>'
            '<script>self.__next_f.push([1,"static/chunks/main-1.js"])</script>')
    rows = [{"route": "/", "ms": 40, "kb": 120}, {"route": "/big", "ms": 300, "kb": 450},
            {"route": "/slow", "ms": 2500, "kb": 90}, {"route": "/huge", "ms": 50, "kb": 1500},
            {"route": "/gone", "error": "didn't answer"}]
    script = (f'import {{ scriptsIn, gzipBytes, judge, report }} from "{mod("check-speed.mjs")}";'
              f"const s = scriptsIn({json.dumps(html)});"
              "console.log(JSON.stringify({ s, bytes: s.reduce((a, r) => a + gzipBytes(r), 0) }));"
              f"const rows = {json.dumps(rows)};"
              "console.log(JSON.stringify(rows.map((r) => judge(r).level)));"
              "console.log(JSON.stringify(report(rows.slice(0, 3))));"
              "console.log(JSON.stringify(report(rows.slice(0, 1))));"
              "console.log(JSON.stringify(report(rows)));")
    found, levels, warned, clean, failed = [json.loads(x) for x in node(script, tmp_path).splitlines()]
    assert found["s"] == ["static/chunks/main-1.js"] and 3900 < found["bytes"] < 4200
    assert levels == ["ok", "warn", "warn", "fail", "fail"]
    assert warned["code"] == WARN_EXIT and any("/big: 450 kB of JS" in x for x in warned["lines"])
    assert any(x.startswith("/slow") and "2500 ms" in x for x in warned["lines"])
    assert clean["code"] == 0 and failed["code"] == 1
    assert warned["lines"][0].split() == ["Page", "Response", "JS", "(gzip)"]          # a small table


@needs_node
def test_a11y_report_blocks_on_serious_and_critical_only(tmp_path):
    def v(rule, impact):
        return {"id": rule, "impact": impact, "help": f"{rule} help", "nodes": [{"target": ["#x"]}]}
    results = [{"route": "/", "viewport": "desktop", "landed": "/", "violations": [v("region", "moderate")]},
               {"route": "/me", "viewport": "phone", "landed": "/sign-in", "violations": [v("image-alt", "critical")]}]
    script = (f'import {{ report }} from "{mod("check-a11y.mjs")}";'
              f"const r = {json.dumps(results)};"
              "console.log(JSON.stringify(report(r, { browser: true })));"
              "console.log(JSON.stringify(report(r.slice(0, 1), { browser: true })));"
              "console.log(JSON.stringify(report([{ ...r[0], violations: [] }], { browser: true })));"
              "console.log(JSON.stringify(report([{ ...r[0], violations: [] }], { browser: false })));")
    failed, warned, clean, nobrowser = [json.loads(x) for x in node(script, tmp_path).splitlines()]
    assert failed["code"] == 1 and any("FAIL [critical] image-alt" in x and "/me (-> /sign-in) phone" in x
                                       for x in failed["lines"])
    assert warned["code"] == WARN_EXIT and any("WARN [moderate] region" in x for x in warned["lines"])
    assert clean["code"] == 0
    assert nobrowser["code"] == WARN_EXIT and any("without a browser" in x for x in nobrowser["lines"])


# -------------------------------------------------------------------- end to end, on a built app
BAD_PAGE = """/* eslint-disable @next/next/no-img-element */
export default function Bad() {
  return (<main><h1>Bad</h1><img src="/x.png" /><button></button></main>);
}
"""
GOOD_PAGE = """export default function Home() {
  return (<main><h1>Welcome</h1><p>Book a table.</p></main>);
}
"""
REDIRECT_PAGE = """import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default function Private() { redirect("/"); }
"""


def run(cmd, cwd, env=None, timeout=600):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                          env={**os.environ, "NEXT_TELEMETRY_DISABLED": "1", **(env or {})})


@pytest.fixture(scope="module")
def built_app(tmp_path_factory):
    if not (HAS_NODE and HAS_MODULES):
        pytest.skip("the template's node_modules aren't installed")
    app = tmp_path_factory.mktemp("ship-app") / "app"
    shutil.copytree(TEMPLATE, app, ignore=shutil.ignore_patterns("node_modules", ".next", "*.tsbuildinfo"))
    (app / "node_modules").symlink_to((TEMPLATE / "node_modules").resolve())
    (app / "src/app/page.tsx").write_text(GOOD_PAGE)
    for route, body in (("bad", BAD_PAGE), ("private", REDIRECT_PAGE)):
        (app / "src/app" / route).mkdir(parents=True)
        (app / "src/app" / route / "page.tsx").write_text(body)
    r = run(["npx", "next", "build"], app)
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    return app


def chromium_starts(app: Path) -> bool:
    r = run(["node", "-e", "require('playwright').chromium.launch().then((b) => b.close())"], app, timeout=120)
    return r.returncode == 0


def test_accessibility_check_fails_on_critical_problems_at_both_widths(built_app):
    if not chromium_starts(built_app):
        pytest.skip("Playwright's Chromium can't start here")
    r = run(["node", "scripts/check-a11y.mjs", "/private"], built_app)
    assert r.returncode == 1, r.stdout + r.stderr
    out = r.stdout
    assert "FAIL [critical] image-alt" in out and "FAIL [critical] button-name" in out
    assert "/bad desktop" in out and "/bad phone" in out                   # both widths
    assert "ok   / desktop" in out and "/private (-> /) phone" in out       # redirects are checked where they land
    assert out.rstrip().splitlines()[-2].startswith("Accessibility check failed: 2 serious or critical")


def test_accessibility_check_without_a_browser_still_blocks_and_says_what_it_skipped(built_app):
    r = run(["node", "scripts/check-a11y.mjs"], built_app, env={"A11Y_NO_BROWSER": "1"})
    assert r.returncode == 1, r.stdout + r.stderr
    assert "FAIL [critical] image-alt" in r.stdout and "no browser" in r.stdout
    assert "colour contrast and the phone width weren't checked" in r.stdout


def test_speed_check_reports_a_table_for_every_page(built_app):
    r = run(["node", "scripts/check-speed.mjs", "/private"], built_app)
    assert r.returncode == 0, r.stdout + r.stderr
    lines = r.stdout.splitlines()
    assert lines[0].split() == ["Page", "Response", "JS", "(gzip)"]
    rows = {ln.split()[0]: ln for ln in lines[1:] if ln.startswith("/")}
    assert set(rows) == {"/", "/bad", "/private"} and "(-> /)" in rows["/private"]
    kb = int(rows["/"].split()[3])
    assert 50 < kb < 300                                                    # Next's own runtime, gzipped
    assert "All 3 page(s) answer" in lines[-1]


def test_security_check_fails_on_a_committed_secret(built_app, tmp_path):
    repo = tmp_path / "repo"
    shutil.copytree(built_app, repo, symlinks=True, ignore=shutil.ignore_patterns(".next", "node_modules"))
    (repo / "src/lib/keys.ts").write_text(f'export const KEY = `{KEY_HEADER}\\nabc`;\nexport const DB = "{DB_URL}";\n')
    for args in (["init", "-q"], ["add", "-A"]):
        subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)
    r = run(["node", "scripts/check-security.mjs"], repo, timeout=180)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "FAIL secret: src/lib/keys.ts:1: private key" in r.stdout
    assert "FAIL secret: src/lib/keys.ts:2: database URL with a password" in r.stdout
    assert "s3cr3t-Pw-9x" not in r.stdout                                   # never the value
    (repo / "src/lib/keys.ts").unlink()
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True, capture_output=True)
    r = run(["node", "scripts/check-security.mjs"], repo, timeout=180)
    # the template's own dependencies pass (its known advisories are listed, not counted); offline it's a warning
    assert r.returncode in (0, WARN_EXIT), r.stdout + r.stderr
    assert "Secrets: none found" in r.stdout
