import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one database; running files in parallel would have them
    // truncating each other's fixtures mid-test.
    fileParallelism: false,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
