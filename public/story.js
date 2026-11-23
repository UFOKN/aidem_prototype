// The USACE journey (story 5 in Figma), at the site root. It began as a copy
// of story 1 (Figma: AidEM, Section 1, node 12:408). The current step is kept
// in the URL hash (#2); the last step leads to the EM interface (em/).

import { createMap, loadData, BREACH_HOURS, IMPACT_TIERS, ZONES, impactClock, facilityName, FACILITY_ICONS, facilityIconSvg } from "./map/core.js";
import { createPanel } from "./map/panel.js";
import { cascadeGraphSvg } from "./map/cascade-graph.js";
import { floodTables, toggleUses } from "./summary.js";

// Opening view on the South Fork Dam (from the explorer's URL
// #16.72/40.348515/-78.774338/176.3/60: zoom/lat/lng/bearing/pitch).
const DAM_VIEW = { center: [-78.774338, 40.348515], zoom: 16.72, bearing: 176.3, pitch: 60, elevation: 474.5 };
// Step 1: the dam sits in the space right of the story card (360 px wide, 10 px in)
const DAM_PADDING = { top: 0, right: 0, bottom: 0, left: 380 };

// The cascade analysis for the sidebar's impacts tables (scripts/build_data.py,
// build_cascade): its summary, each tier's buildings by use, and the facilities,
// their links and service areas. Any of them may be missing (null).
const [impacts, useByTier, cascadeFacilities, cascadeLinks, serviceAreas] = await Promise.all(
  ["cascade_summary.json", "cascade_use_by_tier.json", "cascade_facilities.geojson", "cascade_links.geojson", "cascade_service_areas.geojson"].map((f) => loadData(f)));
const n = (v) => Math.round(v).toLocaleString("en-US");
const tierSwatch = (i) => `<i style="background:${IMPACT_TIERS[i].color}${IMPACT_TIERS[i].stroke ? `; box-shadow: inset 0 0 0 1px ${IMPACT_TIERS[i].stroke}` : ""}"></i>`;

