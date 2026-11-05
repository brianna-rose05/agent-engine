// Screenshots of every page of the built app, for the designer (docs/designer.md). Template file: do not edit.
//   node scripts/screenshots.mjs /book /my-bookings     <- routes the design requires (others are found in src/app)
// Run after `npx next build`. Starts the built app in local mode (like scripts/check-app.mjs: no real data is
// touched), opens every page in Chromium as a signed-out visitor at desktop (1280x800) and phone (390x844) size and
// saves review/screens/<page>-<width>.png, plus review/screens/manifest.json listing what was shot and what wasn't.
//
// What it can see: what a signed-out visitor sees, and pages that render without data. A page that sends a signed-out
// visitor somewhere else (a redirect to sign-in) is listed as skipped, not shot: the page it lands on is shot on its
// own. Dynamic routes ([id]) are never visited. Each shot is the top of the page, at most 2400 px tall.
//
// Needs Playwright and Chromium. When they're missing it installs them into ~/.cache/studio-playwright (never into the
// project), with `playwright install --with-deps chromium`, falling back to the browser alone without root, and
// prints how long that took. Flags: --no-install (fail instead), --out <dir> (default review/screens).
// Exit codes: 0 shots taken; 1 the app didn't start or no page could be shot; 2 the app isn't built; 3 no browser.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PLAYWRIGHT_VERSION = "1.63.0";
const VIEWPORTS = [
  { width: 1280, height: 800, mobile: false },
  { width: 390, height: 844, mobile: true },
];
const MAX_HEIGHT = 2400;
const MAX_ROUTES = 30;

const args = process.argv.slice(2);
const noInstall = args.includes("--no-install");
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : "review/screens";
const required = args.filter((a, i) => a.startsWith("/") && (outIdx < 0 || i !== outIdx + 1));
const pwHome = process.env.PLAYWRIGHT_DIR || join(homedir(), ".cache", "studio-playwright");
const port = 3000 + Math.floor(Math.random() * 2000) + 1000;
const started = Date.now();
const secs = (t) => Math.round((Date.now() - t) / 100) / 10;

/** Static routes from src/app (skips dynamic [segments], private folders, api, and route groups' parentheses). */
function discover(dir = "src/app", prefix = "") {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name.startsWith("[") || name.startsWith("_") || name === "api") continue;
      const seg = name.startsWith("(") ? "" : `/${name}`;
      out.push(...discover(p, prefix + seg));
    } else if (/^page\.(tsx|ts|jsx|js)$/.test(name)) {
      out.push(prefix || "/");
    }
  }
  return out;
}

/** "/" -> "home", "/staff/schedule" -> "staff-schedule": the file name of a page's screenshots. */
function slug(route) {
  const s = route.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return s || "home";
}

/** Playwright from wherever it is (the project, our own cache folder, or a global install), with the folder it
 * resolved from (for its CLI, to install the browser). */
function loadPlaywright() {
  const roots = [process.cwd(), pwHome];
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    // no npm on PATH
  }
  for (const root of roots) {
    const req = createRequire(join(root, "noop.js"));
    try {
      const pw = req("playwright");
      return { pw, cli: join(dirname(req.resolve("playwright/package.json")), "cli.js") };
    } catch {
      // not there
    }
  }
  return null;
}

function run(cmd, cmdArgs, opts = {}) {
  const env = { ...process.env };
  delete env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
  execFileSync(cmd, cmdArgs, { stdio: ["ignore", "inherit", "inherit"], env, timeout: 15 * 60 * 1000, ...opts });
}

function installBrowser(cli) {
  try {
    run(process.execPath, [cli, "install", "--with-deps", "chromium"]);
  } catch {
    console.log("setup: installing with system packages failed (no root?); installing the browser alone");
    run(process.execPath, [cli, "install", "chromium"]);
  }
}

