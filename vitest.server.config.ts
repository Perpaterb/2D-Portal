import { defineConfig } from 'vitest/config';

// Black-box tests of the deployed server function and database over HTTP.
// Needs a running Supabase (local or remote): see scripts/test-server.sh.
export default defineConfig({
  test: {
    include: ['tests/server/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
