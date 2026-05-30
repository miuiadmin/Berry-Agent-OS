import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': './src',
    },
  },
  test: {
    exclude: ['node_modules', 'dist', '参考源码', 'web'],
    pool: 'forks',
    testTimeout: 30000,
    maxForks: 4,
  },
});
