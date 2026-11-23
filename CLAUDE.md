# AidEM prototype

Flood scenario prototype for the South Fork Dam: MapLibre and PMTiles, static files in `public/`. README.md covers the data pipeline and pages. FIGMA.md maps every Figma frame to its code. Read both before changing either side.

Two pages (Nov 2026; the explorer and stories 1 and 3 were removed, their Figma frames remain). Old `/stories/story-N/` addresses redirect to them, keeping the `#N` step.

- The USACE journey (story 5 in Figma) is the site root: `public/index.html` and `public/story.js`. It started as a copy of story 1 with the sidebar on the right and the layer panel on the left (CSS in `index.html`, `TOOLS_PADDING` in `story.js`). The story card stays bottom-left. It has five steps: step 4 zooms to Franklin Power Ventures and selects Franklin Memorial Medical Center, a hospital outside the flood zone that loses power. Its last step and the "Emergency Managers" toggle lead to the EM interface.
- The EM interface (story 4 in Figma) is `/em/` (`public/em/index.html`): a 50/50 split screen, live map left, report right; each overview row opens its subpage in place (risk overview, flooding, EAP, evacuation notices; the subpage is internal state, the URL holds the story step `#1`–`#5`), and the map switches to that subpage's layers. The risk overview combines direct and indirect impacts (tier table, a clickable flood timeline with the cascade as a tree, life loss). The flooding facts come from `public/summary.js`, shared with the USACE sidebar. Its "USACE" toggle and step 1's back button lead back to `/#5`.
- `public/fade.js` fades through black between the two pages (`fadeTo(url)`); pages load it in `<head>` so the fade-in starts before the first paint.
- Shared map code is `public/map/core.js` (`createMap` and its options), `panel.js` (layer panel, flood control, legends), `timeline.js` (the time slider) and `core.css`/`panel.css`. `cascade-graph.js` draws the cascade around a selected facility for the USACE journey's facility detail (vertical, tier colours, natural size so its text never scales).

Run the site with `./script server` (port 8080). It's deployed to GitHub Pages from `public/` (README, Deploy); keep every file under 100 MB. Locally, `public/data/terrain.pmtiles` may be the full zoom-15 copy (`build/terrain-z15.pmtiles`, 242 MB), hidden from git with `git update-index --skip-worktree`; the committed file is the 69 MB zoom-14 cut. Undo with `git update-index --no-skip-worktree public/data/terrain.pmtiles && git checkout public/data/terrain.pmtiles`. The data build is `uv run scripts/build_data.py`. To run one build step on its own, load the script with `uv run --with pyshp --with pyproj --with rasterio --with numpy --with pillow --with shapely --with scipy python` and call the function.

## Code

No build step: plain ES modules and CSS served from `public/`. MapLibre, PMTiles and the Protomaps basemap come from jsdelivr at pinned versions; Basecoat's button and form CSS is vendored in `public/vendor/`. Every path is relative, since GitHub Pages serves the site under a subpath.

