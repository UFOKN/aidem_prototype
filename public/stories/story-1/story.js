// Story 1, wireframe stage. Text and frames from Figma (AidEM, Section 1,
// node 12:408). The current step is kept in the URL hash (#2).

import { createMap, BREACH_HOURS, IMPACT_TIERS, ZONES, relativeToBreach, facilityName } from "../../map/core.js";
import { createPanel } from "../../map/panel.js";

// Opening view on the South Fork Dam (from the explorer's URL
// #16.72/40.348515/-78.774338/176.3/60: zoom/lat/lng/bearing/pitch).
const DAM_VIEW = { center: [-78.774338, 40.348515], zoom: 16.72, bearing: 176.3, pitch: 60, elevation: 474.5 };

// Cascading impacts summary (../data/johnstown_cascade, copied by the pipeline).
const impacts = await fetch("../../data/cascade_summary.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
// The same buildings by use (homes, businesses, ...) in each tier, for the expandable buildings table.
const useByTier = await fetch("../../data/cascade_use_by_tier.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);

const app = await createMap({
  container: "map",
  flood: null,
  layers: { evac: false }, // counties (domain) always on
  terrain: true,
  facilityPopup: false, // facility details replace the summary in the sidebar
  mapOptions: { bounds: undefined, ...DAM_VIEW },
});
window.app = app;

// Keyframe elevations are the ground under each centre (m). During the flight
// the camera's focus height is interpolated between them instead of following
// the terrain, which would bob the camera up and down over ridges and valleys.
// Step 2 camera, driven by the flood clock: one eased move from the dam
// close-up (step 1's view) at the breach to a vista over the valley (looking
// south, dam on the left, Johnstown on the right) while the water runs towards
// West Point, hold briefly, then glide straight to Johnstown as the front gets there.
const JOHNSTOWN = { center: [-78.917, 40.326], zoom: 14, bearing: 175.6, pitch: 25, elevation: 356.5 }; // almost overhead
// Centred on the river between Mineral Point and West Point. The pitch is
// already halfway from the dam close-up to the final, near-overhead view.
const VISTA = { center: [-78.8459, 40.378], zoom: 14.16, bearing: 175.6, pitch: (DAM_VIEW.pitch + JOHNSTOWN.pitch) / 2, elevation: 411 };
// The pull-back to the vista arcs instead of cutting the corner: the centre
// first runs north along the flood path past South Fork, then turns west to
// the vista, so the waterway stays in view. Control point of that curve:
// ARC of the way from the straight line's midpoint to the corner at the
// dam's longitude and the vista's latitude (1 = widest arc, 0 = straight).
const ARC = 0.6;
const TO_VISTA_VIA = [0, 1].map((i) => {
  const mid = (DAM_VIEW.center[i] + VISTA.center[i]) / 2;
  const corner = i === 0 ? DAM_VIEW.center[0] : VISTA.center[1];
  return mid + (corner - mid) * ARC;
});
const VISTA_AT = 9.35;        // h: pull-back ends as the front reaches the loops at West Point
const GLIDE_FROM = VISTA_AT;  // h: no hold; the eases in and out of the vista make the pause
const JOHNSTOWN_HOURS = 10.0; // h: the front reaches downtown Johnstown
const FLOOD_SPEED = 0.06;     // simulated hours per second while the flood plays

// Map padding keeps content clear of the card (300px wide, bottom-left).
// The opening view uses none, so it matches the explorer view it came from.
// Camera calls with their own padding stack on top of the map's padding.
const NO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };
const CARD_PADDING = { top: 20, right: 20, bottom: 20, left: 320 };
// With the toolbar, sidebar (361px) and layer panel (230px, right) showing.
const TOOLS_PADDING = { top: 70, right: 270, bottom: 30, left: 390 };

// Impact layers (LAYER_GROUPS in map/core.js): direct (flooded facilities
// and buildings) from step 2 on, indirect (loss of service) from step 3 on.
function showImpacts({ direct, indirect }) {
  app.setLayer("directImpacts", direct);
  app.setLayer("indirectImpacts", indirect);
}
// Whole map from above: the flood model's extent plus the service areas of
// the cascading impacts, with step 2's bearing. The pitch stays as it is
// when coming from another step; opened from the URL it is step 2's.
function overviewBounds() {
  const [w, s, e, n] = Object.values(app.rasters)[0].bounds;
  const b = new app.maplibregl.LngLatBounds([w, s], [e, n]);
  for (const f of app.impactAreas.features) {
    f.geometry.coordinates.flat(f.geometry.type === "Polygon" ? 1 : 2).forEach((c) => b.extend(c));
  }
  return b;
}
// The facility step 3 is about: the sewage plant at Dornick Point, flooded,
// whose failure reaches the hospitals, schools and colleges it serves.
const CASCADE_FACILITY = "DORNICK PT WWTP";
const OVERVIEW = (fly) => ({ bounds: overviewBounds(), bearing: JOHNSTOWN.bearing, pitch: fly ? app.map.getPitch() : JOHNSTOWN.pitch, padding: TOOLS_PADDING });

// Each step is a static state, so the URL (#2) always opens the same view.
// show({ fly, slide }) sets it: with fly the camera flies there from wherever
// it is, with slide the toolbar and panels slide in; without them the step
// is simply there (opening it from the URL). Two transitions are animated
// when the reader clicks next: step 1 to 2 runs the flood (playFlood) and
// step 2 to 3 the cascade (playCascade). Each ends in the next step's state.
const steps = [
  {
    // Frame 1: map centered on dam
    html: `
      <img src="dam-1889.png" alt="">
      <p class="credit">Image: NPS/Harpers Ferry Center</p>
      <p class="note">On May 31, 1889 the South Fork Dam failed after heavy rainfall, releasing 20 million tons of water. It caused the Johnstown Flood that claimed more than 2,200 lives.</p>
      <p>This scenario of a fictional, present day dam failure at South Fork shows how AidEM helps agencies work together from first flood map to an effective evacuation order</p>`,
    next: "Start →",
    show({ fly, slide }) {
      app.setInteractive(false); // the opening view stays put
      hidePill();
      app.setFlood(null);
      showImpacts({ direct: false, indirect: false });
      app.selectFacility(null);
      app.setCascades(false);
      hideTools();
      moveCamera({ ...DAM_VIEW, padding: NO_PADDING }, fly);
    },
  },
  {
    // Frame 2: Johnstown after the flood front got there, with the tools
    html: `<p>AidEM uses some of the best hydrologic modeling and impact assessment to assess direct flood impacts.</p>`,
    // Added to the card at the end of the flood animation (the result of step 2).
    result: `<p>We combine it with local data to deliver location-specific risk insights.</p>`,
    next: "Calculate cascading impacts →", // "Skip →" while the animation runs
    show({ fly, slide }) {
      app.setInteractive(true);
      hidePill();
      app.setFlood("arrival_first");
      app.setTime(JOHNSTOWN_HOURS);
      // Direct impacts follow the flood clock; the cascades wait for step 3.
      showImpacts({ direct: true, indirect: false });
      app.selectFacility(null);
      app.setCascades(false); // a selected facility shows no cascade before step 3
      if (!content.querySelector(".result")) content.insertAdjacentHTML("beforeend", this.result.replace("<p>", '<p class="result enter">'));
      showTools(slide); // toolbar and layer panel with the time slider
      moveCamera({ ...JOHNSTOWN, padding: NO_PADDING }, fly);
    },
  },
  {
    // Frame 3: cascading impacts of one flooded facility, two levels deep
    html: `
      <p>Flooding causes disruption far beyond the flood zone. AidEM models cascading failures.</p>
      <p>Explore the map. When you’re ready, click Next to turn data into action.</p>`,
    next: "Next →",
    show({ fly, slide, keepFacility = false }) {
      app.setInteractive(true);
      cascadeLayers({ keepFlood: fly });
      showTools(slide);
      if (!keepFacility) app.selectFacility(null);
      app.setCascades(true);
      moveCamera(OVERVIEW(fly), fly);
      showPill();
    },
  },
  {
    // Frame 4: same map as step 3
    html: `
      <p>Successful evacuations require collaboration between USACE and emergency managers on the ground</p>
      <p>Next, bring in EMs to coordinate evacuations before flooding strikes.</p>`,
    next: "Go to EM interface →", // on to the EM interface (story 3)
    show(opts) {
      steps[2].show(opts);
    },
  },
];

// Step 1 to 2: the flood runs from the dam to Johnstown with the camera
// following it, driven by the flood clock. One eased move from the dam
// close-up to the vista over the valley while the water runs towards West
// Point, then a glide to Johnstown as the front gets there. Ends in step 2.
async function playFlood() {
  app.setFlood("arrival_first", { fade: true });
  showImpacts({ direct: true, indirect: false }); // they appear as the water reaches them
  app.setTime(BREACH_HOURS);
  app.map.setPadding(NO_PADDING);
  // While the animation runs, the next button skips to its end.
  let skipped = false;
  setSkip(() => { skipped = true; app.map.stop(); app.pause(); });
  // The camera is at the dam (step 1). If the reader came back to step 1
  // and clicked on before the camera got there, finish that move first.
  const c = app.map.getCenter();
  if (Math.abs(c.lng - DAM_VIEW.center[0]) + Math.abs(c.lat - DAM_VIEW.center[1]) > 0.001) {
    await flyTo(DAM_VIEW, 1000);
  }
  if (current !== 1) return;
  app.map.setCenterClampedToGround(false);
  if (!skipped) {
    stopGlide = app.on("time", (t) => {
      if (t <= VISTA_AT) {
        app.map.jumpTo(lerpCamera(DAM_VIEW, VISTA, ease((t - BREACH_HOURS) / (VISTA_AT - BREACH_HOURS)), TO_VISTA_VIA));
      } else if (t >= GLIDE_FROM) {
        app.map.jumpTo(lerpCamera(VISTA, JOHNSTOWN, ease((t - GLIDE_FROM) / (JOHNSTOWN_HOURS - GLIDE_FROM))));
      }
    });
    await app.play({ to: JOHNSTOWN_HOURS, speed: FLOOD_SPEED });
    stopGlide?.();
    stopGlide = null;
  }
  if (current !== 1) return; // left the step mid-animation
  setSkip(null);
  app.map.setCenterClampedToGround(true);
  steps[1].show({ fly: false, slide: true }); // played through or skipped: step 2's state
  // The flood keeps going after the flight; the time slider in the layer
  // panel can pause it. Leaving the step stops it (go).
  app.play({ to: app.maxHours, speed: FLOOD_SPEED });
}

// Map layers of steps 3 and 4. Coming from step 2 the reader's flood layer
// stays; opened from the URL it is max depth.
function cascadeLayers({ keepFlood = false } = {}) {
  if (!keepFlood || !app.flood) app.setFlood("depth_max");
  showImpacts({ direct: true, indirect: true });
}

// "Show cascades": a bouncing pill next to the sewage plant in steps 3 and 4.
// Clicking it selects the plant: its arrows grow out to the facilities it
// takes out, then the buildings that lose a service fade in. It only shows
// until the reader has seen one cascade (by the pill or by clicking a facility).
let pill = null, pillUsed = false;
function showPill() {
  if (!pill) {
    const el = document.createElement("button");
    el.className = "cascade-pill";
    el.textContent = "Show cascades";
    el.addEventListener("click", (e) => { e.stopPropagation(); showCascade(); });
    pill = new app.maplibregl.Marker({ element: el, anchor: "left", offset: [16, 0] }).setLngLat(app.facilityInfo(CASCADE_FACILITY).lngLat);
  }
  if (!app.facility && !pillUsed) pill.addTo(app.map);
}
function hidePill() { pill?.remove(); }
app.on("facility", (name) => { if (name) { pillUsed = true; hidePill(); } else if (current >= 2) showPill(); });
async function showCascade() {
  app.selectFacility(CASCADE_FACILITY, { buildings: false });
  await growLinks();
  if (app.facility === CASCADE_FACILITY) app.showAffectedBuildings({ fade: 1000 });
}
// The selected facility's arrows grow out from it.
async function growLinks() {
  const GROW_MS = 1500, t0 = performance.now();
  app.setLinkProgress(0);
  await new Promise((resolve) => {
    const frame = (now) => {
      const k = Math.min(1, (now - t0) / GROW_MS);
      app.setLinkProgress(ease(k));
      if (k < 1) requestAnimationFrame(frame); else resolve();
    };
    requestAnimationFrame(frame);
  });
}

// Step 2 to 3: zoom out to the whole map, keeping the reader's flood layer,
// and fade in the buildings that lose a service. Nothing is selected: the
// "Show cascades" pill next to the sewage plant shows one cascade on click.
// Ends in step 3's state.
async function playCascade() {
  const step = () => current === 2;
  let skipped = false;
  setSkip(() => { skipped = true; app.map.stop(); });
  // Calculated from a facility's details: it stays selected, and its
  // cascade grows out once the map has zoomed out.
  const keep = app.facility;
  const finish = () => { setSkip(null); steps[2].show({ fly: false, slide: false, keepFacility: !!keep }); };
  app.setInteractive(true);
  cascadeLayers({ keepFlood: true });
  if (!keep) { app.selectFacility(null); app.setCascades(true); }
  app.map.setLayoutProperty("cascade-buildings", "visibility", "none"); // fades in after the zoom
  const { bounds, ...camera } = OVERVIEW(true);
  if (!app.map.cameraForBounds(bounds, camera)) camera.padding = NO_PADDING; // narrow window, see moveCamera
  await new Promise((resolve) => {
    app.map.once("moveend", resolve);
    app.map.fitBounds(bounds, { ...camera, duration: 3500 });
  });
  if (!step()) return;
  if (skipped) return finish();
  setSkip(null);
  if (keep && app.facility === keep) {
    app.setCascades(true, { buildings: false });
    app.setLinkProgress(0);
    await Promise.all([app.fadeInIndirectBuildings(1200), growLinks()]);
    if (step() && app.facility === keep) app.showAffectedBuildings({ fade: 1000 });
    return;
  }
  await app.fadeInIndirectBuildings(1200);
  if (step()) showPill();
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Camera helpers ------------------------------------------------------------

let stopGlide = null;
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2); // ease in-out
const lerp = (a, b, k) => a + (b - a) * k;

// Camera between a and b at k (0-1). Zoom changes linearly; the centre's
// progress is scaled to the zoom, so the ground moves across the screen at
// a steady pace instead of racing while zoomed in and crawling when out.
// With `via`, the centre follows a curve (quadratic Bézier) bent towards it.
function lerpCamera(a, b, k, via) {
  const dz = b.zoom - a.zoom;
  const u = Math.abs(dz) < 1e-6 ? k : (1 - 2 ** (-dz * k)) / (1 - 2 ** -dz);
  const along = (i) => via
    ? (1 - u) ** 2 * a.center[i] + 2 * u * (1 - u) * via[i] + u ** 2 * b.center[i]
    : lerp(a.center[i], b.center[i], u);
  return {
    center: [along(0), along(1)],
    zoom: lerp(a.zoom, b.zoom, k),
    bearing: lerp(a.bearing, b.bearing, k),
    pitch: lerp(a.pitch, b.pitch, k),
    elevation: lerp(a.elevation, b.elevation, k),
  };
}

// To a camera ({ center, zoom, ... } or { bounds, ... }), flying or at once.
function moveCamera({ bounds, ...camera }, animate) {
  const duration = animate ? 2500 : 0;
  // In a window too narrow for the padding, fit without it (fitBounds
  // would otherwise not move at all).
  if (bounds && !app.map.cameraForBounds(bounds, camera)) camera.padding = NO_PADDING;
  if (bounds) app.map.fitBounds(bounds, { ...camera, duration });
  else if (animate) app.map.flyTo({ ...camera, duration });
  else app.map.jumpTo(camera);
}

function flyTo(camera, duration = 2500) {
  return new Promise((resolve) => {
    app.map.once("moveend", resolve);
    app.map.flyTo({ ...camera, duration });
  });
}

// --- Toolbar and layer panel ------------------------------------------------
// Shown from the end of step 2 on, and kept when going back, until step 1.
// The CSS (body.tools) slides the toolbar in and fades the panel.

let panel = null;
// Without slide they appear in place (body.instant turns the transitions off).
function showTools(slide = true) {
  panel ??= createPanel(app);
  if (!sidebar.hasChildNodes()) sidebar.innerHTML = sidebarHtml();
  syncIndirect();
  if (slide) {
    requestAnimationFrame(() => document.body.classList.add("tools"));
  } else if (!document.body.classList.contains("tools")) {
    document.body.classList.add("instant", "tools");
    document.body.offsetWidth; // apply the end state before the transitions come back
    requestAnimationFrame(() => document.body.classList.remove("instant"));
  }
}
function hideTools() {
  document.body.classList.remove("tools");
}

// --- Sidebar ---------------------------------------------------------------
// Scenario summary. Zone figures are LifeSim results, summed over the three
// evacuation zones (each life loss figure is a mean for one scenario, so
// zones add up within a column). Flood figures come from the flood rasters
// (Depth/Velocity/Arrival Time, computed once from the source GeoTIFFs).

const sidebar = document.querySelector(".sidebar");
// Rows that open the buildings by use (indirect impacts).
sidebar.addEventListener("click", (e) => {
  const expand = e.target.closest(".expand");
  if (!expand) return;
  const open = expand.getAttribute("aria-expanded") !== "true", tier = expand.closest("tr").dataset.tier;
  expand.setAttribute("aria-expanded", open);
  for (const tr of expand.closest("table").querySelectorAll(`tr.use[data-tier="${tier}"]`)) tr.hidden = !open;
});
const card = document.querySelector(".card");
new ResizeObserver(() => document.body.style.setProperty("--card-height", `${card.offsetHeight}px`)).observe(card);
const FLOOD_FACTS = {
  areaSqMi: 4.9,        // cells with depth > 0
  maxDepth: 79,         // ft
  medianDepth: 16,      // ft, over the flooded area
  velocityP99: 25,      // ft/s; the raw maximum is a spike at the breach
};

// Facility details: clicking a facility on the map shows them over the
// summary; closing them (or clicking elsewhere on the map) brings it back.
app.on("facility", () => renderDetail());
// Also called on every step change, since the details depend on the step.
function renderDetail() {
  const name = app.facility;
  const summary = sidebar.querySelector(".scroll");
  sidebar.querySelector(".detail")?.remove();
  if (summary) summary.hidden = !!name;
  const info = name && app.facilityInfo(name);
  if (!info) return;
  sidebar.insertAdjacentHTML("beforeend", facilityHtml(info));
  sidebar.querySelector(".detail .back").addEventListener("click", () => app.selectFacility(null));
  // Before step 3 the impacts are a button that calculates them (as in the summary).
  sidebar.querySelector(".detail .calculate")?.addEventListener("click", () => go(2));
}

function facilityHtml(p) {
  const n = (v) => Math.round(v).toLocaleString("en-US");
  const tier = IMPACT_TIERS[p.tier];
  const when = relativeToBreach(p.impact_h);
  const potential = (l) => (l.certainty === "potential" ? ` <span class="na">(potentially at risk${l.located ? "" : ", location not public"})</span>` : "");
  const inLinks = p.links.filter((l) => l.to === p.name), outLinks = p.links.filter((l) => l.from === p.name);
  const status = p.tier === 1 ? `Flooded, ${p.depth_ft} ft deep` : `Loses ${p.services}`;
  return `<div class="detail">
    <button class="back">← Summary</button>
    <section>
      <h2><i style="background:${tier.color}"></i>${facilityName(p.name)}</h2>
      <p class="type">${p.type}${p.certainty === "potential" ? " · potentially at risk" : ""}</p>
      <table>
        <tr><td>${tier.label}</td><td>${status}</td></tr>
        <tr><td>Offline</td><td>${when ?? "no time (potentially at risk)"}</td></tr>
      </table>
    </section>
    ${inLinks.length ? `<section>
      <h2>Depends on</h2>
      <table>${inLinks.map((l) => `<tr><td>${facilityName(l.from)}${potential(l)}</td><td>${l.service}</td></tr>`).join("")}</table>
    </section>` : ""}
    ${current < 2 ? `<section>
      <h2>Impacts</h2>
      <button class="calculate">Calculate cascading impacts</button>
    </section>` : p.area || outLinks.length ? `<section>
      <h2>Impacts</h2>
      ${p.area ? `<h3>Buildings &amp; people</h3>
      <table>
        <tr><td>Buildings that lose its ${p.area.service}</td><td>${n(p.area.buildings)}</td></tr>
        <tr><td>People</td><td>${n(p.area.pop_day)}</td></tr>
      </table>` : ""}
      ${outLinks.length ? `<h3>Facilities</h3>
      <p class="type">${outLinks.length} ${outLinks.length === 1 ? "facility loses" : "facilities lose"} ${outLinks[0].service}${potential(outLinks[0])}</p>
      <table>${outLinks.map((l) => `<tr><td>${facilityName(l.to)}</td></tr>`).join("")}</table>` : ""}
    </section>` : ""}
  </div>`;
}

function sidebarHtml() {
  const z = [1, 2, 3].map((n) => app.zoneStats(n));
  const sum = (k) => z.reduce((a, p) => a + p[k], 0);
  const n = (v) => Math.round(v).toLocaleString("en-US");
  const hm = (h) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")} h`;
  const collapse = z.reduce((a, p) => a + (p.All_Struct * p.All_Collps) / 100, 0);
  const row = (label, value, cls = "") => `<tr class="${cls}"><td>${label}</td><td>${value}</td></tr>`;
  const swatch = (zone) => `<i style="background:${ZONES[zone].color}"></i>`;
  const f = FLOOD_FACTS;
  return `<div class="scroll">
    <section>
    <h2>Direct impacts</h2>
    <table class="cols">
      <thead><tr><th>Population at risk</th><th></th></tr></thead>
      <tr><td>In the flood zone</td><td>${n(sum("PAR_Day"))}</td></tr>
    </table>
    <table class="cols">
      <thead><tr><th>Life loss</th><th></th></tr></thead>
      <tr><td>0–2 h warning</td><td>${n(sum("LL_D_Min"))}</td></tr>
      <tr><td>2–6 h warning</td><td>${n(sum("LL_D_Amp"))}</td></tr>
    </table>
    <table>
      ${row("Structures flooded", n(sum("All_Struct")))}
      ${row("of which critical", n(sum("Crt_Struct")), "sub")}
      ${row("Likely to collapse", n(collapse))}
      ${impacts ? row("Facilities flooded (2 ft+)", n(impacts.facilities.primary.first_affected.count)) : ""}
    </table>
    </section>
    <section class="indirect"></section>
    <section>
    <h2>Flood modeling</h2>
    <table>
      ${row("Overtopping starts", "0:00 h")}
      ${row("Dam breach", hm(BREACH_HOURS))}
      ${row("Flooded area", `${f.areaSqMi} sq mi`)}
      ${row("Depth", `up to ${f.maxDepth} ft, median ${f.medianDepth} ft`)}
      ${row("Velocity", `up to ${f.velocityP99} ft/s`)}
    </table>
    </section></div>`;
}

// Cascading impacts from the analysis's summary (round 2). Buildings and
// people are counted once, in the first tier where they lose something, so
// the tiers add up; facilities likewise. Primary buildings are any that get
// wet (NSI), so the count differs from LifeSim's structures above.
// indirectLifeLoss: LifeSim's indirect life loss, summed over the zones.
// Indirect impacts section of the summary. Until the cascade has been
// calculated (step 3) it only holds the button that calculates it.
function syncIndirect() {
  const el = sidebar.querySelector("section.indirect");
  if (!el) return;
  const z = [1, 2, 3].map((n) => app.zoneStats(n));
  el.outerHTML = current >= 2
    ? impactsHtml(z.reduce((a, p) => a + p.Ind_LL, 0))
    : `<section class="indirect"><h2>Indirect impacts</h2><button class="calculate">Calculate cascading impacts</button></section>`;
  sidebar.querySelector("section.indirect .calculate")?.addEventListener("click", () => go(2));
  if (app.facility) renderDetail();
}

function impactsHtml(indirectLifeLoss) {
  const n = (v) => Math.round(v).toLocaleString("en-US");
  const row = (label, value, cls = "") => `<tr class="${cls}"><td>${label}</td><td>${value}</td></tr>`;
  if (!impacts) {
    return `<section class="indirect"><h2>Indirect impacts</h2><table>${row("Power, water, sewer, services", `<span class="na">not loaded</span>`)}${row("Indirect life loss", n(indirectLifeLoss))}</table></section>`;
  }
  const b = impacts.buildings, fac = impacts.facilities;
  const first = (tier) => b[tier].first_affected;
  // Flooded buildings are listed with the direct impacts.
  const tiers = [["secondary", 2], ["tertiary", 3]];
  const total = (k) => tiers.reduce((a, [t]) => a + first(t)[k], 0);
  const swatch = (i) => `<i style="background:${IMPACT_TIERS[i].color}"></i>`;
  return `<section class="indirect">
    <h2>Indirect impacts</h2>
    <table class="cols">
      <thead><tr><th>Impact</th><th>People</th></tr></thead>
      ${tiers.map(([t, i]) => `<tr><td>${swatch(i)}${IMPACT_TIERS[i].label}</td><td>${n(first(t).pop_day)}</td></tr>`).join("")}
      <tr><td>All</td><td>${n(total("pop_day"))}</td></tr>
    </table>
    <table class="cols expandable">
      <thead><tr><th>Impact</th><th>Buildings</th></tr></thead>
      ${tiers.map(([t, i]) => {
        const uses = useByTier?.[t];
        const toggle = uses ? `<button class="expand" aria-expanded="false" aria-label="Show buildings by use"></button>` : "";
        return `<tr data-tier="${t}"><td>${toggle}${swatch(i)}${IMPACT_TIERS[i].label}</td><td>${n(first(t).count)}</td></tr>`
          + (uses ?? []).map((u) => `<tr class="use" data-tier="${t}" hidden><td>${u.use}</td><td>${n(u.buildings)}</td></tr>`).join("");
      }).join("")}
      <tr><td>All</td><td>${n(total("count"))}</td></tr>
    </table>
    <table>
      ${row("Facilities losing a service", n(fac.secondary.first_affected.count))}
      ${row("of which hospitals", n(fac.secondary.affected_by_type.Hospitals ?? 0), "sub")}
      ${row("of which EMS and fire", n((fac.secondary.affected_by_type.EMS ?? 0) + (fac.secondary.affected_by_type["Fire Stations"] ?? 0) + (fac.secondary.affected_by_type["Fire Stations EMS"] ?? 0)), "sub")}
      ${row("of which schools and colleges", n((fac.secondary.affected_by_type.Schools ?? 0) + (fac.secondary.affected_by_type["Colleges and Universities"] ?? 0)), "sub")}
    </table>
    <table class="group">
      ${row("Water systems potentially at risk", n(impacts.failed_providers.primary["Public Water System"] ?? 0))}
      ${row("Indirect life loss", n(indirectLifeLoss))}
    </table>
    </section>`;
}

// --- Navigation ----------------------------------------------------------------

const content = document.querySelector(".card .content");
const prev = document.querySelector(".card .prev");
const next = document.querySelector(".card .next");
const startOver = document.querySelector(".card .start-over");
let current = -1;

// New card text, written like an agent would: the old text slides out
// the top of the card, then the new paragraphs appear one after another.
const PARAGRAPH_DELAY = 350; // ms between paragraphs
function setCardText(html) {
  const old = content.hasChildNodes() && content.cloneNode(true);
  if (old) {
    const card = content.parentElement;
    old.classList.add("leaving");
    for (const el of old.querySelectorAll(".enter")) { el.classList.remove("enter"); el.style.animationDelay = ""; } // already shown
    Object.assign(old.style, { top: `${content.offsetTop}px`, left: `${content.offsetLeft}px`, width: `${content.offsetWidth}px` });
    card.append(old);
    old.addEventListener("animationend", () => old.remove(), { once: true });
  }
  content.innerHTML = html;
  [...content.children].forEach((el, i) => {
    el.classList.add("enter");
    el.style.animationDelay = `${(old ? 200 : 0) + i * PARAGRAPH_DELAY}ms`;
  });
}

// During step 2's animation the next button becomes a skip button.
let skip = null;
function setSkip(fn) {
  skip = fn;
  next.textContent = fn ? "Skip →" : steps[current].next;
}

function go(i) {
  if (i < 0 || i >= steps.length || i === current) return;
  const from = current;
  current = i;
  skip = null;
  stopGlide?.();
  stopGlide = null;
  app.map.stop();
  app.map.setCenterClampedToGround(true);
  app.pause();
  const step = steps[i];
  setCardText(step.html);
  next.textContent = step.next;
  prev.hidden = i === 0;
  startOver.hidden = i === 0;
  syncIndirect();
  history.replaceState(null, "", `#${i + 1}`);
  if (from === 0 && i === 1) playFlood();
  else if (from === 1 && i === 2) playCascade();
  else step.show({ fly: from !== -1, slide: from !== -1 }); // opened from the URL: no motion
}

prev.addEventListener("click", () => go(current - 1));
startOver.addEventListener("click", () => go(0));
const EM_INTERFACE = "../story-3/";
next.addEventListener("click", () => {
  if (skip) skip();
  else if (current === steps.length - 1) fadeTo(EM_INTERFACE); // fade.js
  else go(current + 1);
});
document.querySelector('.audience [aria-pressed="false"]').addEventListener("click", () => fadeTo(EM_INTERFACE));
go((parseInt(location.hash.slice(1), 10) || 1) - 1);
