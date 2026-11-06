import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { NextConfig } from "next";

// Local mode (src/lib/runtime.ts) runs PGlite and reads supabase/migrations at runtime. Neither is found by
// Next's file tracing, so serverless deploys (Vercel previews) would ship without them: include them.
//
// Local engine runs and tests share one installed node_modules through a symlink (engine/stacks.py build_repo).
// Turbopack (Next 16's default bundler) never resolves files outside the project root, so a symlinked node_modules
// is declared as an additional root: the folder holding the real node_modules (packages resolve each other through a
// `node_modules` folder). Deploys and cloud sandboxes install a real node_modules: nothing changes there.
function linkedNodeModules(): string | null {
  try {
    return lstatSync("node_modules").isSymbolicLink() ? dirname(realpathSync("node_modules")) : null;
  } catch {
    return null;
  }
}
const linked = linkedNodeModules();

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite"],
  outputFileTracingIncludes: {
    "/**": ["./supabase/migrations/**/*", "./node_modules/@electric-sql/pglite/dist/**/*"],
  },
};
// Added untyped so this file also type-checks on Next 15, which has no such option: projects held on their own
// major (docs/template-upgrades.md) still get this file. Regression (Tool library's first ship, Nov 5): the Next 16
// version of this file failed the type check of a project still on Next 15.
if (linked) Object.assign(nextConfig, { experimental: { turbopackAdditionalRoots: { sharedNodeModules: { path: linked } } } });

export default nextConfig;
