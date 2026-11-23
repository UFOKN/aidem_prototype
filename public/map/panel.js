// Layer panel for the USACE journey and the EM overview, plus the flood control
// it shares with the EM page's other maps. Both build their own DOM and follow
// the app's events, so they stay in sync with code that drives the map. Needs
// panel.css.
//
//   import { createPanel, floodControl } from "./map/panel.js";
//   createPanel(app);              // the whole panel
//   floodControl(app, element);    // just the flood layer toggle, legend and clock

import { timelineHtml, setPlaying, updateTimeline, watchTimeline } from "./timeline.js";
import { BREACH_HOURS, DEPTH_CLASSES, IMPACT_TIERS, LAYER_GROUPS, VELOCITY_CLASSES, ZONES, clock } from "./core.js";

const swatch = (label, color) => `<span><i style="background:${color}"></i>${label}</span>`;
// A stepped scale (like a risk scale): one bar of class colours, with the
// class limits written under the joins and the unit after the last one.
const scale = (classes, unit) => `<div class="scale"><div class="bar">${classes.map(([, c]) => `<i style="background:${c}"></i>`).join("")}</div>
  <div class="ticks">${classes.slice(1).map(([, , v], i) => `<span style="left:${((i + 1) / classes.length) * 100}%">${v}${i === classes.length - 2 ? ` ${unit}` : ""}</span>`).join("")}</div></div>`;

/** Legend HTML for "depth", "velocity" or "zones" (use inside a .legend element). */
export function legend(kind) {
  if (kind === "depth") return scale(DEPTH_CLASSES, "ft");
  if (kind === "velocity") return scale(VELOCITY_CLASSES, "ft/s");
  if (kind === "zones") return Object.entries(ZONES).map(([z, v]) => swatch(`Zone ${z}`, v.color)).join("");
  return "";
}

// Impact tiers as stacked blocks with a coloured bar (Figma: Story 1 /
// Step 3, layer panel). Each block shows while its layer group is on.
// The EM page draws its map legend from these blocks too.
/** One block for a tier ({ label, note?, color }); group ties it to a layer group. */
export const tierItem = (t, group) => `<div class="tier-item"${group ? ` data-group="${group}"` : ""} style="--bar:${t.color}"><strong>${t.label}</strong>${t.note ? `<span>${t.note}</span>` : ""}</div>`;
const tierLegend = () => `<div class="tier-legend">
  ${[[IMPACT_TIERS[1], "directImpacts"], [IMPACT_TIERS[2], "indirectImpacts"], [IMPACT_TIERS[3], "indirectImpacts"]]
    .map(([t, group]) => tierItem(t, group)).join("")}
</div>`;

// The flood layers in the toggle's order: id, button label, button title, heading
const FLOOD_LAYERS = [
  ["arrival_first", "Timeline", "Flood advance over time", "Flood advance"],
  ["depth_max", "Depth", "Maximum depth", "Depth in feet"],
  ["velocity_max", "Velocity", "Maximum velocity", "Velocity in feet per second"],
];

/**
 * The flood layer's heading and legend (or the time slider for the flood
 * advance), a rule, and a segmented toggle between the layers (Figma, Story 1 /
 * Step 3). Renders into `root` and follows the app's flood, time and play
 * events. Every [data-flood] child of root shows only with its layer.
 */
export function floodControl(app, root) {
  root.innerHTML = `
    ${FLOOD_LAYERS.map(([id, , , heading]) => `<h2 class="layer-title" data-flood="${id}">${heading}</h2>`).join("")}
    <div class="legend" data-flood="depth_max">${legend("depth")}</div>
    <div class="legend" data-flood="velocity_max">${legend("velocity")}</div>
    <div class="advance" data-flood="arrival_first">${timelineHtml(app.maxHours, BREACH_HOURS)}</div>
    <hr class="rule">
    <div class="segmented button-group" role="group" aria-label="Flood layer">
      ${FLOOD_LAYERS.map(([id, label, title]) => `<button class="btn" data-variant="outline" data-size="xs" data-flood="${id}" aria-pressed="false" title="${title}">${label}</button>`).join("")}
    </div>`;
  const $ = (sel) => root.querySelector(sel);
  const slider = $("input.time"), playBtn = $(".play");

  // One flood layer at a time, since they share the same area and colours.
  const syncFlood = (id) => {
    for (const b of root.querySelectorAll(".segmented button")) b.setAttribute("aria-pressed", b.dataset.flood === id);
    for (const el of root.querySelectorAll(":scope > [data-flood]")) el.hidden = el.dataset.flood !== id;
  };
  for (const b of root.querySelectorAll(".segmented button")) b.addEventListener("click", () => app.setFlood(b.dataset.flood));
  app.on("flood", syncFlood);
  syncFlood(app.flood);

  // Clock
  const syncTime = (t) => {
    slider.value = t;
    $(".clock-time").textContent = clock(t);
    updateTimeline(root);
  };
  watchTimeline(root);
  app.on("time", syncTime);
  syncTime(app.time);
  slider.addEventListener("input", () => { app.pause(); app.setTime(+slider.value); });
  app.on("play", (on) => setPlaying(playBtn, on));
  playBtn.addEventListener("click", () => (app.playing ? app.pause() : app.play()));
}

/**
 * The layer panel: the flood control in one card and a single "Impacts" switch
 * with the tier legend in another. Turned on, the switch shows the impact groups
 * impactGroups() returns (the story's current ones).
 */
export function createPanel(app, { parent = document.body, impactGroups = () => ["directImpacts", "indirectImpacts"] } = {}) {
  const el = document.createElement("div");
  el.className = "layer-panel";
  el.innerHTML = `
    <div class="panel-card"><section class="flood"></section></div>
    <div class="panel-card">
      <section>
        <label class="group-head"><h2>Impacts</h2><input type="checkbox" class="impacts-toggle switch" role="switch" aria-label="Show impacts"></label>
        ${tierLegend()}
      </section>
    </div>`;
  parent.append(el);
  floodControl(app, el.querySelector("section.flood"));

  // The switch is on while either impact group is on; a tier's block shows while its group is on.
  const GROUPS = ["directImpacts", "indirectImpacts"];
  const isOn = (group) => app.map.getLayoutProperty(LAYER_GROUPS[group][0], "visibility") !== "none";
  const box = el.querySelector(".impacts-toggle");
  const sync = () => {
    box.checked = GROUPS.some(isOn);
    for (const g of GROUPS) for (const item of el.querySelectorAll(`.tier-item[data-group="${g}"]`)) item.hidden = !isOn(g);
  };
  box.addEventListener("change", () => {
    const on = box.checked; // read once: each setLayer re-syncs the box
    for (const g of GROUPS) app.setLayer(g, on && impactGroups().includes(g));
  });
  app.on("layer", sync);
  sync();
  // While a facility is selected its impacts stay on: the switch is locked.
  const syncLock = (name) => {
    box.disabled = !!name;
    box.closest("label").classList.toggle("disabled", !!name);
  };
  app.on("facility", syncLock);
  syncLock(app.facility);

  return el;
}
