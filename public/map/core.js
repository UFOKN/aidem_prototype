// Shared map for the explorer (../index.html) and the story experiments
// (../stories/*). Builds the MapLibre map with all data layers and exposes a
// small API to drive it. Pages add their own UI on top.
//
//   import { createMap } from "../../map/core.js";
//   const app = await createMap({ container: "map" });
//   app.setFlood("arrival_first");   // "depth_max", "velocity_max", "arrival_first" or null
//   app.setTime(9.5);                // flood advance clock, hours since start
//   app.play({ to: 12, speed: 1 });  // animate the clock
//   app.setLayer("evac", true);      // see LAYER_GROUPS
//   app.selectZone(2);               // outline a zone (null clears)
//   app.map.flyTo({ ... });          // plain MapLibre for everything else
//   app.on("time", (t) => ...);      // events: time, play, flood, zone, layer
//
// Data paths resolve relative to this file, so pages can live in any folder.

import * as maplibregl from "https://cdn.jsdelivr.net/npm/maplibre-gl@6.15.0/dist/maplibre-gl.mjs";
import * as pmtiles from "https://cdn.jsdelivr.net/npm/pmtiles@4.5.0/+esm";
import * as basemaps from "https://cdn.jsdelivr.net/npm/@protomaps/basemaps@5.7.2/+esm";

export { maplibregl };

const DATA = new URL("../data/", import.meta.url).href;
const ASSETS = new URL("../assets/", import.meta.url).href;
const FLAVOR = "white";

maplibregl.addProtocol("pmtiles", new pmtiles.Protocol().tile);

// ---------------------------------------------------------------------------
// Styling constants (exported so pages can build legends from them)

// color-relief only supports "interpolate" (a "step" silently renders
// nothing), so stepped classes put two stops EPS apart at each break.
// ["elevation"] is the decoded value; NoData is -1 and stays transparent.
const EPS = 0.001;
function stepped(below, ...pairs) {
  const stops = [];
  let prev = below;
  for (let i = 0; i < pairs.length; i += 2) {
    const [value, color] = [pairs[i], pairs[i + 1]];
    stops.push(value - EPS, prev, value, color);
    prev = color;
  }
  return ["interpolate", ["linear"], ["elevation"], ...stops];
}

// Max depth in ft, stepped classes: <2, 2-6, 6-10, 10-20, 20-40, 40+.
export const DEPTH_CLASSES = [
  ["< 2 ft", "#c6dbef", 0], ["2–6", "#9ecae1", 2], ["6–10", "#6baed6", 6],
  ["10–20", "#4292c6", 10], ["20–40", "#2171b5", 20], ["40+", "#084594", 40],
];
const DEPTH_RAMP = stepped("rgba(0,0,0,0)", ...DEPTH_CLASSES.flatMap(([, c, v]) => [v, c]));
const FLOOD_OPACITY = 0.85;

// Max velocity in ft/s, stepped classes: <2, 2-5, 5-10, 10-15, 15+.
// Velocity is very skewed (median ~4.7 ft/s, a few cells near the breach
// above 300), so a linear ramp spends most colours on rare extremes and a log
// one on near-still water. Classes give each band a readable share of the
// flooded area (28/23/25/13/11%) and line up with rough hazard steps: hard to
// wade from ~2 ft/s, people and cars swept from ~5, building damage from ~10.
export const VELOCITY_CLASSES = [
  ["< 2 ft/s", "#feebe2", 0], ["2–5", "#fbb4b9", 2], ["5–10", "#f768a1", 5],
  ["10–15", "#c51b8a", 10], ["15+", "#7a0177", 15],
];
const VELOCITY_RAMP = stepped("rgba(0,0,0,0)", ...VELOCITY_CLASSES.flatMap(([, c, v]) => [v, c]));

// Flood advance: colour cells by first arrival time relative to the current
// time t (hours since simulation start). Cells reached by t are FLOODED,
// the rest are clear.
export const BREACH_HOURS = 8.83; // from the flood files' Read Me
export const FLOODED = "#9ecae1"; // from the max depth ramp, like WATER and RIVER_LINE
const CLEAR = "rgba(0,0,0,0)";
function advanceRamp(t) {
  // The clear stop sits ~1 min past t: an EPS-wide end segment gets lost on
  // the GPU, so cells wet at t = 0 wouldn't show at the start.
  const pts = [[-0.5, CLEAR], [-0.25, FLOODED], [t, FLOODED], [t + 0.02, CLEAR]];
  const stops = [];
  let last = -Infinity;
  for (const [v, c] of pts) {
    if (v <= last) continue; // stops must strictly increase
    stops.push(v, c);
    last = v;
  }
  return ["interpolate", ["linear"], ["elevation"], ...stops];
}

// Evacuation zones, coloured by evacuation order. Triggers from the zones' Read Me.
export const ZONES = {
  1: { color: "#d7301f", trigger: "Evacuate at the start, when overtopping is forecast" },
  2: { color: "#fc8d59", trigger: "Evacuate when dam performance becomes uncertain" },
  3: { color: "#fdcc8a", trigger: "Evacuate shortly before failure" },
};
const zoneColor = ["match", ["get", "Zone"], ...Object.entries(ZONES).flatMap(([z, v]) => [+z, v.color]), "#999"];
// Selected zone: the same hue, darkened, at a stronger fill.
const darken = (hex, k = 0.7) => "#" + hex.slice(1).match(/../g).map((c) => Math.round(parseInt(c, 16) * k).toString(16).padStart(2, "0")).join("");
const zoneColorDark = ["match", ["get", "Zone"], ...Object.entries(ZONES).flatMap(([z, v]) => [+z, darken(v.color)]), "#666"];

// Named groups of layer ids for setLayer().
export const LAYER_GROUPS = {
  evac: ["evac-fill", "evac-selected-fill", "evac-line"],
  buildings: ["buildings"],
  hillshade: ["hillshade"],
  domain: ["domain-outline", "county-label"],
  dam: ["reservoir", "dam"],
  // Cascading impacts (scripts/build_data.py, build_cascade), off unless
  // asked for. Direct: flooded buildings and facilities (tier 1); the
  // buildings come from a small source of their own, cheap enough to show
  // during camera flights (story 1, step 2). Indirect: the ones that lose a
  // service (tiers 2 and 3).
  directImpacts: ["cascade-flooded", "cascade-facilities-direct"],
  indirectImpacts: ["cascade-buildings", "cascade-facilities-indirect"],
};
const OFF_BY_DEFAULT = ["directImpacts", "indirectImpacts"];
// Both facility layers, for clicks and hover.
const FACILITY_LAYERS = ["cascade-facilities-direct", "cascade-facilities-indirect"];

