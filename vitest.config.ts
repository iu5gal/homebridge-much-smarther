import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@much-smarther\/core\/cloud$/, replacement: source('./packages/core/src/cloud.ts') },
      { find: /^@much-smarther\/core$/, replacement: source('./packages/core/src/index.ts') },
      { find: /^@much-smarther\/simulator$/, replacement: source('./packages/simulator/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      reporter: ['text', 'html'],
      thresholds: {
        'packages/core/src/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
      },
    },
  },
});
