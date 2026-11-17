# 2dholes: User Stories

A 2D, browser-based puzzle platformer with a portal gun, paints and a level editor.
Hosted on GitHub Pages (`Perpaterb/2D-Portal`). Status is tracked with the checkboxes below.

Branches:
- `game-core`: US-001 to US-020 (the whole game, local levels, deterministic replays and ghosts)
- `portal-view`: US-026 to US-028 (seeing through portals, seamless passing through, portal magnetism)
- `global-levels`: US-021 to US-025 (Supabase backend, global levels, replay-verified leaderboards, Pages deploy)

---

## Menu and storage

### US-001 Main menu
As a player I can open the app and see a menu titled "2dholes" with **My levels** and **Global levels**.
- [x] "New level" creates a blank level and opens it in the editor
- [x] My levels lists every saved level with name, last edited date (`17 Nov 2026, 14:30`), playable or not, and my best time
- [x] I can open, rename, duplicate and delete a level (delete asks for confirmation)

### US-002 Local persistence
- [x] Levels auto-save while I edit
- [x] Levels (and my best replays) survive a page refresh, stored in this browser

## Editor

### US-003 Infinite canvas
- [x] The level has no edges in any direction
- [x] Holding the middle mouse button and dragging moves the camera
- [x] The scroll wheel zooms around the cursor
- [x] A grid shows where tiles snap

### US-004 Placing tiles and objects
- [x] The editor opens in creator mode by default
- [x] Toolbar: white wall (portal-able), dark grey wall (not portal-able), start, finish, box, pressure plate, door, blue / orange / white dispenser, select
- [x] Left click or drag places, right click or drag erases
- [x] Undo / redo (Ctrl+Z / Ctrl+Y)
- [x] Snap-to-grid toggle: walls and doors always sit on the grid; with snap off, other objects can be placed anywhere

### US-005 Wiring by channel
- [x] Plates, doors and dispensers each have a colour channel; objects sharing a channel are linked
- [x] Linked objects show their channel colour in the editor and in play
- [x] Selecting an object shows its properties (channel, and for dispensers: default on/off, direction, liquid cap)

### US-006 Play and Esc
- [x] A Play button in the top right is enabled only when the level has exactly one start and at least one finish; hovering it says what is missing
- [x] Play starts from a fresh copy of the level
- [x] Esc (or Stop) goes straight back to the editor with the level unchanged
- [x] Reaching a finish shows a "Level complete" screen with the time

## Player, portals, boxes

### US-007 Movement
- [x] Run with A/D or arrow keys, jump with Space / W / Up
- [x] Gravity and collision with walls, closed doors and boxes

### US-008 Portal gun
- [x] Left click fires portal A, right click fires portal B, towards the mouse
- [x] A portal only lands on a portal-able face (white wall, or any wall painted white) with room for it (two tiles long, open space in front)
- [x] Firing a portal replaces the previous portal of that colour

### US-009 Portal physics and speed cap
- [x] The player, boxes and liquid pass through linked portals keeping their speed, turned to match the exit portal
- [x] Nothing ever moves faster than the global speed cap, including straight out of a portal

### US-010 Boxes
- [x] E picks up the nearest box in reach and holds it in front of the gun; E again drops it (keeping its momentum)
- [x] Portals cannot be fired while holding a box
- [x] A held box collides with walls and can be carried through portals

## Plates and doors

### US-011 Pressure plates
- [x] A plate is pressed while the player or a box is on it, and lights up in its channel colour

### US-012 Multi-lock doors
- [x] Doors are the only door type: a door is open only while every plate on its channel is pressed
- [x] It closes again as soon as any of those plates is released (but never closes onto something standing in it)

## Liquids

### US-013 Dispensers
- [x] Blue, orange and white dispensers; each is on or off by default and flips to the other state while its channel is active (every plate on it pressed)
- [x] Each dispenser has a cap on how much of its liquid can exist at once; when it is at the cap it keeps pouring and the oldest of its liquid despawns
- [x] Turning a dispenser off leaves its liquid in the level; liquid never despawns over time