// Cascading impacts. Tiers: 1 primary (flooded, 2 ft for facilities, any
// water for buildings), 2 secondary (lost a service from a failed facility),
// 3 tertiary (lost a service from a facility that failed in tier 2).
// Buildings are shown in their first tier only.
export const IMPACT_TIERS = {
  1: { label: "Flooded", color: "#d81b60" },
  2: { label: "Loss of service", color: "#f57c00" },
  3: { label: "Indirect impact", color: "#43a047" },
};
// Colours of the failed utilities, by what they provide (legend only; the
// cascade arrows are black).
// Service areas themselves are never drawn; their data still gives the
// buildings and people per facility and the story's overview bounds.
export const UTILITY_AREAS = {
  "Gas-Fired Power Plant": { label: "Power (hypothetical plant)", color: "#6a1b9a" },
  "Wastewater Treatment Plants": { label: "Sewer", color: "#00796b" },
  "Public Water System": { label: "Drinking water (potentially at risk)", color: "#37474f", dashed: true },
};
const tierColor = (prop) => ["match", ["get", prop], ...Object.entries(IMPACT_TIERS).flatMap(([t, v]) => [+t, v.color]), "#999"];
const withAlpha = (hex, a) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")}, ${a})`;
// Losses with no time (potential) are lighter: in the colour's alpha rather
// than the opacity, so every impact building shares one opacity and a fade
// (fadeInIndirectBuildings) ends exactly on each one's usual look.
const POTENTIAL_ALPHA = 0.4; // x 0.75 opacity = 0.3
const indirectColor = ["case", ["get", "potential"],
  ["match", ["get", "tier"], ...Object.entries(IMPACT_TIERS).flatMap(([t, v]) => [+t, withAlpha(v.color, POTENTIAL_ALPHA)]), withAlpha("#999999", POTENTIAL_ALPHA)],
  tierColor("tier")];
const SELECTED_OPACITY = 0.9; // buildings of the selected facility
// Impact buildings: hidden until their time (feature state "hidden"), faded
// while a facility's own buildings show (feature state "dim"). k (0-1) is how
// far the dimmed ones have faded, for the cross-fade in showAffectedBuildings.
const DIM_OPACITY = 0.08;
const hiddenOr = (dimmed, normal) => ["case", ["boolean", ["feature-state", "hidden"], false], 0, ["boolean", ["feature-state", "dim"], false], dimmed, normal];
const towardsDim = (v, k) => v + (DIM_OPACITY - v) * k;
const IMPACT_OPACITY = 0.75;
const indirectOpacity = (k = 1) => hiddenOr(towardsDim(IMPACT_OPACITY, k), IMPACT_OPACITY);
const floodedOpacity = indirectOpacity;
const FACILITY_PENDING = "#b0b0b0"; // facilities not yet affected (flood advance)

// Modern dam (built by the pipeline, see DAM_* in scripts/build_data.py),
// drawn abstractly as a translucent wall plus the spillway shape at its NE end.
const DAM_COLOR = "#f0806f";
// Rivers, lakes and the reservoir.
const WATER = "#6baed6";
// River centrelines drawn on top of everything but labels, so the river
// paths stay visible through the flood.
const RIVER_LINE = "#2171b5";

// Hours as H:MM.
export const hm = (h) => `${Math.floor(h)}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;
export const fmt = (n) => n.toLocaleString("en-US");

// ---------------------------------------------------------------------------
// Zone popup

export function zonePopupHtml(p) {
  const z = ZONES[p.Zone] ?? { color: "#999", trigger: "" };
  return `
    <h3><i style="background:${z.color}"></i>Evacuation zone ${p.Zone}</h3>
    <div class="trigger">${z.trigger}</div>
    <table>
      <tbody>
        <tr><th>Structures flooded</th><td>${fmt(p.All_Struct)}</td></tr>
        <tr><th>&nbsp; of which critical</th><td>${fmt(p.Crt_Struct)}</td></tr>
        <tr><th>Likely to collapse</th><td>${p.All_Collps}%</td></tr>
        <tr><th>&nbsp; critical structures</th><td>${p.Crt_Collps}%</td></tr>
      </tbody>
      <tbody>
        <tr><th>Population at risk (day)</th><td>${fmt(p.PAR_Day)}</td></tr>
        <tr><th>Population at risk (night)</th><td>${fmt(p.PAR_Nght)}</td></tr>
      </tbody>
    </table>
    <table style="margin-top:8px">
      <thead><tr><th class="sub">Life loss</th><th>0–2 h warning</th><th>2–6 h warning</th></tr></thead>
      <tbody>
        <tr><th>Day failure</th><td>${fmt(p.LL_D_Min)}</td><td>${fmt(p.LL_D_Amp)}</td></tr>
        <tr><th>Night failure</th><td>${fmt(p.LL_N_Min)}</td><td>${fmt(p.LL_N_Amp)}</td></tr>
        <tr><th>Indirect</th><td colspan="2">${fmt(p.Ind_LL)}</td></tr>
      </tbody>
    </table>
    <table style="margin-top:8px">
      <tbody>
        <tr><th>Typical depth</th><td>${p.Depth_lowq}–${p.Depth_uppq} ft</td></tr>
        <tr><th>Typical flood arrival</th><td>${p.Arrv_lowq}–${p.Arrv_uppq} h</td></tr>
      </tbody>
    </table>
    <div class="note">Life loss is the mean for one scenario (day or night, warning time); don't add the columns. Typical = 25th–75th percentile.</div>`;
}

/** "8:50 h before the breach" / "0:54 h after the breach" / null without a time. */
export function relativeToBreach(h) {
  if (h == null) return null;
  const m = Math.round(Math.abs(h) * 60); // rounded, like the story pages
  const t = `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} h`;
  return h < 0 ? `${t} before the breach` : `${t} after the breach`;
}

// Readable facility names: the source abbreviates some and writes most in
// capitals. Known abbreviations get a full name, the rest are title-cased.
const FACILITY_NAMES = {
  "DORNICK PT WWTP": "Dornick Point sewage plant",
  "GREATER JOHNSTOWN WA RIVERSIDE": "Greater Johnstown Water Authority (Riverside)",
  "HIGHLAND S & W AUTH BEAVERDAM": "Highland Sewer & Water Authority (Beaverdam)",
  "SOUTHWESTERN CAMBRIA CNTY AUTH": "Southwestern Cambria County Authority",
  "EAST TAYLOR MUNI AUTH": "East Taylor Municipal Authority",
  "WCRO": "WCRO radio", "WLKJ-FM1": "WLKJ radio",
  "FOREST HILLS JSHS": "Forest Hills Junior/Senior High School",
  "GREATER JOHNSTOWN SHS": "Greater Johnstown Senior High School",
  "JOHNSTOWN CCC": "Johnstown Community Corrections Center",
};
export function facilityName(s) {
  if (FACILITY_NAMES[s]) return FACILITY_NAMES[s];
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Jshs|Shs|Ms|Hs|Ctc|Ems|Llc|Inc)\b/g, (w) => ({ Jshs: "JSHS", Shs: "SHS", Ms: "MS", Hs: "HS", Ctc: "CTC", Ems: "EMS", Llc: "LLC", Inc: "Inc" })[w])
    .replace(/\bEl Sch\b/g, "Elementary School").replace(/\bSch\b/g, "School")
    .replace(/\bTwp\b/g, "Township").replace(/\bDlp\b/g, "DLP");
}

