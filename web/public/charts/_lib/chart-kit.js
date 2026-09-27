// Small helpers shared by chart pages. Load after d3:
//   <script src="/charts/_lib/chart-kit.js"></script>
// Everything is optional; a chart page can ignore this file entirely.
(function () {
  const css = getComputedStyle(document.documentElement);

  window.RefugeChart = {
    /** A brand token from /brand.css, e.g. color('--chart-model'). */
    color: name => css.getPropertyValue(name).trim(),

    /** SVG path for a horizontal bar from x0, rounded at the data end only. */
    hbar(x0, y, w, h, r = 4) {
      r = Math.min(r, w / 2, h / 2);
      return `M${x0},${y}H${x0 + w - r}Q${x0 + w},${y} ${x0 + w},${y + r}V${y + h - r}Q${x0 + w},${y + h} ${x0 + w - r},${y + h}H${x0}Z`;
    },

    /** Shortens an SVG text node with "…" until it fits maxWidth (put the full text in a tooltip). */
    fitText(node, maxWidth) {
      const full = node.textContent;
      let n = full.length;
      while (n > 1 && node.getComputedTextLength() > maxWidth) node.textContent = full.slice(0, --n).trimEnd() + '…';
    },

    /** Calls draw(width) now and again whenever the page width changes, so text stays 1:1. */
    onWidth(draw) {
      let last = 0;
      const run = () => {
        const w = Math.round(document.body.clientWidth);
        if (w && w !== last) { last = w; draw(w); }
      };
      // Wait for web fonts so text measured while drawing uses the real font.
      document.fonts.ready.then(() => {
        new ResizeObserver(run).observe(document.body);
        run();
      });
    },

    /** Tells the site how tall this page is, so its frame fits exactly. */
    reportHeight() {
      const send = () => parent.postMessage({ type: 'refuge:height', height: document.body.getBoundingClientRect().height }, '*');
      new ResizeObserver(send).observe(document.body);
    },

    /** Hover tooltip. show(event, html) near the pointer; hide() on leave. */
    tooltip() {
      const el = document.createElement('div');
      el.className = 'rc-tip';
      el.hidden = true;
      document.body.appendChild(el);
      return {
        show(event, html) {
          el.innerHTML = html;
          el.hidden = false;
          const pad = 12, w = el.offsetWidth, h = el.offsetHeight;
          let x = event.clientX + pad, y = event.clientY + pad;
          if (x + w > innerWidth - 4) x = event.clientX - w - pad;
          if (y + h > innerHeight - 4) y = event.clientY - h - pad;
          el.style.left = Math.max(4, x) + 'px';
          el.style.top = Math.max(4, y) + 'px';
        },
        hide() { el.hidden = true; },
      };
    },
  };

  const style = document.createElement('style');
  style.textContent = `
    .rc-tip { position: fixed; z-index: 10; pointer-events: none; max-width: 260px;
      padding: 8px 10px; border-radius: 6px; font: 12px/1.45 var(--font-body);
      background: #151c2a; color: var(--cream); border: 1px solid var(--border);
      box-shadow: 0 4px 14px rgba(0,0,0,0.35); }
    .rc-tip b { font-family: var(--font-display); font-weight: 600; }
    .rc-tip .muted { color: var(--fg-muted); }
    .rc-axis text { fill: var(--chart-axis); font: 11px var(--font-body); }
    .rc-axis line, .rc-axis path { stroke: var(--chart-grid); }
    .rc-label { fill: var(--cream); font: 12px var(--font-body); }
    .rc-muted { fill: var(--fg-muted); font: 11px var(--font-body); }
  `;
  document.head.appendChild(style);
})();
