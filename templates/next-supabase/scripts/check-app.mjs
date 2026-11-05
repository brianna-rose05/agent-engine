// Starts the built app (after `next build`) in local mode and requests every page. Template file: do not edit.
//   node scripts/check-app.mjs /book /my-bookings     <- routes the design requires
// Fails if a required route is missing (404), or any page answers with a server error or doesn't answer.
// Pages that need a signed-in person may redirect (3xx): that counts as working.
import { allRoutes, logTail, requiredRoutes, startApp, status } from "./app-server.mjs";

const required = requiredRoutes();
const routes = allRoutes(required);
const app = await startApp();

let failed = false;
try {
  for (const route of routes) {
    const code = await status(app.base, route);
    const missing = code === 404 && required.includes(route);
    const bad = code === 0 || code >= 500 || missing;
    if (bad) failed = true;
    console.log(`${bad ? "FAIL" : "ok  "} ${route} -> ${code || "no answer"}${missing ? " (required page is missing)" : ""}`);
  }
} finally {
  app.stop();
}
if (failed) {
  console.log("\nServer log (last lines):\n" + logTail(app));
  process.exit(1);
}
console.log(`\n${routes.length} pages answered without a server error.`);
process.exit(0);
