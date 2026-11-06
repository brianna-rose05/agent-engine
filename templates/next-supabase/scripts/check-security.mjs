// The Ship screen's security check. Template file: do not edit.
//   node scripts/check-security.mjs
// 1. Dependencies: `npm audit --omit=dev` (production dependencies only). A high or critical advisory fails the
//    check; a moderate one is a warning. Advisories the template itself ships with (ACCEPTED below, fixed only by a
//    major upgrade of the template) are listed as known, not counted. If the audit service can't be reached, the
//    check doesn't block: it passes with a warning saying the dependencies weren't audited.
// 2. Secrets: every file in the repo (git ls-files) is scanned for keys, tokens, private keys and connection
//    strings with a password. Any match fails the check. Only the file, line and kind are printed, never the value.
// 3. Sign-in on changes: each route handler (src/app/**/route.ts with POST/PUT/PATCH/DELETE) and server action
//    file ("use server") should reach the template's sign-in or owner checks (src/lib/session.ts, src/lib/owner.ts).
//    A file that doesn't is a warning, never a failure: public forms (sign-up, a contact form) are fine.
// Exit 0: passed. Exit 10: passed with warnings. Exit 1: failed.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { WARN_EXIT } from "./app-server.mjs";

/**
 * Advisories the template's own pinned dependencies carry, fixed only by a major upgrade: listed, not counted.
 * Empty since the Next 16 / zod 4 upgrade (docs/template-upgrades.md). Keep the mechanism: when a new advisory
 * can only be fixed by a major upgrade of the template, add it here as { "GHSA-...": "why it is accepted" }.
 */
export const ACCEPTED = {};

