// Layer panel for the USACE journey and the EM overview. Builds its own DOM and
// stays in sync with the app, so it also works next to code that drives the
// map. Needs panel.css.
//
//   import { createPanel } from "./map/panel.js";
//   createPanel(app);

import { timelineHtml, setPlaying, updateTimeline, watchTimeline } from "./timeline.js";
import { BREACH_HOURS, DEPTH_CLASSES, FLOODED, IMPACT_TIERS, LAYER_GROUPS, UTILITY_AREAS, VELOCITY_CLASSES, ZONES, clock } from "./core.js";

const swatch = (label, color, stroke) => `<span><i style="background:${color}${stroke ? `; box-shadow: inset 0 0 0 1px ${stroke}` : ""}"></i>${label}</span>`;
// A stepped scale (like a risk scale): one bar of class colours, with the
// class limits written under the joins and the unit after the last one.
const scale = (classes, unit) => `<div class="scale"><div class="bar">${classes.map(([, c]) => `<i style="background:${c}"></i>`).join("")}</div>
  <div class="ticks">${classes.slice(1).map(([, , v], i) => `<span style="left:${((i + 1) / classes.length) * 100}%">${v}${i === classes.length - 2 ? ` ${unit}` : ""}</span>`).join("")}</div></div>`;

/** Legend HTML for "depth", "velocity", "advance", "zones", "direct", "flooded", "indirect", "tiers" or "utilities" (use inside a .legend element). */
export function legend(kind) {
  if (kind === "depth") return scale(DEPTH_CLASSES, "ft");
  if (kind === "velocity") return scale(VELOCITY_CLASSES, "ft/s");
  if (kind === "advance") return swatch("Flooded", FLOODED);
  if (kind === "zones") return Object.entries(ZONES).map(([z, v]) => swatch(`Zone ${z}`, v.color)).join("");
  if (kind === "direct") return swatch(IMPACT_TIERS[1].label, IMPACT_TIERS[1].color) + swatch("Not yet affected", "#808080");
  // Flooded buildings and facilities on a flood map (story 3); with the
  // flood advance, facilities are grey until the water reaches them.
  if (kind === "flooded") return swatch("Flooded buildings and facilities", IMPACT_TIERS[1].color);
  if (kind === "flooded-advance") return swatch("Flooded buildings and facilities", IMPACT_TIERS[1].color) + swatch("Facility not yet flooded", "#808080");
  if (kind === "indirect") return swatch(IMPACT_TIERS[2].label, IMPACT_TIERS[2].color, IMPACT_TIERS[2].stroke) + swatch(IMPACT_TIERS[3].label, IMPACT_TIERS[3].color, IMPACT_TIERS[3].stroke);
  if (kind === "impacts") return Object.values(IMPACT_TIERS).map((v) => swatch(v.label, v.color, v.stroke)).join("");
  if (kind === "tiers") return Object.values(IMPACT_TIERS).map((v) => swatch(v.label, v.color, v.stroke)).join("")
    + swatch("Not yet affected", "#808080");
  if (kind === "utilities") return Object.values(UTILITY_AREAS).map((v) => swatch(v.label, v.color)).join("");
  return "";
}

// Impact tiers as stacked blocks with a coloured bar (Figma: Story 1 /
// Step 3, layer panel). Each block shows while its layer group is on.
// Story 4 draws its map legend from these blocks too.
/** One block for a tier ({ label, note?, color }); group ties it to a layer group. */
export const tierItem = (t, group) => `<div class="tier-item"${group ? ` data-group="${group}"` : ""} style="--bar:${t.color}"><strong>${t.label}</strong>${t.note ? `<span>${t.note}</span>` : ""}</div>`;
const tierLegend = () => `<div class="tier-legend">
  ${[[IMPACT_TIERS[1], "directImpacts"], [IMPACT_TIERS[2], "indirectImpacts"], [IMPACT_TIERS[3], "indirectImpacts"]]
    .map(([t, group]) => tierItem(t, group)).join("")}
</div>`;

