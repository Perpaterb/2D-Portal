# 2dholes

A 2D puzzle platformer for the browser: build levels, shoot portals, pour paint, and race the clock.

- Level editor with an endless canvas, walls that do and don't take portals, boxes, pressure plates,
  multi-lock doors and blue (slippery), orange (bounce) and white (portal-able) paint dispensers.
- Deterministic physics: every run is a replay file, and a run's time comes from re-running its replay.
- Race a ghost of your best run, or any replay file.

## Develop

```bash
npm install
npm run dev              # http://localhost:5173/2D-Portal/
npm test                 # unit tests
npm run test:e2e         # end-to-end tests (builds and serves the site)
npm run coverage:stories # which user stories have an end-to-end test
./scripts/smoke.sh --target <url>
```

Docs: `docs/UserStories.md` (what the game does and progress) and `docs/TechFromUserStories.md` (how).
