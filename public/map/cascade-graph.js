// The failure cascade around one facility as a small vertical tree (Figma
// 509:2453): what it depends on above it, the facility, then what it takes
// out (the people in its service area and the facilities that lose its
// service, each with their own people). Styled like story 4's flood timeline:
// facilities as tier-coloured circles with their type's icon, people as a
// small dot in a quieter line, one sentence per entry, each consequence
// indented under its cause and joined by a grey elbow arrow. Each entry's time
// stands above it, unless the entry above has the same time. Drawn at its
// natural size (text never scales).
import { IMPACT_TIERS, FACILITY_ICONS, impactClock, facilityName } from "./core.js";

const ICON = 10; // facility circle radius (20 px, as story 4's timeline)
const DOT = 5; // people dot radius
const INDENT = 26; // px per step of the cascade (story 4's timeline)
const MAX_W = 329; // the sidebar's content width: longer entries wrap
const ROW = 40; // px from one single-line entry to the next
const TIME = 18; // px for the time line above an entry
const ARROW = "#b5b5b5";
const HEAD = 3.5; // arrowhead arm, px
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const n = (v) => Math.round(v).toLocaleString("en-US");

export function glyph(type) {
  const key = Object.keys(FACILITY_ICONS).find((k) => FACILITY_ICONS[k].types.includes(type));
  if (!key) return "";
  const g = FACILITY_ICONS[key], s = 14 / Math.max(g.w, g.h);
  return `<path d="${g.d}" fill="#fff" transform="translate(${12 - (g.w * s) / 2} ${12 - (g.h * s) / 2}) scale(${s})"/>`;
}

/**
 * SVG markup of the cascade around a facility. info: app.facilityInfo(name);
 * lookup: name => facilityInfo, for the facilities it links to.
 */
export function cascadeGraphSvg(info, lookup) {
  // Entries: a facility ("X floods", "X loses electric power") or the people it serves
  const fac = (p, what, h) => ({ name: p.name, tier: p.tier, text: `${facilityName(p.name)} ${what ?? (p.tier === 1 ? "floods" : `loses ${p.services}`)}`, type: p.type, h: h ?? p.impact_h, kids: [] });
  const ppl = (p, h) => p.area && { name: p.name, tier: Math.min(3, p.tier + 1), people: true, text: `${n(p.area.pop_day)} people lose ${p.area.service}`, h, kids: [] };
  const self = fac(info);
  const ups = info.links.filter((l) => l.to === info.name).map((l) => lookup(l.from)).filter(Boolean).map((p) => fac(p));
  const own = ppl(info, info.impact_h);
  if (own) self.kids.push(own);
  for (const l of info.links.filter((l) => l.from === info.name)) {
    const p = lookup(l.to); if (!p) continue;
    const d = fac(p, `loses ${l.service}`, l.impact_h ?? p.impact_h), dp = ppl(p, d.h);
    if (dp) d.kids.push(dp);
    self.kids.push(d);
  }
  // Layout, top to bottom. Text wraps at word breaks (Inter 16 is ~8.4 px a
  // character, 14 ~7.4 px).
  const size = (e) => (e.people ? 14 : 16), cw = (e) => (e.people ? 7.4 : 8.4), lh = (e) => (e.people ? 20 : 22);
  const r = (e) => (e.people ? DOT : ICON);
  const textX = (e) => r(e) + (e.people ? 6 : 8); // 6 px after a dot, 8 after an icon (2 px more room)
  const wrap = (text, px, w) => {
    const max = Math.max(8, Math.floor(px / w)), lines = [];
    for (const word of text.split(" ")) {
      if (lines.length && (lines[lines.length - 1] + " " + word).length <= max) lines[lines.length - 1] += " " + word;
      else lines.push(word);
    }
    return lines;
  };
  const nodes = [], arrows = [];
  let y = 0, lastTime = null;
  const place = (e, x) => {
    const t = e.h != null ? impactClock(e.h) : null;
    e.time = t && t !== lastTime ? t : null;
    if (t) lastTime = t;
    y += e.time ? TIME : 0;
    e.x = x; e.y = y;
    e.lines = wrap(e.text, MAX_W - x - textX(e), cw(e));
    y += ROW + (e.lines.length - 1) * lh(e);
    nodes.push(e);
  };
  for (const u of ups) { place(u, ICON); arrows.push([u, self]); }
  const tree = (e, x) => {
    place(e, x);
    for (const k of e.kids) { arrows.push([e, k]); tree(k, x + INDENT); }
  };
  tree(self, ups.length ? ICON + INDENT : ICON);
  const width = Math.ceil(Math.max(...nodes.map((e) => e.x + textX(e) + Math.max(...e.lines.map((l) => l.length * cw(e)))))) + 4;
  const top = -ICON - 2;
  const height = y - ROW + ICON + 4 - top;
  // Elbow arrows: from below the cause's circle, a rounded corner, an open head
  // 6 px short of an icon, 4 px of a dot (less half the stroke)
  const arrow = ([a, b]) => {
    const from = a.y + r(a) + 2;
    const tip = b.x - r(b) - (b.people ? 4 : 6) - 0.75;
    const bend = Math.min(6, b.y - from, b.x - a.x);
    return `<path d="M${a.x} ${from}V${b.y - bend}Q${a.x} ${b.y} ${a.x + bend} ${b.y}H${tip}M${tip - HEAD} ${b.y - HEAD}L${tip} ${b.y}L${tip - HEAD} ${b.y + HEAD}"/>`;
  };
  // Each entry links to its facility (people: the facility they depend on):
  // data-facility on a full-width band behind the row (for hover) and on the row
  const band = (e) => {
    const y0 = e.y - (e.time ? TIME : 0) - ROW / 2, y1 = e.y + (e.lines.length - 1) * lh(e) + ROW / 2; // bands meet, so a facility and its people read as one
    return `<rect class="cg-band" data-facility="${esc(e.name)}" x="0" y="${y0}" width="${width}" height="${y1 - y0}"/>`;
  };
  const node = (e) => {
    const t = IMPACT_TIERS[e.tier], x = textX(e);
    const mark = e.people
      ? `<circle r="${DOT}" fill="${t.color}"${t.stroke ? ` stroke="${t.stroke}"` : ""}/>`
      : `<circle r="${ICON}" fill="${t.color}"${t.stroke ? ` stroke="${t.stroke}"` : ""}/><g transform="translate(${-ICON} ${-ICON}) scale(${(2 * ICON) / 24})">${glyph(e.type)}</g>`;
    return `<g class="cg-row" data-facility="${esc(e.name)}" transform="translate(${e.x} ${e.y})">
      ${mark}
      ${e.time ? `<text x="${x}" y="${-ICON - 6}" font-size="13" fill="#555">${e.time}</text>` : ""}
      <text x="${x}" y="${e.people ? 5 : 6}" font-size="${size(e)}" fill="${e.people ? "#666" : "#000"}">${e.lines.map((l, i) => `<tspan x="${x}" dy="${i ? lh(e) : 0}">${esc(l)}</tspan>`).join("")}</text>
    </g>`;
  };
  return `<svg class="cascade-graph" width="${width}" height="${height}" viewBox="0 ${top} ${width} ${height}" role="img" aria-label="Cascade around ${esc(facilityName(info.name))}" font-family="Inter, system-ui, sans-serif">
    <g fill="transparent">${nodes.map(band).join("")}</g>
    <g fill="none" stroke="${ARROW}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${arrows.map(arrow).join("")}</g>
    ${nodes.map(node).join("")}
  </svg>`;
}
