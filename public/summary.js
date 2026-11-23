// Scenario summary shared by the USACE journey's sidebar (story.js) and the
// EM interface's Flooding page (em/), so both show the same figures.
import { BREACH_HOURS, clock } from "./map/core.js";

const FLOODED_AREA_SQ_MI = 4.9; // cells with depth > 0, computed once from the source GeoTIFFs
const row = (label, value) => `<tr><td>${label}</td><td>${value}</td></tr>`;

/** The flood scenario's key facts as a table (no heading; callers wrap it). */
export function floodTables() {
  return `
    <table>
      ${row("Location", "South Fork Dam")}
      ${row("Scenario", "Dam failure")}
      ${row("Overtopping starts", clock(0))}
      ${row("Dam breach", clock(BREACH_HOURS))}
      ${row("Flooded area", `${FLOODED_AREA_SQ_MI} sq mi`)}
    </table>`;
}

/**
 * Click handler for tables whose rows open sub-rows: a button.expand in a row
 * with data-tier opens or closes the tr.use rows of the same tier.
 */
export function toggleUses(e) {
  const expand = e.target.closest(".expand");
  if (!expand) return;
  const open = expand.getAttribute("aria-expanded") !== "true", tier = expand.closest("tr").dataset.tier;
  expand.setAttribute("aria-expanded", open);
  for (const tr of expand.closest("table").querySelectorAll(`tr.use[data-tier="${tier}"]`)) tr.hidden = !open;
}
