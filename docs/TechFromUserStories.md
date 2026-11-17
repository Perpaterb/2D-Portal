# 2dholes: Technical log by user story

Stack: TypeScript, Vite, HTML Canvas 2D, no runtime dependencies. Tests: Vitest (unit, config parity)
and Playwright (end-to-end, smoke). Hosted on GitHub Pages under `/2D-Portal/`.

Layout:
- `src/sim/` the deterministic simulation (no DOM, no floats in state); must stay runnable on the server
- `src/app/` the browser app: router, menu, editor, play screen, renderer, storage, UI helpers
- `tests/unit/` simulation, replay and config-parity tests
- `tests/e2e/` end-to-end tests through the built site, titled with story IDs; `smoke.spec.ts` is `@smoke`
- `scripts/smoke.sh` smoke suite against any URL (`--verify-fails` proves it can go red)
- `scripts/story-coverage.mjs` reports which stories have an E2E test

---

## US-001 Main menu
Hash router (`#/` menu, `#/edit/<id>` editor) with screen mounting and cleanup. Menu lists levels newest first
with edited date (`DD MMM YYYY, HH:MM`, locale independent), playable badge and best time; rename / duplicate /
delete use custom modals (delete confirms). Global levels panel is a placeholder until US-022.
Files: `src/app/router.ts`, `src/app/main.ts`, `src/app/menu.ts`, `src/app/ui.ts`, `src/app/style.css`, `index.html`.
E2E: `tests/e2e/menu-editor.spec.ts` (US-001).

## US-002 Local persistence
`localStorage` per level (`2dholes.level.<id>`) plus an index; editor autosaves 250 ms after each change and on
leaving. All reads and writes are wrapped; a failed save shows a toast.
Files: `src/app/storage.ts`, `src/app/editor.ts`. E2E: US-002 (reload keeps tiles), US-018 (best survives reload).

## US-003 Infinite canvas
Tiles are a sparse map keyed by `cellKey(cx, cy)` (about a million cells each way). Middle-drag pans, wheel zooms
about the cursor; the renderer draws only visible cells (or iterates the map when that is smaller).
Files: `src/sim/fixed.ts`, `src/app/editor.ts`, `src/app/render.ts`. E2E: US-003 (pans 4800 px, builds there).

## US-004 Placing tiles and objects
Toolbar with keyboard shortcuts, drag-paint walls (cells interpolated between mouse samples), right-drag erase,
snapshot undo / redo, snap toggle (remembered per browser). Walls and doors always use the grid; with snap off
other objects keep the exact pixel. Mouse-to-world uses the canvas size measured at event time, and the
properties panel floats over the canvas (fixes clicks landing three cells off after the panel opened).
Files: `src/app/editor.ts`, `src/app/render.ts`, `src/app/style.css`. E2E: US-004.

## US-005 Wiring by channel
Eight colour channels; plates, doors and dispensers carry `channel`. Properties panel edits channel, and for
dispensers liquid, default on / off, direction and cap (10 to 400).
Files: `src/sim/level.ts`, `src/app/editor.ts`, `src/app/render.ts`. E2E: US-005.

## US-006 Play and Esc
`checkPlayable` (exactly one start, at least one finish) drives the Play button and its tooltip. Play builds a new
`Sim` from the saved level; Esc / Stop returns to where play started. Finish overlay shows the time.
Files: `src/sim/level.ts`, `src/app/play.ts`, `src/app/editor.ts`. E2E: US-006; unit: `tests/unit/replay.test.ts`.

## US-007 Movement
Fixed 60 Hz tick, integer sub-pixel units (256 per px). Run acceleration and friction, coyote time, jump buffer,
short hop. Axis-separated movement that only collides with cells / boxes fully ahead of the leading edge.
Files: `src/sim/sim.ts`, `src/sim/fixed.ts`. Unit: `tests/unit/sim.test.ts`; E2E: `tests/e2e/gameplay.spec.ts`.

## US-008 Portal gun
1 px ray march from the player, resolving diagonal corner crossings; portals are two tiles long on a portal-able
face with empty cells in front and no overlap with the other portal. Clicks are queued with the aim at the moment
of the click, one shot per tick (fixes fast click-then-move firing at the wrong spot).
Files: `src/sim/sim.ts` (`firePortal`, `placePortal`), `src/app/play.ts`. Unit + E2E.