### US-014 Liquid physics and painting
- [x] Liquid falls and flows as particles and goes through portals
- [x] A particle touching a wall face of a different colour paints that face and disappears
- [x] A particle touching a face of its own colour does not paint and stays (pools or slides)
- [x] White paints dark grey, blue and orange; blue paints white, dark grey and orange; orange paints white, dark grey and blue

### US-015 Blue gel (slippery)
- [x] Blue faces are slippery: almost no friction for the player and boxes, up to the speed cap

### US-016 White paint (portal-able)
- [x] A face painted white takes portals, including dark grey walls
- [x] Blue or orange paint on a white wall keeps it portal-able

### US-017 Orange paint (bounce)
- [x] Orange faces bounce the player and boxes back off them, keeping most of their speed, capped by the speed limit

## Speedrun and replays

### US-018 Speedrun timer
- [x] Every play shows a timer (`mm:ss.mmm`) that starts when the level starts and stops at the finish
- [x] My best time per level is saved locally and shown in the menu

### US-019 Deterministic physics and replay files
- [x] The simulation is fully deterministic: integer maths on a fixed 60 Hz tick, so the same level and inputs always give the same result on any machine
- [x] Every run is recorded as a replay (inputs per tick, tied to the exact level version)
- [x] A finished run's time is worked out from the replay alone
- [x] I can save a replay file, load a replay file, and watch it play back

### US-020 Ghosts
- [x] While playing, a ghost of my best run (or a loaded replay file) runs alongside me (racing a leaderboard record arrives with US-024)
- [x] The ghost can be turned off and on (G)

## Portal visuals and feel (branch `portal-view`)

### US-026 Seeing through portals
- [x] When both portals exist, each shows the world beyond the other portal, inside the cone from the character's head through the portal opening
- [x] Walls between the head and a portal block that part of the view
- [x] The view is turned to match the portal facings (90 degrees for floor to wall, mirrored for two floor portals)
- [x] Portal views show everything (player, boxes, liquid, doors); one level deep: portals inside a portal view are plain coloured lines (the view draws the same scene function as the main world, without views; the E2E pixel test checks the exit shows through)
- [x] With only one portal out, it is just a coloured line on the surface

### US-027 Seamless passing through
- [x] A player or box part-way through a portal shows on both sides: the part already through comes out of the other portal
- [x] On passing through, the camera keeps the player at the same place on screen, and turned views ease back to upright in about a third of a second
- [x] Aiming stays exact while the camera is turned

### US-028 Portal magnetism
- [x] A player or box in the air, moving into a portal and within about 1.5 tiles of its centre line, is pulled towards the centre (all portal orientations)
- [x] No pull on the ground, when moving away from the portal, or on liquid
- [x] It never exceeds the speed cap and is deterministic (physics version bumped; earlier local best times and replay files no longer apply)

## Global levels (branch `global-levels`)

### US-021 Upload to global
- [ ] An "Upload to global" button in the editor asks for the password; the server checks it (never the page)
- [ ] Only playable levels can be uploaded
- [ ] Re-uploading a changed level replaces it and resets its leaderboard

### US-022 Global levels are play-only
- [ ] Anyone visiting the site can browse and play global levels
- [ ] Global levels open in play mode only: no editor, no editing

### US-023 Delete a global level
- [ ] With the password I can delete a global level (and its leaderboard)

### US-024 Replay-verified arcade leaderboard
- [ ] Finishing a global level asks for an arcade-style name of up to 8 characters
- [ ] No time is submitted: the replay file is submitted, and the server re-runs it to work out the time
- [ ] Each global level shows a leaderboard of best times (best per name)
- [ ] Anyone can watch any leaderboard replay (including the world record) or race against it as a ghost

### US-025 Live on GitHub Pages
- [ ] The site auto-deploys from `main` to GitHub Pages
- [ ] `scripts/smoke.sh --target <url>` passes against the live URL (suite written and passing against a local production build; not yet run live)
