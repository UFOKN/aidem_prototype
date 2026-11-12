# AidEM prototype

Flood scenario prototype for the South Fork Dam: MapLibre and PMTiles, static files in `public/`. README.md covers the data pipeline and pages. FIGMA.md maps every Figma frame to its code. Read both before changing either side.

- Story 1 (`public/stories/story-1/`) is the USACE journey: a map story with a sidebar and a layer panel.
- Story 3 (`public/stories/story-3/index.html`) is the current EM interface: an overview with cards plus subpages (`#flood`, `#people`, `#impacts`, `#plan`) that change in place. (Story 2, the first EM version, was removed; its Figma frames remain.)
- `public/stories/fade.js` fades through black between story 1 and story 3 (`fadeTo(url)`); pages load it in `<head>` so the fade-in starts before the first paint.
- Shared map code is `public/map/core.js` (`createMap` and its options), `panel.js` (layer panel, legends) and `core.css`.

Run the site with `./script server` (port 8080). It's deployed to GitHub Pages from `public/` (README, Deploy); keep every file under 100 MB. The data build is `uv run scripts/build_data.py`. To run one build step on its own, load the script with `uv run --with pyshp --with pyproj --with rasterio --with numpy --with pillow --with shapely --with scipy python` and call the function.

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

- Two sources count flooded buildings differently. LifeSim (USACE, per evacuation zone): 2,422 buildings, 13,246 people by day and 5,794 at night. The cascade analysis (per building, `../data/johnstown_cascade/output`): 2,587 buildings, including every building the water reaches. Story 3 shows both, with a note.
- Nearly all indirect impacts have their first impact at 0:00 on the slider (overtopping start), because the main providers fail then. So the indirect layer barely changes over time. That comes from the data, not a bug.
- "Potentially at risk" means buildings and facilities that depend on drinking-water systems whose intakes aren't public. The map counts 2,002 buildings in that category. People figures for that category alone aren't built yet.
- Write "People (day)" and "People (night)", never "People, day".

## Open threads

- Excess or incremental risk (failure minus non-failure) isn't supported: it would need a non-failure model run.
- Most Figma map screenshots are stale: story 3's depth and advance maps lack flooded buildings, and story 1 steps 3 and 4 show old arrows and no "Show cascades" pill.
- The sticky note next to Story 1 / Step 2 asks whether "of which critical" and "Facilities flooded" duplicate each other. Both are 22, and likely the same facilities.