/** A running Chromium, installing Playwright and the browser first when they're missing. */
async function browser() {
  const t = Date.now();
  let found = loadPlaywright();
  if (!found) {
    if (noInstall) throw new Error("Playwright is not installed (--no-install)");
    console.log(`setup: installing Playwright ${PLAYWRIGHT_VERSION} into ${pwHome}`);
    mkdirSync(pwHome, { recursive: true });
    run("npm", ["install", "--prefix", pwHome, "--no-save", "--no-audit", "--no-fund", "--loglevel=error",
                `playwright@${PLAYWRIGHT_VERSION}`]);
    found = loadPlaywright();
    if (!found) throw new Error("Playwright didn't install");
  }
  const { pw, cli } = found;
  try {
    const b = await pw.chromium.launch();
    console.log(`setup: Chromium ready in ${secs(t)}s`);
    return b;
  } catch (e) {
    if (noInstall || !/Executable doesn't exist|playwright install/i.test(String(e?.message ?? e))) throw e;
  }
  console.log("setup: installing Chromium");
  installBrowser(cli);
  const b = await pw.chromium.launch();
  console.log(`setup: Playwright and Chromium installed in ${secs(t)}s`);
  return b;
}

if (!existsSync(".next/BUILD_ID")) {
  console.log("The app isn't built: run `npx next build` first.");
  process.exit(2);
}

let chromium;
try {
  chromium = await browser();
} catch (e) {
  console.log(`No browser for screenshots: ${String(e?.message ?? e).split("\n")[0].slice(0, 300)}`);
  process.exit(3);
}

const routes = [...new Set([...discover(), ...required])].sort().slice(0, MAX_ROUTES);
const env = { ...process.env, PORT: String(port), NEXT_TELEMETRY_DISABLED: "1" };
delete env.DATABASE_URL;                                // always local mode: no real data is touched
delete env.NEXT_PUBLIC_SUPABASE_URL;
const server = spawn("npx", ["next", "start", "-p", String(port)], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
const stop = () => {
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {
    // already gone
  }
};
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function answers() {
  try {
    await fetch(`http://localhost:${port}/`, { redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

const shots = [];
const skipped = [];
let code = 0;
try {
  let up = false;
  for (let i = 0; i < 60 && !(up = await answers()); i++) await sleep(1000);
  if (!up) throw new Error("the app didn't start");
  mkdirSync(outDir, { recursive: true });
  for (const vp of VIEWPORTS) {
    // Not isMobile: a phone browser would zoom out to fit a page that's too wide, which hides the very problem the
    // designer looks for. A 390 px wide window shows it as content cut off at the right edge instead.
    const context = await chromium.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1,
                                                 hasTouch: vp.mobile });
    const page = await context.newPage();
    for (const route of routes) {
      try {
        const res = await page.goto(`http://localhost:${port}${route}`, { waitUntil: "load", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        const status = res?.status() ?? 0;
        const landed = new URL(page.url()).pathname.replace(/\/$/, "") || "/";
        if (landed !== (route.replace(/\/$/, "") || "/")) {
          if (vp === VIEWPORTS[0]) skipped.push({ route, reason: `a signed-out visitor is sent to ${landed}` });
          continue;
        }
        if (status >= 400) {
          if (vp === VIEWPORTS[0]) skipped.push({ route, reason: `the page answered ${status}` });
          continue;
        }
        const size = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight, title: document.title,
        }));
        const file = join(outDir, `${slug(route)}-${vp.width}.png`);
        const tall = size.scrollHeight > MAX_HEIGHT;
        // the window's width (what fits on screen; anything wider is cut off, as a visitor sees it), full height up to
        // MAX_HEIGHT
        await page.screenshot({ path: file, fullPage: true,
                                clip: { x: 0, y: 0, width: vp.width, height: Math.min(size.scrollHeight, MAX_HEIGHT) } });
        shots.push({ route, width: vp.width, height: vp.height, file, title: size.title,
                     page_height: size.scrollHeight, cut: tall,
                     horizontal_scroll: size.scrollWidth > vp.width + 1 });
        console.log(`shot ${route} at ${vp.width}px -> ${file}${size.scrollWidth > vp.width + 1 ? " (scrolls sideways)" : ""}`);
      } catch (e) {
        if (vp === VIEWPORTS[0]) skipped.push({ route, reason: `couldn't open it: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}` });
      }
    }
    await context.close();
  }
  if (!shots.length) throw new Error("no page could be shot");
} catch (e) {
  code = 1;
  console.log(`Screenshots failed: ${String(e?.message ?? e).split("\n")[0]}`);
  console.log("Server log (last lines):\n" + log.split("\n").slice(-30).join("\n"));
} finally {
  await chromium.close().catch(() => {});
  stop();
}
if (shots.length) {
  writeFileSync(join(outDir, "manifest.json"),
                JSON.stringify({ shots, skipped, seconds: secs(started) }, null, 2) + "\n");
  for (const s of skipped) console.log(`skipped ${s.route}: ${s.reason}`);
  console.log(`\n${shots.length} screenshots of ${new Set(shots.map((s) => s.route)).size} pages in ${secs(started)}s.`);
}
process.exit(code);