// Built from pieces so this file doesn't match itself.
const BEGIN = "-----" + "BEGIN";
export const SECRET_PATTERNS = [
  ["private key", new RegExp(`${BEGIN} [A-Z0-9 ]*PRIVATE KEY-----`)],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{8,}/],
  ["Vercel token", /\bvercel_[A-Za-z0-9_-]{8,}/],
  ["Daytona API key", /\bdtn_[A-Za-z0-9_-]{8,}/],
  ["Stripe secret key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Supabase service key", /\bsb_secret_[A-Za-z0-9_-]{16,}/],
  ["database URL with a password", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/"'`@]+:([^@\s"'`]+)@([^/\s:"'`?]+)/],
];
/** Passwords and hosts in example connection strings that aren't secrets. */
const PLACEHOLDER_PASSWORD = /^(?:\*+|x+|password|pass|pw|secret|postgres|changeme|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|\[[^\]]*\]|\.\.\.)$/i;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|host|example\.com|db)$/i;
const SKIP_FILES = new Set(["scripts/check-security.mjs", "package-lock.json"]);
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_EXAMPLE = /\.(example|sample|template)$/;

/** Secrets in one file's text: [{line, kind}]. */
export function findSecrets(text) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    for (const [kind, re] of SECRET_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      if (kind === "database URL with a password" && (PLACEHOLDER_PASSWORD.test(m[1]) || LOCAL_HOST.test(m[2]))) continue;
      found.push({ line: i + 1, kind });
    }
  });
  return found;
}

function trackedFiles() {
  const r = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.split("\0").filter(Boolean);
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", ".git"].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(".", p));
    }
  };
  walk(".");
  return out;
}

export function scanSecrets(files = trackedFiles()) {
  const problems = [];
  for (const file of files) {
    if (SKIP_FILES.has(file) || !existsSync(file)) continue;
    if (ENV_FILE.test(file) && !ENV_EXAMPLE.test(file)) {
      problems.push(`${file}: a settings file with secrets is in the repo (keep .env files out of git)`);
      continue;
    }
    const st = statSync(file);
    if (!st.isFile() || st.size > 1_000_000) continue;
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    for (const { line, kind } of findSecrets(buf.toString("utf8"))) problems.push(`${file}:${line}: ${kind}`);
  }
  return problems;
}

/** npm audit's JSON -> {blocking, warnings, known, lows} (advisory lines; known: the template's own), or {unreachable}. */
export function readAudit(stdout, accepted = ACCEPTED) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return { unreachable: "npm audit didn't answer" };
  }
  if (!report || !report.vulnerabilities || report.error) {
    const why = report?.error?.summary || report?.error?.code || "npm audit didn't answer";
    return { unreachable: String(why).split("\n")[0].slice(0, 200) };
  }
  const advisories = new Map();
  for (const v of Object.values(report.vulnerabilities)) {
    for (const via of v.via ?? []) {
      if (typeof via !== "object" || !via) continue;
      const id = String(via.url ?? "").split("/").pop() || `${via.name}:${via.title}`;
      advisories.set(id, { id, name: via.name ?? v.name, severity: via.severity ?? v.severity, title: via.title ?? "", fix: v.fixAvailable });
    }
  }
  const blocking = [];
  const warnings = [];
  const known = [];
  let lows = 0;
  for (const a of [...advisories.values()].sort((x, y) => x.name.localeCompare(y.name))) {
    const line = `${a.severity} ${a.name}: ${a.title} (${a.id})`;
    if (Object.hasOwn(accepted, a.id)) known.push(`${a.severity} ${a.name} (${a.id}): ${accepted[a.id]}`);
    else if (a.severity === "high" || a.severity === "critical") blocking.push(line);
    else if (a.severity === "moderate") warnings.push(line);
    else lows += 1;
  }
  return { blocking, warnings, known, lows };
}

/** Route handlers and server action files that change data without reaching a sign-in or owner check. */
export function unguardedMutations(root = "src/app") {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(name)) continue;
      const text = readFileSync(p, "utf8");
      const route = /^route\.(ts|js)$/.test(name) &&
        /export\s+(?:async\s+)?(?:function\s+|const\s+)(POST|PUT|PATCH|DELETE)\b/.test(text);
      const action = /^\s*["']use server["']/m.test(text);
      if (!route && !action) continue;
      const guarded = /@\/lib\/(session|owner)["']/.test(text) ||
        /\b(getActor|requireActor|getAuth|requireOwner|isOwner)\s*\(/.test(text);
      if (!guarded) out.push(`${relative(".", p)}: ${route ? "a route handler that changes" : "server actions that change"} data without checking who is signed in`);
    }
  };
  walk(root);
  return out;
}

function main() {
  const failures = [];
  const warnings = [];
  const notes = [];

  const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", timeout: 120_000 });
  const deps = readAudit(audit.stdout || "");
  if (deps.unreachable) {
    warnings.push(`Dependencies weren't audited (${deps.unreachable.replace(/[.\s]+$/, "")}). Nothing was blocked for it.`);
  } else {
    failures.push(...deps.blocking.map((x) => `dependency: ${x}`));
    warnings.push(...deps.warnings.map((x) => `dependency: ${x}`));
    notes.push(`Dependencies audited: ${deps.blocking.length} high or critical, ${deps.warnings.length} moderate, ${deps.lows} low.`);
    if (deps.known.length) {
      notes.push(`Known in the template (not counted until it is upgraded): ${deps.known.length}.`);
      notes.push(...deps.known.map((x) => `  ${x}`));
    }
  }

  const secrets = scanSecrets();
  failures.push(...secrets.map((x) => `secret: ${x}`));
  notes.push(`Secrets: ${secrets.length ? `${secrets.length} found` : "none found in the repo's files"}.`);

  const unguarded = unguardedMutations();
  warnings.push(...unguarded.map((x) => `sign-in: ${x} (fine for public forms)`));
  notes.push(`Changes behind sign-in: ${unguarded.length ? `${unguarded.length} file(s) to look at` : "every route handler and server action checks who is signed in"}.`);

  for (const x of failures) console.log(`FAIL ${x}`);
  for (const x of warnings) console.log(`WARN ${x}`);
  console.log("");
  for (const x of notes) console.log(x);
  if (failures.length) {
    console.log(`\nSecurity check failed: ${failures.length} problem(s) to fix.`);
    process.exit(1);
  }
  if (warnings.length) {
    console.log(`\nPassed with warnings: ${warnings.length} note(s), nothing blocking.`);
    process.exit(WARN_EXIT);
  }
  console.log("\nNo security problems found.");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
