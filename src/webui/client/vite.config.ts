/**
 * vite 构建配置（刀二构建管线——契约篇 §6.8 构建管线条）。
 *
 * 关键裁决（冷读 CR-4/5/6）：
 * - outDir **仓根锚定**：vite 相对 outDir 按 config 所在目录（root）解析，
 *   必须绝对路径钉到仓根 dist/webui——与 tsc 宿主侧产物（dist/webui/app.js，
 *   运行时 staticRoot = import.meta.dirname）同目录共存；
 * - emptyOutDir: false **钉死**：清目录会连带清掉 tsc 同目录产物；
 * - dev proxy：/api → 宿主缺省端口，changeOrigin: true（Host 头改写为代理
 *   目标——宿主防线② Host 白名单的通过条件）。
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // SPA root = 本目录（index.html 在此）
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    // 仓根锚定（防 vite 相对解析落到 src/webui/dist 之类）；false = 不清目录
    outDir: fileURLToPath(new URL('../../../dist/webui', import.meta.url)),
    emptyOutDir: false,
  },
  server: {
    // 开发形态：vite dev server 直开（默认 5173），API 面转发宿主——changeOrigin
    // 必开（转发请求的 Host 头改写为目标，否则宿主 Host 白防线 403）
    proxy: {
      '/api': { target: 'http://127.0.0.1:7860', changeOrigin: true },
    },
  },
});
