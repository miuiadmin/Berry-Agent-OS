import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const backendPort = process.env.APP_PORT || 3888;
const backendHost = process.env.APP_HOST || "127.0.0.1";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 3889,
    proxy: {
      "/api": `http://${backendHost}:${backendPort}`,
      "/ws": { target: `ws://${backendHost}:${backendPort}`, ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
