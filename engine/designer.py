"""The designer (docs/designer.md): a different model from the dev looks at screenshots of every page of a built web
app, at desktop and phone size, and asks for changes only for clear visual defects.

Two ways in:
- The integrator (task INT): after its whole-app check passes and before it merges, the engine calls
  `Task.review_design` (made by `make_designer`) inside the integrator's own sandbox, where the production build is.
- Anything else that has a sandbox with the app built in it (the Ship screen's checks, later): call `review_design`
  directly. It takes the screenshots, runs the designer and returns its verdict; it never raises.

Screenshots come from the template's scripts/screenshots.mjs (Playwright Chromium, installed when missing), as a
signed-out visitor, in local mode: review/screens/<page>-<width>.png plus review/screens/manifest.json. Nothing in
review/ is ever merged: the integrator's work is committed before the screenshots are taken.
"""
from __future__ import annotations

import json
import re
import shlex
import time

from engine.interfaces import Sandbox, Task

SCREENS_DIR = "review/screens"
VIEWPORTS = ((1280, 800), (390, 844))            # desktop, phone (what screenshots.mjs shoots)
SCREENSHOT_TIMEOUT_S = 900                       # a fresh sandbox may install Playwright and Chromium first
DESIGN_CHANGES = "the designer requested changes"   # the reason on an attempt the designer sent back
MAX_DESIGN_COMMENTS = 8
MAX_BRIEF_CHARS = 4000
DESIGNER_ERROR_NOTE = "The designer couldn't review the screenshots, so the app merges as it is."
BUDGET_REASON = "the spending limit didn't allow a design review"


def verdict_path(task_id: str) -> str:
    return f"review/{task_id}-design.json"


def screenshot_cmd(routes=()) -> str:
    """The template script, with the routes the design requires (it finds the other static pages itself)."""
    return " ".join(["node scripts/screenshots.mjs", *(shlex.quote(r) for r in routes if str(r).startswith("/"))])


def design_brief(description: str) -> str:
    """What the designer needs from the project brief: the pages and what each is for, and the Look the owner chose
    in the setup wizard. The wizard's composeSpec (web/convex/wizard.ts) writes them as "## Pages" and
    "## Look and feel: <name>" sections of the description the planner gets. A brief without them (a project made
    before the wizard, the benchmark) is passed on as it is, cut to MAX_BRIEF_CHARS."""
    text = (description or "").strip()
    sections = re.split(r"(?m)^(?=## )", text)
    keep = [s.strip() for s in sections if re.match(r"## (Pages|Look and feel)\b", s)]
    out = "\n\n".join(keep) if keep else text
    return out if len(out) <= MAX_BRIEF_CHARS else out[:MAX_BRIEF_CHARS - 20] + "\n... (brief cut)"


def take_screenshots(box: Sandbox, routes=()) -> dict:
    """Run scripts/screenshots.mjs in a sandbox where the app is built. Returns {ok, reason, shots, skipped, seconds,
    output}: `shots` are the manifest's entries ({route, width, file, horizontal_scroll, cut, ...}); `reason` says in
    plain words why there are none (no Chromium, the app isn't built, ...). Never raises."""
    t0 = time.time()
    try:
        r = box.exec(screenshot_cmd(routes) + " 2>&1", timeout=SCREENSHOT_TIMEOUT_S)
        manifest = box.exec(f"cat {SCREENS_DIR}/manifest.json 2>/dev/null").output if r.code == 0 else ""
    except Exception as e:
        return {"ok": False, "reason": f"the screenshot step failed ({type(e).__name__}: {str(e)[:150]})",
                "shots": [], "skipped": [], "seconds": round(time.time() - t0, 1), "output": ""}
    seconds = round(time.time() - t0, 1)
    shots, skipped = [], []
    try:
        data = json.loads(manifest) if manifest.strip() else {}
        shots = [s for s in data.get("shots", []) if isinstance(s, dict) and s.get("file")]
        skipped = [s for s in data.get("skipped", []) if isinstance(s, dict)]
    except (ValueError, AttributeError):
        pass
    if r.code == 0 and shots:
        return {"ok": True, "reason": "", "shots": shots, "skipped": skipped, "seconds": seconds, "output": r.output}
    lines = [ln.strip() for ln in r.output.splitlines() if ln.strip()]
    said = next((ln for ln in lines if ln.startswith(("No browser", "The app isn't built", "Screenshots failed"))),
                lines[-1] if lines else "")
    reason = {3: "no browser for screenshots", 2: "the app isn't built", 124: "the screenshots timed out"}.get(
        r.code, "the screenshots couldn't be taken")
    if said and r.code != 124:
        reason += f": {said[:200]}"
    return {"ok": False, "reason": reason, "shots": [], "skipped": skipped, "seconds": seconds, "output": r.output}


