import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  trailingSlash: true,
  images: { unoptimized: true },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: "http://127.0.0.1:3888/api/:path*" },
    ];
  },
};

export default nextConfig;
