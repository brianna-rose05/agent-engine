// The Ship screen's accessibility check. Template file: do not edit.
//   node scripts/check-a11y.mjs /book /my-bookings     <- routes the design requires (as check-app.mjs)
// Starts the built app (after `next build`) in local mode and runs axe-core on every page check-app.mjs visits,
// at desktop (1280 px) and phone (390 px) width, in headless Chromium (Playwright). Pages that need sign-in are
// checked where they redirect to.
// "serious" and "critical" problems fail the check; "moderate" and "minor" ones are warnings.
// If Chromium isn't installed it runs `npx playwright install --with-deps --only-shell chromium` once. If Chromium still can't
// start, the pages are checked without a browser (jsdom, server-rendered HTML): colour contrast and the phone width
// can't be checked that way, which the check says as a warning.
// Exit 0: passed. Exit 10: passed with warnings. Exit 1: failed.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { allRoutes, logTail, startApp, WARN_EXIT } from "./app-server.mjs";

const require = createRequire(import.meta.url);
export const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
];
export const BLOCKING = new Set(["serious", "critical"]);
const IMPACT_ORDER = ["critical", "serious", "moderate", "minor"];

/** Chromium through Playwright, installing it once if it's missing; null when it can't start here. */
async function launchChromium(say) {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    say("Playwright isn't installed (npm ci installs it from package.json).");
    return null;
  }
  try {
    return await chromium.launch();
  } catch {
    // not installed yet: download it (with the system libraries it needs when we may install them)
  }
  const t0 = Date.now();
  // headless shell only (about 115 MB, not the full browser too)
  for (const args of [["playwright", "install", "--with-deps", "--only-shell", "chromium"], ["playwright", "install", "--only-shell", "chromium"]]) {
    const r = spawnSync("npx", args, { encoding: "utf8", timeout: 10 * 60_000 });
    if (r.status !== 0) continue;
    try {
      const browser = await chromium.launch();
      say(`Installed Chromium in ${Math.round((Date.now() - t0) / 1000)} s.`);
      return browser;
    } catch {
      // try the next way
    }
  }
  say(`Chromium couldn't be installed or started here (tried for ${Math.round((Date.now() - t0) / 1000)} s).`);
  return null;
}

const axeSource = () => readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const AXE_OPTIONS = { resultTypes: ["violations"] };

async function scanWithBrowser(browser, base, routes) {
  const results = [];
  const source = axeSource();
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    for (const route of routes) {
      try {
        await page.goto(base + route, { waitUntil: "load", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        await page.addScriptTag({ content: source });
        const violations = await page.evaluate((opts) => window.axe.run(document, opts).then((r) => r.violations), AXE_OPTIONS);
        results.push({ route, viewport: vp.name, landed: new URL(page.url()).pathname, violations });
      } catch (e) {
        results.push({ route, viewport: vp.name, error: String(e?.message ?? e).split("\n")[0] });
      }
    }
    await context.close();
  }
  return results;
}

async function scanWithJsdom(base, routes) {
  const { JSDOM, VirtualConsole } = require("jsdom");
  const source = axeSource();
  const results = [];
  for (const route of routes) {
    try {
      const r = await fetch(base + route);
      const html = await r.text();
      const dom = new JSDOM(html, { url: r.url, runScripts: "outside-only", virtualConsole: new VirtualConsole() });
      dom.window.eval(source);
      // colour contrast needs real layout, which jsdom doesn't have
      const res = await dom.window.axe.run(dom.window.document, { ...AXE_OPTIONS, rules: { "color-contrast": { enabled: false } } });
      results.push({ route, viewport: "no browser", landed: new URL(r.url).pathname, violations: res.violations });
      dom.window.close();
    } catch (e) {
      results.push({ route, viewport: "no browser", error: String(e?.message ?? e).split("\n")[0] });
    }
  }
  return results;
}

/** Results per page and width -> problems grouped by rule, worst first: [{id, impact, help, where: [..], nodes}]. */
export function summarize(results) {
  const byRule = new Map();
  for (const r of results) {
    for (const v of r.violations ?? []) {
      const rule = byRule.get(v.id) ?? { id: v.id, impact: v.impact ?? "minor", help: v.help ?? "", where: [], nodes: 0, sample: "" };
      const at = r.landed && r.landed !== r.route ? `${r.route} (-> ${r.landed})` : r.route;
      rule.where.push(`${at} ${r.viewport}`);
      rule.nodes += v.nodes?.length ?? 0;
      rule.sample ||= (v.nodes?.[0]?.target ?? []).join(" ").slice(0, 80);
      byRule.set(v.id, rule);
    }
  }
  return [...byRule.values()].sort((a, b) => IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact) || a.id.localeCompare(b.id));
}

