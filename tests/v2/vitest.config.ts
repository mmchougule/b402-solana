import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000, // some Light calls take a beat
    hookTimeout: 30_000,
    include: ['**/*.test.ts'],
    pool: 'forks', // each test file in its own process so a hung Photon
                   // doesn't take down the whole suite
  },
});
