// Living topographic backdrop, a straight port of the game's
// TopoBackground: faint gold contour lines traced from a 3D value-noise
// field whose time axis creeps forward, so the terrain slowly breathes
// behind the shell exactly as it does behind the site. Self-contained,
// throttled to ~20fps, paused while hidden, static under reduced motion.
// Wrapped in an IIFE because it shares the page's global scope with app.js.
(() => {
  const canvas = document.getElementById("topo") as HTMLCanvasElement | null;
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;

  const CELL = 26;
  const LEVELS = [0.34, 0.42, 0.5, 0.58, 0.66, 0.74];
  const INDEX_EVERY = 3;
  const SPEED = 0.05;
  const DRIFT_X = 1.4;
  const DRIFT_Y = 0.5;
  const FRAME_MS = 50;
  const RENDER_SCALE = 0.75;

  function hash3(x: number, y: number, z: number): number {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
    h = (h ^ (h >>> 13)) | 0;
    h = Math.imul(h, 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function smooth(t: number): number {
    return t * t * (3 - 2 * t);
  }

  function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  function valueNoise3(x: number, y: number, z: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const fx = smooth(x - ix);
    const fy = smooth(y - iy);
    const fz = smooth(z - iz);
    const c000 = hash3(ix, iy, iz);
    const c100 = hash3(ix + 1, iy, iz);
    const c010 = hash3(ix, iy + 1, iz);
    const c110 = hash3(ix + 1, iy + 1, iz);
    const c001 = hash3(ix, iy, iz + 1);
    const c101 = hash3(ix + 1, iy, iz + 1);
    const c011 = hash3(ix, iy + 1, iz + 1);
    const c111 = hash3(ix + 1, iy + 1, iz + 1);
    return lerp(
      lerp(lerp(c000, c100, fx), lerp(c010, c110, fx), fy),
      lerp(lerp(c001, c101, fx), lerp(c011, c111, fx), fy),
      fz,
    );
  }

  function fbm(x: number, y: number, z: number): number {
    return valueNoise3(x, y, z) * 0.65 + valueNoise3(x * 2.1, y * 2.1, z * 1.7) * 0.35;
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raf = 0;
  let lastDraw = 0;
  let cols = 0;
  let rows = 0;
  let field = new Float32Array(0);
  const started = performance.now();

  function resize(): void {
    if (!canvas) return;
    canvas.width = Math.ceil(window.innerWidth * RENDER_SCALE);
    canvas.height = Math.ceil(window.innerHeight * RENDER_SCALE);
    cols = Math.ceil(window.innerWidth / CELL) + 2;
    rows = Math.ceil(window.innerHeight / CELL) + 2;
    field = new Float32Array(cols * rows);
  }

  interface Point {
    x: number;
    y: number;
  }

  function draw(nowMs: number): void {
    if (!canvas || !ctx) return;
    const elapsed = (nowMs - started) / 1000;
    const t = elapsed * SPEED;
    const freq = 1 / (CELL * 5.2);

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        field[row * cols + col] = fbm(
          (col * CELL + elapsed * DRIFT_X) * freq,
          (row * CELL + elapsed * DRIFT_Y) * freq,
          t,
        );
      }
    }

    ctx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
    ctx.clearRect(0, 0, canvas.width / RENDER_SCALE, canvas.height / RENDER_SCALE);
    ctx.lineWidth = 1;

    LEVELS.forEach((iso, levelIndex) => {
      const isIndexLine = levelIndex % INDEX_EVERY === 1;
      ctx.strokeStyle = isIndexLine ? "rgba(212, 171, 58, 0.115)" : "rgba(212, 171, 58, 0.065)";
      ctx.beginPath();
      for (let row = 0; row < rows - 1; row += 1) {
        for (let col = 0; col < cols - 1; col += 1) {
          const tl = field[row * cols + col] ?? 0;
          const tr = field[row * cols + col + 1] ?? 0;
          const br = field[(row + 1) * cols + col + 1] ?? 0;
          const bl = field[(row + 1) * cols + col] ?? 0;
          const caseIndex =
            (tl > iso ? 8 : 0) | (tr > iso ? 4 : 0) | (br > iso ? 2 : 0) | (bl > iso ? 1 : 0);
          if (caseIndex === 0 || caseIndex === 15) continue;

          const x = col * CELL;
          const y = row * CELL;
          const top: Point = { x: x + (CELL * (iso - tl)) / (tr - tl), y };
          const bottom: Point = { x: x + (CELL * (iso - bl)) / (br - bl), y: y + CELL };
          const left: Point = { x, y: y + (CELL * (iso - tl)) / (bl - tl) };
          const right: Point = { x: x + CELL, y: y + (CELL * (iso - tr)) / (br - tr) };

          const segments: Array<[Point, Point]> = [];
          switch (caseIndex) {
            case 1:
            case 14:
              segments.push([left, bottom]);
              break;
            case 2:
            case 13:
              segments.push([bottom, right]);
              break;
            case 3:
            case 12:
              segments.push([left, right]);
              break;
            case 4:
            case 11:
              segments.push([top, right]);
              break;
            case 5:
              segments.push([left, top], [bottom, right]);
              break;
            case 6:
            case 9:
              segments.push([top, bottom]);
              break;
            case 7:
            case 8:
              segments.push([left, top]);
              break;
            case 10:
              segments.push([top, right], [left, bottom]);
              break;
          }
          for (const [a, b] of segments) {
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
          }
        }
      }
      ctx.stroke();
    });
  }

  // One frame is asked for when the next drawing is nearly due, not every
  // display frame: asking sixty (or 120, or 144) times a second to draw
  // twenty made the page run a full frame of its own each time, with
  // nothing to show for two in three of them. The drawing follows the
  // clock, so it looks the same however the frames fall.
  const LEAD_MS = 4;
  let timer = 0;

  function tick(nowMs: number): void {
    raf = 0;
    lastDraw = nowMs;
    draw(nowMs);
    wait();
  }

  function wait(): void {
    const due = Math.max(0, FRAME_MS - LEAD_MS - (performance.now() - lastDraw));
    timer = window.setTimeout(() => {
      timer = 0;
      if (running()) raf = window.requestAnimationFrame(tick);
    }, due);
  }

  // The shell pauses the loop under a running world (chrome.ts): a
  // full-screen redraw twenty times a second is work the table and the
  // call would rather have. The last frame stays drawn.
  let paused = false;

  function running(): boolean {
    return !paused && !document.hidden && !reducedMotion;
  }

  function sync(): void {
    if (running()) {
      if (!raf && !timer) raf = window.requestAnimationFrame(tick);
      return;
    }
    if (raf) window.cancelAnimationFrame(raf);
    if (timer) window.clearTimeout(timer);
    raf = 0;
    timer = 0;
  }

  function onVisibility(): void {
    sync();
  }

  window.odmTopo = {
    pause() {
      paused = true;
      sync();
    },
    resume() {
      paused = false;
      sync();
    },
  };

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  function onResize(): void {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resize();
      draw(performance.now());
    }, 150);
  }

  resize();
  if (reducedMotion) {
    draw(started);
  } else {
    raf = window.requestAnimationFrame(tick);
    document.addEventListener("visibilitychange", onVisibility);
  }
  window.addEventListener("resize", onResize);
})();
