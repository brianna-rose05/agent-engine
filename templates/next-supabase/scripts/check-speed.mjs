// The Ship screen's speed check. Template file: do not edit.
//   node scripts/check-speed.mjs /book /my-bookings     <- routes the design requires (as check-app.mjs)
// Starts the built app (after `next build`) in local mode and, for every page check-app.mjs visits, measures:
// - response time: the page's HTML, the median of 3 requests after one warm-up (local mode, so no network to a
//   database: production adds that);
// - first-load JS: the gzipped size of every /_next/static/*.js file the page's HTML loads, read from .next/static
//   (what `next build` calls "First Load JS").
// Warning when a page loads more than 300 kB of JS or takes more than 2 s; fails only past 1 MB or 10 s.
// Exit 0: passed. Exit 10: passed with warnings. Exit 1: failed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { allRoutes, logTail, startApp, WARN_EXIT } from "./app-server.mjs";

export const LIMITS = { warnKB: 300, failKB: 1024, warnMs: 2000, failMs: 10_000 };

/**
 * The /_next/static .js files a page's HTML loads (script tags, preloads and the React Server Components payload).
 * Legacy-browser polyfills (`<script nomodule>`) aren't counted: modern browsers skip them, and Next doesn't count them.
 */
export function scriptsIn(html) {
  const legacy = new Set();
  for (const tag of html.match(/<script\b[^>]*\bnomodule\b[^>]*>/gi) ?? []) {
    const src = tag.match(/\bsrc="(?:\/_next\/)?([^"]+)"/i);
    if (src) legacy.add(src[1]);
  }
  const out = new Set();
  for (const m of html.matchAll(/(?:\/_next\/)?static\/(?:chunks|[A-Za-z0-9_-]+)\/[A-Za-z0-9_\-./[\]()%@~]+?\.js/g)) {
    const rel = m[0].replace(/^\/_next\//, "");
    if (!rel.includes("..") && !legacy.has(rel) && !/(^|\/)polyfills-[^/]*\.js$/.test(rel)) out.add(decodeURIComponent(rel));
  }
  return [...out].sort();
}

const gzCache = new Map();
/** Gzipped bytes of .next/<rel>, 0 when the file isn't there. */
export function gzipBytes(rel, dir = ".next") {
  if (!gzCache.has(rel)) {
    const p = join(dir, rel);
    gzCache.set(rel, existsSync(p) ? gzipSync(readFileSync(p)).length : 0);
  }
  return gzCache.get(rel);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function measure(base, route) {
  const timed = async () => {
    const t = performance.now();
    const r = await fetch(base + route);
    const html = await r.text();
    return { ms: performance.now() - t, html, status: r.status, landed: new URL(r.url).pathname };
  };
  await timed(); // warm-up: the first request in local mode also starts its database
  const runs = [await timed(), await timed(), await timed()];
  const last = runs.at(-1);
  const scripts = scriptsIn(last.html);
  const bytes = scripts.reduce((sum, rel) => sum + gzipBytes(rel), 0);
  return { route, landed: last.landed, status: last.status, ms: Math.round(median(runs.map((x) => x.ms))), kb: Math.round(bytes / 1024), scripts: scripts.length };
}

/** Verdict per page: "ok" | "warn" | "fail", with the reasons. */
export function judge(row, limits = LIMITS) {
  const reasons = [];
  let level = "ok";
  const bump = (l, why) => {
    reasons.push(why);
    if (l === "fail" || level === "ok") level = l;
  };
  if (row.error) return { level: "fail", reasons: [row.error] };
  if (row.kb > limits.failKB) bump("fail", `${row.kb} kB of JS (limit ${limits.failKB} kB)`);
  else if (row.kb > limits.warnKB) bump("warn", `${row.kb} kB of JS (aim for under ${limits.warnKB} kB)`);
  if (row.ms > limits.failMs) bump("fail", `${(row.ms / 1000).toFixed(1)} s to answer (limit ${limits.failMs / 1000} s)`);
  else if (row.ms > limits.warnMs) bump("warn", `${(row.ms / 1000).toFixed(1)} s to answer (aim for under ${limits.warnMs / 1000} s)`);
  return { level, reasons };
}

/** The table and verdict lines, and the exit code. */
export function report(rows, limits = LIMITS) {
  const verdicts = rows.map((r) => ({ r, ...judge(r, limits) }));
  const width = Math.max(4, ...rows.map((r) => r.route.length)) + 2;
  const lines = [`${"Page".padEnd(width)}${"Response".padStart(10)}${"JS (gzip)".padStart(12)}  `];
  for (const { r, level } of verdicts) {
    const mark = level === "ok" ? "" : level === "warn" ? "  slow" : "  too slow";
    lines.push(r.error
      ? `${r.route.padEnd(width)}${"-".padStart(10)}${"-".padStart(12)}  didn't load`
      : `${r.route.padEnd(width)}${`${r.ms} ms`.padStart(10)}${`${r.kb} kB`.padStart(12)}${mark}${r.landed && r.landed !== r.route ? ` (-> ${r.landed})` : ""}`);
  }
  const failed = verdicts.filter((v) => v.level === "fail");
  const warned = verdicts.filter((v) => v.level === "warn");
  lines.push("");
  for (const v of [...failed, ...warned]) lines.push(`${v.level === "fail" ? "FAIL" : "WARN"} ${v.r.route}: ${v.reasons.join("; ")}`);
  if (failed.length) {
    lines.push(`Speed check failed: ${failed.length} page(s) far too slow or too heavy.`);
    return { lines, code: 1 };
  }
  if (warned.length) {
    lines.push(`Passed with warnings: ${warned.length} page(s) could be faster.`);
    return { lines, code: WARN_EXIT };
  }
  lines.push(`All ${rows.length} page(s) answer in under ${limits.warnMs / 1000} s with under ${limits.warnKB} kB of JS.`);
  return { lines, code: 0 };
}

async function main() {
  const routes = allRoutes();
  const app = await startApp();
  const rows = [];
  try {
    for (const route of routes) {
      try {
        rows.push(await measure(app.base, route));
      } catch (e) {
        rows.push({ route, error: `didn't answer (${String(e?.message ?? e).split("\n")[0]})` });
      }
    }
  } finally {
    app.stop();
  }
  if (rows.some((r) => r.error)) console.log("Server log (last lines):\n" + logTail(app, 20) + "\n");
  const { lines, code } = report(rows);
  console.log(lines.join("\n"));
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