export function facilityPopupHtml(p, links = []) {
  const out = links.filter((l) => l.from === p.name);
  const takesOut = out.length
    ? `<tr><th>Takes out</th><td>${out.length} ${out.length === 1 ? "facility" : "facilities"} (${out[0].service})<br><span class="cause">arrows on the map</span></td></tr>`
    : "";
  const tier = IMPACT_TIERS[p.tier];
  const when = relativeToBreach(p.impact_h);
  const what = p.tier === 1
    ? `Flooded, ${p.depth_ft} ft deep`
    : `Loses ${p.services}<br><span class="cause">from ${p.causes}</span>`;
  return `
    <h3><i style="background:${tier.color}"></i>${facilityName(p.name)}</h3>
    <div class="trigger">${p.type}</div>
    <table><tbody>
      <tr><th>${tier.label}</th><td>${what}</td></tr>
      <tr><th>Offline</th><td>${when ?? "no time (potentially at risk)"}</td></tr>
      ${takesOut}
    </tbody></table>
    ${p.impact_h != null && p.impact_h < 0 ? `<div class="note">Before the breach: from the river flows the model starts with.</div>` : ""}`;
}

// ---------------------------------------------------------------------------
// Map

/**
 * @param {object} opts
 * @param {string|HTMLElement} opts.container
 * @param {boolean} [opts.hash=false]       keep the view in the URL (#zoom/lat/lng/...)
 * @param {string|null} [opts.flood="depth_max"]  initial flood layer
 * @param {object} [opts.layers]            initial visibility per LAYER_GROUPS name, e.g. { buildings: false }
 * @param {boolean} [opts.zonePopup=true]   click a zone for its impact summary
 * @param {boolean} [opts.facilityPopup=true] click a facility for a popup; false leaves the details
 *   to the page (listen to the "facility" event, look up with app.facilityInfo(name))
 * @param {boolean} [opts.controls=true]    zoom/compass and scale controls
 * @param {boolean} [opts.compass=true]     the compass (rotation) button in the zoom control
 * @param {boolean} [opts.tooltips=true]    the flood value under the cursor (depth, velocity, arrival)
 * @param {boolean} [opts.facilityClick=true] click a facility to select it (and open its popup)
 * @param {boolean} [opts.facilityNames=false] hovering a facility shows its name
 * @param {boolean|number} [opts.terrain=false]  3D terrain; a number sets the exaggeration
 * @param {object} [opts.mapOptions]        passed through to maplibregl.Map
 */
// Scale bar after the Figma design: a black and a white segment with the
// distances above them, in miles (feet when zoomed in). Measured across the
// middle of the map, like MapLibre's own ScaleControl.
class ScaleBar {
  constructor({ maxWidth = 160 } = {}) {
    this.maxWidth = maxWidth;
  }
  onAdd(map) {
    this.map = map;
    this.el = document.createElement("div");
    this.el.className = "maplibregl-ctrl scale-bar";
    this.update = () => this.render();
    map.on("move", this.update);
    this.render();
    return this.el;
  }
  onRemove() {
    this.map.off("move", this.update);
    this.el.remove();
  }
  render() {
    const map = this.map;
    const y = map.getContainer().clientHeight / 2;
    const feet = map.unproject([0, y]).distanceTo(map.unproject([this.maxWidth, y])) * 3.28084;
    const [unit, total] = feet >= 2640 ? ["mi", feet / 5280] : ["ft", feet];
    const p = 10 ** Math.floor(Math.log10(total));
    const nice = (total / p >= 5 ? 5 : total / p >= 2 ? 2 : 1) * p;
    const num = (v) => String(+v.toFixed(2));
    this.el.style.width = `${Math.round((this.maxWidth * nice) / total)}px`;
    this.el.innerHTML = `<div class="labels"><span>0</span><span>${num(nice / 2)}</span><span>${num(nice)} ${unit}</span></div><div class="bar"><i></i><i></i></div>`;
  }
}