// oneImpactToggle: a single "Impacts" checkbox for both impact groups (story 5);
// turned on, it shows the groups impactGroups() returns (the story's current ones).
export function createPanel(app, { parent = document.body, evac = true, oneImpactToggle = false, impactGroups = () => ["directImpacts", "indirectImpacts"] } = {}) {
  const el = document.createElement("div");
  el.className = "layer-panel";
  // Two cards (Figma, Story 1 / Step 3): the flood layer, picked with a
  // segmented toggle, and the other layers below it.
  el.innerHTML = `
    <div class="panel-card">
    <section>
      <h2 class="layer-title" data-flood="arrival_first">Flood advance</h2>
      <h2 class="layer-title" data-flood="depth_max">Depth in feet</h2>
      <h2 class="layer-title" data-flood="velocity_max">Velocity in feet per second</h2>
      <div class="legend" data-flood="depth_max">${legend("depth")}</div>
      <div class="legend" data-flood="velocity_max">${legend("velocity")}</div>
      <div class="advance" hidden>${timelineHtml(app.maxHours, BREACH_HOURS)}
      </div>
      <hr class="rule">
      <div class="segmented button-group" role="group" aria-label="Flood layer">
        <button class="btn" data-variant="outline" data-size="xs" data-flood="arrival_first" aria-pressed="false" title="Flood advance over time">Timeline</button>
        <button class="btn" data-variant="outline" data-size="xs" data-flood="depth_max" aria-pressed="false" title="Maximum depth">Depth</button>
        <button class="btn" data-variant="outline" data-size="xs" data-flood="velocity_max" aria-pressed="false" title="Maximum velocity">Velocity</button>
      </div>
    </section>
    </div>
    <div class="panel-card">
    ${evac ? `<section>
      <h2>Layers</h2>
      <label><input type="checkbox" data-group="evac"> Evacuation zones</label>
      <div class="legend" data-group="evac">${legend("zones")}</div>
    </section>` : ""}
    <section>
      ${oneImpactToggle
        // One toggle (story 5, story 4): a switch right of the heading; the whole row toggles
        ? `<label class="group-head"><h2>Impacts</h2><input type="checkbox" class="impacts-toggle switch" role="switch" aria-label="Show impacts"></label>`
        : `<h2>Facilities and buildings</h2>
      <label><input type="checkbox" data-group="directImpacts"> Direct impacts</label>
      <label><input type="checkbox" data-group="indirectImpacts"> Indirect impacts</label>`}
      ${tierLegend()}
    </section>
    </div>`;
  parent.append(el);

  const $ = (sel) => el.querySelector(sel);
  const advance = $(".advance");
  const slider = $(".time");
  const playBtn = $(".play");

  // Flood layer: one at a time, since they share the same area and colours.
  const segments = [...el.querySelectorAll(".segmented button")];
  const syncFlood = (id) => {
    for (const b of segments) b.setAttribute("aria-pressed", b.dataset.flood === id);
    advance.hidden = id !== "arrival_first";
    for (const l of el.querySelectorAll(".legend[data-flood], .layer-title[data-flood]")) l.hidden = l.dataset.flood !== id;
  };
  for (const b of segments) b.addEventListener("click", () => app.setFlood(b.dataset.flood));
  app.on("flood", syncFlood);
  syncFlood(app.flood);

  // Layer groups; a group's legend shows only while the group is on.
  const isOn = (group) => app.map.getLayoutProperty(LAYER_GROUPS[group][0], "visibility") !== "none";
  const syncGroup = (group, on) => {
    const box = el.querySelector(`input[data-group="${group}"]`);
    if (box) box.checked = on;
    for (const leg of el.querySelectorAll(`[data-group="${group}"]:is(.legend, .tier-item)`)) leg.hidden = !on;
  };
  for (const box of el.querySelectorAll("input[data-group]")) {
    syncGroup(box.dataset.group, isOn(box.dataset.group));
    box.addEventListener("change", () => app.setLayer(box.dataset.group, box.checked));
  }
  // The single impacts toggle: on while either group is on
  const impactsBox = $(".impacts-toggle");
  const syncImpacts = () => { if (impactsBox) impactsBox.checked = isOn("directImpacts") || isOn("indirectImpacts"); };
  impactsBox?.addEventListener("change", () => {
    const on = impactsBox.checked; // read once: each setLayer re-syncs the box
    for (const g of ["directImpacts", "indirectImpacts"]) app.setLayer(g, on && impactGroups().includes(g));
  });
  syncImpacts();
  // With one toggle there are no per-group boxes to sync the tier legend at start
  if (impactsBox) for (const g of ["directImpacts", "indirectImpacts"]) syncGroup(g, isOn(g));
  app.on("layer", ({ name, on }) => { syncGroup(name, on); syncImpacts(); });
  // While a facility is selected its impacts stay on: those toggles are locked.
  const syncLock = (name) => {
    for (const box of el.querySelectorAll('input[data-group="directImpacts"], input[data-group="indirectImpacts"], .impacts-toggle')) {
      box.disabled = !!name;
      box.closest("label").classList.toggle("disabled", !!name);
    }
  };
  app.on("facility", syncLock);
  syncLock(app.facility);

  // Clock
  const syncTime = (t) => {
    slider.value = t;
    $(".clock-time").textContent = clock(t);
    updateTimeline(el);
  };
  watchTimeline(el);
  app.on("time", syncTime);
  syncTime(app.time);
  slider.addEventListener("input", () => { app.pause(); app.setTime(+slider.value); });
  app.on("play", (on) => setPlaying(playBtn, on));
  playBtn.addEventListener("click", () => (app.playing ? app.pause() : app.play()));

  return el;
}
