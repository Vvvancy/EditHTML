import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // 测试直接解析各包的 TS 源码，无需先 build（CI 上干净检出时没有 dist/）。
    // 用别名而不是 exports 条件：Vitest 在 Node 环境走 SSR 解析，不读 resolve.conditions。
    alias: [
      {
        find: /^@edithtml\/([a-z-]+)$/,
        replacement: fileURLToPath(new URL('./packages/$1/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    coverage: { provider: 'v8', include: ['packages/*/src/**'], exclude: ['**/*.test.ts'] },
  },
});
