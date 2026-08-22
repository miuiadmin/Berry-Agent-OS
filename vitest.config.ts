import { defineConfig } from 'vitest/config'

/**
 * 1.0 测试配置（技术栈篇 §2.3：CI 门禁四件之一）。
 * 测试文件与被测模块同目录（src/<模块>/*.test.ts），只覆盖本模块与跨 contract 的公开面。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