export async function createMap(opts) {
  const {
    container, hash = false, flood = "depth_max", layers = {},
    zonePopup = true, facilityPopup: useFacilityPopup = true, controls = true, terrain = false, mapOptions = {},
    compass = true, tooltips = true, facilityClick = true, facilityNames = false,
  } = opts;

  const empty = { type: "FeatureCollection", features: [] };
  const [domain, rasters, zones, impactAreas, impactBuildings, impactFacilities, impactLinks] = await Promise.all([
    fetch(DATA + "domain.json").then((r) => r.json()),
    fetch(DATA + "rasters.json").then((r) => r.json()),
    fetch(DATA + "evacuation_zones.geojson").then((r) => r.json()),
    fetch(DATA + "cascade_service_areas.geojson").then((r) => (r.ok ? r.json() : empty)).catch(() => empty),
    fetch(DATA + "cascade_buildings.geojson").then((r) => (r.ok ? r.json() : empty)).catch(() => empty),
    fetch(DATA + "cascade_facilities.geojson").then((r) => (r.ok ? r.json() : empty)).catch(() => empty),
    fetch(DATA + "cascade_links.geojson").then((r) => (r.ok ? r.json() : empty)).catch(() => empty),
  ]);
  let selectedFacility = null;
  const linksOf = (name) => impactLinks.features.map((f) => f.properties).filter((l) => l.from === name || l.to === name);
  const floodedBuildings = { type: "FeatureCollection", features: impactBuildings.features.filter((f) => f.properties.tier === 1) };

  // The map is limited to the flood model's extent (the flood rasters'
  // footprint) plus 10%, which is also where the detailed terrain reaches,
  // widened to take in the service areas of the cascading impacts.
  const [fw, fs, fe, fn] = Object.values(rasters)[0].bounds;
  const [padX, padY] = [(fe - fw) * 0.1, (fn - fs) * 0.1];
  let [w, s, e, n] = [fw - padX, fs - padY, fe + padX, fn + padY];
  for (const f of impactAreas.features) {
    for (const [x, y] of f.geometry.coordinates.flat(f.geometry.type === "Polygon" ? 1 : 2)) {
      [w, s, e, n] = [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)];
    }
  }
  const visibleAt = (group) => (layers[group] ?? !OFF_BY_DEFAULT.includes(group) ? "visible" : "none");

  // Basemap flavor (Protomaps), with our water colour.
  const flavor = { ...basemaps.namedFlavor(FLAVOR), water: WATER };
  // The basemap's sparse OSM buildings are replaced with Overture footprints.
  const baseLayers = basemaps.layers("protomaps", flavor, { lang: "en" }).filter((l) => l.id !== "buildings");
  // Hillshade goes on land/landuse, under water, roads and buildings.
  const firstWater = baseLayers.findIndex((l) => l.id.startsWith("water"));
  // Data layers go below the first basemap label layer.
  const firstLabel = baseLayers.findIndex((l) => l.type === "symbol");
  // Rivers and other water areas sit above the flood, below buildings.
  const WATER_ON_TOP = ["water", "water_stream", "water_river"];
  // Flood layers drawn over the rivers and reservoir instead (still under the river-path line).
  const OVER_WATER = ["depth_max", "velocity_max"];

  const ramps = { depth_max: DEPTH_RAMP, velocity_max: VELOCITY_RAMP, arrival_first: advanceRamp(0) };
  const rasterSources = {};
  const rasterLayers = [];
  for (const [id, r] of Object.entries(rasters)) {
    rasterSources[id] = {
      type: "raster-dem",
      url: "pmtiles://" + new URL(r.url, new URL("../", import.meta.url)).href,
      encoding: r.encoding,
      redFactor: r.redFactor,
      greenFactor: r.greenFactor,
      blueFactor: r.blueFactor,
      baseShift: r.baseShift,
      tileSize: r.tileSize,
    };
    rasterLayers.push({
      id,
      type: "color-relief",
      source: id,
      layout: { visibility: id === flood ? "visible" : "none" },
      paint: {
        "color-relief-color": ramps[id] ?? DEPTH_RAMP,
        // "linear" blends between data cells; "nearest" shows hard cells like QGIS.
        resampling: "linear",
        "color-relief-opacity": FLOOD_OPACITY,
        "color-relief-opacity-transition": { duration: 0, delay: 0 }, // fadeIn() animates it
      },
    });
  }

  const map = new maplibregl.Map({
    container,
    hash,
    // Without a hash in the URL, start on the whole flood extent.
    bounds: [fw, fs, fe, fn],
    fitBoundsOptions: { padding: 40 },
    attributionControl: { compact: false }, // full text, styled in core.css
    maxBounds: [[w, s], [e, n]],
    ...(terrain ? { maxPitch: 75 } : {}),
    ...mapOptions,
    style: {
      version: 8,
      glyphs: ASSETS + "fonts/{fontstack}/{range}.pbf",
      sprite: ASSETS + "sprites/v4/" + FLAVOR,
      sources: {
        protomaps: {
          type: "vector",
          url: "pmtiles://" + DATA + "basemap.pmtiles",
          attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
        },
        buildings: {
          type: "vector",
          url: "pmtiles://" + DATA + "buildings.pmtiles",
          attribution: '<a href="https://docs.overturemaps.org/attribution">© Overture Maps Foundation</a>',
        },
        terrain: {
          type: "raster-dem",
          url: "pmtiles://" + DATA + "terrain.pmtiles",
          encoding: "terrarium",
          tileSize: 512,
          attribution: '<a href="https://mapterhorn.com/attribution">© Mapterhorn</a> (USGS 3DEP)',
        },
        "terrain-3d": {
          type: "raster-dem",
          url: "pmtiles://" + DATA + "terrain.pmtiles",
          encoding: "terrarium",
          tileSize: 512,
        },
        domain: { type: "geojson", data: DATA + "domain.geojson" },
        // tolerance 0: the default simplification drops holes at low zoom and
        // fills in hills that the zones wrap around. Already simplified in the pipeline.
        evac: { type: "geojson", data: zones, tolerance: 0 },
        dam: { type: "geojson", data: DATA + "dam.geojson", tolerance: 0 },
        reservoir: { type: "geojson", data: DATA + "reservoir.geojson" },
        // Feature ids are the feature's index (generateId), for the
        // feature state that hides them until their impact time.
        "impact-buildings": { type: "geojson", data: impactBuildings, generateId: true },
        "impact-facilities": { type: "geojson", data: impactFacilities, generateId: true },
        "impact-flooded": { type: "geojson", data: floodedBuildings, generateId: true },
        "selected-buildings": { type: "geojson", data: empty },
        ...rasterSources,
      },
      ...(terrain ? { terrain: { source: "terrain-3d", exaggeration: terrain === true ? 1 : terrain } } : {}),
      layers: [
        ...baseLayers.slice(0, firstWater),
        {
          id: "hillshade",
          type: "hillshade",
          source: "terrain",
          layout: { visibility: visibleAt("hillshade") },
          paint: {
            "hillshade-method": "igor",
            "hillshade-exaggeration": 0.25,
            "hillshade-shadow-color": "rgba(40,45,55,0.9)",
            "hillshade-highlight-color": "rgba(255,255,255,0.6)",
            "hillshade-accent-color": "rgba(0,0,0,0)",
          },
        },
        ...baseLayers.slice(firstWater, firstLabel).filter((l) => !WATER_ON_TOP.includes(l.id)),
        ...rasterLayers.filter((l) => !OVER_WATER.includes(l.id)),
        ...baseLayers.filter((l) => WATER_ON_TOP.includes(l.id)),
        {
          id: "reservoir", type: "fill", source: "reservoir",
          layout: { visibility: visibleAt("dam") },
          paint: { "fill-color": WATER },
        },
        ...rasterLayers.filter((l) => OVER_WATER.includes(l.id)),
        {
          id: "evac-fill", type: "fill", source: "evac",
          layout: { visibility: visibleAt("evac") },
          paint: { "fill-color": zoneColor, "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.5, 0.3] },
        },
        {
          id: "evac-selected-fill", type: "fill", source: "evac", filter: ["==", ["id"], -1],
          layout: { visibility: visibleAt("evac") },
          paint: { "fill-color": zoneColorDark, "fill-opacity": 0.5 },
        },
        {
          id: "evac-line", type: "line", source: "evac",
          layout: { visibility: visibleAt("evac") },
          paint: { "line-color": zoneColor, "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.5, 1.2] },
        },
        {
          id: "dam", type: "fill-extrusion", source: "dam", filter: ["in", ["get", "kind"], ["literal", ["body", "spill"]]],
          layout: { visibility: visibleAt("dam") },
          paint: {
            "fill-extrusion-color": DAM_COLOR,
            "fill-extrusion-opacity": 0.6,
            "fill-extrusion-vertical-gradient": false,
            // Heights are above the ground at each slice: with 3D terrain
            // MapLibre stands each slice on the terrain; the f* values use
            // smoothed ground, for the flat map.
            "fill-extrusion-base": ["get", terrain ? "base" : "fbase"],
            "fill-extrusion-height": ["get", terrain ? "height" : "fheight"],
          },
        },
        {
          // Overture buildings as semi-translucent extrusions; tilt to see 3D.
          // Heights are in metres; without a height, floors x 3 m, else 6 m.
          id: "buildings",
          type: "fill-extrusion",
          source: "buildings",
          "source-layer": "building",
          minzoom: 13,
          filter: ["!=", ["get", "is_underground"], true],
          layout: { visibility: visibleAt("buildings") },
          paint: {
            "fill-extrusion-color": "#fff",
            // ["*", null, 3] gives 0 rather than null, so guard num_floors explicitly.
            "fill-extrusion-height": [
              "coalesce",
              ["get", "height"],
              ["case", ["has", "num_floors"], ["*", ["get", "num_floors"], 3], 6],
            ],
            "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
            "fill-extrusion-opacity": 0.3,
          },
        },
        {
          // Buildings that lose a service, one dot each, in their first tier
          // (the flooded ones are cascade-flooded, drawn above). Above the 3D
          // buildings, so the extrusions don't cover them.
          id: "cascade-buildings", type: "circle", source: "impact-buildings", filter: [">=", ["get", "tier"], 2],
          layout: { visibility: visibleAt("indirectImpacts"), "circle-sort-key": ["-", 0, ["get", "tier"]] },
          paint: {
            "circle-color": indirectColor,
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 12, 1.6, 15, 3.5],
            // Hidden until its impact time (feature state, see syncCascadeTime)
            "circle-opacity": indirectOpacity(),
          },
        },
        {
          id: "cascade-flooded", type: "circle", source: "impact-flooded",
          layout: { visibility: visibleAt("directImpacts") },
          paint: {
            "circle-color": IMPACT_TIERS[1].color,
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 12, 1.6, 15, 3.5],
            "circle-opacity": floodedOpacity(),
          },
        },
        {
          id: "river-path", type: "line", source: "protomaps", "source-layer": "water",
          minzoom: 9, filter: ["==", ["get", "kind"], "river"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": RIVER_LINE, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.75, 14, 1.5, 18, 3] },
        },
        ...baseLayers.slice(firstLabel),
        {
          id: "domain-outline",
          type: "line",
          source: "domain",
          layout: { visibility: visibleAt("domain") },
          paint: { "line-color": "#333", "line-width": 1.5, "line-dasharray": [3, 2] },
        },
        {
          // County names (the map domain is Cambria County and two neighbours).
          id: "county-label", type: "symbol", source: "domain", maxzoom: 13,
          filter: ["==", ["geometry-type"], "Point"],
          layout: {
            visibility: visibleAt("domain"),
            "text-field": ["get", "county"],
            "text-font": ["Noto Sans Medium"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 7, 11, 12, 16],
            "text-transform": "uppercase",
            "text-letter-spacing": 0.12,
          },
          paint: { "text-color": "#555", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.5 },
        },
        // Buildings the selected facility affects (selectFacility, loaded from
        // data/cascade_by_provider): shown at full strength while the other
        // impact buildings fade.
        {
          id: "cascade-selected-buildings", type: "circle", source: "selected-buildings",
          layout: { visibility: "none", "circle-sort-key": ["-", 0, ["get", "tier"]] }, // nearer tiers on top
          paint: {
            "circle-color": tierColor("tier"),
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1, 12, 2, 15, 4],
            "circle-opacity": SELECTED_OPACITY,
          },
        },
        // Affected facilities, above the labels so they stay clickable: direct
        // (flooded) and indirect (lose a service) as separate layers.
        ...[["cascade-facilities-direct", "directImpacts", ["==", ["get", "tier"], 1]],
          ["cascade-facilities-indirect", "indirectImpacts", [">=", ["get", "tier"], 2]]].map(([id, group, filter]) => ({
          id, type: "circle", source: "impact-facilities", filter,
          layout: { visibility: visibleAt(group), "circle-sort-key": ["-", 0, ["get", "tier"]] },
          paint: {
            // Always shown; grey until its impact time in flood advance
            // (feature state "pending", see syncCascadeTime).
            "circle-color": ["case", ["boolean", ["feature-state", "pending"], false], FACILITY_PENDING, tierColor("tier")],
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 4, 14, 7],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 1.5,
            "circle-opacity": ["case", ["boolean", ["feature-state", "pending"], false], 1, ["==", ["get", "certainty"], "potential"], 0.35, 1],
          },
        })),
        {
          // Rings around the selected facility and the ones linked to it.
          id: "cascade-linked", type: "circle", source: "impact-facilities", filter: ["in", ["get", "name"], ["literal", []]],
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 7, 14, 10],
            "circle-color": "rgba(0,0,0,0)",
            "circle-stroke-color": "#000000",
            "circle-stroke-width": 1.5,
          },
        },
      ],
    },
  });



  if (controls) {
    map.addControl(new maplibregl.NavigationControl({ showCompass: compass }), "top-right");
    map.addControl(new ScaleBar(), "bottom-left");
  }
  window.map = map; // handy in the console
  await new Promise((resolve) => map.once("load", resolve));

  // --- API -----------------------------------------------------------------
  const events = new EventTarget();
  const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));
  const setVisible = (id, on) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  };

  const maxHours = Math.ceil(rasters.arrival_first?.max ?? 18);
  let floodId = flood, time = 0, raf = null;

  // closeOnClick is off: its map click listener also fires on the click that
  // opens the popup on another zone, closing it again. Handled below instead.
  const popup = new maplibregl.Popup({ className: "zone-popup", maxWidth: "300px", closeOnClick: false });
  let selectedZone = null;

  // Raster values under the cursor: read the flood layer's own PMTiles at
  // maxzoom and decode the pixel (same encoding the map uses for colours).
  const archives = {};
  // Least recently used first. A decoded tile is ~1 MB; the cursor is
  // usually over 1-4 tiles, so a dozen is plenty.
  const TILE_CACHE = 12;
  const tiles = new Map(); // "id/z/x/y" -> Promise<ImageData|null>
  function rasterTile(id, z, x, y) {
    const key = `${id}/${z}/${x}/${y}`;
    const hit = tiles.get(key);
    if (hit) {
      tiles.delete(key); // move to the back: most recently used
      tiles.set(key, hit);
      return hit;
    }
    archives[id] ??= new pmtiles.PMTiles(new URL(rasters[id].url, new URL("../", import.meta.url)).href);
    const tile = archives[id].getZxy(z, x, y).then(async (res) => {
      if (!res) return null;
      const bmp = await createImageBitmap(new Blob([res.data], { type: "image/webp" }),
        { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, bmp.width, bmp.height);
    }).catch(() => null);
    tiles.set(key, tile);
    if (tiles.size > TILE_CACHE) tiles.delete(tiles.keys().next().value); // least recently used
    return tile;
  }

  // Tooltip with the value under the cursor, for these flood layers.
  const TOOLTIPS = {
    depth_max: (v) => `Depth: ${v.toFixed(1)} ft`,
    velocity_max: (v) => `Velocity: ${v.toFixed(1)} ft/s`,
    arrival_first: (v) => `Flooded: ${hm(Math.max(0, v))} h`,
  };
  const tooltip = new maplibregl.Popup({ className: "value-tip", closeButton: false, closeOnClick: false, offset: 12, anchor: "left" });

  const app = {
    map, maplibregl, domain, rasters, zones, impactAreas, maxHours,

    on(type, fn) {
      const h = (e) => fn(e.detail);
      events.addEventListener(type, h);
      return () => events.removeEventListener(type, h);
    },

    /**
     * Show one flood layer ("depth_max", "velocity_max", "arrival_first") or
     * none (null). With { fade: true } it fades in instead of appearing at once.
     */
    setFlood(id, { fade = false } = {}) {
      Object.keys(rasters).forEach((r) => setVisible(r, r === id));
      if (fade && id && id !== floodId) fadeIn(id);
      else if (id) fadeIn(id, 0);
      if (id !== "arrival_first") app.pause();
      floodId = id;
      syncCascadeTime();
      emit("flood", id);
    },
    get flood() { return floodId; },

    /** Flood advance clock, in hours since simulation start. */
    setTime(t) {
      time = Math.max(0, Math.min(maxHours, t));
      map.setPaintProperty("arrival_first", "color-relief-color", advanceRamp(time));
      syncCascadeTime();
      emit("time", time);
    },
    get time() { return time; },

    /**
     * Animate the clock from the current time. Resolves when it reaches `to`
     * or is paused. speed is simulated hours per real second.
     */
    play({ to = maxHours, speed = 0.5 } = {}) {
      app.pause();
      if (time >= to) app.setTime(0);
      return new Promise((resolve) => {
        let last = performance.now();
        const frame = (now) => {
          const t = Math.min(to, time + (Math.max(0, now - last) / 1000) * speed);
          last = now;
          app.setTime(t);
          if (t >= to) { app.pause(); return; }
          raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        app._resolvePlay = resolve;
        emit("play", true);
      });
    },
    pause() {
      if (raf) cancelAnimationFrame(raf);
      const wasPlaying = raf !== null;
      raf = null;
      app._resolvePlay?.();
      app._resolvePlay = null;
      if (wasPlaying) emit("play", false);
    },
    get playing() { return raf !== null; },

    /** Show or hide a layer group from LAYER_GROUPS. */
    setLayer(name, on) {
      (LAYER_GROUPS[name] ?? [name]).forEach((id) => setVisible(id, on));
      if (name === "evac" && !on) popup.remove();
      emit("layer", { name, on });
    },

    /**
     * Outline a zone (1-3), or clear with null. With { popup: lngLat } also
     * opens its impact summary there.
     */
    selectZone(zone, { popup: at } = {}) {
      // Moving an open popup fires its "close" (which clears the selection),
      // so handle the popup before setting the selection.
      if (zone == null || !at) popup.remove();
      if (zone != null && at) popup.setLngLat(at).setHTML(zonePopupHtml(app.zoneStats(zone))).addTo(map);
      selectedZone = zone;
      map.setFilter("evac-selected-fill", ["==", ["id"], zone ?? -1]);
      emit("zone", zone);
    },
    get zone() { return selectedZone; },

    /**
     * Show the failure cascade of a facility (by name), two levels deep: the
     * facilities it took out and, in turn, the ones those took out, with the
     * buildings each of them leaves without a service (the other impact
     * buildings fade). Arrows run from the providers it depends on and along
     * both levels, with rings around the facilities. null clears it.
     * With { buildings: false } the buildings wait for showAffectedBuildings().
     */
    selectFacility(name, { buildings = true } = {}) {
      if (name === selectedFacility) return;
      selectedFacility = name;
      applySelection(buildings);
      emit("facility", name);
    },
    get facility() { return selectedFacility; },

    /**
     * Cascades on or off. Off (story 1 before the cascade is calculated), a
     * selected facility gets its ring but no arrows or affected buildings.
     * Turning them on applies them to the current selection.
     */
    setCascades(on, { buildings = true } = {}) {
      cascadesOn = on;
      if (selectedFacility) applySelection(buildings);
    },
    get cascades() { return cascadesOn; },

    /** Draw the selected facility's arrows k (0-1) of the way along. */
    setLinkProgress(k) {
      linkProgress = Math.max(0, Math.min(1, k));
      drawLinks();
    },

    /**
     * Fade the buildings that lose a service (the indirect impacts layer) in
     * over `ms`, with a plain opacity up to the usual one (IMPACT_OPACITY; a
     * plain number is cheap to change every frame, an expression makes
     * MapLibre rebuild all the dots), then the layer's own styling (hidden
     * until their time) comes back.
     */
    async fadeInIndirectBuildings(ms = 1200) {
      const id = "cascade-buildings";
      map.setPaintProperty(id, "circle-opacity-transition", { duration: 0, delay: 0 }); // animated frame by frame
      map.setPaintProperty(id, "circle-opacity", 0);
      map.setLayoutProperty(id, "visibility", "visible");
      const t0 = performance.now();
      await new Promise((resolve) => {
        const frame = (now) => {
          const k = Math.min(1, Math.max(0, (now - t0) / ms));
          map.setPaintProperty(id, "circle-opacity", IMPACT_OPACITY * k);
          if (k < 1) requestAnimationFrame(frame); else resolve();
        };
        requestAnimationFrame(frame);
      });
      map.setPaintProperty(id, "circle-opacity", indirectOpacity(dimFade));
    },

    /** Turn the reader's map controls (pan, zoom, rotate) on or off. */
    setInteractive(on) {
      for (const h of ["scrollZoom", "boxZoom", "dragRotate", "dragPan", "keyboard", "doubleClickZoom", "touchZoomRotate"]) map[h][on ? "enable" : "disable"]();
    },

    /** Show the selected facility's buildings, fading in over `fade` ms. */
    showAffectedBuildings({ fade = 0 } = {}) {
      return showAffectedBuildings(affectedNames, fade);
    },

    /**
     * A facility's details by name: its properties, its links (from and to
     * other facilities) and its service area's properties (buildings and
     * people that lose its service), if it has one.
     */
    facilityInfo(name) {
      const feature = impactFacilities.features.find((f) => f.properties.name === name);
      if (!feature) return null;
      const area = impactAreas.features.find((f) => f.properties.name === name)?.properties ?? null;
      return { ...feature.properties, lngLat: feature.geometry.coordinates, links: linksOf(name), area };
    },

    /**
     * Value of a raster layer at a point (e.g. ft/s for "velocity_max"),
     * or null where it has no data. Async: may fetch a tile.
     */
    async valueAt(id, lngLat) {
      const r = rasters[id];
      if (!r) return null;
      const { lng, lat } = maplibregl.LngLat.convert(lngLat);
      const n = 2 ** r.maxzoom;
      const xf = ((lng + 180) / 360) * n;
      const rad = (lat * Math.PI) / 180;
      const yf = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
      const [x, y] = [Math.floor(xf), Math.floor(yf)];
      const img = await rasterTile(id, r.maxzoom, x, y);
      if (!img) return null;
      const px = Math.min(img.width - 1, Math.floor((xf - x) * img.width));
      const py = Math.min(img.height - 1, Math.floor((yf - y) * img.height));
      const i = (py * img.width + px) * 4;
      const v = img.data[i] * r.redFactor + img.data[i + 1] * r.greenFactor + img.data[i + 2] * r.blueFactor - r.baseShift;
      return Math.abs(v - r.nodata) < 0.01 ? null : v;
    },

    /** Properties of a zone (1-3) from the evacuation zones file. */
    zoneStats(zone) {
      return zones.features.find((f) => f.id === zone)?.properties;
    },

    /** Bounding box [[w, s], [e, n]] of a zone, for map.fitBounds(). */
    zoneBounds(zone) {
      const b = new maplibregl.LngLatBounds();
      const f = zones.features.find((f) => f.id === zone);
      f?.geometry.coordinates.flat(2).forEach((c) => b.extend(c));
      return b.toArray();
    },
  };

  popup.on("close", () => {
    if (selectedZone != null) {
      selectedZone = null;
      map.setFilter("evac-selected-fill", ["==", ["id"], -1]);
      emit("zone", null);
    }
  });
  // Value tooltip: follows the cursor while a layer from TOOLTIPS is shown.
  let hoverSeq = 0;
  map.on("mousemove", async (e) => {
    const seq = ++hoverSeq;
    const fac = facilityNames && facilityAt(e.point);
    if (fac) return tooltip.setLngLat(fac.geometry.coordinates).setHTML(facilityName(fac.properties.name)).addTo(map);
    const format = tooltips && TOOLTIPS[floodId];
    if (!format) return tooltip.remove();
    const v = await app.valueAt(floodId, e.lngLat);
    if (seq !== hoverSeq) return; // a newer move has answered already
    if (v == null) return tooltip.remove();
    tooltip.setLngLat(e.lngLat).setHTML(format(v)).addTo(map);
  });
  map.getCanvas().addEventListener("mouseleave", () => { hoverSeq++; tooltip.remove(); });
  app.on("flood", () => { hoverSeq++; tooltip.remove(); });

  // Facility popup: click an affected facility for what happened to it.
  const facilityPopup = new maplibregl.Popup({ className: "zone-popup", maxWidth: "300px", offset: 8 });
  const facilityLayersOn = () => FACILITY_LAYERS.filter((id) => map.getLayoutProperty(id, "visibility") !== "none");
  const facilityAt = (point) => {
    const on = facilityLayersOn();
    return on.length > 0 && map.queryRenderedFeatures(point, { layers: on }).find((f) => shown(f));
  };
  const shown = () => true; // facilities are always on the map (grey until affected)
  for (const id of FACILITY_LAYERS) map.on("click", id, (e) => {
    if (!facilityClick) return;
    const f = e.features.find(shown);
    if (!f) return;
    if (useFacilityPopup) facilityPopup.setLngLat(f.geometry.coordinates).setHTML(facilityPopupHtml(f.properties, linksOf(f.properties.name))).addTo(map);
    app.selectFacility(f.properties.name);
  });
  // Without the popup, a click elsewhere on the map clears the selection.
  map.on("click", (e) => { if (!useFacilityPopup && selectedFacility && !facilityAt(e.point)) app.selectFacility(null); });
  facilityPopup.on("close", () => app.selectFacility(null));
  for (const id of FACILITY_LAYERS) {
    map.on("mousemove", id, (e) => (map.getCanvas().style.cursor = facilityClick && e.features.some(shown) ? "pointer" : ""));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }
  // With both facility layers off, nothing is left to select.
  app.on("layer", ({ name }) => {
    if (name in LAYER_GROUPS && /Impacts$/.test(name) && !facilityLayersOn().length) { facilityPopup.remove(); app.selectFacility(null); }
  });

  if (zonePopup) {
    map.on("click", (e) => {
      if (facilityAt(e.point)) return; // the facility popup has it
      const hit = map.getLayoutProperty("evac-fill", "visibility") !== "none"
        && map.queryRenderedFeatures(e.point, { layers: ["evac-fill"] })[0];
      if (hit) app.selectZone(hit.id, { popup: e.lngLat });
      else if (selectedZone != null) app.selectZone(null);
    });
    // Hover: stronger fill and outline on the zone under the cursor; the
    // other zones fade back.
    let hovered = null;
    const setHover = (zone) => {
      if (zone === hovered) return;
      if (hovered != null) map.setFeatureState({ source: "evac", id: hovered }, { hover: false });
      if (zone != null) map.setFeatureState({ source: "evac", id: zone }, { hover: true });
      hovered = zone;
      const hover = ["boolean", ["feature-state", "hover"], false];
      map.setPaintProperty("evac-fill", "fill-opacity", ["case", hover, 0.5, zone != null ? 0.08 : 0.3]);
      map.setPaintProperty("evac-line", "line-opacity", ["case", hover, 1, zone != null ? 0.25 : 1]);
      map.getCanvas().style.cursor = zone != null ? "pointer" : "";
    };
    map.on("mousemove", "evac-fill", (e) => setHover(e.features[0]?.id ?? null));
    map.on("mouseleave", "evac-fill", () => setHover(null));
  }

  // Fade a flood layer in from transparent. Done by hand: MapLibre's paint
  // transitions don't redraw a layer that starts at opacity 0.
  let fadeRaf = null;
  function fadeIn(id, duration = 800) {
    cancelAnimationFrame(fadeRaf);
    const t0 = performance.now();
    const frame = (now) => {
      const k = duration > 0 ? Math.min(1, Math.max(0, (now - t0) / duration)) : 1;
      Object.keys(rasters).forEach((r) => map.setPaintProperty(r, "color-relief-opacity", r === id ? FLOOD_OPACITY * k : FLOOD_OPACITY));
      if (k < 1) fadeRaf = requestAnimationFrame(frame);
    };
    frame(t0);
  }

  // Buildings that lose a service from any of the named facilities: one file
  // per provider (data/cascade_by_provider), loaded on demand and merged. The
  // other impact buildings fade (feature state "dim") meanwhile.
  let affectedSeq = 0;
  let affectedNames = [];
  let dimFade = 1; // how far the cross-fade has got (1: the layers' own styling)
  async function showAffectedBuildings(names, fade = 0) {
    const seq = ++affectedSeq;
    const pids = [...new Set(names.map((n) => impactFacilities.features.find((f) => f.properties.name === n)?.properties.provider).filter(Boolean))];
    const on = pids.length > 0; // facilities that provide nothing leave the map as it is
    const files = await Promise.all(pids.map((pid) =>
      fetch(DATA + "cascade_by_provider/" + pid.replace("/", "_") + ".json").then((r) => (r.ok ? r.json() : empty)).catch(() => empty)));
    if (seq !== affectedSeq) return; // another facility was selected meanwhile
    // With a fade, the facility's buildings fade in while the others fade
    // down, together: the facility's buildings are mostly the same dots, so
    // dimming the others first would make the layer dip and come back.
    const crossFade = fade && on;
    const setFade = (k) => {
      // While fading, every impact dot is dimmed alike, so a plain number does
      // (cheap every frame; an expression makes MapLibre rebuild all the dots).
      // Otherwise the other layers only when they change, so a selection
      // doesn't cut into fadeInIndirectBuildings.
      if (k !== 1) {
        map.setPaintProperty("cascade-buildings", "circle-opacity", towardsDim(IMPACT_OPACITY, k));
        map.setPaintProperty("cascade-flooded", "circle-opacity", towardsDim(IMPACT_OPACITY, k));
      } else if (dimFade !== 1) {
        map.setPaintProperty("cascade-buildings", "circle-opacity", indirectOpacity());
        map.setPaintProperty("cascade-flooded", "circle-opacity", floodedOpacity());
      }
      // The facility's own buildings come up faster than the others go down,
      // so the dots both layers share never get lighter on the way.
      map.setPaintProperty("cascade-selected-buildings", "circle-opacity", SELECTED_OPACITY * Math.min(1, 2.5 * k));
      dimFade = k;
    };
    for (const id of ["cascade-buildings", "cascade-flooded", "cascade-selected-buildings"]) {
      map.setPaintProperty(id, "circle-opacity-transition", { duration: 0, delay: 0 }); // animated frame by frame
    }
    setFade(crossFade ? 0 : 1);
    for (const [source, data] of [["impact-buildings", impactBuildings], ["impact-flooded", floodedBuildings]]) {
      data.features.forEach((_, id) => map.setFeatureState({ source, id }, { dim: on }));
    }
    map.getSource("selected-buildings").setData({ type: "FeatureCollection", features: files.flatMap((d) => d.features) });
    map.setLayoutProperty("cascade-selected-buildings", "visibility", on ? "visible" : "none");
    if (!crossFade) return;
    const t0 = performance.now();
    await new Promise((resolve) => {
      const frame = (now) => {
        const k = Math.min(1, (now - t0) / fade);
        if (seq !== affectedSeq) return resolve(); // the next selection takes over (and ends the fade)
        setFade(k);
        if (k < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  // Arrows, rings and affected buildings of the selected facility
  // (selectFacility, setCascades).
  let cascadesOn = true;
  function applySelection(buildings) {
    const name = cascadesOn ? selectedFacility : null;
    const all = impactLinks.features;
    const level1 = name ? [...new Set(all.filter((f) => f.properties.from === name).map((f) => f.properties.to))] : [];
    const links = name
      ? all.filter((f) => f.properties.from === name || f.properties.to === name || (level1.includes(f.properties.from) && f.properties.to !== name))
      : [];
    // Water systems have no location (their plants aren't public): their
    // links are left off the map and only listed in the details.
    selectedLinks = links.filter((f) => f.properties.located);
    drawLinks();
    const names = name ? [...new Set([name, ...selectedLinks.flatMap((f) => [f.properties.from, f.properties.to])])] : selectedFacility ? [selectedFacility] : [];
    map.setFilter("cascade-linked", ["in", ["get", "name"], ["literal", names]]);
    affectedNames = name ? [name, ...level1] : [];
    linkProgress = 1;
    showAffectedBuildings(buildings ? affectedNames : []);
  }

  // Failure cascade of the selected facility (selectFacility): black arrows
  // with a white outline from each provider to the facilities it took out;
  // potential (drinking water) dashed. Drawn as SVG over the map rather than
  // as a map layer: with 3D terrain, MapLibre drapes line layers onto the
  // ground, under the 3D buildings. Each end is projected to the screen
  // (terrain included) on every frame; the line stops at the facility's ring.
  const SVG = "http://www.w3.org/2000/svg";
  const linkSvg = document.createElementNS(SVG, "svg");
  linkSvg.classList.add("cascade-links");
  map.getCanvasContainer().appendChild(linkSvg);
  let selectedLinks = [];
  let linkProgress = 1; // how far along the arrows are drawn (setLinkProgress)
  // Radius of the rings around linked facilities (cascade-linked), plus a gap.
  const ringRadius = (z) => 7 + (Math.min(Math.max(z, 9), 14) - 9) * (3 / 5) + 2;
  function drawLinks() {
    const shown = selectedLinks.filter((f) => !(f.properties.impact_h != null && f.properties.impact_h > (cascadeCutoff ?? Infinity)));
    if (!shown.length) { if (linkSvg.firstChild) linkSvg.replaceChildren(); return; }
    const r = ringRadius(map.getZoom());
    const front = inFront();
    const lines = [], heads = [];
    for (const f of shown) {
      const ends = clipToFront(f.geometry.coordinates, front);
      if (!ends) continue; // all of it behind the camera
      const [a, b] = ends.map((c) => map.project(c));
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 2 * r + 4) continue; // ends too close together to show a line
      const ux = dx / len, uy = dy / len;
      const p = (t) => `${(a.x + ux * t).toFixed(1)},${(a.y + uy * t).toFixed(1)}`;
      const dashed = f.properties.certainty === "potential" ? ' stroke-dasharray="4 3"' : "";
      const end = r + (len - 2 * r) * linkProgress;
      if (end - r < 1) continue; // not started yet
      lines.push(`<path class="casing" d="M${p(r)}L${p(end)}"/><path class="line" d="M${p(r)}L${p(end)}"${dashed}/>`);
      if (end < len / 2) continue; // the arrowhead appears once the line passes the middle
      // Arrowhead at the middle, pointing from provider to facility.
      const mx = a.x + dx / 2, my = a.y + dy / 2, nx = -uy, ny = ux;
      const pt = (along, side) => `${(mx + ux * along + nx * side).toFixed(1)},${(my + uy * along + ny * side).toFixed(1)}`;
      heads.push(`<path class="head" d="M${pt(5, 0)}L${pt(-4, 4)}L${pt(-4, -4)}Z"/>`);
    }
    linkSvg.innerHTML = lines.join("") + heads.join("");
  }
  map.on("render", () => { if (selectedLinks.length) drawLinks(); });

  // map.project() clamps points behind the camera, which would point a line
  // the wrong way when the map is tilted. inFront() returns how far in front
  // of the camera's near cut a point is (metres, along the view direction);
  // clipToFront() shortens a link to the part in front of it.
  function inFront() {
    const c = map.getCenter(), z = map.getZoom(), lat0 = (c.lat * Math.PI) / 180;
    const b = (map.getBearing() * Math.PI) / 180, p = (map.getPitch() * Math.PI) / 180;
    const fwd = [Math.sin(p) * Math.sin(b), Math.sin(p) * Math.cos(b), -Math.cos(p)]; // east, north, up
    const metresPerPx = (40075016.686 * Math.cos(lat0)) / (512 * 2 ** z);
    const fov = (map.getVerticalFieldOfView() * Math.PI) / 180;
    const camDist = (map.getCanvas().clientHeight / 2 / Math.tan(fov / 2)) * metresPerPx;
    const elev0 = map.getCenterElevation();
    return ([lng, lat]) => {
      const e = (lng - c.lng) * 111320 * Math.cos(lat0), n = (lat - c.lat) * 110540;
      const u = (map.queryTerrainElevation([lng, lat]) ?? elev0) - elev0;
      return e * fwd[0] + n * fwd[1] + u * fwd[2] + camDist * 0.9;
    };
  }
  function clipToFront([a, b], front) {
    const fa = front(a), fb = front(b);
    if (fa <= 0 && fb <= 0) return null;
    if (fa > 0 && fb > 0) return [a, b];
    const t = fa / (fa - fb), cut = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    return fa > 0 ? [a, cut] : [cut, b];
  }

  // Cascading impacts follow the flood clock while "Flood advance" is shown:
  // a building or facility appears once its impact time (hours after the
  // dam failure) has passed. Items without a time (potential losses) show
  // from the start. With any other flood layer, or none, everything shows.
  // Done with feature state, which applies at once; changing a data-driven
  // paint property or filter instead rebuilds the tiles in the background
  // and could leave the map behind the clock. Facilities stay on the map,
  // grey until affected.
  const cascadeHidden = { "impact-buildings": [], "impact-facilities": [], "impact-flooded": [] };
  const cascadeData = { "impact-buildings": impactBuildings, "impact-facilities": impactFacilities, "impact-flooded": floodedBuildings };
  let cascadeCutoff;
  function syncCascadeTime() {
    const cutoff = floodId === "arrival_first" ? Math.round((time - BREACH_HOURS) * 100) / 100 : Infinity;
    if (cutoff === cascadeCutoff) return;
    cascadeCutoff = cutoff;
    drawLinks();
    for (const [source, data] of Object.entries(cascadeData)) {
      data.features.forEach((f, id) => {
        const h = f.properties.impact_h;
        const hidden = h != null && h > cutoff;
        if (hidden === (cascadeHidden[source][id] ?? false)) return;
        cascadeHidden[source][id] = hidden;
        // Facilities stay on the map, grey ("pending") until affected.
        map.setFeatureState({ source, id }, source === "impact-facilities" ? { pending: hidden } : { hidden });
      });
    }
  }

  app.setTime(0);
  return app;
}