DESIGNER_SPEC = """The app below was just built, and it passed every automated check: types, tests, a production
build, and every page answering. You are the designer, a different model from the dev who built it. Look at
screenshots of its pages and decide whether it can merge as it looks.

What the app is meant to be (from the owner's brief: its pages and what each is for, and the look they chose):
{brief}

Screenshots, taken in Chromium from the production build as a signed-out visitor (no data, nobody signed in), at
desktop (1280x800) and phone (390x844) width. Open EVERY one with the Read tool (it shows you the image):
{shots}
{skipped}
A phone shot shows what fits on a 390 px screen: anything wider is cut off at the right edge, as a visitor would see
it. Shots longer than 2400 px show only the top of the page.
{second}
Write {verdict} with exactly this JSON and nothing else:
{{"verdict": "approve" or "changes",
  "comments": ["<page> (<width>): <the specific visual problem, where it is, and how to fix it>", ...]}}
for example "/book (390): the time slot table runs off the right edge; let it wrap or scroll inside its card".
- "changes" ONLY for a clear visual defect a visitor would notice at once:
  - content overflowing its box, cut off, or running off the screen; horizontal scrolling on the phone
  - elements overlapping each other
  - text that can't be read (too little contrast with its background, or too small to read)
  - missing styling: raw, unstyled HTML (default serif text, blue underlined links, bare form controls)
  - a broken or empty layout: a page that is blank, collapsed, or shows an error instead of its content
  - text that contradicts what the page is for (a sign-up page headed "Sign in", leftover placeholder text)
- Never for taste: colours, fonts, spacing, wording or layout choices that work are not defects, even if you'd do them
  differently, and even where they differ from the look in the brief. When unsure, approve.
- "approve" may carry comments as notes; they don't block anything. Keep comments few (at most 8), one per problem.
- Pages that need someone signed in, or data, weren't shot: say nothing about them.
Don't change any other file: you review, the dev agents write the code. End with DONE."""

DESIGNER_SECOND = """
This is your second look at this app in this run. The first time you asked for these changes, and the integrator has
tried to fix them:
{previous}
Check whether they are fixed, and look for new clear defects. The app merges after this review either way: anything
you still ask for is shown to the owner as a design warning.
"""


def designer_spec(brief: str, shots: list[dict], skipped: list[dict], task_id: str = "INT", rnd: int = 1,
                  previous=()) -> str:
    def shot(s: dict) -> str:
        notes = [n for n, on in (("scrolls sideways", s.get("horizontal_scroll")),
                                 ("cut at 2400 px", s.get("cut"))) if on]
        title = f', title "{s["title"]}"' if s.get("title") else ""
        return f"- {s.get('route', '?')} at {s.get('width', '?')}px: {s['file']}{title}" + \
            (f" ({', '.join(notes)})" if notes else "")
    skip = "".join(f"\n- {s.get('route', '?')}: {s.get('reason', 'not shot')}" for s in skipped)
    return DESIGNER_SPEC.format(
        brief=brief.strip() or "(no brief)", shots="\n".join(shot(s) for s in shots),
        skipped=f"Not shot (a signed-out visitor can't see them, or they didn't open):{skip}\n" if skip else "",
        second=DESIGNER_SECOND.format(previous="\n".join(f"- {c}" for c in previous)) if rnd > 1 and previous else "",
        verdict=verdict_path(task_id))


def parse_design_review(text: str) -> dict | None:
    """The designer's verdict file, read leniently (code fences, text around the JSON, a single comment as a string),
    or None when it isn't usable: no JSON object, an unknown verdict, or "changes" without a comment."""
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(v, dict):
        return None
    verdict = str(v.get("verdict", "")).strip().lower()
    raw = v.get("comments")
    raw = [raw] if isinstance(raw, str) else raw if isinstance(raw, list) else []
    comments = [c for c in (" ".join(str(x).split()) for x in raw if isinstance(x, (str, int, float))) if c]
    if verdict == "approve" or (verdict == "changes" and comments):
        return {"verdict": verdict, "comments": comments}
    return None


