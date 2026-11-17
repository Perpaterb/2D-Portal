// Config-parity checks: cheap assertions over deployment config that catch wiring bugs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PAGES_BASE } from '../../vite.config';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('deployment config parity', () => {
  it('the Vite base path is the GitHub Pages project path', () => {
    expect(PAGES_BASE).toBe('/2D-Portal/');
  });

  it('the Pages workflow deploys only from main, one deploy at a time, after tests', () => {
    const wf = read('.github/workflows/pages.yml');
    expect(wf).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(wf).toMatch(/cancel-in-progress: false/);
    expect(wf).toMatch(/deploy:\s*\n\s*needs: test/);
    expect(wf).toMatch(/path: dist/);
  });

  it('the post-deploy smoke run targets the same path the site is built for', () => {
    const wf = read('.github/workflows/pages.yml');
    const m = /smoke\.sh --target (\S+)/.exec(wf);
    expect(m).not.toBeNull();
    expect(new URL(m![1]).pathname).toBe(PAGES_BASE);
  });

  it('local end-to-end tests run against the same base path', () => {
    expect(read('playwright.config.ts')).toContain(`localhost:4173${PAGES_BASE}`);
  });

  it('CI never deploys', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toMatch(/deploy-pages/);
    expect(ci).toMatch(/branches-ignore: \[main\]/);
  });

  it('the simulation never imports browser code (it must run on the server)', () => {
    for (const f of ['src/sim/sim.ts', 'src/sim/level.ts', 'src/sim/replay.ts', 'src/sim/fixed.ts']) {
      const src = read(f);
      expect(src).not.toMatch(/from '\.\.\/app/);
      expect(src).not.toMatch(/\b(window|document|performance|Date\.now|Math\.random)\b/);
    }
  });
});