## US-009 Portal physics and speed cap
Linked portals open a hole in their wall cells for bodies aligned with the mouth; crossing the face plane maps
position and velocity through an exact integer matrix (reflect for same facing, identity for opposite, 90 degree
rotation otherwise), clamps to fit the exit, then clamps speed to `MAX_SPEED` (20 px/tick per axis). Movement is
sub-stepped at 8 px so nothing tunnels. Closing a portal pushes stuck bodies back out.
Files: `src/sim/sim.ts`. Unit: transform for all 16 pairs, wall walk-through, floor fling, endless fall at the cap,
liquid through portals; E2E: walk through a wall portal.

## US-010 Boxes
E grabs the nearest box within 56 px; held boxes spring to a point 44 px along the aim, collide with walls and
boxes, drop if pulled more than 110 px away. Firing is ignored while holding. A held box never passes a portal on
its own; it is carried across when the player goes through (fixes the box going first and being dropped).
Files: `src/sim/sim.ts`. Unit: pick up / drop / no firing, wall stop, carried through a portal, stand on a box; E2E.

## US-011 Pressure plates
Sensor strip at the plate; pressed by the player or any box (held or not).
Files: `src/sim/sim.ts`, `src/app/render.ts`. Unit + E2E.

## US-012 Multi-lock doors
Channel is active when it has plates and all are pressed; doors open while active and close when not, unless the
player or a box overlaps the door cell. Liquid inside a closing door is removed.
Files: `src/sim/sim.ts`. Unit: multi-lock, never closes on a box, blocks when shut; E2E: opens, then relocks.

## US-013 Dispensers
Dispenser on = default XOR channel active. Emits every 2 ticks with seeded integer spread; per-dispenser FIFO and
`alive` count; above the cap the oldest of its liquid is removed. `poured` counts every particle (informational).
Files: `src/sim/sim.ts`. Unit: cap keeps pouring and removes oldest, flipped off keeps liquid; E2E: cap 10, off-by-default dispenser.

## US-014 Liquid physics and painting
Particles are 4 px bodies with gravity and portal travel. On hitting a wall face whose colour (paint, else base
white / dark) differs, the face is painted and the particle is removed; white on a white wall clears paint. Same
colour: the particle rests; resting particles sharing a 4 px cell nudge sideways so liquid spreads.
Files: `src/sim/sim.ts`, `src/app/render.ts`. Unit + E2E (blue, orange, white all paint in one level).

## US-015 Blue gel
Ground paint priority orange > blue. On blue: acceleration 12, friction 2 (normal 128 / 160) for player and boxes.
Files: `src/sim/sim.ts`. Unit: slide distance; E2E: stands on blue and keeps sliding after release.

## US-016 White paint
`isPortalable` = white wall or white-painted face; blue / orange on a white wall stays portal-able.
Files: `src/sim/sim.ts`. Unit; E2E: dark floor refuses a portal, then takes one once painted white.

## US-017 Orange paint
Hitting an orange face faster than 2 px/tick reflects that velocity component at 90 percent.
Files: `src/sim/sim.ts`. Unit: box bounces; E2E: box dropped onto orange bounces.

## US-018 Speedrun timer
Timer is the tick count from level start (`mm:ss.mmm`). It starts with the level, not on first input, so waiting
for liquid to settle costs time. Best per level saved with its replay and level hash; an edited level has no best.
Files: `src/sim/replay.ts` (`formatTicks`), `src/app/play.ts`, `src/app/storage.ts`, `src/app/menu.ts`. E2E.

## US-019 Deterministic physics and replay files
All state is integers within 2^53; only `+ - *`, truncating division, `isqrt` (corrected `Math.sqrt`) and a 32-bit
PRNG seeded from the level hash. Level hash is FNV over canonical JSON. Replays are run-length encoded
`[count, bits, aimX, aimY]` runs tied to level hash and `SIM_VERSION`; `runReplay` re-simulates from scratch and is
the source of the time. Live finishes re-verify their own replay before saving. Save / load replay files; loading
checks the level version.
Files: `src/sim/fixed.ts`, `src/sim/level.ts`, `src/sim/replay.ts`, `src/app/play.ts`, `src/app/editor.ts`.
Unit: same inputs same hash, one changed input changes the hash, integer-only state, record / replay identical,
lying `ticks` ignored, wrong version rejected, damaged files rejected. E2E: the browser's replay re-run in Node
gives the same finish tick and the same state hash as Chromium; watch and load-from-file show the same time.

