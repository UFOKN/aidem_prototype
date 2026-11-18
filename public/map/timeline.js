// The flood time slider (Figma: panel card 559:388), shared by the layer panel and the EM flood toggle.
// A native range input stays on top, invisible, for dragging, keys and screen readers; the track, the
// filled part, the grabber, the breach marker and the time are drawn under it. The time sits right of
// the playhead and moves to the left end of the track when it no longer fits there.
//
//   timelineHtml(maxHours, breachHours)  markup: .timeline (input.time, strong.clock-time) and button.play
//   updateTimeline(root)                 redraw from the input's value (call after setting it)
//   setPlaying(button, on)               play or pause icon
//   watchTimeline(root)                  redraw when the slider's size changes (shown, resized)

const GRABBER = 20; // px: the grabber's width, also the native thumb's, so clicks land under it
const TEXT_PAD = 8; // px between the time and the track's end

const PLAY = `<svg width="11" height="12" viewBox="0 0 11 12" fill="none" aria-hidden="true"><path d="M1.5 1.4v9.2a.5.5 0 0 0 .76.43l7.4-4.6a.5.5 0 0 0 0-.86l-7.4-4.6a.5.5 0 0 0-.76.43Z" fill="black" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PAUSE = `<svg width="11" height="12" viewBox="0 0 11 12" fill="none" aria-hidden="true"><path d="M0.75 1.5C0.75 1.30109 0.829018 1.11032 0.96967 0.96967C1.11032 0.829018 1.30109 0.75 1.5 0.75H3C3.19891 0.75 3.38968 0.829018 3.53033 0.96967C3.67098 1.11032 3.75 1.30109 3.75 1.5V10.5C3.75 10.6989 3.67098 10.8897 3.53033 11.0303C3.38968 11.171 3.19891 11.25 3 11.25H1.5C1.30109 11.25 1.11032 11.171 0.96967 11.0303C0.829018 10.8897 0.75 10.6989 0.75 10.5V1.5ZM6.75 1.5C6.75 1.30109 6.82902 1.11032 6.96967 0.96967C7.11032 0.829018 7.30109 0.75 7.5 0.75H9C9.19891 0.75 9.38968 0.829018 9.53033 0.96967C9.67098 1.11032 9.75 1.30109 9.75 1.5V10.5C9.75 10.6989 9.67098 10.8897 9.53033 11.0303C9.38968 11.171 9.19891 11.25 9 11.25H7.5C7.30109 11.25 7.11032 11.171 6.96967 11.0303C6.82902 10.8897 6.75 10.6989 6.75 10.5V1.5Z" fill="black" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function timelineHtml(maxHours, breachHours) {
  const b = (breachHours / maxHours).toFixed(4);
  return `<div class="timeline-row">
    <div class="timeline" style="--b:${b}">
      <span class="breach-label">Breach</span>
      <div class="track">
        <div class="fill"><i class="grabber"><b></b><b></b></i></div>
        <i class="breach-line"></i>
        <strong class="clock-time"></strong>
      </div>
      <input class="time" type="range" min="0" max="${maxHours}" step="0.01" value="0" aria-label="Time">
    </div>
    <button class="btn play" data-variant="outline" title="Play / pause" aria-label="Play / pause">${PLAY}</button>
  </div>`;
}

export function setPlaying(button, on) {
  button.innerHTML = on ? PAUSE : PLAY;
}

export function updateTimeline(root) {
  const tl = root.querySelector(".timeline");
  if (!tl) return;
  const slider = tl.querySelector("input.time"), text = tl.querySelector(".clock-time");
  const f = +slider.max ? Math.min(1, Math.max(0, +slider.value / +slider.max)) : 0;
  tl.style.setProperty("--f", f);
  const w = tl.clientWidth;
  if (!w) return; // hidden
  const grabberEnd = GRABBER / 2 + f * (w - GRABBER) + GRABBER / 2;
  tl.classList.toggle("text-left", grabberEnd + 6 > w - TEXT_PAD - text.offsetWidth);
}

export function watchTimeline(root) {
  const tl = root.querySelector(".timeline");
  if (tl && typeof ResizeObserver !== "undefined") new ResizeObserver(() => updateTimeline(root)).observe(tl);
}
