import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.NEXT_BUILD_EXPORT === "1" ? { output: "export" } : {}),
  distDir: "out",
  trailingSlash: true,
  images: { unoptimized: true },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: "http://127.0.0.1:7860/api/:path*" },
    ];
  },
};

export default nextConfig;
