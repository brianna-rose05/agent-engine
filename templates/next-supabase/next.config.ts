import type { NextConfig } from "next";

// Local mode (src/lib/runtime.ts) runs PGlite and reads supabase/migrations at runtime. Neither is found by
// Next's file tracing, so serverless deploys (Vercel previews) would ship without them: include them.
const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite"],
  outputFileTracingIncludes: {
    "/**": ["./supabase/migrations/**/*", "./node_modules/@electric-sql/pglite/dist/**/*"],
  },
};

export default nextConfig;
