import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["playwright"],
  experimental: {
    cpus: 1,
    workerThreads: false,
  },
};

export default nextConfig;
