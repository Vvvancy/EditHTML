import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // 测试直接解析各包的 TS 源码（package.json exports 中的 "source" 条件），无需先 build。
    conditions: ['source'],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    coverage: { provider: 'v8', include: ['packages/*/src/**'], exclude: ['**/*.test.ts'] },
  },
});
