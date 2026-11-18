# AidEM prototype

Flood scenario prototype for the South Fork Dam: MapLibre and PMTiles, static files in `public/`. README.md covers the data pipeline and pages. FIGMA.md maps every Figma frame to its code. Read both before changing either side.

- Story 1 (`public/stories/story-1/`) is the USACE journey: a map story with a sidebar and a layer panel.
- Story 3 (`public/stories/story-3/index.html`) is the current EM interface: an overview with cards plus subpages (`#flood`, `#people`, `#impacts`, `#plan`) that change in place. (Story 2, the first EM version, was removed; its Figma frames remain.)
- Story 4 (`public/stories/story-4/index.html`) is a third EM version: a 50/50 split screen, live map left, report right; each heading opens its detail in place (risk overview, flooding, EAP, evacuation plan; the tab is internal state, the URL holds the story step `#1`–`#5`), and the map switches to that detail's layers. The risk overview combines direct and indirect impacts (tier table, a clickable flood timeline with the cascade as a tree, life loss); the separate Direct and Indirect impacts pages were removed (Nov 2026). The flooding facts come from `public/stories/summary.js`, shared with story 1's sidebar. Story 5 links to it and back.
- Story 5 (`public/stories/story-5/`) started as a copy of story 1 with the sidebar on the right and the layer panel on the left (CSS in its `index.html`, `TOOLS_PADDING` in its `story.js`). The story card stays bottom-left. It has five steps: step 4 zooms to Franklin Power Ventures and selects Franklin Memorial Medical Center, a hospital outside the flood zone that loses power. Its last step leads to story 4, and story 4 links back to it.
- `public/stories/fade.js` fades through black between story 1 and story 3 (`fadeTo(url)`); pages load it in `<head>` so the fade-in starts before the first paint.
- Shared map code is `public/map/core.js` (`createMap` and its options), `panel.js` (layer panel, legends) and `core.css`. `cascade-graph.js` draws the cascade around a selected facility for story 5's facility detail (vertical, tier colours, natural size so its text never scales).

Run the site with `./script server` (port 8080). It's deployed to GitHub Pages from `public/` (README, Deploy); keep every file under 100 MB. Locally, `public/data/terrain.pmtiles` may be the full zoom-15 copy (`build/terrain-z15.pmtiles`, 242 MB), hidden from git with `git update-index --skip-worktree`; the committed file is the 69 MB zoom-14 cut. Undo with `git update-index --no-skip-worktree public/data/terrain.pmtiles && git checkout public/data/terrain.pmtiles`. The data build is `uv run scripts/build_data.py`. To run one build step on its own, load the script with `uv run --with pyshp --with pyproj --with rasterio --with numpy --with pillow --with shapely --with scipy python` and call the function.

## Figma

File `FTpE5i6BheiMWE7zVX7N6f`, page "Prototype". Story frames sit in rows around y 25430 (the user moves them, so look them up by name rather than position). The user designs there too.

- Before changing a frame, look at what's in it now. The user edits frames directly (texts, removed elements, new frames). Sync those edits into code; never overwrite or delete them. Once a mockup of theirs was deleted and couldn't be restored: the API token has no version-history scope.
- Keep the user's wording exactly, including punctuation.
- Edit frames in place. Resizing an auto-layout frame resets hug sizing, so set `layoutSizingHorizontal`/`Vertical` (or the axis sizing modes) again afterwards.
- Map images in frames are screenshots. Capture them with `scripts/capture_receiver.py`, which only accepts requests from `http://localhost:8080` (see FIGMA.md). The cascade arrows are an SVG over the canvas and need compositing.

## "Address comments"

1. List unresolved comments with the figma-comments skill (`list ... --raw` for positions). Posting, replying and resolving need the user's OK, and the API can't resolve. The user resolves comments by hand.
2. For each pin, find the layer under it (`node_offset` within `node_id`) with a hit test. Many comments only make sense with their position.
3. Check whether the user changed the frame since the last sync, and treat those changes as part of the request.
4. Change the code, verify it (below), then update the frames.
5. Ask when a comment is genuinely ambiguous instead of guessing. The user may answer "ignore".

## Verifying

- Syntax-check every changed script. For inline modules, extract the `<script type="module">` body to a `.mjs` file in the scratchpad and run `node --check`.
- After removing code, re-read the lines around the cut. A slice once deleted story 3's map loader (`mapObserver`, `watchMaps`) along with the code it was meant to remove.
- Maps only load while the browser pane is visible. Check `tabs_context` first. If the pane is hidden, DOM checks still work but maps, `createMap` and `requestAnimationFrame` don't. Say what couldn't be checked; don't report it as passing.
- 3D terrain maps (story 1, the explorer) currently don't finish loading in the pane at all, even when it's visible. The 2D maps in stories 2 and 3 do.
- The browser caches pages: add `?v=N` to the URL after edits.

## Data notes

- Two sources count flooded buildings differently. LifeSim (USACE, per evacuation zone, two zones since Nov 2026): 2,425 buildings, 13,246 people. The cascade analysis (per building, round 3 in `../data/cascades v3`; only schools, hospitals and power facilities): 2,587 buildings, including every building the water reaches. Story 3 shows both, with a note.
- Times are shown as clock times ("5:10 AM", "2:00 PM"), from `clock()` in `map/core.js`: the dam breach (model hour 8.83) is at 2:00 PM, so overtopping (model hour 0) starts at 5:10 AM. Model code keeps hours since overtopping; impact times in the data are hours relative to the breach (`impactClock()`). Warning lead times ("0–2 h warning") stay durations. "Typical flood arrival" per zone is the 25th–75th percentile of when the zone's flooded buildings first get wet (round 3's `first_wet_h` and `evac_zone`; `zone_arrival.json`, `build_zone_arrival`), not LifeSim's `Arrv_lowq`/`Arrv_uppq`, which don't say what they count from. Don't use the flood raster for it: water wet at model start includes real flooding (653 zone 1 buildings are wet from 5:10 AM), but also the river and reservoir.
- A selected facility highlights every building it serves (`data/cascade_by_provider`, `build_cascade`): the cascade lists each building once, in its first tier, so flooded buildings are added from the facility's service area as tier 1.
- Indirect impacts come in two waves on the slider: at 5:10 AM, when flooded schools and Crichton Rehabilitation Center fail and their areas lose schooling and care, and at 2:54 PM, when Franklin Power Ventures fails and takes power from two hospitals and two schools. Story 1's cascade ("Show cascades") is Franklin Power Ventures.
- Impact tier colours (flooded `#7a0177`, loss of service `#d6336c`, indirect impact `#f39c12` with a 1 px `#9a5b00` outline) live only in `IMPACT_TIERS` in `map/core.js`; stories 1 and 3, the legends and the map layers all read them, so a tweak there changes everything. Figma swatches are set by hand to match.
- The scenario is daytime only (client feedback, Nov 2026): show no night figures (`PAR_Nght`, `LL_N_*`, `pop_night`) anywhere, in code or Figma, and no "(day)" or "Day" labels either: people figures are simply "People".

## Open threads

- Excess or incremental risk (failure minus non-failure) isn't supported: it would need a non-failure model run.
- Most Figma map screenshots are stale: story 3's depth and advance maps lack flooded buildings, and story 1 steps 3 and 4 show old arrows and no "Show cascades" pill.
- The sticky note next to Story 1 / Step 2 asks whether "of which critical" and "Facilities flooded" duplicate each other. Both are 22, and likely the same facilities.