## US-020 Ghosts
A second `Sim` runs the ghost replay in lockstep and only its player is drawn (translucent). Ghost is your best for
the current level version, or a loaded replay file ("Race as ghost"). G toggles it.
Files: `src/app/play.ts`, `src/app/render.ts`, `src/app/editor.ts`. E2E: best ghost moves, G toggles, race a file.

## US-026 Seeing through portals
Rendering only. `portalview.ts` (DOM free) holds the geometry: `teleportAffine` (same maths as the sim teleport, in
pixels) and its inverse `viewAffine`; `visibleSpans` samples 24 rays from the player's head to the portal mouth and
keeps the unblocked runs; `viewWedge` builds the cone from each visible span out past the face. `render.ts` now splits
`drawScene` (one copy of the world) from `drawPortalViews`, which clips to each wedge, fills it, applies `viewAffine`
and draws the scene from beyond the other portal, then a faint portal-colour tint and the mouth on top. One level
deep: `drawScene` never draws views. Tile and backdrop drawing take a world rectangle so rotated and mapped views only
draw what they cover.
Files: `src/app/portalview.ts` (new), `src/app/render.ts`, `src/app/editor.ts` (new rect API).
Unit: `tests/unit/portalview.test.ts` (inverse for all 16 facing pairs, behind-the-face mapping, open / half / fully
blocked line of sight, eye behind the face). E2E: `tests/e2e/portals.spec.ts` reads canvas pixels: the exit beside
the right portal appears inside the left wall only once both portals exist; one portal draws no view.

## US-027 Seamless passing through
`crossings` finds bodies whose centre is in front of a mouth but whose back part is behind it; `drawScene` draws a
copy through `teleportAffine`, clipped to the exit mouth's front, while the wall hides the part behind the entry. The
sim records the facings of the player's last portal (`lastPlayerTeleport`, cosmetic, not hashed); the play camera
composes its orientation with the inverse portal matrix (`orientationAfterTeleport`) so the screen does not jump,
then eases angle and flip back to upright over 350 ms. Aim undoes zoom and orientation (`screenOffsetToWorld`).
`window.__holes.cam` and `.views` expose the camera and wedge count for tests.
Files: `src/app/portalview.ts`, `src/app/render.ts`, `src/app/play.ts`, `src/app/router.ts`, `src/sim/sim.ts`.
Unit: crossing detection, motion keeps its screen direction for all 16 pairs, aim round trip under turned and flipped
views. E2E: a box resting 8 px into the left wall shows coming out of the right portal (pixels); floor-to-wall fall
turns the view about a quarter turn and is upright again within 600 ms.

## US-028 Portal magnetism
`Sim.magnetise`: for an airborne player or box moving into a portal (at least 1 px/tick), within 4 tiles in front and
1.5 tiles of the centre line, if the body would clip the mouth edge it is slid sideways (through normal collision)
just enough to fit, at a speed timed to finish before its leading edge reaches the face (1 to 8 px/tick). Velocity is
never changed, so flings keep their momentum and aligned bodies are untouched; an earlier velocity-based version left
sideways drift after the portal and broke the endless-fall test, so it was replaced. Liquid never calls it.
`SIM_VERSION` is now 2, so older local bests and replay files are no longer accepted.
Files: `src/sim/sim.ts`. Unit: `tests/unit/sim.test.ts` (pulled in vs the same fall missing with it disabled; no pull
when rising, too far off, or already aligned; momentum unchanged; liquid never passed in). E2E: a short hop beside a
floor portal falls into it.

## US-021 to US-024 (not started)
Planned on branch `global-levels`: Supabase tables for levels and runs, Edge Functions for password-checked
upload / delete and replay submission that runs `src/sim` server side to compute the time.

## US-025 Live on GitHub Pages (in progress)
`.github/workflows/pages.yml`: on push to `main`, unit + E2E tests, build, deploy (one deploy at a time, never
cancelled), then `scripts/smoke.sh` against the live URL. `.github/workflows/ci.yml` runs tests on other branches
and never deploys. Config-parity tests check base path, deploy branch, smoke target and that `src/sim` has no
browser or time dependencies.
Files: `.github/workflows/pages.yml`, `.github/workflows/ci.yml`, `scripts/smoke.sh`, `tests/e2e/smoke.spec.ts`,
`tests/unit/config.test.ts`, `vite.config.ts`, `playwright.config.ts`.
Not yet done: Pages has not been enabled or deployed; smoke has run only against a local production build.
