// Starts the built app (after `next build`) in local mode and requests every page. Template file: do not edit.
//   node scripts/check-app.mjs /book /my-bookings     <- routes the design requires
// Fails if a required route is missing (404), or any page answers with a server error or doesn't answer.
// Pages that need a signed-in person may redirect (3xx): that counts as working.
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const required = process.argv.slice(2).filter((r) => r.startsWith("/"));
const port = 3000 + Math.floor(Math.random() * 2000) + 1000;

/** Static routes from src/app (skips dynamic [segments] and route groups' parentheses). */
function discover(dir = "src/app", prefix = "") {
  const out = [];
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

const routes = [...new Set([...discover(), ...required])].sort();
const env = { ...process.env, PORT: String(port), NEXT_TELEMETRY_DISABLED: "1" };
delete env.DATABASE_URL;                                // always local mode: no real data is touched
delete env.NEXT_PUBLIC_SUPABASE_URL;
// Its own process group, so stopping it also stops the Next.js server npx starts.
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
async function get(route) {
  try {
    const r = await fetch(`http://localhost:${port}${route}`, { redirect: "manual" });
    return r.status;
  } catch {
    return 0;
  }
}

let failed = false;
try {
  for (let i = 0; i < 60 && (await get("/")) === 0; i++) await sleep(1000);
  for (const route of routes) {
    const status = await get(route);
    const missing = status === 404 && required.includes(route);
    const bad = status === 0 || status >= 500 || missing;
    if (bad) failed = true;
    console.log(`${bad ? "FAIL" : "ok  "} ${route} -> ${status || "no answer"}${missing ? " (required page is missing)" : ""}`);
  }
} finally {
  stop();
}
if (failed) {
  console.log("\nServer log (last lines):\n" + log.split("\n").slice(-40).join("\n"));
  process.exit(1);
}
console.log(`\n${routes.length} pages answered without a server error.`);
process.exit(0);
