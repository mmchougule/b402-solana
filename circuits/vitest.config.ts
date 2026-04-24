import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120_000, // witness generation is slow
    hookTimeout: 120_000,
    include: ['tests/**/*.test.ts'],
  },
});
