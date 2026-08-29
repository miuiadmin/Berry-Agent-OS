import { defineConfig } from 'vitest/config';

/**
 * 1.0 测试配置（技术栈篇 §2.3：CI 门禁四件之一）。
 * 测试文件与被测模块同目录（src/<模块>/*.test.ts），只覆盖本模块与跨 contract 的公开面。
 */
export default defineConfig({
  test: {
    // 金样回放轨（tools/golden/*.test.mjs）窄面收进常规测试：spawn 子进程跑
    // smoke-replay（.mjs 在 tsc 视野外——tsconfig include 只有 src/，typecheck
    // 不覆盖此处，回放双闸出口 process.exit 的语义靠子进程隔离完整保留）。
    // client 子树显式排除（CR-7）：SPA 测试若引入需 jsdom 环境，node 环境的
    // 常规轨不收（域不同不静默跑红）
    include: ['src/**/*.test.ts', '!src/webui/client/**', 'tools/golden/*.test.mjs'],
    environment: 'node',
  },
});
