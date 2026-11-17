import { defineConfig } from 'vite';

// Bundles the deterministic simulation for the Supabase Edge Function (Deno), so the
// server re-runs replays with exactly the same code as the game.
export default defineConfig({
  build: {
    outDir: 'supabase/functions/api/_generated',
    emptyOutDir: true,
    minify: false,
    lib: { entry: 'src/server/entry.ts', formats: ['es'], fileName: () => 'sim.js' },
  },
});
