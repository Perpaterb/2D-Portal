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

## US-020 Ghosts (changed: global levels only)
First built as a personal-best ghost plus "race a replay file"; on request both were removed so ghosts exist only on
global levels (US-029). Local play keeps best times, and saving, loading and watching replays.
Files: `src/app/play.ts`, `src/app/editor.ts`, `src/app/menu.ts`. E2E: local replays still reproduce, and local play
has no ghosts and no ghost panel (`tests/e2e/gameplay.spec.ts`).

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

## Backend overview (US-021 to US-025, US-029)
Supabase. `supabase/migrations/20261117000000_global_levels.sql`: `global_levels` (keyed by the admin's local level
id as `source_id`), `runs` (unique per level and name, `ticks` only ever written by the server) and `admin_attempts`.
Row-level security on all three; the public can read levels and runs, writes are revoked from `anon` /
`authenticated`, and `admin_attempts` is invisible to them. All writes go through one Edge Function,
`supabase/functions/api/index.ts` (`verify_jwt = false` in `supabase/config.toml`, so the public key works; access is
checked inside). The function imports the game's own physics, bundled from `src/server/entry.ts` by
`vite.sim.config.ts` into `supabase/functions/api/_generated/sim.js` (built, not committed). The page talks to it
through `src/app/global.ts` with only the public URL and anon / publishable key (`VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`).
Local stack: `scripts/supabase-local.sh` starts Supabase in Docker, builds the bundle, serves the function with a
test password and exports the env; `npm run test:server` (`tests/server/api.test.ts`, black box over HTTP) and
`npm run test:e2e` use it. CI does the same on GitHub's runners.

## US-021 Admin unlock
"Unlock admin" sends the password to the function, which compares SHA-256 digests in constant time and logs the
attempt. More than 5 failures from one address in 15 minutes (address from `cf-connecting-ip`, else the last
`x-forwarded-for` hop, which the client cannot forge), or 50 overall, refuses with 429. The password is kept in
`sessionStorage` (this tab only) and sent with each admin call; a "Wrong password" reply locks again. Upload parses
and checks the level server side, inserts or updates by `source_id`, and clears the leaderboard only if the level
hash changed.
Files: `supabase/functions/api/index.ts`, `src/app/global.ts`, `src/app/menu.ts`, `src/app/style.css`.
Server tests: password checked, lockout even with the right password, unplayable refused, update keeps or resets.
E2E: wrong password toast, unlock, add, up-to-date state, survives reload, Lock hides admin buttons.

## US-022 Global levels are play-only
Global levels are fetched with their data and opened straight into play mode; Esc returns to the menu. There is no
route from a global level to the editor. Server tests: public reads work, direct inserts and deletes are refused.

## US-023 Admin delete
`delete-level` (cascades to runs) and `delete-run`, both behind the password; buttons only render while unlocked.
Server test: wrong password refused, entry then level removed. E2E: remove an entry and then the level from the menu.

## US-024 Replay-verified leaderboard
Only the replay is sent. The function rejects other level versions (409), more than 5 minutes of input, and replays
that do not finish, then re-runs the replay with the bundled sim and stores the computed ticks; a slower run never
replaces a name's best. Rank is the count of faster runs plus one. Arcade name entry (`src/app/arcade.ts`): 8 slots,
Up / Down cycle, Left / Right move, typing works, Enter submits, last name remembered; rules shared in
`src/sim/names.ts`. Menu shows the record and a Top 10 with Watch.
Measured: a busy level costs about 0.3 s of CPU per minute of play, so 5 minutes fits the function's 2 s CPU limit.
Unit: `tests/unit/names.test.ts`. Server tests: lying `ticks` ignored, best per name, refusals. E2E: two runs ranked
1 and 2 with the server's time, record in the menu, watching a leaderboard replay shows the same time.

## US-029 Ghost panel
While playing a global level, the left panel lists the top 10 with a colour dot, rank, name, time and an eye. Opening
an eye fetches that replay (cached), starts a ghost sim fast-forwarded to the current tick, and draws it in its row's
colour with a name tag; R restarts every ghost with the run. Eyes are saved per level in `localStorage`
(`2dholes.eyes.<id>`). After submitting, the panel refreshes from the server. `window.__holes.ghosts` exposes them.
Files: `src/app/play.ts`, `src/app/render.ts`, `src/app/router.ts`, `src/app/style.css`.
E2E: eyes start closed, two ghosts in two colours both running, name tag pixels in the ghost's colour above it, eyes
remembered next time, closing one removes only that ghost.

## US-025 Live on GitHub Pages (in progress)
`.github/workflows/pages.yml` on push to `main`: test (unit, server and E2E against a local Supabase), then
`backend` (checks the secrets exist, links the project, `db push`, copies `ADMIN_PASSWORD` into function secrets
from a temporary env file, builds the sim bundle, deploys `api`), then `deploy` (checks the public variables, builds
the site with them, publishes Pages), then `smoke` against the live URL. One deploy at a time, never cancelled.
`.github/workflows/ci.yml` runs the same tests on other branches and never deploys. Config-parity tests check the job
order, that the page build never sees the admin password or a service key, `verify_jwt`, and the RLS / revoke rules.
Smoke (`tests/e2e/smoke.spec.ts`, `@smoke`): build, play and time a local level; reach the global server and open a
global level when one exists.
Files: `.github/workflows/pages.yml`, `.github/workflows/ci.yml`, `scripts/smoke.sh`, `tests/e2e/smoke.spec.ts`,
`tests/unit/config.test.ts`, `vite.config.ts`, `playwright.config.ts`.
First deploy (17 Nov 2026, run 44052563978): test, backend and smoke passed. The Pages publish was first refused
because the `github-pages` environment only allowed `game-core` (the default branch when Pages was turned on); `main`
was added as an allowed deployment branch and `main` made the repository default, then the failed jobs re-ran green.
Checked by hand on the live site: page loads, public read of `global_levels` returns 200, a wrong admin password
gets 401 "Wrong password" (so `ADMIN_PASSWORD` reached the function), anonymous inserts get 401.