/** The report's lines and its exit code. */
export function report(results, { browser }) {
  const lines = [];
  const rules = summarize(results);
  const errors = results.filter((r) => r.error);
  for (const r of results) {
    if (r.error) {
      lines.push(`FAIL ${r.route} ${r.viewport}: couldn't be checked (${r.error})`);
      continue;
    }
    const rank = (impact) => (IMPACT_ORDER.includes(impact) ? IMPACT_ORDER.indexOf(impact) : IMPACT_ORDER.length - 1);
    const worst = IMPACT_ORDER[Math.min(...r.violations.map((v) => rank(v.impact)), IMPACT_ORDER.length)];
    const tag = BLOCKING.has(worst) ? "FAIL" : r.violations.length ? "warn" : "ok  ";
    const at = r.landed && r.landed !== r.route ? ` (-> ${r.landed})` : "";
    lines.push(`${tag} ${r.route}${at} ${r.viewport}: ${r.violations.length ? `${r.violations.length} problem(s), worst ${worst}` : "no problems"}`);
  }
  const blocking = rules.filter((x) => BLOCKING.has(x.impact));
  const warnings = rules.filter((x) => !BLOCKING.has(x.impact));
  if (rules.length) lines.push("");
  for (const x of rules) {
    const where = [...new Set(x.where)];
    lines.push(`${BLOCKING.has(x.impact) ? "FAIL" : "WARN"} [${x.impact}] ${x.id}: ${x.help} - ${x.nodes} element(s) on ${where.slice(0, 4).join(", ")}${where.length > 4 ? ` and ${where.length - 4} more` : ""}${x.sample ? ` (e.g. ${x.sample})` : ""}`);
  }
  lines.push("");
  if (!browser) lines.push("Checked without a browser: colour contrast and the phone width weren't checked.");
  const pages = new Set(results.map((r) => r.route)).size;
  if (blocking.length || errors.length) {
    lines.push(`Accessibility check failed: ${blocking.length} serious or critical problem(s)${errors.length ? `, ${errors.length} page check(s) that didn't run` : ""} on ${pages} page(s).`);
    return { lines, code: 1 };
  }
  if (warnings.length || !browser) {
    lines.push(`Passed with warnings: ${warnings.length} moderate or minor problem(s) on ${pages} page(s), nothing serious.`);
    return { lines, code: WARN_EXIT };
  }
  lines.push(`No accessibility problems found on ${pages} page(s) at desktop and phone width.`);
  return { lines, code: 0 };
}

async function main() {
  const t0 = Date.now();
  const routes = allRoutes();
  const notes = [];
  // A11Y_NO_BROWSER=1 checks without a browser, as when Chromium can't start (the template's tests use it).
  const browser = process.env.A11Y_NO_BROWSER === "1" ? null : await launchChromium((m) => notes.push(m));
  const app = await startApp();
  let results;
  try {
    results = browser ? await scanWithBrowser(browser, app.base, routes) : await scanWithJsdom(app.base, routes);
  } finally {
    await browser?.close().catch(() => {});
    app.stop();
  }
  const { lines, code } = report(results, { browser: Boolean(browser) });
  if (results.some((r) => r.error)) console.log("Server log (last lines):\n" + logTail(app, 20) + "\n");
  for (const n of notes) console.log(n);
  console.log(lines.join("\n"));
  console.log(`(${Math.round((Date.now() - t0) / 1000)} s)`);
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
