// Shared by the page checks (check-app, check-a11y, check-speed). Template file: do not edit.
// Finds the app's pages and starts the built app (after `next build`) in local mode on a free port.
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Exit code of a check that passed with notes (warnings): the ship goes on and shows them. */
export const WARN_EXIT = 10;

/** Static routes from src/app (skips dynamic [segments] and route groups' parentheses). */
export function discover(dir = "src/app", prefix = "") {
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

/** The routes given on the command line (the pages the design requires). */
export const requiredRoutes = (argv = process.argv.slice(2)) => argv.filter((r) => r.startsWith("/"));

/** Every page to check: the discovered ones plus the required ones, sorted. */
export const allRoutes = (required = requiredRoutes()) => [...new Set([...discover(), ...required])].sort();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts `next start` in local mode (no DATABASE_URL: no real data is touched) and waits until "/" answers.
 * Returns { base, port, log(), stop() }. Throws if it never answers.
 */
export async function startApp({ waitSeconds = 60 } = {}) {
  const port = 3000 + Math.floor(Math.random() * 2000) + 1000;
  const env = { ...process.env, PORT: String(port), NEXT_TELEMETRY_DISABLED: "1" };
  delete env.DATABASE_URL;
  delete env.NEXT_PUBLIC_SUPABASE_URL;
  // Its own process group, so stopping it also stops the Next.js server npx starts.
  const server = spawn("npx", ["next", "start", "-p", String(port)], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const base = `http://localhost:${port}`;
  const app = {
    base,
    port,
    log: () => log,
    stop: () => {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        // already gone
      }
    },
  };
  for (let i = 0; i < waitSeconds; i++) {
    if ((await status(base, "/")) !== 0) return app;
    await sleep(1000);
  }
  return app; // callers see each page not answering, with the server log
}

/** The HTTP status of a page without following redirects; 0 when it doesn't answer. */
export async function status(base, route) {
  try {
    const r = await fetch(`${base}${route}`, { redirect: "manual" });
    await r.arrayBuffer();
    return r.status;
  } catch {
    return 0;
  }
}

/** The last lines of the server's log, for a failure report. */
export const logTail = (app, lines = 40) => app.log().split("\n").slice(-lines).join("\n");
