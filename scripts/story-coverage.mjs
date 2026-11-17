#!/usr/bin/env node
// Reports which user stories are walked through by at least one end-to-end test.
// A story counts as covered when its ID appears in an E2E test title in tests/e2e.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const stories = [...readFileSync(join(root, 'docs/UserStories.md'), 'utf8').matchAll(/^### (US-\d+)\s+(.*)$/gm)].map((m) => ({ id: m[1], title: m[2] }));
const dir = join(root, 'tests/e2e');
const titles = readdirSync(dir)
  .filter((f) => f.endsWith('.spec.ts'))
  .flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/test\(\s*'([^']+)'/g)].map((m) => m[1]));

const covered = new Set();
for (const t of titles) {
  for (const m of t.matchAll(/US-(\d+)(?: to US-(\d+))?/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = a; i <= b; i++) covered.add(`US-${String(i).padStart(3, '0')}`);
  }
}

let n = 0;
for (const s of stories) {
  const ok = covered.has(s.id);
  if (ok) n++;
  console.log(`${ok ? '[x]' : '[ ]'} ${s.id} ${s.title}`);
}
const pct = stories.length ? Math.round((n / stories.length) * 100) : 0;
console.log(`\nE2E story coverage: ${n}/${stories.length} stories (${pct}%)`);
