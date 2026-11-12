// Fade through black between story 1 (USACE) and story 3 (EM interface).
// fadeTo(url) fades the page out to black (500 ms), then opens url; the next
// page, if it loads this script in its <head>, fades in from black. A plain
// script (not a module) so the fade-in is set up before the first paint.
(() => {
  const MS = 500, KEY = "aidem-fade-in";
  const style = document.createElement("style");
  style.textContent = `
    html.fade-out body::after, html.fade-in body::after {
      content: ""; position: fixed; inset: 0; z-index: 1000; background: #000000; pointer-events: none;
    }
    html.fade-out body::after { animation: aidem-fade ${MS}ms ease-in both; }
    html.fade-in body::after { animation: aidem-fade ${MS}ms ease-out reverse both; }
    @keyframes aidem-fade { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { html.fade-out body::after, html.fade-in body::after { animation-duration: 1ms; } }`;
  document.head.append(style);
  const root = document.documentElement;
  let arriving = false;
  try { arriving = sessionStorage.getItem(KEY) === "1"; sessionStorage.removeItem(KEY); } catch {}
  if (arriving) {
    // The animation starts at the first paint, which can be seconds away
    // while the stylesheets load, so the overlay goes when it has finished.
    root.classList.add("fade-in");
    const done = () => root.classList.remove("fade-in");
    addEventListener("animationend", (e) => { if (e.animationName === "aidem-fade") done(); });
    addEventListener("load", () => setTimeout(done, MS + 1000)); // in case the animation never runs (hidden tab)
  }
  window.fadeTo = (url) => {
    try { sessionStorage.setItem(KEY, "1"); } catch {}
    root.classList.remove("fade-in");
    root.classList.add("fade-out");
    setTimeout(() => { location.href = url; }, MS);
  };
  // Coming back with the browser's back button restores the black page from
  // the cache: clear it.
  addEventListener("pageshow", (e) => { if (e.persisted) root.classList.remove("fade-out"); });
})();
