// The crab loader: Whimsy Loaders, https://www.whimsically.app/loaders, by Sasha. Transcribed from the site's own
// export (a draw function plus a canvas loop) with the pixel table and timings kept as they are: a 15 by 7 pixel
// crab drawn in one colour at varying alpha, claws bobbing, eight legs walking, the eyes blinking once every sixth
// cycle. Draws one still frame and stops when the person asked for reduced motion.
(function () {
  const BODY = [
    [-4, 0], [-3, 0], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [3, 0], [4, 0],
    [-4, -1], [-3, -1], [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1], [3, -1], [4, -1],
    [-4, 1], [-3, 1], [-2, 1], [-1, 1], [0, 1], [1, 1], [2, 1], [3, 1], [4, 1],
    [-3, -2], [-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2], [3, -2],
    [-3, 2], [-2, 2], [-1, 2], [0, 2], [1, 2], [2, 2], [3, 2],
  ];
  const LEFT_CLAW = [[-5, -2], [-6, -2], [-6, -1], [-5, -1], [-6, -3], [-7, -2]];
  const RIGHT_CLAW = [[5, -2], [6, -2], [6, -1], [5, -1], [6, -3], [7, -2]];
  const LEGS = [[-4, 0], [-3, 0.5], [-2, 1], [-1, 1.5], [1, 0], [2, 0.5], [3, 1], [4, 1.5]];

  function drawCrab(ctx, w, hgt, t, rgb) {
    ctx.clearRect(0, 0, w, hgt);
    const h = w > 30 ? 2 : 1, cx = Math.round(w / 2), cy = Math.round(hgt / 2);
    const c = (x, y, a) => { ctx.fillStyle = `rgba(${rgb},${a})`; ctx.fillRect(Math.round(cx + x * h), Math.round(cy + y * h), h, h); };
    BODY.forEach(([x, y]) => c(x, y, 0.62));
    c(-1, -3, 0.72); c(1, -3, 0.72); c(-1, -2, 0.58); c(1, -2, 0.58);
    const blink = Math.floor(t / 2800) % 6 === 0 && t % 2800 < 160;
    if (blink) { ctx.fillStyle = `rgba(${rgb},0.5)`; ctx.fillRect(Math.round(cx - 1.5 * h), Math.round(cy - 3 * h), 2 * h, Math.max(1, Math.round(0.4 * h))); }
    else { c(-1, -3, 0.92); c(1, -3, 0.92); }
    const bob = Math.round(1.5 * Math.sin(0.0018 * t));
    LEFT_CLAW.forEach(([x, y]) => c(x, y, 0.65)); c(-7, -1 + bob, 0.55); c(-7, -3 - bob, 0.45);
    RIGHT_CLAW.forEach(([x, y]) => c(x, y, 0.65)); c(7, -1 + bob, 0.55); c(7, -3 - bob, 0.45);
    [[-5, 0], [-4, -1], [5, 0], [4, -1]].forEach(([x, y]) => c(x, y, 0.58));
    const u = 0.003 * t;
    LEGS.forEach(([bx, ph]) => {
      const phase = u + ph * Math.PI, r = Math.abs(Math.sin(phase)), o = bx < 0 ? -1 : 1;
      const nx = bx + o * Math.round(1 + r), ny = 2 + Math.round(1.2 * Math.sin(phase));
      c(bx, 2, 0.52); c(nx, ny, 0.42 + 0.2 * r);
      if (r > 0.5) c(nx + o, ny + 1, 0.28);
    });
  }

  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const rgbOf = el => { const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(el).color); return m ? `${m[1]},${m[2]},${m[3]}` : "128,128,128"; };

  /** Every canvas.crab on the page: sized to its css box at the device ratio, tinted with its inherited colour. */
  window.startCrabs = function startCrabs() {
    const canvases = [...document.querySelectorAll("canvas.crab")];
    if (!canvases.length) return;
    const dpr = window.devicePixelRatio || 2;
    const items = canvases.map(cv => {
      const w = cv.clientWidth || 16, hgt = cv.clientHeight || 14;
      cv.width = w * dpr; cv.height = hgt * dpr;
      const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
      return { ctx, w, hgt, rgb: rgbOf(cv) };
    });
    const t0 = performance.now();
    const frame = () => { const t = performance.now() - t0; items.forEach(it => drawCrab(it.ctx, it.w, it.hgt, t, it.rgb)); };
    frame();
    if (still.matches) return;
    (function loop() { frame(); requestAnimationFrame(loop); })();
  };
  window.drawCrab = drawCrab;
})();