- **Map state has one owner.** `createMap()` returns `app`, which holds the flood layer, clock, layer groups and the selected zone and facility. Change them only through its API (`setFlood`, `setTime`, `play`/`pause`, `setLayer`, `selectZone`, `selectFacility`, `growLinks`, …) and follow them with `app.on("flood" | "time" | "play" | "layer" | "zone" | "facility", fn)`. Don't set visibility, filters or paint on `app.map` for anything the API covers: the panel, legends and pointer handlers listen to the events and would drift. Plain `app.map` is fine for cameras.
- **Pointer input** (hover looks, cursor, tooltips, clicks on facilities and zones) is one handler per event in `createMap` (section "Pointer"). A facility wins over the zone under it. Add new hover or click behaviour there, not as extra per-layer listeners.
- **Layer groups.** `LAYER_GROUPS` names what `setLayer()` toggles. The facility layers belong to several groups (their impact group, `facilities`, and for indirect ones `showNeutralFacilities()`), so `applyFacilityLayers` works out their visibility from all of them after every change; don't toggle them by layer id.
- **Panels** (`createPanel`, `floodControl` in `panel.js`) render their own DOM and sync from the events, so the page's own code can drive the map freely. The EM page reuses `floodControl` on its subpage maps.
- **Data**: `loadData(file)` from `core.js` fetches JSON from `public/data/`, returning null (or a fallback) when a file is missing.
- **USACE page** (`story.js`): `steps[i].show({ fly, slide })` sets a step's whole state, so `#N` always opens the same view; `go(i)` switches steps, and the two animated transitions (`playFlood`, `playCascade`) end by calling the next step's `show`.
- **EM page** (`em/index.html`, one inline module): `step` is the story step in the URL hash, `page` the open subpage (internal). `render()` rebuilds the report; `syncMap()` is the one place that sets what each page shows on the map.
- **Security.** The data files are trusted and go into `innerHTML` as they are. Anything a reader types (the notice modal) goes through `esc()` or `textContent`; keep it that way. No inline event handlers.
- **Accessibility.** Clickable elements that aren't buttons get `tabindex="0"` and Enter/Space (the EM report's keydown handler). Story card text is an `aria-live` region. New animations respect `prefers-reduced-motion`.
- **Known issue**: MapLibre logs `this.expression.evaluate is not a function` (from `setFeatureState`) after the impact buildings cross-fade (`showAffectedBuildings`, `fadeInIndirectBuildings` in `core.js`). Those set the dot opacity to plain numbers while feature states change. It predates the Nov 23 cleanup; nothing visible is known to break.

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
- After removing code, re-read the lines around the cut. A slice once deleted a page's map loader along with the code it was meant to remove.
- Maps only load while the browser pane is visible. Check `tabs_context` first. If the pane is hidden, DOM checks still work but maps, `createMap` and `requestAnimationFrame` don't. Say what couldn't be checked; don't report it as passing.
- The USACE journey's 3D terrain map sometimes doesn't finish loading in the pane, even when it's visible (it did load on 23 Nov 2026). Check `map.loaded()` before clicking through its steps. The EM interface's 2D map loads reliably.
- To test hover or clicks, dispatch `MouseEvent`s on `app.map.getCanvas()` at projected points. Pass points to `queryRenderedFeatures` as `[x, y]` arrays: a plain `{ x, y }` object is read as options and returns every feature in the layer.
- The browser caches pages: add `?v=N` to the URL after edits.

## Data notes

- Two sources count flooded buildings differently. LifeSim (USACE, per evacuation zone, two zones since Nov 2026): 2,425 buildings, 13,246 people. The cascade analysis (per building, round 3 in `../data/cascades v3`; only schools, hospitals and power facilities): 2,587 buildings, including every building the water reaches. Both appear: LifeSim in the zone figures (EM overview text, zone table, life loss), the cascade in the impact tables (EM Impacts page, USACE sidebar), each building counted once.
- Times are shown as clock times ("5:10 AM", "2:00 PM"), from `clock()` in `map/core.js`: the dam breach (model hour 8.83) is at 2:00 PM, so overtopping (model hour 0) starts at 5:10 AM. Model code keeps hours since overtopping; impact times in the data are hours relative to the breach (`impactClock()`). Warning lead times ("0–2 h warning") stay durations. "Typical flood arrival" per zone is the 25th–75th percentile of when the zone's flooded buildings first get wet (round 3's `first_wet_h` and `evac_zone`; `zone_arrival.json`, `build_zone_arrival`), not LifeSim's `Arrv_lowq`/`Arrv_uppq`, which don't say what they count from. Don't use the flood raster for it: water wet at model start includes real flooding (653 zone 1 buildings are wet from 5:10 AM), but also the river and reservoir.
- A selected facility highlights every building it serves (`data/cascade_by_provider`, `build_cascade`): the cascade lists each building once, in its first tier, so flooded buildings are added from the facility's service area as tier 1.
- Indirect impacts come in two waves on the slider: at 5:10 AM, when flooded schools and Crichton Rehabilitation Center fail and their areas lose schooling and care, and at 2:54 PM, when Franklin Power Ventures fails and takes power from two hospitals and two schools. The "Show cascades" pill on both pages selects Franklin Memorial Medical Center, which loses power from Franklin Power Ventures.
- Impact tier colours (flooded `#7a0177`, loss of service `#d6336c`, indirect impact `#f39c12` with a 1 px `#9a5b00` outline) live only in `IMPACT_TIERS` in `map/core.js`, with each tier's label and one-line note; both pages, the legends and the map layers read them, so a tweak there changes everything. Figma swatches are set by hand to match.
- The scenario is daytime only (client feedback, Nov 2026): show no night figures (`PAR_Nght`, `LL_N_*`, `pop_night`) anywhere, in code or Figma, and no "(day)" or "Day" labels either: people figures are simply "People".

## Open threads

- Excess or incremental risk (failure minus non-failure) isn't supported: it would need a non-failure model run.
- Most Figma map screenshots are stale: story 3's depth and advance maps lack flooded buildings, and story 1 steps 3 and 4 show old arrows and no "Show cascades" pill.
- The sticky note next to Story 1 / Step 2 asks whether "of which critical" and "Facilities flooded" duplicate each other. Both are 22, and likely the same facilities.
