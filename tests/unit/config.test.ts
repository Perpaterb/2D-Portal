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
    expect(wf).toMatch(/backend:\s*\n\s*needs: test/);
    expect(wf).toMatch(/deploy:\s*\n\s*needs: backend/);
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

  it('the live build talks to the backend the pipeline deployed, and the password only goes to the server', () => {
    const wf = read('.github/workflows/pages.yml');
    expect(wf).toContain('VITE_SUPABASE_URL: ${{ vars.SUPABASE_URL }}');
    expect(wf).toContain('VITE_SUPABASE_ANON_KEY: ${{ vars.SUPABASE_ANON_KEY }}');
    expect(wf).toMatch(/supabase db push/);
    expect(wf).toMatch(/supabase functions deploy api .*--no-verify-jwt/);
    expect(wf).toMatch(/supabase secrets set .*--env-file/);
    // the admin password must never reach the page build
    const deployJob = wf.slice(wf.indexOf('  deploy:'), wf.indexOf('  smoke:'));
    expect(deployJob).not.toMatch(/ADMIN_PASSWORD/);
    expect(deployJob).not.toMatch(/SERVICE_ROLE/);
  });

  it('the server function accepts the public key (access is checked inside it)', () => {
    expect(read('supabase/config.toml')).toMatch(/\[functions\.api\][\s\S]*verify_jwt = false/);
  });

  it('the database only lets the public read, never write', () => {
    const sql = read('supabase/migrations/20261117000000_global_levels.sql');
    for (const t of ['global_levels', 'runs', 'admin_attempts']) expect(sql).toContain(`alter table public.${t} enable row level security`);
    expect(sql).toMatch(/revoke insert, update, delete on public\.global_levels from anon, authenticated/);
    expect(sql).toMatch(/revoke insert, update, delete on public\.runs from anon, authenticated/);
    expect(sql).not.toMatch(/for (insert|update|delete|all)/);
  });

  it('the page source never contains a service key or the admin password', () => {
    for (const f of ['src/app/global.ts', 'src/app/menu.ts', 'src/app/play.ts']) {
      const src = read(f);
      expect(src).not.toMatch(/SERVICE_ROLE|service_role|ADMIN_PASSWORD/);
    }
  });

  it('CI never deploys', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toMatch(/deploy-pages/);
    expect(ci).toMatch(/branches-ignore: \[main\]/);
  });

  it('the simulation never imports browser code (it must run on the server)', () => {
    for (const f of ['src/sim/sim.ts', 'src/sim/level.ts', 'src/sim/replay.ts', 'src/sim/fixed.ts', 'src/sim/names.ts', 'src/server/entry.ts']) {
      const src = read(f);
      expect(src).not.toMatch(/from '\.\.\/app/);
      expect(src).not.toMatch(/\b(window|document|performance|Date\.now|Math\.random)\b/);
    }
  });
});
