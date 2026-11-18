// The scenario summary's sections, shared by the USACE journey's sidebar
// (index.html) and the EM interface's detail pages (em/) so both show the same figures. Each function returns the
// section's tables (no heading); callers wrap them.
//
// zones: the evacuation zones' properties (LifeSim results; each life loss
// figure is a mean for one scenario, so zones add up within a column).
// impacts: cascade_summary.json; useByTier: cascade_use_by_tier.json.
import { BREACH_HOURS, IMPACT_TIERS, clock } from "./map/core.js";

// Flood figures from the flood rasters (computed once from the source GeoTIFFs).
export const FLOOD_FACTS = {
  areaSqMi: 4.9,        // cells with depth > 0
};

const n = (v) => Math.round(v).toLocaleString("en-US");
const row = (label, value, cls = "") => `<tr class="${cls}"><td>${label}</td><td>${value}</td></tr>`;
const total = (zones, k) => zones.reduce((a, p) => a + p[k], 0);
const tierSwatch = (i) => `<i style="background:${IMPACT_TIERS[i].color}${IMPACT_TIERS[i].stroke ? `; box-shadow: inset 0 0 0 1px ${IMPACT_TIERS[i].stroke}` : ""}"></i>`;

// Story 5 leaves out the people in the flood zone (populationAtRisk: false)
// and the figures its Lives at risk section shows (lifeLoss: false: direct
// life loss and likely to collapse).
export function directTables(zones, impacts, { populationAtRisk = true, lifeLoss = true } = {}) {
  const sum = (k) => total(zones, k);
  return `
    ${populationAtRisk ? `<table class="cols">
      <thead><tr><th>Population at risk</th><th></th></tr></thead>
      <tr><td>In the flood zone</td><td>${n(sum("PAR_Day"))}</td></tr>
    </table>` : ""}
    ${lifeLoss ? `<table class="cols">
      <thead><tr><th>Life loss</th><th></th></tr></thead>
      <tr><td>0\u202F–\u202F2 h warning</td><td>${n(sum("LL_D_Min"))}</td></tr>
      <tr><td>2\u202F–\u202F6 h warning</td><td>${n(sum("LL_D_Amp"))}</td></tr>
    </table>` : ""}
    <table>
      ${row("Structures flooded", n(sum("All_Struct")))}
      ${row("of which critical", n(sum("Crt_Struct")), "sub")}
      ${lifeLoss ? row("Likely to collapse", n(sum("All_Collps"))) : ""}
      ${impacts ? row("Facilities flooded (2 ft+)", n(impacts.facilities.primary.first_affected.count)) : ""}
    </table>`;
}

// Cascading impacts, counted once in the first tier where they lose
// something, so the tiers add up; flooded buildings are with the direct impacts.
// The buildings table opens by use: callers handle clicks on .expand
// (see toggleUses).
export function indirectTables(zones, impacts, useByTier) {
  const indirectLifeLoss = total(zones, "Ind_LL");
  if (!impacts) return `<table>${row("Cascading impacts", `<span class="na">not loaded</span>`)}${row("Indirect life loss", n(indirectLifeLoss))}</table>`;
  const first = (tier) => impacts.buildings[tier].first_affected;
  const fac = impacts.facilities;
  const tiers = [["secondary", 2], ["tertiary", 3]];
  const sum = (k) => tiers.reduce((a, [t]) => a + first(t)[k], 0);
  return `
    <table class="cols">
      <thead><tr><th>Impact</th><th>People</th></tr></thead>
      ${tiers.map(([t, i]) => `<tr><td>${tierSwatch(i)}${IMPACT_TIERS[i].label}</td><td>${n(first(t).pop_day)}</td></tr>`).join("")}
      <tr><td>All</td><td>${n(sum("pop_day"))}</td></tr>
    </table>
    <table class="cols expandable">
      <thead><tr><th>Impact</th><th>Buildings</th></tr></thead>
      ${tiers.map(([t, i]) => {
        const uses = useByTier?.[t];
        const toggle = uses ? `<button class="expand" aria-expanded="false" aria-label="Show buildings by use"></button>` : "";
        return `<tr data-tier="${t}"><td>${toggle}${tierSwatch(i)}${IMPACT_TIERS[i].label}</td><td>${n(first(t).count)}</td></tr>`
          + (uses ?? []).map((u) => `<tr class="use" data-tier="${t}" hidden><td>${u.use}</td><td>${n(u.buildings)}</td></tr>`).join("");
      }).join("")}
      <tr><td>All</td><td>${n(sum("count"))}</td></tr>
    </table>
    <table>
      ${row("Facilities losing a service", n(fac.secondary.first_affected.count))}
      ${row("of which hospitals", n(fac.secondary.affected_by_type.Hospitals ?? 0), "sub")}
      ${row("of which schools", n(fac.secondary.affected_by_type.Schools ?? 0), "sub")}
    </table>
    <table class="group">
      ${row("Indirect life loss", n(indirectLifeLoss))}
    </table>`;
}

export function floodTables() {
  const f = FLOOD_FACTS;
  return `
    <table>
      ${row("Location", "South Fork Dam")}
      ${row("Scenario", "Dam failure")}
      ${row("Overtopping starts", clock(0))}
      ${row("Dam breach", clock(BREACH_HOURS))}
      ${row("Flooded area", `${f.areaSqMi} sq mi`)}
    </table>`;
}

/** Click handler for the buildings table: opens or closes a tier's uses. */
export function toggleUses(e) {
  const expand = e.target.closest(".expand");
  if (!expand) return;
  const open = expand.getAttribute("aria-expanded") !== "true", tier = expand.closest("tr").dataset.tier;
  expand.setAttribute("aria-expanded", open);
  for (const tr of expand.closest("table").querySelectorAll(`tr.use[data-tier="${tier}"]`)) tr.hidden = !open;
}