const app = await createMap({
  compass: false,
  rotate: false,
  container: "map",
  flood: null,
  layers: { evac: false }, // counties (domain) always on
  terrain: true,
  facilityPopup: false, // facility details replace the summary in the sidebar
  mapOptions: { bounds: undefined, ...DAM_VIEW, padding: DAM_PADDING },
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
// With the toolbar, sidebar (361px, right) and layer panel (230px, left) showing.
const TOOLS_PADDING = { top: 70, right: 390, bottom: 30, left: 390 }; // sidebar right; layer panel and card left (story 5)

// Impact layers (LAYER_GROUPS in map/core.js): direct (flooded facilities
// and buildings) from step 2 on, indirect (loss of service) from step 3 on.
function showImpacts({ direct, indirect }) {
  app.setLayer("directImpacts", direct);
  app.setLayer("indirectImpacts", indirect);
  // Step 2 also shows the facilities the flood doesn't reach, grey, until the cascade is calculated
  app.showNeutralFacilities(direct && !indirect);
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
// The facility step 3 is about: Franklin Power Ventures (hypothetical),
// flooded, whose failure takes power from the hospitals and schools it serves.
const CASCADE_FACILITY = "Franklin Power Ventures";
const HOSPITAL = "FRANKLIN MEMORIAL MEDICAL CENTER"; // loses power from it (step 4)
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
    title: "Introduction",
    html: `
      <img src="dam-1889.png" alt="">
      <p class="credit">Image: <a href="https://www.nps.gov/jofl/learn/historyculture/the-south-fork-dam.htm" target="_blank" rel="noopener">NPS/Harpers Ferry Center</a></p>
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
      moveCamera({ ...DAM_VIEW, padding: DAM_PADDING }, fly);
    },
  },
  {
    // Frame 2: Johnstown after the flood front got there, with the tools
    title: "Flood modeling",
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
    title: "Cascading impacts",
    html: `
      <p>Flooding causes disruption far beyond the flood zone. AidEM models those cascading impacts.</p>`,
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
    // Frame 4: a hospital outside the flood zone that loses power when
    // Franklin Power Ventures floods: both in view, the hospital selected
    // (its arrow from the plant and the buildings it serves).
    title: "Cascading impacts",
    html: `
      <p>This hospital is outside the flood zone but would lose power when its energy source floods.</p>`,
    next: "Next →",
    show({ fly, slide }) {
      app.setInteractive(true);
      cascadeLayers({ keepFlood: fly });
      showTools(slide);
      app.setCascades(true);
      hidePill();
      const [a, b] = [CASCADE_FACILITY, HOSPITAL].map((n) => app.facilityInfo(n).lngLat);
      // Centred on the hospital, with the plant still in view: the bounds reach as far past the hospital as the plant is away
      const [dx, dy] = [Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])];
      const bounds = [[b[0] - dx, b[1] - dy], [b[0] + dx, b[1] + dy]];
      moveCamera({ bounds, bearing: JOHNSTOWN.bearing, pitch: JOHNSTOWN.pitch, padding: TOOLS_PADDING, maxZoom: 15 }, fly);
      app.selectFacility(HOSPITAL);
    },
  },
  {
    // Frame 5: same map as step 3
    title: "Collaboration",
    html: `
      <p>Successful evacuations require collaboration between USACE and emergency managers on the ground</p>
      <p>Share report with the County Emergency Manager.</p>`,
    next: "Share report →", // on to the EM interface (story 4)
    show(opts) {
      steps[2].show(opts);
      hidePill(); // the pill is step 3's
    },
  },
];

// Step 1 to 2: the flood runs from the dam to Johnstown with the camera
// following it, driven by the flood clock. One eased move from the dam
// close-up to the vista over the valley while the water runs towards West
// Point, then a glide to Johnstown as the front gets there. Ends in step 2.
async function playFlood() {
  ensurePanel().classList.add("slider-only");
  setTransition(true); // the slider shows at once, but can't be used until the flood has got to Johnstown
  app.setFlood("arrival_first", { fade: true });
  showImpacts({ direct: true, indirect: false }); // they appear as the water reaches them
  app.setTime(BREACH_HOURS);
  // While the animation runs, the next button skips to its end.
  let skipped = false;
  setSkip(() => { skipped = true; app.map.stop(); app.pause(); });
  // The camera is at the dam (step 1). If the reader came back to step 1
  // and clicked on before the camera got there, finish that move first.
  const c = app.map.getCenter();
  if (Math.abs(c.lng - DAM_VIEW.center[0]) + Math.abs(c.lat - DAM_VIEW.center[1]) > 0.001) {
    await flyTo({ ...DAM_VIEW, padding: DAM_PADDING }, 1000);
  }
  if (current !== 1) return;
  app.map.setCenterClampedToGround(false);
  if (!skipped) {
    stopGlide = app.on("time", (t) => {
      if (t <= VISTA_AT) {
        // The dam's offset from the card eases out while the camera leaves it
        const k = ease((t - BREACH_HOURS) / (VISTA_AT - BREACH_HOURS));
        app.map.jumpTo({ ...lerpCamera(DAM_VIEW, VISTA, k, TO_VISTA_VIA), padding: { ...NO_PADDING, left: DAM_PADDING.left * (1 - k) } });
      } else if (t >= GLIDE_FROM) {
        app.map.jumpTo(lerpCamera(VISTA, JOHNSTOWN, ease((t - GLIDE_FROM) / (JOHNSTOWN_HOURS - GLIDE_FROM))));
      }
    });
    await app.play({ to: JOHNSTOWN_HOURS, speed: FLOOD_SPEED });
    stopGlide?.();
    stopGlide = null;
  }
  if (current !== 1) return; // left the step mid-animation
  setTransition(false);
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

// "Show cascades": a bouncing pill next to Franklin Memorial Medical Center,
// always in step 3 while nothing is selected. Clicking it goes on to step 4,
// which zooms in and selects the hospital.
let pill = null;
function showPill() {
  if (!pill) {
    const el = document.createElement("div");
    el.className = "cascade-pill";
    el.innerHTML = `<button>Show cascades</button>`;
    el.querySelector("button").addEventListener("click", (e) => { e.stopPropagation(); go(3); }); // step 4 selects the hospital
    pill = new app.maplibregl.Marker({ element: el, anchor: "left", offset: [16, 0] }).setLngLat(app.facilityInfo(HOSPITAL).lngLat);
  }
  if (!app.facility && current === 2) pill.addTo(app.map);
}
function hidePill() { pill?.remove(); }
app.on("facility", (name) => { if (name) hidePill(); else showPill(); });
// Step 2 to 3: zoom out to the whole map, keeping the reader's flood layer,
// and fade in the buildings that lose a service. Nothing is selected: the
// "Show cascades" pill next to the power plant shows one cascade on click.
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
  // The buildings that lose a service fade in while the map zooms out
  const buildingsIn = keep ? null : app.fadeInIndirectBuildings(3500);
  await new Promise((resolve) => {
    app.map.once("moveend", resolve);
    app.map.fitBounds(bounds, { ...camera, duration: 3500 });
  });
  if (!step()) return;
  if (skipped) return finish();
  setSkip(null);
  if (keep && app.facility === keep) {
    app.setCascades(true, { buildings: false });
    await Promise.all([app.fadeInIndirectBuildings(1200), app.growLinks(1500, ease)]);
    if (step() && app.facility === keep) app.showAffectedBuildings({ fade: 1000 });
    return;
  }
  await buildingsIn;
  if (step()) showPill();
}

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
function ensurePanel() {
  // The Impacts switch brings back the indirect impacts only once the cascade is calculated (step 3 on)
  panel ??= createPanel(app, { impactGroups: () => (current >= 2 ? ["directImpacts", "indirectImpacts"] : ["directImpacts"]) });
  return panel;
}
// The flood slider alone shows already while the flood runs (step 1 to 2): no layer toggle, no impacts
// card, and play and the slider are off. When the transition is over, or skipped, the whole panel shows
// (user, Nov 19)
function setTransition(on) {
  const el = ensurePanel();
  el.classList.toggle("slider-only", on);
  el.classList.toggle("early", on);
  for (const c of el.querySelectorAll(".play, input.time")) c.disabled = on;
}
function showTools(slide = true) {
  ensurePanel();
  if (!sidebar.querySelector(".scroll")) sidebar.insertAdjacentHTML("beforeend", sidebarHtml()); // below the audience toggle
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
  panel?.classList.remove("early", "slider-only");
}

// --- Sidebar ---------------------------------------------------------------
// Scenario summary. The sections' tables come from summary.js, shared with
// story 4: LifeSim results summed over the evacuation zones, the cascade
// summary, and flood figures from the flood rasters.

const sidebar = document.querySelector(".sidebar");
// Rows that open the buildings by use (indirect impacts).
sidebar.addEventListener("click", toggleUses);
const card = document.querySelector(".card");
new ResizeObserver(() => document.body.style.setProperty("--card-height", `${card.offsetHeight}px`)).observe(card);

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
  const tier = IMPACT_TIERS[p.tier];
  const when = impactClock(p.impact_h);
  const inLinks = p.links.filter((l) => l.to === p.name), outLinks = p.links.filter((l) => l.from === p.name);
  const status = p.tier === 1 ? `Flooded, ${p.depth_ft} ft deep` : `Loses ${p.services}`;
  return `<div class="detail">
    <button class="back">← Summary</button>
    <section>
      <h2><i style="background:${tier.color}"></i>${facilityName(p.name)}</h2>
      <p class="type">${p.type}</p>
      <table>
        <tr><td>${tier.label}</td><td>${status}</td></tr>
        <tr><td>Offline</td><td>${when ?? "no time"}</td></tr>
      </table>
    </section>
    ${current < 2 ? `<section>
      <h2>Estimated impacts</h2>
      <button class="btn calculate" data-size="sm">Calculate cascading impacts</button>
    </section>` : ""}
    ${current >= 2 && (inLinks.length || outLinks.length || p.area) ? `<section>
      <h2>Estimated impacts</h2>
      ${cascadeGraphSvg(p, (name) => app.facilityInfo(name))}
    </section>` : ""}
  </div>`;
}

// The summary: flood modeling, then (from step 3, see syncIndirect) Lives at
// risk and All impacts. (The Direct and Indirect impacts sections were removed.)
function sidebarHtml() {
  return `<div class="scroll">
    <section>
    <h2>Flood modeling</h2>
    ${floodTables()}
    </section>
    <section class="indirect" hidden></section></div>`;
}

// Estimated life loss and impacts from the flood modeling step (2) on (Figma
// comment, Nov 18); step 2 leaves out the indirect life loss row and the
// indirect tiers, which wait for the cascade step (3). Before step 2, nothing
// (an empty, hidden placeholder).
function syncIndirect() {
  const el = sidebar.querySelector("section.indirect");
  if (!el) return;
  sidebar.querySelector("section.all-impacts")?.remove(); // replaced along with the section, not stacked
  el.outerHTML = current >= 1 ? impactsHtml(current >= 2) : `<section class="indirect" hidden></section>`;
  if (app.facility) renderDetail();
}

// Direct life loss as two bars on one scale (Figma comment, Nov 19: "do this vis
// for now"): the 0-2 h warning bar fills the width, the 2-6 h warning bar is
// scaled to it, its figure ending at the bar's end.
function livesBars(zones) {
  const tot = (k) => zones.reduce((a, z) => a + z[k], 0);
  const [a, b] = [tot("LL_D_Min"), tot("LL_D_Amp")];
  return `<div class="lives-bars" role="img" aria-label="Direct life loss: ${n(a)} with 0 to 2 hours of warning, ${n(b)} with 2 to 6 hours">
      <div class="lbl"><span>0\u202F–\u202F2 h warning</span><b>${n(a)}</b></div>
      <div class="bar" style="width:100%; background:${IMPACT_TIERS[1].color}"></div>
      <div class="bar second" style="width:${(100 * b) / a}%"></div>
      <div class="lbl" style="padding-right:${100 - (100 * b) / a}%"><span>2\u202F–\u202F6 h warning</span><b>${n(b)}</b></div>
    </div>`;
}

function impactsHtml(cascaded = true) {
  const zones = Object.keys(ZONES).map((n) => app.zoneStats(+n));
  // The same LifeSim figures as the EM interface's Impacts page
  const sum = (k) => n(zones.reduce((a, z) => a + z[k], 0));
  return `<section class="indirect">
    <h2>Estimated life loss</h2>
    ${livesBars(zones)}
    ${cascaded ? `<table><tr><td>Indirect</td><td>${sum("Ind_LL")}</td></tr></table>` : ""}
    <table class="group">
      <tr><td>Structures likely to collapse</td><td>${sum("All_Collps")}</td></tr>
    </table>
    </section>${allImpactsHtml(!cascaded)}`;
}

// Estimated impacts (from the EM interface's Impacts page, made compact for the
// sidebar): people, critical facilities and other structures per tier, each
// counted once in its first tier so the tiers add up; tier rows open into
// facility kinds and building uses. Then, hidden for now (SHOW_TIMELINE), the
// cascade as a timeline of facilities, each failure under the one that causes
// it; a timeline row selects its facility (details and graph).
const KINDS = [["energy", "Power"], ["hospital", "Hospitals"], ["school", "Schools"]];
const SHOW_TIMELINE = false; // the cascade timeline is hidden for now (user, Nov 2026)
// pending (step 2, before the cascade is calculated): the indirect tiers are
// faded, without numbers, and the totals count the flooded tier only.
function allImpactsHtml(pending = false) {
  if (!impacts || !cascadeFacilities) return "";
  const facs = cascadeFacilities.features.map((f) => f.properties);
  const links = (cascadeLinks?.features ?? []).map((f) => f.properties);
  const areaOf = (name) => serviceAreas?.features.find((f) => f.properties.name === name)?.properties;
  const kindOf = (type) => Object.keys(FACILITY_ICONS).find((k) => FACILITY_ICONS[k].types.includes(type));
  const facCount = (tier, kind) => facs.filter((p) => (tier == null || p.tier === tier) && (!kind || kindOf(p.type) === kind)).length;
  const swatch = tierSwatch;
  const num = (v) => (v ? n(v) : `<span class="na">–</span>`);
  const tiers = [["primary", 1], ["secondary", 2], ["tertiary", 3]].map(([key, i]) => ({ key, i, ...impacts.buildings[key].first_affected }));
  // Three tables, each under its own heading: people per tier, structures
  // (opening into buildings by use) and facilities (opening into their kinds)
  // The toggle after the label (kept on the label's last word), so swatches line up with the people table
  const tierCell = (t) => {
    const words = IMPACT_TIERS[t.i].label.split(" "), last = words.pop();
    return `<td>${swatch(t.i)}${words.length ? words.join(" ") + " " : ""}<span class="nowrap">${last}<button class="expand after" aria-expanded="false" aria-label="Show by kind"></button></span></td>`;
  };
  const waits = (t) => pending && t.i > 1;
  // Step 2 shows only the flooded row; the other rows wait hidden with their
  // number (data-value) until "Calculate cascading impacts" below the table
  const pendingRow = (t, value) => `<tr class="pending" hidden><td>${swatch(t.i)}${IMPACT_TIERS[t.i].label}</td><td data-value="${value}"></td></tr>`;
  const peopleRows = tiers.map((t) => (waits(t) ? pendingRow(t, n(t.pop_day)) : `<tr><td>${swatch(t.i)}${t.i === 1 ? "In the flood zone" : IMPACT_TIERS[t.i].label}</td><td>${n(t.pop_day)}</td></tr>`)); // people: the flooded tier reads "In the flood zone"
  const structureRows = tiers.map((t) => waits(t) ? pendingRow(t, n(t.count)) : `<tr data-tier="str-${t.key}">${tierCell(t)}<td>${n(t.count)}</td></tr>`
    + (useByTier?.[t.key] ?? []).map((u) => `<tr class="use" data-tier="str-${t.key}" hidden><td>${u.use}</td><td>${n(u.buildings)}</td></tr>`).join(""));
  const facilityRows = tiers.map((t) => waits(t) ? pendingRow(t, facCount(t.i) ? n(facCount(t.i)) : "–") : `<tr data-tier="fac-${t.key}">${tierCell(t)}<td>${num(facCount(t.i))}</td></tr>`
    + KINDS.map(([k, label]) => `<tr class="use" data-tier="fac-${t.key}" hidden><td>${label}${facilityIconSvg(k)}</td><td>${num(facCount(t.i, k))}</td></tr>`).join(""));
  // Rows of one table; while pending, the total waits hidden too
  const body = (rows, total) => `<tbody>${rows.join("")}${pending ? total.replace('<tr class="total">', '<tr class="total pending" hidden>') : total}</tbody>`;
  const addRow = pending ? `<button class="add-row">+ Calculate cascading impacts</button>` : "";
  const sum = (k) => tiers.filter((t) => !waits(t)).reduce((a, t) => a + t[k], 0);
  // The cascade: facilities with an impact time, each under the facility it depends on
  const event = (p) => ({ name: p.name, tier: p.tier, h: p.impact_h, text: p.tier === 1 ? `${facilityName(p.name)} floods` : `${facilityName(p.name)} loses ${p.services}` });
  const hasCause = (p) => links.some((l) => l.to === p.name && facs.some((q) => q.name === l.from));
  const events = [];
  const add = (e, depth, lasts) => {
    const kids = facs.filter((p) => p.impact_h != null && links.some((l) => l.from === e.name && l.to === p.name)).map(event).sort((a, b) => a.h - b.h);
    events.push({ ...e, depth, lasts, hasKids: kids.length > 0 });
    kids.forEach((k, i) => add(k, depth + 1, [...lasts, i === kids.length - 1]));
  };
  // The dam breach (hour 0 relative to the breach) among them, as a plain row
  [...facs.filter((p) => p.impact_h != null && !hasCause(p)).map(event), { dam: true, h: 0, text: "South Fork Dam fails" }]
    .sort((a, b) => a.h - b.h).forEach((e) => (e.dam ? events.push({ ...e, depth: 0, lasts: [] }) : add(e, 0, [])));
  // Elbow lines: x of the dot at each depth (4 px to its centre), and its y,
  // lower when the row starts with its time
  const X = (k) => 4 + k * 16;
  const timeOf = (e, i) => (e.depth && impactClock(events[i - 1].h) === impactClock(e.h) ? "" : impactClock(e.h));
  const guides = (e, i) => {
    const g = [], d = e.depth, DOT = timeOf(e, i) ? 29 : 13;
    for (let k = 0; k < d - 1; k++) if (!e.lasts[k]) g.push(`<b style="left:${X(k)}px; top:0; bottom:0"></b>`);
    if (d) {
      g.push(`<svg style="left:${X(d - 1)}px" width="12" height="${DOT}"><path d="M0.5 0V${DOT - 4}Q0.5 ${DOT} 4.5 ${DOT}H8.5M6 ${DOT - 2.5}L8.5 ${DOT}L6 ${DOT + 2.5}"/></svg>`);
      if (!e.lasts[d - 1]) g.push(`<b style="left:${X(d - 1)}px; top:${DOT}px; bottom:0"></b>`);
    }
    if (e.hasKids) g.push(`<b style="left:${X(d)}px; top:${DOT + 5}px; bottom:0"></b>`);
    return g.join("");
  };
  const li = (e, i) => {
    if (e.dam) return `<li class="dam"><span><span class="dot"></span><span><time>${impactClock(e.h)}</time>${e.text}</span></span></li>`;
    const a = areaOf(e.name), time = timeOf(e, i);
    return `<li data-facility="${e.name}">${guides(e, i)}<span style="padding-left:${e.depth * 16}px"><span class="dot" style="background:${IMPACT_TIERS[e.tier].color}${time ? "; margin-top: 21px" : ""}"></span><span>${time ? `<time>${time}</time>` : ""}${e.text}${a ? `<small>${n(a.pop_day)} people lose ${a.service}</small>` : ""}</span></span></li>`;
  };
  return `<section class="all-impacts">
    <h2>Estimated impacts</h2>
    <h3>People</h3>
    <table class="cols">
      ${body(peopleRows, `<tr class="total"><td>Total</td><td data-value="${n(tiers.reduce((a, t) => a + t.pop_day, 0))}">${n(sum("pop_day"))}</td></tr>`)}
    </table>
    ${addRow}
    <h3>Critical facilities</h3>
    <table class="cols expandable">
      ${body(facilityRows, `<tr class="total"><td>Total</td><td data-value="${facCount(null)}">${pending ? facCount(1) : facCount(null)}</td></tr>`)}
    </table>
    ${addRow}
    <h3>Other structures</h3>
    <table class="cols expandable">
      ${body(structureRows, `<tr class="total"><td>Total</td><td data-value="${n(tiers.reduce((a, t) => a + t.count, 0))}">${n(sum("count"))}</td></tr>`)}
    </table>
    ${addRow}
    <p class="note">Each building is counted once</p>
    ${SHOW_TIMELINE ? `<h3>Cascade timeline</h3>
    <ol class="cascade">${events.map(li).join("")}</ol>` : ""}
  </section>`;
}
// A timeline row, or an entry in a facility's Impacts graph, selects its
// facility: its details and graph replace the sidebar
sidebar.addEventListener("click", (e) => {
  const el = e.target.closest(".all-impacts li[data-facility], .cascade-graph [data-facility]");
  if (!el || el.dataset.facility === app.facility) return;
  app.selectFacility(el.dataset.facility);
  // The map pans to it (zooming in if it is far out)
  const info = app.facilityInfo(el.dataset.facility);
  if (info) app.map.easeTo({ center: info.lngLat, zoom: Math.max(app.map.getZoom(), 13), duration: 800 });
});
// "Calculate cascading impacts" (step 2): the waiting rows and totals fade in
// with a spinner where each number goes, then the numbers appear, and the
// story moves on to the cascade step (whose tables are the same, now complete).
sidebar.addEventListener("click", async (e) => {
  if (!e.target.closest(".all-impacts .add-row")) return;
  const section = sidebar.querySelector(".all-impacts");
  section.querySelectorAll(".add-row").forEach((b) => b.remove());
  const rows = [...section.querySelectorAll("tr.pending")];
  const cells = rows.map((r) => r.querySelector("td[data-value]"));
  cells.forEach((c) => (c.innerHTML = `<span class="spinner"></span>`));
  rows.forEach((r) => { r.hidden = false; r.classList.add("appearing"); });
  await new Promise((r) => setTimeout(r, 1200));
  cells.forEach((c) => (c.textContent = c.dataset.value));
  await new Promise((r) => setTimeout(r, 700));
  if (current === 1) go(2);
});
// All impacts: a tier row opens anywhere on the row (the toggle handles itself)
sidebar.addEventListener("click", (e) => {
  const tr = e.target.closest(".all-impacts tr[data-tier]:not(.use)"); // sub rows don't toggle
  if (tr && !e.target.closest(".expand")) tr.querySelector(".expand")?.click();
});
// In the graph, a facility and its people hover as one
const hoverGraph = (name) => { for (const b of sidebar.querySelectorAll(".cascade-graph .cg-band")) b.classList.toggle("hover", b.dataset.facility === name); };
sidebar.addEventListener("mouseover", (e) => hoverGraph(e.target.closest(".cascade-graph [data-facility]")?.dataset.facility));
sidebar.addEventListener("mouseleave", () => hoverGraph(null));

// --- Navigation ----------------------------------------------------------------

const content = document.querySelector(".card .content");
const prev = document.querySelector(".card .prev");
const next = document.querySelector(".card .next");
const startOver = document.querySelector(".card .start-over");
// Minimize: the card shrinks to a "Guided tour" button that opens it again
document.querySelector(".card .head").addEventListener("click", () => card.classList.add("min")); // the whole header row, as in the EM interface
document.querySelector(".card .restore").addEventListener("click", () => card.classList.remove("min"));
let current = -1;

// New card text, written like an agent would: the old text slides out
// the top of the card, then the new paragraphs appear one after another.
const PARAGRAPH_DELAY = 350; // ms between paragraphs
function setCardText(html) {
  const old = content.hasChildNodes() && content.cloneNode(true);
  if (old) {
    const card = content.parentElement;
    old.classList.add("leaving");
    old.removeAttribute("aria-live"); // the old text isn't read again on its way out
    old.setAttribute("aria-hidden", "true");
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
  if (panel) setTransition(false);
  const step = steps[i];
  setCardText(step.html);
  document.querySelector(".card .step").textContent = step.title;
  document.querySelector(".card .head").hidden = i === 0;
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
const EM_INTERFACE = "em/";
next.addEventListener("click", () => {
  if (skip) skip();
  else if (current === steps.length - 1) fadeTo(EM_INTERFACE); // fade.js
  else go(current + 1);
});
document.querySelector('.audience [aria-pressed="false"]').addEventListener("click", () => fadeTo(EM_INTERFACE));
go((parseInt(location.hash.slice(1), 10) || 1) - 1);
