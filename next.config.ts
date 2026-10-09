import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Browser automation packages must stay as real node_modules at runtime.
  serverExternalPackages: ["playwright", "playwright-core", "@sparticuz/chromium"],
  // Files read from disk at runtime that the bundler cannot see: the serverless Chromium binary
  // and the Mermaid bundle used to draw diagrams inside PDFs.
  outputFileTracingIncludes: {
    "/api/research": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/api/warm": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/api/export/pdf": [
      "./node_modules/@sparticuz/chromium/bin/**/*",
      "./node_modules/mermaid/dist/mermaid.min.js",
    ],
  },
  // The local dev machine is single-core; Vercel's builders are not.
  ...(process.env.VERCEL ? {} : { experimental: { cpus: 1, workerThreads: false } }),
};

export default nextConfig;