def normalize_design_review(v) -> dict:
    """A design verdict the engine can act on, whatever came back: {verdict: approve | changes, comments,
    designer_error?, skipped?, reason?}. Comments are one plain line each, at most MAX_DESIGN_COMMENTS. Anything
    unusable (no verdict, "changes" with nothing to change, a crash) approves with designer_error: the designer never
    loses a working app. A skipped review (no screenshots, the spending limit) approves with its reason."""
    if isinstance(v, dict) and v.get("skipped"):
        return {"verdict": "approve", "comments": [], "skipped": True,
                "reason": " ".join(str(v.get("reason") or "").split())[:300] or "skipped"}
    if not isinstance(v, dict) or v.get("verdict") not in ("approve", "changes") or v.get("designer_error"):
        why = " ".join(str(v.get("reason") or v.get("note") or "").split())[:200] if isinstance(v, dict) else ""
        return {"verdict": "approve", "comments": [], "designer_error": True,
                "reason": DESIGNER_ERROR_NOTE + (f" ({why})" if why else "")}
    raw = v.get("comments")
    raw = [raw] if isinstance(raw, str) else raw if isinstance(raw, list) else []
    comments = [c for c in (" ".join(str(x).split())[:500] for x in raw if isinstance(x, (str, int, float))) if c]
    comments = comments[:MAX_DESIGN_COMMENTS]
    if v["verdict"] == "changes" and not comments:
        return {"verdict": "approve", "comments": [], "designer_error": True, "reason": DESIGNER_ERROR_NOTE}
    return {"verdict": v["verdict"], "comments": comments}


def review_design(box: Sandbox, agent, *, brief: str, routes=(), task_id: str = "INT", rnd: int = 1, previous=(),
                  budget_cap: float | None = None) -> dict:
    """Screenshots of every page, then the designer's verdict on them, in `box` (a sandbox where the app's production
    build is: `npx next build` has run). Reusable outside the integrator (the Ship screen's "design" check:
    docs/designer.md). Never raises. Returns normalize_design_review's dict plus:
        cost_usd, turns, seconds, claim  what the designer's run cost (0 when it didn't run)
        screens                          how many screenshots it looked at
    skipped (with reason) when no screenshot could be taken; designer_error when its run or verdict broke.
    Nothing it writes is kept: call it after the work is committed, or in a sandbox that is thrown away."""
    shots = take_screenshots(box, routes)
    if not shots["ok"]:
        return {"verdict": "approve", "comments": [], "skipped": True, "reason": shots["reason"], "cost_usd": 0.0,
                "turns": 0, "seconds": shots["seconds"], "claim": "", "screens": 0}
    path = verdict_path(task_id)
    spec = designer_spec(brief, shots["shots"], shots["skipped"], task_id, rnd, previous)
    task = Task(f"{task_id}-design" + (str(rnd) if rnd > 1 else ""), "Design review: every page, desktop and phone",
                spec, ["review/*"], "", role="designer", merge=False, max_attempts=1)
    extra = {"budget_cap": budget_cap} if budget_cap is not None and _takes(agent.run, "budget_cap") else {}
    t0 = time.time()
    try:
        box.exec(f"rm -f {shlex.quote(path)}")
        rep = agent.run(task, box, attempt=1, feedback=None, **extra)
    except Exception as e:
        return {**normalize_design_review({"designer_error": True, "note": f"{type(e).__name__}: {e}"}),
                "cost_usd": 0.0, "turns": 0, "seconds": round(time.time() - t0, 1), "claim": "error",
                "screens": len(shots["shots"])}
    run = {"cost_usd": float(rep.cost_usd or 0.0), "turns": int(rep.turns or 0), "claim": rep.claim,
           "seconds": round(time.time() - t0, 1), "screens": len(shots["shots"])}
    try:
        said = box.exec(f"cat {shlex.quote(path)} 2>/dev/null").output
    except Exception as e:
        said, rep.claim = "", f"error: {type(e).__name__}"
    v = parse_design_review(said)
    if v is None:
        why = rep.claim.removeprefix("error: ") if rep.claim.startswith("error") else "no valid verdict file"
        v = {"designer_error": True, "note": why}
    return {**normalize_design_review(v), **run}


def make_designer(designer, brief: str, routes=(), task_id: str = "INT", budget=None):
    """Task.review_design for the integrator: review_design in its sandbox, with the designer agent (Sonnet in the
    worker), the brief's pages and look, and the pages the integrator had to build. `budget` (the engine's) caps the
    designer's run at what's left of the project's limit."""
    def review(box: Sandbox, rnd: int = 1, previous=()) -> dict:
        cap = budget.cap(getattr(designer, "budget_usd", 1.0)) if budget is not None else None
        return review_design(box, designer, brief=brief, routes=routes, task_id=task_id, rnd=rnd, previous=previous,
                             budget_cap=cap)
    return review


def _takes(fn, name: str) -> bool:
    from engine.engine import _takes as takes
    return takes(fn, name)
