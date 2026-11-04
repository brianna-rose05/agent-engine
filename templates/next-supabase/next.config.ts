import type { NextConfig } from "next";

// PGlite (local mode, src/lib/runtime.ts) loads its own WebAssembly files, so it isn't bundled.
const nextConfig: NextConfig = { serverExternalPackages: ["@electric-sql/pglite"] };

export default nextConfig;
