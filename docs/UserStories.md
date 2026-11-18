# 2dholes: User Stories

A 2D, browser-based puzzle platformer with a portal gun, paints and a level editor.
Hosted on GitHub Pages (`Perpaterb/2D-Portal`). Status is tracked with the checkboxes below.

Branches:
- `game-core`: US-001 to US-020 (the whole game, local levels, deterministic replays and ghosts)
- `portal-view`: US-026 to US-028 (seeing through portals, seamless passing through, portal magnetism)
- `global-levels`: US-020 (changed), US-021 to US-025, US-029 (Supabase backend, admin, global levels, replay-verified leaderboard, ghost panel, Pages deploy)
- `blocks-and-slopes`: US-033 (changed), US-036 to US-038 (wall pop-out, per-side colours, 45° slopes)
- `diagonal-portals`: US-039 (portals on slopes)
- `editor-and-timer`: US-018 (changed), US-030 to US-034 (timer on first action, Q restart, rectangle select, painted blocks, toolbar order), US-017 (changed), US-035 (no overlapping objects)

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
- [x] A held box can't be flung: it never moves faster than the player carrying it plus their run speed, so letting go mid-swing doesn't throw it (added in `editor-and-timer`)

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
- [x] The whole level holds at most 200 drops of liquid, however many dispensers it has; past that the oldest drop anywhere despawns (a dispenser's own cap goes up to 200) (added in `diagonal-portals`)
- [ ] A full 5-minute run on a liquid-heavy level (four dispensers, slopes) is verified by the server inside its 2-second limit (added in `diagonal-portals`)
  - Not met: measured on this machine a 5-minute run takes about 1.1 s to check on a flat level with four dispensers, but about 2.4 s with slopes (was 6 to 8 s). Accepted as is (a family game); the safety net below covers the rest.
- [x] If checking a run takes longer than 1.5 s the server stops and says "This run is too long to verify on this level", rather than the request crashing (added in `diagonal-portals`)
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

### US-017 Orange paint (bounce) (changed in `editor-and-timer`)
- [x] Orange faces bounce the player and boxes back off them with no loss of speed, capped by the speed limit

## Speedrun and replays

### US-018 Speedrun timer (changed by US-030)
- [x] Every play shows a timer (`mm:ss.mmm`) that stops at the finish (it starts on the first action, see US-030)
- [x] My best time per level is saved locally and shown in the menu

### US-019 Deterministic physics and replay files
- [x] The simulation is fully deterministic: integer maths on a fixed 60 Hz tick, so the same level and inputs always give the same result on any machine
- [x] Every run is recorded as a replay (inputs per tick, tied to the exact level version)
- [x] A finished run's time is worked out from the replay alone
- [x] I can save a replay file, load a replay file, and watch it play back

### US-020 Ghosts (changed: global levels only)
- [x] Local levels have no ghosts (the personal-best ghost and "race a replay file" are removed); best times and saving, loading and watching replays stay
- [x] Ghosts exist only on global levels, through the ghost panel (US-029)

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

### US-021 Admin unlock (changed by US-046 and US-048)
- [x] The menu has an "Unlock admin" button that asks for the password; the server checks it against `ADMIN_PASSWORD` (never the page)
- [x] While unlocked (until Lock is pressed or the tab is closed), each playable level in My levels shows "Add to global", or "Update global" if it is already global (superseded: US-046 replaces it with Submit to global for everyone)
- [x] Updating a global level replaces it and resets its leaderboard (only if the level actually changed) (superseded: US-048, global levels can't be changed)
- [x] A wrong password says so; after 5 wrong tries in 15 minutes from the same address, unlocking is refused for a while

### US-022 Global levels are play-only
- [x] Anyone visiting the site can browse and play global levels
- [x] Global levels open in play mode only: no editor, no editing

### US-023 Admin delete
- [x] While unlocked, the admin can delete a global level (and its leaderboard)
- [x] While unlocked, the admin can delete a single leaderboard entry

### US-024 Replay-verified leaderboard (changed by US-049)
- [x] Finishing a global level asks for an arcade-style name of up to 8 characters (superseded: US-049 submits under the remembered name)
- [x] Only the replay is submitted; the server re-runs it to work out the time
- [x] Best run per name is kept; runs longer than 5 minutes are not accepted
- [x] Each global level shows its top 10 in the menu, and any of those replays can be watched

### US-029 Ghost panel
- [x] While playing a global level, the top 10 is listed on the left with names, times and an eye on each row
- [x] Opening an eye turns that run's ghost on, closing it turns it off; any number can be on at once
- [x] Each ghost has its own colour (matching its row) and a name tag hovering above it
- [x] Eyes start closed and the choice is remembered per level in this browser

### US-025 Live on GitHub Pages
- [x] The site auto-deploys from `main` to GitHub Pages
- [x] The pipeline also deploys the database schema and server function, and copies `ADMIN_PASSWORD` into the server's secrets
- [x] `scripts/smoke.sh --target <url>` passes against the live URL, including reaching the global levels server and opening a global level when one exists (no global level existed at first deploy, so the open-a-level branch has only run locally)

## Editor and timer improvements (branch `editor-and-timer`)

### US-030 Timer starts on the first action
- [x] The timer shows 00:00.000 and the whole world waits (dispensers, liquid, boxes) until I first move, jump, pick up or shoot a portal
- [x] A run's time counts from that first action, worked out from the replay alone, by the game and by the leaderboard server alike
- [x] Ghosts wait at the start and set off when I do
- [x] Replays and best times from the older physics version are refused with a clear message

### US-031 Q restarts
- [x] Q (as well as R) restarts the level straight away, mid-run or on the finish screen, on local and global levels

### US-032 Rectangle select, duplicate and move
- [x] With Select, dragging on empty space draws a grid-aligned selection rectangle
- [x] Corner and edge handles grow or shrink the rectangle
- [x] Dragging inside the rectangle moves everything in it (walls, blocks, objects); things it passes over are not damaged until I let the selection go
- [x] Duplicate (button or Ctrl+D) copies everything copyable in the rectangle (all but the start) into a new selection I can drag into place; copies keep their channels
- [x] Delete removes everything in the selection; Esc lets it go; undo and redo cover all of it

### US-033 Painted blocks (changed by US-036)
- [x] The editor has blue and orange blocks: walls that start covered in that paint on every side (the white block became the plain white wall in the pop-out)
- [x] In play they behave exactly like a painted wall (slippery, bounce, portal-able) and liquid can paint over them

### US-034 Toolbar order
- [x] Select and Erase sit at the top of the toolbar
- [x] The Erase tool's icon is a trash can

### US-035 Objects can't overlap
- [x] Placing an object (start, finish, box, plate, door, dispenser) on top of another object is refused
- [x] The start, a finish or a box may stand on a plate (that is how plates are pressed); nothing else may share a plate's space
- [x] Dragging an object onto another one stops it short; a selection can't be moved or duplicated onto objects outside it

## Blocks and slopes (branch `blocks-and-slopes`)

### US-036 Wall pop-out
- [x] One Wall button in the toolbar opens a pop-out next to it: Full block, One side or Slope
- [x] Full block, then a colour: white, dark grey, blue or orange
- [x] One side, then which side, then a colour
- [x] Slope, then which way it faces (four rotations), then a colour
- [x] The choice is remembered and shown on the button; 1 and 2 still pick a full white or dark wall, B and O full blue or orange

### US-037 Per-side colours
- [x] Placing a one-side wall on an existing block recolours only that side, so all four sides of a block can differ
- [x] On an empty cell it makes a dark grey block with that side coloured
- [x] Each side behaves like its colour in play (white takes portals, blue is slippery, orange bounces), and liquid paints over it as usual

### US-038 45° slopes
- [x] Slopes come in four rotations and every colour
- [x] The player walks up and down slopes; boxes slide down them; liquid runs down them
- [x] The sloped face takes paint: blue is slippery (you slide down), orange bounces you off at 45° with no speed lost
- [x] Their two flat sides are ordinary wall sides (white flat sides take portals)

## Diagonal portals (branch `diagonal-portals`)

### US-039 Portals on slopes
- [x] A portal can be fired onto the white sloped face of two slopes in a line
- [x] Going in or out of a diagonal portal turns you by 45° steps and keeps your speed (to within rounding)
- [x] Seeing through, seamless passing and magnetism work for diagonal portals; the camera turns and eases back upright

## Global level order and my results (branch `global-order-and-results`)

### US-040 Admin sets the order of global levels (changed by US-043)
- [x] Everyone sees the global levels in the order the admin sets, instead of newest first
- [x] While unlocked, each global level row has ▲ and ▼ buttons; a move saves straight away and everyone sees the new order the next time the list loads (superseded: US-043 drag to reorder)
- [x] A newly added level goes to the bottom of the list; "Update global" keeps its place; deleting a level closes the gap ("Update global" superseded by US-048)
- [x] Only the server changes the order, after checking the admin password, like add and delete

### US-041 My result on each global level
- [x] Once I've finished a global level, its row shows "Completed" and my best time
- [x] The time is the one the game shows at the finish; it counts even if I didn't submit it to the leaderboard
- [x] If the admin changes the level, my old time no longer counts (it's for a different version), just as the leaderboard resets (superseded: US-048 means a global level can't change; the hash check stays as a safety net)
- [x] It's remembered in this browser, one result per level whoever played (no accounts)

## Global folders, submissions and thumbnails (branches `level-thumbnails`, then `global-folders-and-submissions`)

### US-042 Global levels page
- [ ] The menu's global levels panel becomes a **Global levels** button that opens its own page, with a back button to the menu
- [ ] The page shows the current folder's folders then its levels, with a breadcrumb path (Global › Puzzles › Hard); clicking a folder opens it
- [ ] Each level keeps Play, Top 10, Watch, the record, its author ("by NAME") and my "Completed" and best time

### US-043 Folders (admin)
- [ ] While unlocked the admin can create, rename and delete folders; folders can hold folders
- [ ] Dragging a level or folder onto a folder moves it in; dragging onto the "up a level" target or a breadcrumb moves it out
- [ ] Dragging within a folder reorders it; everyone sees the same order
- [ ] Deleting a folder moves what was in it up to its parent, so no level is lost by accident
- [ ] A folder can't be dragged into itself or one of its own folders

### US-044 Global search
- [ ] A search box on the global page finds levels and folders by name across every folder as I type
- [ ] Each result shows its folder path; clicking a level plays it, clicking a folder opens it

### US-045 Thumbnails
- [ ] Every level row (My levels, global levels, submission requests) shows a small picture of the level
- [ ] The picture is drawn from the level itself (never an uploaded image), so it always matches

### US-046 Anyone can submit a level
- [ ] Each level in My levels has **Submit to global**, for everyone including the admin; "Add to global" and "Update global" are gone
- [ ] Submitting needs a level name and a finish of that exact level version: the finishing run is sent and the server re-runs it, like a leaderboard run
- [ ] The submission carries my name as its author (US-049)
- [ ] I'm told it is waiting for review; one address (a home connection) can have at most 10 waiting requests

### US-047 Submission queue (admin)
- [ ] While unlocked the global page shows a **Requests** list with a count: each request's thumbnail, name, author and when it was sent
- [ ] The admin can play-test a request (play only, nothing goes on any leaderboard), then **Approve** or **Reject** it
- [ ] Approving puts it at the bottom of the top Global folder, ready to organise; rejecting removes it

### US-048 Global levels can't be changed
- [ ] There is no "Update global": a global level's layout never changes once approved
- [ ] The admin can only rename (the leaderboard stays) or delete a global level

### US-049 My name, asked once
- [ ] The first time the site opens it asks for my name (arcade style, up to 8 characters) and this browser remembers it
- [ ] Leaderboard runs and level submissions use that name automatically: finishing a global level submits the run under my name, with no typing at the finish
- [ ] The menu shows "Playing as NAME"; clicking it changes the name (handy on a shared computer)
