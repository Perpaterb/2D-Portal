import { defineConfig } from 'vite';

// GitHub Pages serves the project site at /<repo-name>/. Dev and preview use the same
// base so local testing matches production paths exactly.
export const PAGES_BASE = '/2D-Portal/';

export default defineConfig({
  base: PAGES_BASE,
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
});
