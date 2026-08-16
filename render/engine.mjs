/**
 * The kinetic lyric engine.
 *
 * One world, painted per frame as a pure function of the frame number: an
 * obsidian room holding a volumetric beam, a wall of glowing panels and a
 * lot of typography. Words move on their sung timestamps; everything else
 * moves on measured audio — bass drives the beam and the haze, onsets tick
 * the grain and the panels — so nothing can drift out of sync.
 *
 * Scenes are templates keyed by section kind (chant, verse, pre, chorus,
 * tag, instrumental). A song is data: `timing.json` says what is sung when,
 * `analysis.json` says how the record moves. Per-line `device` hints let a
 * lyric sheet opt a line into a bespoke treatment (redact, crack) without
 * the engine knowing the song.
 *
 * Determinism rules: no Date.now, no Math.random — a seeded PRNG builds
 * every particle and panel up front, and paint(frame) touches no state that
 * survives between calls except caches keyed by content.
 *
 * @module render/engine
 */

/* ---------------------------------------------------------------- palette */

const BG = '#07070B';
const INK_DEFAULT = '#F2F5FA';
const DIM_DEFAULT = '#6E7889';
const RAMP = ['#00C0E0', '#0090F0', '#2090F0', '#7060F0', '#B040F0', '#F04060', '#E0A040'];
const CYAN = RAMP[0];
const VIOLET = RAMP[3];
const MAGENTA = RAMP[4];
const RED = RAMP[5];
const AMBER = RAMP[6];

const MONO = 'Menlo';

/* ----------------------------------------------------------------- helpers */

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, u) => a + (b - a) * u;

/** 0→1 progress of t across [a, b], clamped. */
const span = (t, a, b) => clamp01((t - a) / Math.max(1e-6, b - a));

const easeOutCubic = (u) => 1 - (1 - u) ** 3;
const easeOutQuint = (u) => 1 - (1 - u) ** 5;
const easeInOutCubic = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const easeOutExpo = (u) => (u >= 1 ? 1 : 1 - 2 ** (-10 * u));
const easeOutBack = (u) => 1 + 2.2 * (u - 1) ** 3 + 1.2 * (u - 1) ** 2;

/** Seeded PRNG — the only randomness allowed in the building. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** #rrggbb → 'r,g,b' for building rgba() strings. */
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};

/** Linear mix of two hex colours, u clamped 0..1. */
const mixHex = (a, b, u) => {
  const A = parseInt(a.slice(1), 16);
  const B = parseInt(b.slice(1), 16);
  const v = Math.max(0, Math.min(1, u));
  const ch = (sa, sb) => Math.round(sa + (sb - sa) * v);
  const r = ch((A >> 16) & 255, (B >> 16) & 255);
  const g = ch((A >> 8) & 255, (B >> 8) & 255);
  const bl = ch(A & 255, B & 255);
  return `rgb(${r},${g},${bl})`;
};

/* ==================================================================== */

export async function createStage(canvas, timing, analysis) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  /* ------------------------------------------------------------ style pack
     Every aesthetic choice the engine makes can be overridden per song by a
     `style` block in the lyric sheet. Defaults are the venue pack. */
  const style = timing.style || {};
  const DISPLAY = style.display || '"Avenir Next Condensed"';
  const TEXTY = style.text || '"Avenir Next"';
  const TEXT_STYLE = style.textStyle || '';           // e.g. 'italic ' for speed
  const INK = style.ink || '#F2F5FA';
  const DIM = style.dim || '#6E7889';
  const VERSE_ACCENTS = style.verseAccents || [CYAN, VIOLET, MAGENTA, AMBER];
  const CHORUS_ACCENTS = style.chorusAccents || [CYAN, MAGENTA];
  const WORLD = style.world || 'venue';               // 'venue' | 'horizon'
  const CRACK_OK = style.crack !== false;
  /* The motion dial, 0 calm .. 1 punchy. The director sets it per song; the
     fallback guesses from tempo. Scales pops, pumps, kicks and flashes so a
     ballad never behaves like a banger. */
  const DW = style.displayWeight || 900;           // serif displays want 700
  const TW_N = style.textWeightNormal || 600;
  const TW_E = style.textWeightEmph || 800;
  const INVERT_OK = style.chorusInvert !== false;
  const TAIL = style.tail || 0;                    // seconds of film after the song
  const TXC = style.textCenterY || 0.5;            // where lockups centre vertically
  const M = style.motion ?? Math.max(0.25, Math.min(1, ((analysis.bpm || 100) - 60) / 90));
  const POP_K = 1.5 - 0.7 * M;    // mellow songs let words arrive slower
  const PUMP_K = 0.45 + 0.7 * M;  // and breathe less on the bass
  const KICK_K = 0.5 + 0.6 * M;   // and shake less on onsets
  const FPS = analysis.fps;
  const DUR = analysis.duration;
  const frames = Math.ceil((DUR + (timing.style?.tail || 0)) * FPS);
  const DUR2 = DUR + (timing.style?.tail || 0);

  /* The scroll world's backdrop: the cover, softened once at init. */
  let coverCanvas = null;
  if ((style.world === 'scroll') && timing.cover) {
    try {
      const img = new Image();
      img.src = timing.cover;
      await img.decode();
      coverCanvas = document.createElement('canvas');
      coverCanvas.width = W;
      coverCanvas.height = H;
      const g = coverCanvas.getContext('2d');
      const scale = Math.max(W / img.width, H / img.height) * 1.06;
      const dw = img.width * scale;
      const dh = img.height * scale;
      g.filter = 'blur(26px) saturate(0.85)';
      g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      g.filter = 'none';
      g.fillStyle = 'rgba(5,5,9,0.66)';
      g.fillRect(0, 0, W, H);
    } catch { coverCanvas = null; /* no cover, no problem — the dark holds */ }
  }

  /* Fonts must be resolved before any measurement happens. */
  await Promise.all([
    document.fonts.load(`900 100px ${DISPLAY}`),
    document.fonts.load(`700 100px ${DISPLAY}`),
    document.fonts.load(`800 100px ${TEXTY}`),
    document.fonts.load(`600 100px ${TEXTY}`),
    document.fonts.load(`500 100px ${TEXTY}`),
    document.fonts.load(`400 100px ${MONO}`),
    document.fonts.load(`700 100px ${MONO}`),
  ]).catch(() => {});

  /* ------------------------------------------------------------ audio in */

  const S = analysis.series;
  const at = (name, t) => {
    const arr = S[name];
    const i = Math.max(0, Math.min(arr.length - 1, Math.round(t * FPS)));
    return arr[i];
  };
  /** Smoothed read — ±n frames box average, for anything that must not jitter. */
  const atSm = (name, t, n = 3) => {
    const arr = S[name];
    const c = Math.round(t * FPS);
    let sum = 0;
    let k = 0;
    for (let i = c - n; i <= c + n; i++) {
      if (i >= 0 && i < arr.length) { sum += arr[i]; k++; }
    }
    return k ? sum / k : 0;
  };
  /** 0..1 spike if a picked onset sits within `w` seconds of t (decaying). */
  const onsetKick = (t, w = 0.12) => {
    let best = 0;
    for (const o of analysis.onsets) {
      if (o > t) break;
      if (t - o < w) best = Math.max(best, 1 - (t - o) / w);
    }
    return best;
  };

  /* ------------------------------------------------------------- typography */

  const measureCache = new Map();
  function textW(text, font) {
    const key = `${font}|${text}`;
    if (!measureCache.has(key)) {
      ctx.font = font;
      measureCache.set(key, ctx.measureText(text).width);
    }
    return measureCache.get(key);
  }
  /** Font size that sets `text` at exactly `target` px wide. */
  function fitSize(text, target, family, weight) {
    const w = textW(text, `${weight} 100px ${family}`);
    return (target / Math.max(1, w)) * 100;
  }

  /* ------------------------------------------------------------- the world */

  const rand = mulberry32(0x05F5C9);

  /** The wall of light panels, echoing the cover. Built once. */
  const panels = [];
  {
    const cols = 26;
    const rows = 12;
    const cw = 74;
    const chGap = 14;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        if (rand() < 0.22) continue; // holes make it a wall, not a spreadsheet
        panels.push({
          x: c * (cw + chGap) - ((cols * (cw + chGap)) / 2),
          y: r * (52 + chGap) - ((rows * (52 + chGap)) / 2),
          w: cw,
          h: 52,
          color: RAMP[Math.floor(rand() * RAMP.length)],
          phase: rand() * Math.PI * 2,
          rate: 0.4 + rand() * 1.2,
          band: ['bass', 'mid', 'high'][Math.floor(rand() * 3)],
        });
      }
    }
  }

  /** Dust motes living inside the beam. */
  const motes = Array.from({ length: 140 }, () => ({
    u: rand(),
    v: rand(),
    r: 0.7 + rand() * 1.9,
    drift: 0.004 + rand() * 0.02,
    tw: rand() * Math.PI * 2,
  }));

  /** Grain: four seeded noise tiles cycled by frame index. */
  const grainTiles = [];
  {
    const gw = 480;
    const gh = 270;
    for (let k = 0; k < 4; k++) {
      const c = document.createElement('canvas');
      c.width = gw;
      c.height = gh;
      const g = c.getContext('2d');
      const img = g.createImageData(gw, gh);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.floor(rand() * 255);
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 34;
      }
      g.putImageData(img, 0, 0);
      grainTiles.push(c);
    }
  }

  const vignette = (() => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(W / 2, H * 0.47, H * 0.44, W / 2, H / 2, H * 1.02);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    return c;
  })();

  function paintBackdrop() {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
  }

  /**
   * @param {number} t
   * @param {number} inten 0..1 overall presence
   * @param {number} live  0..1 how much the panels chase the music
   * @param {{x:number,y:number,scale:number}} cam parallax offset
   */
  function paintPanels(t, inten, live, cam = { x: 0, y: 0, scale: 1 }) {
    if (inten <= 0.001) return;
    ctx.save();
    ctx.translate(W * 0.64 - cam.x * 0.25, H * 0.44 - cam.y * 0.25);
    ctx.scale(cam.scale, cam.scale);
    ctx.rotate(-0.045);
    ctx.transform(1, 0, -0.22, 1, 0, 0); // shear: seen at an angle, like the cover
    for (const p of panels) {
      const e = at(p.band, t);
      const tw = 0.5 + 0.5 * Math.sin(p.phase + t * p.rate * 2.2);
      const a = inten * (0.05 + 0.75 * (0.22 * tw + 0.78 * e * live));
      ctx.fillStyle = `rgba(${rgb(p.color)},${(a * 0.28).toFixed(3)})`;
      ctx.fillRect(p.x - 5, p.y - 5, p.w + 10, p.h + 10);
      ctx.fillStyle = `rgba(${rgb(p.color)},${a.toFixed(3)})`;
      ctx.fillRect(p.x, p.y, p.w, p.h);
    }
    ctx.restore();
  }

  /** The volumetric beam from the cover, top-left down across the frame. */
  function paintBeam(t, inten, color = CYAN) {
    if (inten <= 0.001) return;
    const bass = atSm('bass', t, 4);
    const flicker = 0.92 + 0.08 * Math.sin(t * 9.3) * at('flux', t);
    const a = inten * (0.55 + 0.45 * bass) * flicker;
    const x0 = W * 0.135;
    const y0 = -H * 0.08;
    const reach = H * 1.18;
    const ang = 0.86 + 0.018 * Math.sin(t * 0.21); // slow sweep, never still
    const dx = Math.cos(ang) * reach;
    const dy = Math.sin(ang) * reach;
    const half = 0.16 + 0.03 * bass;
    const px = -Math.sin(ang);
    const py = Math.cos(ang);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const cone = (halfW, alpha) => {
      const grad = ctx.createLinearGradient(x0, y0, x0 + dx, y0 + dy);
      grad.addColorStop(0, `rgba(${rgb('#EAF6FF')},${alpha.toFixed(3)})`);
      grad.addColorStop(0.45, `rgba(${rgb(color)},${(alpha * 0.38).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x0 - px * 26, y0 - py * 26);
      ctx.lineTo(x0 + px * 26, y0 + py * 26);
      ctx.lineTo(x0 + dx + px * reach * halfW, y0 + dy + py * reach * halfW);
      ctx.lineTo(x0 + dx - px * reach * halfW, y0 + dy - py * reach * halfW);
      ctx.closePath();
      ctx.fill();
    };
    cone(half, a * 0.85);          // the wash
    cone(half * 0.4, a * 0.95);    // the bright core

    // Motes drift down-beam; each is parameterised along (u) and across (v).
    for (const m of motes) {
      const u = (m.u + t * m.drift) % 1;
      const across = (m.v - 0.5) * 2 * half * reach * u;
      const mx = x0 + Math.cos(ang) * reach * u + px * across;
      const my = y0 + Math.sin(ang) * reach * u + py * across;
      const ma = a * 0.7 * (0.35 + 0.65 * Math.sin(m.tw + t * 2.1) ** 2) * (1 - u * 0.85);
      if (ma < 0.01 || mx < -20 || mx > W + 20 || my > H + 20) continue;
      ctx.fillStyle = `rgba(${rgb('#DCEBFF')},${ma.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(mx, my, m.r * (1 + u), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* The horizon world: a dusk sky that becomes dawn on the song's own
     clock, a sun that rises through the last act, and a road running to the
     vanishing point. An alternative to the venue for songs that travel. */
  const stars = Array.from({ length: 130 }, (_, i) => ({
    x: ((i * 761) % 1000) / 1000,
    y: ((i * 383) % 620) / 1000,
    r: 0.6 + ((i * 131) % 14) / 10,
    tw: ((i * 97) % 63) / 10,
  }));

  function paintHorizon(t, o = {}) {
    const prog = t / DUR;
    const dawn = easeInOutCubic(clamp01((prog - 0.35) / 0.6));
    const hy = H * 0.72;
    const bass = atSm('bass', t, 5);

    // Sky bands, night to dawn.
    const g = ctx.createLinearGradient(0, 0, 0, hy);
    g.addColorStop(0, mixHex('#04050E', '#232C55', dawn * 0.8));
    g.addColorStop(0.55, mixHex('#0A0F2A', '#54346E', dawn));
    g.addColorStop(0.85, mixHex('#171240', '#B04A44', dawn));
    g.addColorStop(1, mixHex('#241A4E', '#FFB347', dawn));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, hy);

    // Stars burn out as morning comes.
    ctx.save();
    for (const s of stars) {
      const a = (1 - dawn) * (0.25 + 0.3 * Math.sin(s.tw + t * 1.7) ** 2);
      if (a <= 0.02) continue;
      ctx.fillStyle = `rgba(240,244,255,${a.toFixed(3)})`;
      ctx.fillRect(s.x * W, s.y * H, s.r, s.r);
    }
    ctx.restore();

    // The sun clears the horizon through the final act.
    const rise = easeInOutCubic(clamp01((prog - 0.55) / 0.42));
    if (rise > 0.02 || dawn > 0.4) {
      const sunR = H * 0.09;
      const sunY = hy + sunR * lerp(1.15, -0.75, rise);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const glow = ctx.createRadialGradient(W / 2, sunY, 0, W / 2, sunY, sunR * (5 + bass * 2));
      glow.addColorStop(0, `rgba(255,190,110,${(0.24 + 0.5 * rise + bass * 0.12).toFixed(3)})`);
      glow.addColorStop(1, 'rgba(255,190,110,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, hy + 2);
      ctx.beginPath();
      ctx.rect(0, 0, W, hy);
      ctx.clip();
      ctx.fillStyle = mixHex('#FFD9A0', '#FFF3DC', rise);
      ctx.beginPath();
      ctx.arc(W / 2, sunY, sunR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Horizon line.
    ctx.fillStyle = `rgba(255,200,130,${(0.25 + 0.45 * dawn + bass * 0.15).toFixed(3)})`;
    ctx.fillRect(0, hy - 1, W, 2.5);

    // The ground and the road, running to the vanishing point.
    ctx.fillStyle = mixHex('#050508', '#1C0F14', dawn * 0.7);
    ctx.fillRect(0, hy, W, H - hy);
    ctx.save();
    ctx.strokeStyle = `rgba(255,220,170,${(0.1 + 0.14 * dawn).toFixed(3)})`;
    ctx.lineWidth = 2;
    for (const k of [-0.34, 0.34]) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + k * W, H + 30);
      ctx.lineTo(W / 2, hy);
      ctx.stroke();
    }
    // Centre-line dashes rush toward the camera.
    const speed = 0.6;
    for (let i = 0; i < 9; i++) {
      const u = ((i / 9 + t * speed) % 1);
      const uu = u * u;
      const y = hy + uu * (H - hy + 40);
      const w = 3 + uu * 26;
      const hgt = 4 + uu * 40;
      ctx.fillStyle = `rgba(255,230,190,${(0.05 + 0.5 * uu).toFixed(3)})`;
      ctx.fillRect(W / 2 - w / 2, y, w, hgt);
    }
    ctx.restore();
  }

  /* The sanctum world: darkness, one candle. The flame is born in the
     intro, breathes with the record, gutters where a line carries
     device:"gutter", and dies for good after a line carrying
     device:"extinguish" — the lyric scripts the light. */
  const flameCues = { gutters: [], deathT: null };
  for (const l of timing.lines) {
    if (l.device === 'gutter') flameCues.gutters.push([l.t0 - 0.2, l.t1 + 1.4]);
    if (l.device === 'extinguish') flameCues.deathT = l.t1 + 0.5;
  }
  const smokes = Array.from({ length: 5 }, (_, i) => ({
    phase: i * 1.7,
    speed: 0.05 + (i % 3) * 0.02,
    amp: 26 + (i * 31) % 40,
  }));
  const ashes = Array.from({ length: 60 }, (_, i) => ({
    x: ((i * 761) % 1000) / 1000,
    y: ((i * 383) % 1000) / 1000,
    r: 0.8 + ((i * 131) % 12) / 8,
    vy: 0.008 + ((i * 53) % 10) / 700,
    drift: ((i * 97) % 20 - 10) / 900,
    tw: ((i * 41) % 63) / 10,
  }));

  function flameLife(t) {
    let life = easeOutCubic(span(t, 0.5, 2.4)); // the flame is lit in the intro
    for (const [g0, g1] of flameCues.gutters) {
      if (t > g0 && t < g1) {
        const mid = clamp01(Math.min(t - g0, g1 - t) / 0.7);
        life = Math.min(life, 1 - 0.72 * mid);
      }
    }
    if (flameCues.deathT !== null) {
      if (t >= flameCues.deathT) life = 0;
      else life = Math.min(life, clamp01((flameCues.deathT - t) / 1.2));
    }
    return life;
  }

  function paintSanctum(t, o = {}) {
    const life = flameLife(t);
    const bass = atSm('bass', t, 6);
    const fx = W / 2;
    const fy = H * 0.845;

    // The room: near-black, faintly warm where the flame lives.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#050407');
    g.addColorStop(0.72, mixHex('#0A0810', '#141018', life * 0.5));
    g.addColorStop(1, mixHex('#070609', '#1A130E', life));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Ash drifts down for ever.
    ctx.save();
    for (const a of ashes) {
      const y = ((a.y + t * a.vy) % 1.06) - 0.03;
      const x = a.x + Math.sin(a.tw + t * 0.5) * a.drift * 8;
      const al = 0.05 + 0.07 * Math.sin(a.tw + t * 1.1) ** 2;
      ctx.fillStyle = `rgba(200,195,185,${al.toFixed(3)})`;
      ctx.fillRect(x * W, y * H, a.r, a.r);
    }
    ctx.restore();

    if (life > 0.005) {
      const flick = 1
        + 0.1 * Math.sin(t * 11.3) * (0.4 + at('flux', t))
        + 0.06 * Math.sin(t * 23.7 + 1.3);
      const fh = H * 0.115 * life * (0.82 + 0.18 * bass * PUMP_K) * flick;
      const sway = Math.sin(t * 1.9) * fh * 0.07 + Math.sin(t * 0.61) * fh * 0.05;

      // Halo — the room breathes with the flame.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const halo = ctx.createRadialGradient(fx, fy - fh * 0.5, 0, fx, fy - fh * 0.5, H * 0.62);
      halo.addColorStop(0, `rgba(255,180,90,${(0.16 * life * flick).toFixed(3)})`);
      halo.addColorStop(0.45, `rgba(200,120,60,${(0.05 * life).toFixed(3)})`);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, W, H);

      // The flame: three nested teardrops.
      const drop = (hh, ww, color, alpha, dx) => {
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(fx + dx, fy);
        ctx.bezierCurveTo(fx + dx - ww, fy - hh * 0.25, fx + dx - ww * 0.5, fy - hh * 0.8, fx + dx + sway, fy - hh);
        ctx.bezierCurveTo(fx + dx + ww * 0.5, fy - hh * 0.8, fx + dx + ww, fy - hh * 0.25, fx + dx, fy);
        ctx.fill();
      };
      drop(fh, fh * 0.30, '#E8862E', 0.55, 0);
      drop(fh * 0.72, fh * 0.20, '#FFB347', 0.75, 0);
      drop(fh * 0.42, fh * 0.11, '#FFE9C8', 0.9, 0);
      ctx.globalAlpha = 1;

      // Wick and a small pool of light on the floor.
      ctx.fillStyle = 'rgba(30,22,18,0.9)';
      ctx.fillRect(fx - 2, fy - 2, 4, 10);
      const pool = ctx.createRadialGradient(fx, fy + 14, 0, fx, fy + 14, fh * 1.5);
      pool.addColorStop(0, `rgba(255,170,90,${(0.1 * life).toFixed(3)})`);
      pool.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = pool;
      ctx.beginPath();
      ctx.ellipse(fx, fy + 16, fh * 1.6, fh * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Smoke rises from the tip once the flame weakens.
      if (life < 0.75) {
        ctx.save();
        ctx.strokeStyle = `rgba(180,178,175,${(0.14 * (1 - life)).toFixed(3)})`;
        ctx.lineWidth = 2;
        for (const s of smokes) {
          ctx.beginPath();
          const x0 = fx + sway;
          const y0 = fy - fh - 6;
          ctx.moveTo(x0, y0);
          for (let k = 1; k <= 12; k++) {
            const u = k / 12;
            ctx.lineTo(
              x0 + Math.sin(s.phase + t * s.speed * 9 + u * 5) * s.amp * u,
              y0 - u * H * 0.3,
            );
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    } else if (flameCues.deathT !== null && t > flameCues.deathT) {
      // After the light: an ember, and the smoke of what was.
      const since = t - flameCues.deathT;
      const ember = Math.max(0, 0.5 - since * 0.1) * (0.6 + 0.4 * Math.sin(t * 5.1));
      if (ember > 0.02) {
        ctx.fillStyle = `rgba(255,120,50,${ember.toFixed(3)})`;
        ctx.fillRect(fx - 2, fy - 4, 4, 4);
      }
      ctx.save();
      ctx.strokeStyle = `rgba(170,168,165,${Math.max(0, 0.2 - since * 0.03).toFixed(3)})`;
      ctx.lineWidth = 2;
      for (const s of smokes) {
        ctx.beginPath();
        ctx.moveTo(fx, fy - 8);
        for (let k = 1; k <= 12; k++) {
          const u = k / 12;
          ctx.lineTo(fx + Math.sin(s.phase + t * s.speed * 9 + u * 5) * s.amp * u * 1.6, fy - 8 - u * H * 0.4);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /* The downpour world: rain falling past a dim skyline, a flooded floor
     that ripples where drops land. For the songs that ask for it. */
  const drops = Array.from({ length: 220 }, (_, i) => ({
    x: ((i * 761) % 1000) / 1000,
    y: ((i * 383) % 1000) / 1000,
    v: 0.55 + ((i * 131) % 45) / 100,
    len: 14 + ((i * 53) % 26),
    a: 0.1 + ((i * 17) % 22) / 100,
  }));
  const towers = Array.from({ length: 14 }, (_, i) => ({
    x: (i / 14) + (((i * 97) % 13) - 6) / 260,
    w: 0.035 + ((i * 41) % 22) / 700,
    h: 0.12 + ((i * 71) % 30) / 130,
  }));

  function paintDownpour(t, o = {}) {
    const bass = atSm('bass', t, 5);
    const floorY = H * 0.86;

    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#05070C');
    g.addColorStop(0.7, '#0A0F1A');
    g.addColorStop(1, '#0D1420');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // A skyline more implied than drawn, a few windows barely awake.
    ctx.save();
    for (const tw of towers) {
      const th = tw.h * H * (1 + bass * 0.03);
      ctx.fillStyle = 'rgba(8,11,18,0.9)';
      ctx.fillRect(tw.x * W, floorY - th, tw.w * W, th);
      const wins = 3 + Math.floor(tw.h * 14);
      for (let k = 0; k < wins; k++) {
        const wx = tw.x * W + ((k * 37) % Math.max(4, tw.w * W - 6)) + 2;
        const wy = floorY - th + ((k * 53) % Math.max(6, th - 8)) + 3;
        const on = Math.sin(t * 0.11 + k * 3.7 + tw.x * 40) > 0.86;
        if (on) {
          ctx.fillStyle = `rgba(${rgb(style.titleAccent || '#9FC3E8')},0.16)`;
          ctx.fillRect(wx, wy, 3, 4);
        }
      }
    }
    ctx.restore();

    // Rain, in two depths; the near layer leans with a slow wind.
    const wind = Math.sin(t * 0.22) * 0.12;
    ctx.save();
    ctx.strokeStyle = 'rgba(190,205,225,1)';
    for (const dpt of drops) {
      const speed = dpt.v * (0.9 + at('flux', t) * 0.25);
      const y = ((dpt.y + t * speed) % 1.08) - 0.04;
      const x = (dpt.x + wind * y * 0.4 + 2) % 1;
      ctx.globalAlpha = dpt.a * (0.5 + bass * 0.4);
      ctx.lineWidth = dpt.len > 28 ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(x * W, y * H);
      ctx.lineTo(x * W + wind * dpt.len, y * H + dpt.len);
      ctx.stroke();
    }
    ctx.restore();

    // The flooded floor: a faint mirror with onset ripples.
    ctx.save();
    ctx.fillStyle = 'rgba(14,20,32,0.85)';
    ctx.fillRect(0, floorY, W, H - floorY);
    ctx.globalCompositeOperation = 'lighter';
    for (let r = 0; r < 7; r++) {
      const seedT = Math.floor(t * 1.6) + r * 61;
      const rx = ((seedT * 7919) % 997) / 997;
      const age = (t * 1.6) % 1;
      const rr = age * 60 + 6;
      const ra = Math.max(0, (0.14 + bass * 0.1) * (1 - age)) * (0.4 + 0.6 * ((seedT % 7) / 7));
      if (ra <= 0.01) continue;
      ctx.strokeStyle = `rgba(170,195,225,${ra.toFixed(3)})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.ellipse(rx * W, floorY + 8 + ((seedT % 5) / 5) * (H - floorY - 16), rr, rr * 0.22, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** One switch for the scenes: venue panels+beam, or the horizon. */
  function paintWorld(t, o = {}) {
    if (WORLD === 'horizon') {
      if (!o.inverted) paintHorizon(t, o);
      return;
    }
    if (WORLD === 'sanctum') {
      if (!o.inverted) paintSanctum(t, o);
      return;
    }
    if (WORLD === 'downpour') {
      if (!o.inverted) paintDownpour(t, o);
      return;
    }
    paintPanels(t, o.panels ?? 0.35, o.live ?? 0.6, o.cam || { x: 0, y: 0, scale: 1 });
    if (o.beam) paintBeam(t, o.beam, o.color || CYAN);
  }

  function paintGrain(f, amount = 0.05) {
    const tile = grainTiles[f % grainTiles.length];
    const jx = ((f * 7919) % 97) - 48;
    const jy = ((f * 104729) % 89) - 44;
    ctx.save();
    ctx.globalAlpha = amount * 3.4;
    ctx.globalCompositeOperation = 'overlay';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tile, jx, jy, W + 100, H + 100);
    ctx.restore();
  }

  function paintVignette(amount = 1) {
    ctx.save();
    ctx.globalAlpha = amount;
    ctx.drawImage(vignette, 0, 0);
    ctx.restore();
  }

  /* -------------------------------------------------------------- lockups */

  /**
   * A composed block of words with per-word style and pop times. Layouts
   * return {words: [{word, t0, t1, x, y, size, family, weight, rot, role}],
   * w, h} in local space centred on (0,0).
   */

  /**
   * Emphasis is earned by being sung long — but only content words qualify.
   * A stretched "the" is phrasing; a stretched "walls" is the point.
   */
  const STOP = new Set(['the', 'a', 'an', 'it', 'you', 'they', 'on', 'was', 'were',
    'that', 'of', 'in', 'to', 'and', 'your', 'should', 'have', 'been', 'them',
    'is', 'let', 'what', 'no', 'must']);
  function emphasisMask(words) {
    const durs = words.map((w) => w.t1 - w.t0).sort((a, b) => a - b);
    const median = durs[Math.floor(durs.length / 2)] || 0.2;
    const eligible = words.map((w) => {
      const bare = w.word.toLowerCase().replace(/[^a-z']/g, '');
      return bare.length >= 4 && !STOP.has(bare) && (w.t1 - w.t0) > median * 1.25;
    });
    // At most two emphasised words per line — pick the longest-sung.
    const ranked = words
      .map((w, i) => ({ i, d: w.t1 - w.t0 }))
      .filter(({ i }) => eligible[i])
      .sort((a, b) => b.d - a.d)
      .slice(0, 2)
      .map(({ i }) => i);
    return words.map((_, i) => ranked.includes(i));
  }

  /**
   * Editorial stack: words flow into rows against a width budget; emphasised
   * words jump scale and pull the accent.
   */
  function layoutStack(line, opts = {}) {
    const budget = opts.width || W * 0.56;
    const base = opts.size || 92;
    const gapX = base * 0.26;
    const emph = emphasisMask(line.words);
    const rows = [];
    let row = { words: [], w: 0 };
    line.words.forEach((wd, i) => {
      const scale = emph[i] ? 1.5 : 1;
      const size = base * scale;
      const weight = emph[i] ? TW_E : TW_N;
      const font = `${TEXT_STYLE}${weight} ${size}px ${TEXTY}`;
      const ww = textW(wd.word.toUpperCase(), font);
      if (row.w > 0 && row.w + gapX + ww > budget) {
        rows.push(row);
        row = { words: [], w: 0 };
      }
      row.words.push({ ...wd, size, ww, weight, emph: emph[i] });
      row.w += (row.w > 0 ? gapX : 0) + ww;
    });
    if (row.words.length) rows.push(row);
    // Widow rescue: a lone word on the last row reads as a wrap failure.
    // Pull a companion down from the row above.
    if (rows.length >= 2 && rows[rows.length - 1].words.length === 1
        && rows[rows.length - 2].words.length >= 3) {
      const prev = rows[rows.length - 2];
      const last = rows[rows.length - 1];
      const moved = prev.words.pop();
      last.words.unshift(moved);
      prev.w -= moved.ww + gapX;
      last.w += moved.ww + gapX;
    }

    const lineH = base * 1.24;
    const totalH = rows.length * lineH;
    const out = [];
    rows.forEach((r, ri) => {
      let x = -r.w / 2;
      const y = -totalH / 2 + ri * lineH + lineH / 2;
      for (const wd of r.words) {
        out.push({
          word: wd.word.toUpperCase(),
          t0: wd.t0,
          t1: wd.t1,
          x: x + wd.ww / 2,
          y: y + (wd.emph ? -wd.size * 0.02 : 0),
          size: wd.size,
          family: TEXTY,
          fstyle: TEXT_STYLE,
          weight: wd.weight,
          rot: 0,
          role: wd.emph ? 'accent' : 'ink',
        });
        x += wd.ww + gapX;
      }
    });
    return { words: out, w: budget, h: totalH, lineH };
  }

  /**
   * Anthem plate: a short line sets every word as its own full-width row;
   * a long line chunks into rows of two-three words so an eight-word chorus
   * still reads as a poster, not a sliver. The whole stack then scales to
   * fit the frame's height.
   */
  function layoutPlate(line, opts = {}) {
    const budget = opts.width || W * 0.72;
    const maxH = opts.maxH || H * (style.plateMaxH || 0.78);

    let rows;
    if (line.words.length <= 4) {
      rows = line.words.map((wd) => [wd]);
    } else {
      rows = [];
      let cur = [];
      let curLen = 0;
      for (const wd of line.words) {
        const bare = wd.word.replace(/[^A-Za-z']/g, '');
        if (cur.length && (cur.length >= 3 || curLen + bare.length > 12)) {
          rows.push(cur);
          cur = [];
          curLen = 0;
        }
        cur.push(wd);
        curLen += bare.length;
      }
      if (cur.length) rows.push(cur);
    }

    const texts = rows.map((r) => r.map((w) => w.word.toUpperCase()).join(' '));
    let sizes = texts.map((text) => fitSize(text, budget, DISPLAY, DW));
    let rowH = sizes.map((s) => s * 0.86);
    const totalH = rowH.reduce((a, b) => a + b, 0);
    const fit = Math.min(1, maxH / totalH);
    sizes = sizes.map((s) => s * fit);
    rowH = rowH.map((h) => h * fit);

    const out = [];
    let y = -(totalH * fit) / 2;
    rows.forEach((row, ri) => {
      y += rowH[ri] / 2;
      const size = sizes[ri];
      const font = `${DW} ${size}px ${DISPLAY}`;
      const gap = size * 0.24;
      const widths = row.map((wd) => textW(wd.word.toUpperCase(), font));
      const total = widths.reduce((a, b) => a + b, 0) + gap * (row.length - 1);
      let x = -total / 2;
      row.forEach((wd, wi) => {
        out.push({
          word: wd.word.toUpperCase(),
          t0: wd.t0,
          t1: wd.t1,
          x: x + widths[wi] / 2,
          y,
          size,
          family: DISPLAY,
          weight: DW,
          rot: 0,
          role: wd === line.words[line.words.length - 1] ? 'accent' : 'ink',
        });
        x += widths[wi] + gap;
      });
      y += rowH[ri] / 2;
    });
    return { words: out, w: budget, h: totalH * fit };
  }

  /** One-row slam for chants. */
  function layoutSlam(line, opts = {}) {
    const budget = opts.width || W * 0.78;
    const text = line.text.toUpperCase();
    const size = fitSize(text, budget, DISPLAY, DW);
    const gap = size * 0.24;
    const widths = line.words.map((wd) => textW(wd.word.toUpperCase(), `${DW} ${size}px ${DISPLAY}`));
    const total = widths.reduce((a, b) => a + b, 0) + gap * (line.words.length - 1);
    let x = -total / 2;
    const out = line.words.map((wd, i) => {
      const cx = x + widths[i] / 2;
      x += widths[i] + gap;
      return {
        word: wd.word.toUpperCase(),
        t0: wd.t0,
        t1: wd.t1,
        x: cx,
        y: 0,
        size,
        family: DISPLAY,
        weight: DW,
        rot: 0,
        role: 'ink',
      };
    });
    return { words: out, w: total, h: size };
  }

  /** Mono voice for the source-reading verse. */
  function layoutMono(line, opts = {}) {
    const size = opts.size || 82;
    const font = `700 ${size}px ${MONO}`;
    const gap = size * 0.62;
    const phrases = [];
    let cur = [];
    for (const wd of line.words) {
      cur.push(wd);
      if (/[,.!?]$/.test(wd.word)) { phrases.push(cur); cur = []; }
    }
    if (cur.length) phrases.push(cur);

    const rows = phrases.map((ph) => {
      const widths = ph.map((wd) => textW(wd.word, font));
      const w = widths.reduce((a, b) => a + b, 0) + gap * (ph.length - 1);
      return { ph, widths, w };
    });
    const lineH = size * 1.5;
    const totalH = rows.length * lineH;
    const maxW = Math.max(...rows.map((r) => r.w));
    const out = [];
    rows.forEach((r, ri) => {
      let x = -maxW / 2;
      const y = -totalH / 2 + ri * lineH + lineH / 2;
      r.ph.forEach((wd, i) => {
        out.push({
          word: wd.word,
          t0: wd.t0,
          t1: wd.t1,
          x: x + r.widths[i] / 2,
          y,
          size,
          family: MONO,
          weight: 700,
          rot: 0,
          role: i === 0 ? 'accent' : 'ink',
        });
        x += r.widths[i] + gap;
      });
    });
    return { words: out, w: maxW, h: totalH, mono: true };
  }

  const layoutCache = new Map();
  function layoutFor(line, kindOverride) {
    const kind = kindOverride || line.kind;
    const key = `${kind}|${line.t0}|${line.text}`;
    if (!layoutCache.has(key)) {
      let lay;
      if (kind === 'chant' || kind === 'tag') lay = layoutSlam(line);
      else if (kind === 'chorus') lay = layoutPlate(line);
      else if (kind === 'mono') lay = layoutMono(line);
      else lay = layoutStack(line);
      layoutCache.set(key, lay);
    }
    return layoutCache.get(key);
  }

  /**
   * Paint one laid-out word with its pop state at time t.
   * role → colour; sung word carries the accent while it is being sung.
   */
  function paintWord(wd, t, o = {}) {
    const accent = o.accent || CYAN;
    const popIn = (o.popIn ?? 0.22) * POP_K;
    const u = span(t, wd.t0, wd.t0 + popIn);
    if (t < wd.t0) {
      if (!o.preview) return;
      ctx.save();
      ctx.globalAlpha = o.previewAlpha ?? 0.13;
      ctx.font = `${wd.fstyle || ''}${wd.weight} ${wd.size}px ${wd.family}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = DIM;
      ctx.fillText(wd.word, wd.x, wd.y);
      ctx.restore();
      return;
    }
    const e = easeOutQuint(u);
    const singing = t >= wd.t0 && t <= wd.t1 + 0.12;
    const scale = o.slam
      ? lerp(1.24, 1, easeOutExpo(u))
      : lerp(0.9, 1, easeOutBack(Math.min(1, u)));
    // A slam is an impact: fully there the frame it lands, only the scale
    // settles. Anything else fades up with its pop.
    const alpha = (o.alpha ?? 1) * (o.slam ? 1 : e);
    let fill = wd.role === 'accent' ? accent : (o.ink || INK);
    if (o.singingAccent && singing && wd.role !== 'accent') fill = accent;
    if (o.ghost) fill = DIM;

    ctx.save();
    ctx.translate(wd.x, wd.y);
    ctx.rotate(wd.rot + (o.rot || 0) * (1 - e));
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    ctx.font = `${wd.fstyle || ''}${wd.weight} ${wd.size}px ${wd.family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (o.shadow) {
      ctx.shadowColor = `rgba(${rgb(accent)},0.55)`;
      ctx.shadowBlur = wd.size * 0.16;
    }
    ctx.fillStyle = fill;
    ctx.fillText(wd.word, 0, 0);
    ctx.restore();
  }

  /* ------------------------------------------------------- world memory -- */

  /** Every line the song has already sung, for the constellation payoff. */
  const memory = timing.lines.map((line, i) => ({ line, i }));

  /* ------------------------------------------------------------ timeline -- */

  /**
   * Sections with their spans; instrumental sections claim the gap to the
   * next vocal. The director then maps each to a scene painter.
   */
  const lines = timing.lines;
  const sections = [];
  {
    const bySection = new Map();
    for (const l of lines) {
      if (!bySection.has(l.section)) bySection.set(l.section, []);
      bySection.get(l.section).push(l);
    }
    // Ordered walk over the sheet's section ids as they appear in the lines,
    // then instrumentals stitched into the gaps.
    const seen = [];
    for (const l of lines) if (!seen.includes(l.section)) seen.push(l.section);
    seen.forEach((id, i) => {
      const ls = bySection.get(id);
      sections.push({
        id,
        kind: ls[0].kind,
        lines: ls,
        t0: ls[0].t0,
        t1: Math.max(...ls.map((x) => x.t1)),
      });
    });
    /* A gap only becomes an instrumental SECTION — its own world, its own
       scene — when it is long enough to be an event in the song. Two seconds
       between one verse and the next is a breath, not a break, and cutting to
       the drop wall and back for it reads as a fault in the film: the frame
       jumps somewhere else for a beat and returns. Those short gaps are left
       to the scene already playing, which simply holds the frame through them.

       The opening and the closing are different: the title card and the end
       card are wanted even when they are brief, so they keep the low bar. */
    const OPENING_GAP = 1.5;
    const BREAK_GAP = 5;      // mid-song: a real instrumental passage
    const CLOSING_GAP = 2.5;

    const stitched = [];
    let cursor = 0;
    for (const s of sections) {
      const gap = s.t0 - cursor;
      if (gap > (cursor === 0 ? OPENING_GAP : BREAK_GAP)) {
        stitched.push({ id: `inst-${stitched.length}`, kind: 'instrumental', lines: [], t0: cursor, t1: s.t0 });
      }
      stitched.push(s);
      cursor = s.t1;
    }
    if (DUR - cursor > CLOSING_GAP) {
      stitched.push({ id: 'inst-final', kind: 'instrumental', lines: [], t0: cursor, t1: DUR });
    }
    sections.length = 0;
    sections.push(...stitched);
  }

  /**
   * The scroll: the whole song as one gliding column over the softened
   * cover. The column eases from line to line on the sung timing, the
   * active line holds full ink with the sung word carrying the accent,
   * and the film closes on a title card. A reading aid, done properly.
   */
  function scrollScene() {
    const colW = W * 0.6;
    const size = 56;
    const lineGap = size * 0.62;
    const stanzaGap = size * 1.4;
    // Lay the whole column out once: wrapped rows per line, stacked anchors.
    const blocks = [];
    let y = 0;
    lines.forEach((line, li) => {
      const prev = lines[li - 1];
      if (prev && (line.section !== prev.section)) y += stanzaGap;
      const lay = layoutStack(line, { width: colW, size });
      blocks.push({ line, lay, y: y + lay.h / 2 });
      y += lay.h + lineGap;
    });
    const totalH = y;
    const anchor = H * 0.44;
    const accent = (style.verseAccents || [CYAN])[0];

    return (t, f) => {
      paintBackdrop();
      if (coverCanvas) ctx.drawImage(coverCanvas, 0, 0);

      // Where is the reading head? Glide between line anchors on sung time.
      let idx = -1;
      for (let i = 0; i < lines.length; i++) if (t >= lines[i].t0) idx = i;
      let scrollY;
      if (idx < 0) {
        scrollY = blocks[0].y - anchor * 1.6; // column waits below the fold
      } else {
        // Hold on the line being sung; glide only in the moment before the
        // next one arrives, so a long line never drifts off mid-word.
        const cur = blocks[idx];
        const next = blocks[idx + 1];
        const u = next ? easeInOutCubic(span(t, lines[idx + 1].t0 - 0.85, lines[idx + 1].t0)) : 0;
        scrollY = lerp(cur.y, next ? next.y : cur.y, u) - anchor;
      }

      const lastEnd = lines[lines.length - 1].t1;
      const columnFade = 1 - easeInOutCubic(span(t, lastEnd + 0.6, lastEnd + 1.6));

      if (columnFade > 0) {
        ctx.save();
        ctx.globalAlpha = columnFade;
        ctx.translate(W / 2, -scrollY);
        blocks.forEach((b, bi) => {
          const dy = b.y - scrollY - anchor;         // distance from the head
          if (b.y - scrollY < -80 || b.y - scrollY > H + 80) return;
          const active = bi === idx;
          const past = bi < idx;
          ctx.save();
          ctx.translate(0, b.y);
          const em = active ? 1.04 : 1;
          ctx.scale(em, em);
          ctx.globalAlpha = columnFade * (active ? 1 : past ? 0.3 : 0.48);
          for (const wd of b.lay.words) {
            // The active line is fully readable — unsung words sit at half
            // ink and each word lifts to full with the accent as it is sung.
            paintWord(wd, active ? t : (past ? wd.t1 + 1 : t), {
              accent,
              singingAccent: active,
              popIn: 0.14,
              preview: true,
              previewAlpha: active ? 0.55 : 1,
            });
          }
          ctx.restore();
        });
        ctx.restore();
      }

      // The close: title card once the last line has been read.
      const card = easeOutCubic(span(t, lastEnd + 1.2, lastEnd + 2.2));
      if (card > 0) {
        ctx.save();
        ctx.globalAlpha = card;
        ctx.textAlign = 'center';
        ctx.font = `${DW} 64px ${DISPLAY}`;
        ctx.letterSpacing = '6px';
        ctx.fillStyle = INK;
        ctx.fillText(timing.title.toUpperCase(), W / 2, H * 0.47);
        ctx.font = `500 28px ${TEXTY}`;
        ctx.letterSpacing = '12px';
        ctx.fillStyle = DIM;
        ctx.fillText(timing.artist.toUpperCase(), W / 2, H * 0.55);
        ctx.letterSpacing = '0px';
        if (timing.footer) {
          ctx.font = `400 24px ${MONO}`;
          ctx.fillText(timing.footer, W / 2, H * 0.61);
        }
        ctx.restore();
      }
      paintGrain(f, 0.04);
      paintVignette(0.9);
    };
  }

  /**
   * The visualizer: a full-frame instrument for songs with no words to
   * show — and the fallback when a lyric video finds none. Three forms
   * (ring, bars, waves), chosen per song by the director, all driven by
   * the measured bands and lit on onsets. Title and artist ride a quiet
   * translucent strip at the foot, with a thin progress line under it.
   */
  function visualizerScene() {
    const form = style.visForm || 'ring';
    const palette = style.verseAccents || RAMP;
    const spin = (style.visSpin === -1 ? -1 : 1);
    const cx = W / 2;
    const cy = H * 0.46;

    const col = (i, n) => palette[i % palette.length];

    function lowerThird(t) {
      ctx.save();
      ctx.fillStyle = 'rgba(4,5,9,0.42)';
      ctx.fillRect(0, H - 110, W, 110);
      ctx.fillStyle = 'rgba(242,245,250,0.08)';
      ctx.fillRect(0, H - 110, W, 1.5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `${DW} 34px ${DISPLAY}`;
      ctx.letterSpacing = '4px';
      ctx.fillStyle = `rgba(${rgb(INK)},0.92)`;
      ctx.fillText(timing.title.toUpperCase(), W * 0.045, H - 58);
      ctx.font = `500 20px ${TEXTY}`;
      ctx.letterSpacing = '7px';
      ctx.fillStyle = `rgba(${rgb(DIM)},0.95)`;
      ctx.fillText(timing.artist.toUpperCase(), W * 0.045, H - 28);
      ctx.letterSpacing = '0px';
      if (timing.footer) {
        ctx.textAlign = 'right';
        ctx.font = `400 18px ${MONO}`;
        ctx.fillText(timing.footer, W * 0.955, H - 32);
      }
      // The progress line: how far into the song we are.
      ctx.fillStyle = `rgba(${rgb(style.titleAccent || palette[0])},0.85)`;
      ctx.fillRect(0, H - 3, W * clamp01(t / DUR), 3);
      ctx.restore();
    }

    /** Recent onsets as expanding, fading rings. */
    function onsetRings(t, maxR) {
      for (const o of analysis.onsets) {
        if (o > t) break;
        const age = t - o;
        if (age > 0.7) continue;
        const a = (1 - age / 0.7) * 0.22;
        ctx.strokeStyle = `rgba(${rgb(palette[Math.floor(o * 7) % palette.length])},${a.toFixed(3)})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, maxR * (0.55 + age * 1.1), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    return (t, f) => {
      const bass = atSm('bass', t, 3);
      const mid = at('mid', t);
      const high = at('high', t);
      const kick = onsetKick(t, 0.14) * KICK_K;

      // Ground: near-black with a breathing wash where the form lives.
      ctx.fillStyle = '#05060A';
      ctx.fillRect(0, 0, W, H);
      const wash = ctx.createRadialGradient(cx, cy, 0, cx, cy, H * 0.72);
      wash.addColorStop(0, `rgba(${rgb(palette[0])},${(0.05 + bass * 0.05).toFixed(3)})`);
      wash.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      if (form === 'ring') {
        const R0 = H * 0.2 * (1 + bass * 0.1 * PUMP_K + kick * 0.05);
        const spokes = 72;
        const rot = t * 0.14 * spin;
        for (let i = 0; i < spokes; i++) {
          const ang = rot + (i / spokes) * Math.PI * 2;
          // Low bands live at the foot of the ring, highs at the crown.
          const pos = (Math.sin(ang) + 1) / 2;
          const e = pos < 0.34 ? atSm('bass', t, 1) : pos < 0.72 ? mid : high;
          const jitter = 0.65 + 0.35 * Math.sin(i * 37.7 + t * 2.2);
          const len = H * 0.04 + e * H * 0.17 * jitter + kick * H * 0.02;
          const r1 = R0;
          const r2 = R0 + len;
          ctx.strokeStyle = `rgba(${rgb(col(i, spokes))},0.8)`;
          ctx.lineWidth = 4.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
          ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
          ctx.stroke();
        }
        const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R0 * 0.92);
        core.addColorStop(0, `rgba(${rgb(palette[0])},${(0.2 + bass * 0.3).toFixed(3)})`);
        core.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(cx, cy, R0 * 0.92, 0, Math.PI * 2);
        ctx.fill();
        onsetRings(t, R0 + H * 0.2);
      }

      if (form === 'bars') {
        const n = 56;
        const bw = (W * 0.82) / n;
        const x0 = W * 0.09;
        const base = cy + H * 0.02;
        for (let i = 0; i < n; i++) {
          const pos = i / n;
          const e = pos < 0.3 ? atSm('bass', t, 1) : pos < 0.7 ? at('mid', t) : at('high', t);
          const jitter = 0.6 + 0.4 * Math.sin(i * 91.3 + t * 1.9);
          const h = 8 + e * H * 0.3 * jitter + kick * H * 0.02;
          ctx.fillStyle = `rgba(${rgb(col(i, n))},0.75)`;
          ctx.fillRect(x0 + i * bw + 1.5, base - h, bw - 3, h);
          ctx.fillStyle = `rgba(${rgb(col(i, n))},0.3)`;
          ctx.fillRect(x0 + i * bw + 1.5, base + 4, bw - 3, h * 0.4);
          // The cap: where this bar peaked over the last third of a second.
          let peak = 0;
          const f0 = Math.max(0, Math.round((t - 0.35) * FPS));
          const f1 = Math.min(S.bass.length - 1, Math.round(t * FPS));
          const arr = pos < 0.3 ? S.bass : pos < 0.7 ? S.mid : S.high;
          for (let k = f0; k <= f1; k++) peak = Math.max(peak, arr[k]);
          const ph = 8 + peak * H * 0.3 * jitter;
          ctx.fillStyle = `rgba(${rgb(INK)},0.5)`;
          ctx.fillRect(x0 + i * bw + 1.5, base - ph - 5, bw - 3, 2.5);
        }
      }

      if (form === 'waves') {
        const ribbons = 4;
        for (let r = 0; r < ribbons; r++) {
          const e = r === 0 ? bass : r === 1 ? mid : r === 2 ? high : at('rms', t);
          const amp = H * (0.03 + e * 0.13) * (1 + kick * 0.3);
          const yBase = H * (0.3 + r * 0.11);
          const k = 2.2 + r * 1.3;
          const speed = (r % 2 ? -1 : 1) * spin * (0.8 + r * 0.35);
          ctx.strokeStyle = `rgba(${rgb(col(r, ribbons))},0.7)`;
          ctx.lineWidth = 3.2 - r * 0.4;
          ctx.beginPath();
          for (let x = 0; x <= W; x += 8) {
            const u = x / W;
            const env = Math.sin(u * Math.PI); // quiet at the edges
            const y = yBase
              + Math.sin(u * Math.PI * 2 * k + t * speed * 2.6) * amp * env
              + Math.sin(u * Math.PI * 2 * (k * 2.7) + t * speed * 1.7) * amp * 0.3 * env;
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        onsetRings(t, H * 0.3);
      }

      ctx.restore();
      lowerThird(t);
      paintGrain(f, 0.045 + kick * 0.02);
      paintVignette(0.8);
    };
  }

  /* The scene list: contiguous spans, each owning the frame while active.
     Scenes get generous handoff overlap via their own enter/exit ramps. */
  const scenes = style.world === 'scroll'
    ? [{ name: 'scroll', t0: 0, t1: DUR2, paint: scrollScene() }]
    : style.world === 'visualizer'
      ? [{ name: 'visualizer', t0: 0, t1: DUR2, paint: visualizerScene() }]
      : buildScenes();

  function buildScenes() {
    const out = [];
    let chorusCount = 0;
    let verseCount = 0;
    let preCount = 0;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const prev = out[out.length - 1];
      const start = prev ? prev.t1 : 0;
      const end = i + 1 < sections.length ? sections[i + 1].t0 : DUR2;

      if (s.kind === 'chant') {
        out.push({ name: `chant-${s.id}`, t0: start, t1: end, paint: chantScene(s) });
      } else if (s.kind === 'mono') {
        out.push({ name: `mono-${s.id}`, t0: start, t1: end, paint: monoVerseScene(s) });
      } else if (s.kind === 'verse') {
        verseCount++;
        out.push({ name: `verse-${s.id}`, t0: start, t1: end, paint: verseScene(s, verseCount) });
      } else if (s.kind === 'pre') {
        preCount++;
        out.push({ name: `pre-${s.id}`, t0: start, t1: end, paint: preScene(s, preCount) });
      } else if (s.kind === 'chorus') {
        chorusCount++;
        out.push({ name: `chorus-${s.id}`, t0: start, t1: end, paint: chorusScene(s, chorusCount) });
      } else if (s.kind === 'tag') {
        out.push({ name: `tag-${s.id}`, t0: start, t1: end, paint: tagScene(s) });
      } else {
        const isFirst = s.t0 < 5;
        const isOutro = (s.t1 - s.t0) > 12 && s.t0 > DUR * 0.5;
        const isEnd = s.t0 > DUR - 8;
        let painter;
        if (isFirst) painter = titleScene(s);
        else if (isOutro) painter = outroScene(s);
        else if (isEnd) painter = endcardScene(s);
        else painter = interludeScene(s);
        out.push({ name: s.id, t0: start, t1: end, paint: painter });
      }
    }
    return out;
  }

  /* ---------------------------------------------------------- the scenes -- */

  /** Cold open + later strobe chant: one slam per repeat, alternating.
      A slam HOLDS until the next repeat's first word lands — the frame is
      never empty mid-chant. */
  function chantScene(section) {
    const isCold = section.t0 < 5;
    const accent = isCold ? CYAN : RED;
    const flips = section.lines.map((l) => Math.min(...l.words.map((w) => w.t0)));
    return (t, f) => {
      paintBackdrop();
      let idx = -1;
      for (let i = 0; i < flips.length; i++) if (t >= flips[i]) idx = i;
      // The room flashes for a beat on every slam landing.
      const flashK = idx >= 0 ? 1 - clamp01(span(t, flips[idx], flips[idx] + 2.5 / FPS)) : 0;
      // The room this song is in, lit by the slam. A featureless black card
      // reads as a dropped layer rather than restraint, but the room has to
      // be the song's own — this lit the venue's wall even for a song set by
      // a candle.
      if (isCold) {
        paintWorld(t, { panels: 0.15 + flashK * 0.4, live: 0.4, beam: 0.28 + flashK * 0.35, color: accent });
      } else {
        paintWorld(t, { panels: 0.5 + flashK * 0.4, live: 1, beam: 0.5, color: accent });
      }
      if (idx >= 0) {
        const line = section.lines[idx];
        const lay = layoutFor(line, 'chant');
        const flip = idx % 2 === 1;
        const grow = isCold ? 1 : Math.min(1.12, 1 + idx * 0.03);
        // Strobe: odd repeats invert the frame.
        if (!isCold && flip) {
          ctx.fillStyle = INK;
          ctx.fillRect(0, 0, W, H);
        }
        const kick = onsetKick(t, 0.1);
        const shake = isCold ? 0 : kick * 7;
        // Every slam LANDS: an overshoot-and-drop envelope wide enough to
        // read at any sampling — six frames of settle, not a one-frame blip.
        const hit = 1 - easeOutCubic(span(t, flips[idx], flips[idx] + 0.2));
        const land = 1 + 0.16 * hit;
        ctx.save();
        ctx.translate(
          W / 2 + (idx % 3 - 1) * W * 0.02 + shake * Math.sin(f * 2.1),
          H / 2 + (idx % 2 ? H * 0.04 : -H * 0.03) + shake * Math.cos(f * 1.7) + hit * 16,
        );
        ctx.scale(grow * land, grow * land);
        for (const wd of lay.words) {
          // The first cycle builds word by word; later cycles hold the
          // previous slam's words until each re-pops on its own time.
          const wt = t >= wd.t0 ? t : (idx > 0 ? wd.t1 + 1 : t);
          paintWord(wd, wt, {
            slam: true,
            popIn: 0.1,
            accent,
            ink: !isCold && flip ? BG : INK,
            singingAccent: !isCold,
          });
        }
        ctx.restore();
        // A two-frame white pop right on the slam.
        if (t - flips[idx] < 2 / FPS) {
          ctx.fillStyle = `rgba(255,255,255,${t - flips[idx] < 1 / FPS ? 0.18 : 0.1})`;
          ctx.fillRect(0, 0, W, H);
        }
      }
      if (isCold && idx < 0 && t < section.lines[0].t0) {
        // A caret holds the silence before the first slam.
        const on = Math.floor(t * 2.4) % 2 === 0;
        if (on) {
          ctx.fillStyle = CYAN;
          ctx.fillRect(W / 2 - 14, H / 2 - 34, 28, 68);
        }
      }
      paintGrain(f, isCold ? 0.05 : 0.08 + onsetKick(t) * 0.05);
      paintVignette(isCold ? 0.8 : 0.5);
    };
  }

  /** The build: world reveal + title lockup, two balanced rows. */
  function titleScene(section) {
    // Split the title into two rows at the midpoint word, sized together.
    const words = timing.title.toUpperCase().split(/\s+/);
    const mid = Math.ceil(words.length / 2);
    const rowsText = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')].filter(Boolean);
    const size = Math.min(
      ...rowsText.map((r) => fitSize(r, W * 0.62, DISPLAY, DW)),
      H * 0.21,
    );
    // A short intro compresses the whole reveal schedule to fit.
    const k = Math.max(0.32, Math.min(1, (section.t1 - section.t0) / 9.9));
    const igniteT0 = section.t0 + 1.2 * k;
    const igniteStep = 1.1 * k;
    return (t, f) => {
      paintBackdrop();
      paintWorld(t, {
        panels: easeOutCubic(span(t, section.t0, section.t0 + 3 * k)) * 0.55,
        beam: easeOutCubic(span(t, section.t0 + 0.4 * k, section.t0 + 2.6 * k)),
        color: style.titleAccent || CYAN,
      });

      const a1 = span(t, section.t0 + 0.6 * k, section.t0 + 1.4 * k);
      if (a1 > 0) {
        ctx.save();
        ctx.globalAlpha = a1;
        ctx.font = `500 30px ${TEXTY}`;
        ctx.textAlign = 'center';
        ctx.letterSpacing = '14px';
        ctx.fillStyle = DIM;
        ctx.fillText(timing.artist.toUpperCase(), W / 2, H * 0.24);
        ctx.letterSpacing = '0px';
        ctx.restore();
      }

      const pump = 1 + atSm('bass', t, 5) * 0.012 * PUMP_K;
      ctx.save();
      ctx.translate(W / 2, H * 0.5);
      ctx.scale(pump, pump);
      rowsText.forEach((row, ri) => {
        const u = span(t, igniteT0 + ri * igniteStep, igniteT0 + ri * igniteStep + 0.5);
        if (u <= 0) return;
        const e = easeOutQuint(u);
        ctx.save();
        ctx.globalAlpha = e;
        ctx.translate(0, (ri - (rowsText.length - 1) / 2) * size * 0.98);
        ctx.scale(lerp(1.06, 1, e), lerp(1.06, 1, e));
        ctx.font = `${DW} ${size}px ${DISPLAY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = `rgba(${rgb(style.titleAccent || CYAN)},0.5)`;
        ctx.shadowBlur = size * 0.14;
        // The last word of the title carries the accent.
        if (ri === rowsText.length - 1) {
          const parts = row.split(' ');
          const last = parts.pop();
          const head = parts.join(' ');
          const headW = head ? textW(head, `${DW} ${size}px ${DISPLAY}`) : 0;
          const lastW = textW(last, `${DW} ${size}px ${DISPLAY}`);
          const gap = head ? size * 0.22 : 0;
          const total = headW + gap + lastW;
          if (head) {
            ctx.fillStyle = INK;
            ctx.fillText(head, -total / 2 + headW / 2, 0);
          }
          ctx.fillStyle = style.titleAccent || CYAN;
          ctx.fillText(last, total / 2 - lastW / 2, 0);
        } else {
          ctx.fillStyle = INK;
          ctx.fillText(row, 0, 0);
        }
        ctx.restore();
      });
      ctx.restore();

      const a2 = span(t, section.t0 + 2.6 * k, section.t0 + 3.4 * k);
      if (a2 > 0 && timing.footer) {
        ctx.save();
        ctx.globalAlpha = a2 * 0.8;
        ctx.font = `400 26px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = DIM;
        ctx.fillText(timing.footer, W / 2, H * 0.78);
        ctx.restore();
      }
      paintGrain(f, 0.05 + at('flux', t) * 0.02);
      paintVignette(1);
    };
  }

  /** Verses: a station per line; camera hands off between them. Each verse
      section advances the palette — the arc walks the brand ramp. */
  function verseScene(section, which) {
    const accent = VERSE_ACCENTS[Math.min(which - 1, VERSE_ACCENTS.length - 1)];
    return (t, f) => {
      paintBackdrop();
      paintWorld(t, { panels: 0.32, live: 0.5, cam: { x: t * 30, y: 0, scale: 1 }, beam: 0.7, color: accent });

      section.lines.forEach((line, li) => {
        const next = section.lines[li + 1];
        const enter = span(t, line.t0 - 0.45, line.t0 + 0.1);
        const exitStart = next ? next.t0 - 0.55 : line.t1 + 1.0;
        const exit = span(t, exitStart, exitStart + 0.55);
        // A line that has finished is GONE — it exits fading and never
        // parks. Remnants without a job read as debris, not memory; the
        // only accumulations left are the drop marquee and the outro
        // constellation, which are composed for it.
        if (enter <= 0 || exit >= 1) return;
        const lay = layoutFor(line);
        const device = line.device || null;
        ctx.save();
        // A line arrives with a little travel, but it LEAVES in place — a
        // finished line fades where it stands, it does not slide off.
        const slideIn = (1 - easeOutCubic(enter)) * W * 0.06;
        ctx.translate(W / 2 + slideIn, H * TXC);
        const pump = 1 + atSm('bass', t, 4) * 0.014 * PUMP_K;
        ctx.scale(pump * lerp(1.03, 1, easeOutCubic(enter)), pump * lerp(1.03, 1, easeOutCubic(enter)));
        ctx.globalAlpha = easeOutCubic(enter) * (1 - easeInOutCubic(exit));
        for (const wd of lay.words) {
          // The vanish device: each word dissolves shortly after it is sung
          // — for lines about things disappearing one by one.
          const va = device === 'vanish'
            ? 1 - easeInOutCubic(span(t, wd.t1 + 0.55, wd.t1 + 1.15))
            : 1;
          if (va <= 0) continue;
          paintWord(wd, t, { accent, singingAccent: true, preview: false, popIn: 0.16, alpha: va });
        }
        // The redaction device: uniform bars sit over the words that have not
        // been sung yet, and each lifts away exactly as its word arrives.
        if (device === 'redact') {
          const bh = Math.min(lay.lineH * 0.82, 104);
          for (const wd of lay.words) {
            const lift = easeOutCubic(span(t, wd.t0 - 0.02, wd.t0 + 0.22));
            if (lift >= 0.85) continue; // gone before it can read as debris
            const bw = textW(wd.word, `${wd.weight} ${wd.size}px ${wd.family}`) + wd.size * 0.12;
            ctx.save();
            ctx.translate(wd.x, wd.y - lift * bh * 0.5);
            ctx.globalAlpha = (1 - lift) ** 1.6;
            ctx.fillStyle = '#131722';
            ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
            ctx.restore();
          }
        }
        ctx.restore();
      });
      paintGrain(f, 0.05);
      paintVignette(1);
    };
  }

  /** The mono verse: reading the source. */
  function monoVerseScene(section) {
    const accent = VIOLET;
    return (t, f) => {
      paintBackdrop();
      paintWorld(t, { panels: 0.22, live: 0.4, beam: 0.45, color: accent });

      // One true gutter column — every number shares it, like an editor.
      const GUTTER = W * 0.16;
      ctx.save();
      ctx.font = `400 34px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(110,120,137,0.5)';
      section.lines.forEach((line, li) => {
        if (t < line.t0 - 0.3) return;
        const next = section.lines[li + 1];
        const exitStart = next ? next.t0 - 0.25 : line.t1 + 1.1;
        const settled = span(t, exitStart, exitStart + 0.7) >= 1;
        if (!settled && t >= exitStart) return; // mid-flight: no number to point at
        // A read line lingers just long enough to feel like context, then
        // dissolves with its number — nothing camps on screen.
        const dissolve = settled ? 1 - span(t, exitStart + 1.4, exitStart + 2.6) : 1;
        if (dissolve <= 0) return;
        ctx.save();
        ctx.globalAlpha = dissolve;
        const y = settled ? H * (0.18 + li * 0.075) : H * 0.5;
        ctx.fillText(String(li + 1), GUTTER - 28, y + 12);
        ctx.restore();
      });
      ctx.restore();

      section.lines.forEach((line, li) => {
        const next = section.lines[li + 1];
        const enter = span(t, line.t0 - 0.3, line.t0);
        const exitStart = next ? next.t0 - 0.25 : line.t1 + 1.1;
        const exit = span(t, exitStart, exitStart + 0.7);
        if (enter <= 0) return;
        const lay = layoutFor(line, 'mono');
        const settled = exit >= 1;
        // Read lines hold briefly as context, then dissolve — they do not
        // camp in the corner for the rest of the verse.
        const dissolve = settled ? 1 - span(t, exitStart + 1.4, exitStart + 2.6) : 1;
        if (dissolve <= 0) return;
        ctx.save();
        if (settled) {
          // Read lines stack up small, left-aligned to the gutter.
          ctx.translate(GUTTER + (lay.w * 0.42) / 2, H * (0.18 + li * 0.075));
          ctx.scale(0.42, 0.42);
          ctx.globalAlpha = 0.34 * dissolve;
        } else {
          const ex = easeInOutCubic(exit);
          const sc = lerp(1, 0.62, ex);
          // The live line grows from the gutter too — one left edge, always.
          ctx.translate(lerp(GUTTER + lay.w / 2, GUTTER + (lay.w * sc) / 2, ex), H * 0.5 - ex * H * 0.26);
          ctx.scale(sc, sc);
          ctx.globalAlpha = 1 - ex * 0.55;
        }
        for (const wd of lay.words) {
          paintWord(wd, t, { accent, singingAccent: true, popIn: 0.12 });
        }
        // Caret rides the currently sung word.
        if (!settled) {
          const cur = [...lay.words].reverse().find((wd) => t >= wd.t0);
          if (cur && t < line.t1 + 0.3) {
            const on = Math.floor(t * 3) % 2 === 0;
            if (on) {
              ctx.fillStyle = accent;
              const cw = textW(cur.word, `${cur.weight} ${cur.size}px ${cur.family}`);
              ctx.fillRect(cur.x + cw / 2 + 10, cur.y - cur.size * 0.44, 6, cur.size * 0.88);
            }
          }
        }
        ctx.restore();
      });
      paintGrain(f, 0.05);
      paintVignette(1);
    };
  }

  /**
   * Pre-chorus: the crack. The line sets as ONE row, and on "open" a seam
   * splits it straight through the glyphs — the upper and lower halves part,
   * light pours out of the gap, and the whole thing breathes on the bass.
   */
  function preScene(section, which = 1) {
    const line = section.lines[0];
    const SEAM = -0.055;
    // The first crack is night-cyan; a reprise cracks warm — dawn through it.
    const accent = which === 1 ? CYAN : AMBER;
    const seamLight = which === 1 ? '#CFF2FF' : '#FFE9C8';
    // The seam row is the phrase before the comma; what follows arrives
    // beneath the crack, breathing. The composition enacts the lyric.
    const commaAt = line.words.findIndex((w) => /,$/.test(w.word));
    const crackWords = commaAt >= 0 ? line.words.slice(0, commaAt + 1) : line.words;
    const restWords = commaAt >= 0 ? line.words.slice(commaAt + 1) : [];
    const crackLine = {
      ...line,
      words: crackWords.map((w) => ({ ...w, word: w.word.replace(/,$/, '') })),
      text: crackWords.map((w) => w.word.replace(/,$/, '')).join(' '),
    };
    return (t, f) => {
      paintBackdrop();
      paintWorld(t, { panels: 0.3, live: 0.5 });
      const openWord = line.words.find((w) => /open/i.test(w.word));
      const crackAt = openWord ? openWord.t0 : line.t0 + 1;
      // The break SNAPS — a few frames, not a linear creep.
      const crack = CRACK_OK ? easeOutExpo(span(t, crackAt, crackAt + 0.45)) : 0;
      // A stage beam belongs on a stage. Elsewhere the world has already
      // been painted above and does not want the venue's lighting rig in it.
      if (WORLD === 'venue') paintBeam(t, 0.55 + crack * 0.45, accent);

      const lay = layoutSlam(crackLine, { width: W * 0.66 });
      const breathe = 1 + atSm('bass', t, 6) * 0.03 * PUMP_K * (1 + crack);
      // The gap scales with the glyphs — a hairline on a huge slam, still a
      // visible break on a long small line.
      const glyph = lay.words[0] ? lay.words[0].size : 120;
      const halfGap = crack * Math.max(9, glyph * 0.1);
      // The line arrives as its own element, not a teleport from the verse.
      const arrive = easeOutCubic(span(t, line.t0 - 0.35, line.t0 + 0.05));

      // A sliver of light escapes the seam — a crack, not a floodlight.
      if (crack > 0.01) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.translate(W / 2, H * TXC);
        ctx.rotate(SEAM);
        const g = ctx.createLinearGradient(0, -halfGap * 3, 0, halfGap * 3);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(0.5, `rgba(${rgb(seamLight)},${(0.4 * crack).toFixed(3)})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(-W, -halfGap * 3 - 2, W * 2, halfGap * 6 + 4);
        ctx.fillStyle = `rgba(${rgb(seamLight)},${(0.7 * crack).toFixed(3)})`;
        ctx.fillRect(-W * 0.42, -1.2, W * 0.84, 2.4);
        ctx.restore();
      }

      for (const half of (CRACK_OK ? [-1, 1] : [0])) {
        ctx.save();
        ctx.translate(W / 2, H * TXC);
        if (half !== 0) {
          ctx.rotate(SEAM);
          // Push the half away FIRST, then clip in the moved space — the
          // clip travels with the glyphs, so each half shows only its own
          // side and nothing is ever drawn twice (the double-exposure bug).
          ctx.translate(crack * 14 * half * -0.5, half * halfGap);
          ctx.beginPath();
          ctx.rect(-W, half < 0 ? -H : 0.5, W * 2, H);
          ctx.clip();
          ctx.rotate(-SEAM);
        }
        ctx.scale(breathe, breathe);
        ctx.globalAlpha = arrive;
        ctx.translate(0, (1 - arrive) * 26);
        for (const wd of lay.words) {
          paintWord(wd, t, { accent, singingAccent: true, popIn: 0.18 });
        }
        ctx.restore();
      }

      // "let it breathe" — under the crack, swelling with the low end.
      if (restWords.length) {
        const bSize = 56;
        const bFont = `600 ${bSize}px ${TEXTY}`;
        const gap = bSize * 0.5;
        const widths = restWords.map((w) => textW(w.word.toUpperCase(), bFont));
        const total = widths.reduce((a, b) => a + b, 0) + gap * (restWords.length - 1);
        const swell = 1 + atSm('bass', t, 5) * 0.09 * PUMP_K;
        ctx.save();
        ctx.translate(W / 2, H * 0.66);
        ctx.scale(swell, swell);
        let x = -total / 2;
        restWords.forEach((w, i) => {
          const u = span(t, w.t0, w.t0 + 0.3);
          if (u > 0) {
            ctx.save();
            ctx.globalAlpha = easeOutCubic(u);
            ctx.font = bFont;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = t <= w.t1 + 0.15 ? accent : INK;
            ctx.fillText(w.word.toUpperCase(), x + widths[i] / 2, 0);
            ctx.restore();
          }
          x += widths[i] + gap;
        });
        ctx.restore();
      }
      paintGrain(f, 0.05 + crack * 0.02);
      paintVignette(1);
    };
  }

  /**
   * Choruses: the anthem plate. The plate NEVER leaves the frame — each line
   * re-slams it, anchored to the line's first sung word, and later choruses
   * invert the frame on alternate slams. A finished plate holds until the
   * next slam, so there is no empty frame between lines.
   */
  function chorusScene(section, which) {
    const flips = section.lines.map((l) => Math.min(...l.words.map((w) => w.t0)));
    return (t, f) => {
      let idx = -1;
      for (let i = 0; i < flips.length; i++) if (t >= flips[i]) idx = i;
      const line = section.lines[Math.max(0, idx)];
      // Alternate slams invert the frame — the panel's favourite move.
      const inverted = INVERT_OK && idx >= 0 && idx % 2 === 1;
      const accent = CHORUS_ACCENTS[Math.min(which - 1, CHORUS_ACCENTS.length - 1)];

      paintBackdrop();
      if (inverted) {
        ctx.fillStyle = INK;
        ctx.fillRect(0, 0, W, H);
        if (WORLD === 'venue') paintPanels(t, 0.07, 0.6);
      } else {
        paintWorld(t, { panels: which > 1 ? 0.55 : 0.35, live: 0.9, beam: 0.85, color: accent });
      }

      const isStamp = /fork/i.test(line.text);
      const lay = isStamp ? layoutSlamStamps(line) : layoutFor(line, 'chorus');
      const pump = 1 + atSm('bass', t, 3) * 0.03 * PUMP_K;
      const kick = onsetKick(t, 0.09) * KICK_K;
      // Before the first word nothing is drawn — a plate faintly on screen
      // before anything is sung reads as words arriving early, because it is.
      if (idx < 0) {
        paintGrain(f, 0.05);
        paintVignette(0.9);
        return;
      }
      const preview = false;
      // The stack composes at every moment: the landed rows' weighted centre
      // rides the frame centre, so a half-built plate is never top-anchored.
      let sumW = 0;
      let sumWY = 0;
      for (const wd of lay.words) {
        let w;
        if (t >= wd.t0) w = 0.15 + 0.85 * easeOutCubic(span(t, wd.t0, wd.t0 + 0.25));
        else if (idx > 0 && !isStamp) w = 1;
        else w = isStamp ? 0.02 : 0.15;
        sumW += w;
        sumWY += w * wd.y;
      }
      const recentre = sumW > 0 ? -(sumWY / sumW) : 0;
      ctx.save();
      ctx.translate(W / 2 + kick * 4 * Math.sin(f * 2.3), H * TXC + kick * 4 * Math.cos(f * 1.9));
      ctx.scale(pump, pump);
      ctx.translate(0, recentre);
      for (const wd of lay.words) {
        // Words pop on their own time; on a re-slam, rows whose word has not
        // come around yet HOLD from the previous cycle rather than vanishing.
        let wt = t;
        if (preview) wt = wd.t1 + 1;
        else if (t < wd.t0 && idx > 0 && !isStamp) wt = wd.t1 + 1;
        paintWord(wd, wt, {
          accent,
          ink: inverted ? BG : INK,
          slam: !isStamp,
          popIn: isStamp ? 0.12 : 0.16,
          shadow: !inverted,
          alpha: preview ? 0.14 : 1,
        });
      }
      ctx.restore();
      if (idx >= 0 && t - flips[idx] < 2 / FPS) {
        ctx.fillStyle = `rgba(255,255,255,${((idx === 0 ? 0.24 : 0.15) * M).toFixed(3)})`;
        ctx.fillRect(0, 0, W, H);
      }
      paintGrain(f, 0.06 + onsetKick(t) * 0.04);
      paintVignette(inverted ? 0.3 : 0.9);
    };

    /** "Fork it, ship it, let them in": three tilted stamps, height-capped. */
    function layoutSlamStamps(line) {
      const phrases = [];
      let cur = [];
      for (const wd of line.words) {
        cur.push(wd);
        if (/[,]$/.test(wd.word) || wd === line.words[line.words.length - 1]) {
          phrases.push(cur);
          cur = [];
        }
      }
      const texts = phrases.map((ph) => ph.map((w) => w.word.replace(/,/g, '').toUpperCase()).join(' '));
      let sizes = texts.map((text) => fitSize(text, W * 0.5, DISPLAY, DW));
      const fitH = Math.min(1, (H * 0.7) / sizes.reduce((a, s) => a + s * 1.04, 0));
      sizes = sizes.map((s) => s * fitH);
      const out = [];
      phrases.forEach((ph, pi) => {
        const size = sizes[pi];
        const y = (pi - (phrases.length - 1) / 2) * size * 1.04;
        const rot = (pi % 2 === 0 ? -1 : 1) * 0.045;
        const font = `900 ${size}px ${DISPLAY}`;
        const gap = size * 0.24;
        const widths = ph.map((w) => textW(w.word.replace(/,/g, '').toUpperCase(), font));
        const total = widths.reduce((a, b) => a + b, 0) + gap * (ph.length - 1);
        let x = -total / 2;
        ph.forEach((wd, i) => {
          out.push({
            word: wd.word.replace(/,/g, '').toUpperCase(),
            t0: wd.t0,
            t1: wd.t1,
            x: (x + widths[i] / 2) * Math.cos(rot) + (pi - 1) * 8,
            y: y + (x + widths[i] / 2) * Math.sin(rot),
            size,
            family: DISPLAY,
            weight: 900,
            rot,
            role: pi === phrases.length - 1 ? 'accent' : 'ink',
          });
          x += widths[i] + gap;
        });
      });
      return { words: out, w: W * 0.52, h: 0 };
    }
  }

  /** Tags: a lone phrase owning the room. The last one closes the film. */
  function tagScene(section) {
    const line = section.lines[0];
    const isFinal = line.t0 > DUR - 8;
    return (t, f) => {
      paintBackdrop();
      const hasMono = timing.lines.some((l) => l.kind === 'mono');
      if (isFinal && !hasMono) {
        // The dawn close: the last line small and calm in the song's own
        // voice, over whatever the world has become.
        paintWorld(t, { panels: 0.2, beam: 0.25, color: style.titleAccent || CYAN });
        const a = easeOutCubic(span(t, line.t0 - 0.2, line.t0 + 0.6));
        ctx.save();
        ctx.globalAlpha = a;
        // Fit the closing line to the frame — a long coda must not bleed.
        ctx.letterSpacing = '6px';
        ctx.textAlign = 'center';
        ctx.fillStyle = INK;
        let closeSize = 44;
        ctx.font = `${TEXT_STYLE}600 ${closeSize}px ${TEXTY}`;
        const cw = ctx.measureText(line.text.toUpperCase()).width;
        if (cw <= W * 0.88) {
          ctx.fillText(line.text.toUpperCase(), W / 2, H * 0.42);
        } else {
          // Two balanced rows beat one illegible sliver.
          const words = line.text.toUpperCase().split(/\s+/);
          let split = Math.ceil(words.length / 2);
          for (let k = Math.ceil(words.length / 2); k < words.length; k++) {
            if (ctx.measureText(words.slice(0, k).join(' ')).width <= W * 0.88) split = k; else break;
          }
          const rows = [words.slice(0, split).join(' '), words.slice(split).join(' ')];
          const wide = Math.max(...rows.map((r) => ctx.measureText(r).width));
          closeSize = Math.min(44, Math.floor((44 * W * 0.86) / wide));
          ctx.font = `${TEXT_STYLE}600 ${closeSize}px ${TEXTY}`;
          rows.forEach((r, ri) => {
            ctx.fillText(r, W / 2, H * (0.385 + ri * 0.062));
          });
        }
        ctx.letterSpacing = '0px';
        const a2c = span(t, line.t0 + 0.7, line.t0 + 1.4);
        if (a2c > 0) {
          ctx.globalAlpha = a * a2c;
          ctx.font = `${DW} 34px ${DISPLAY}`;
          ctx.letterSpacing = '8px';
          ctx.fillStyle = INK;
          ctx.fillText(timing.title.toUpperCase(), W / 2, H * 0.505);
          ctx.font = `500 28px ${TEXTY}`;
          ctx.letterSpacing = '12px';
          ctx.fillStyle = DIM;
          ctx.fillText(timing.artist.toUpperCase(), W / 2, H * 0.565);
          ctx.letterSpacing = '0px';
          if (timing.footer) {
            ctx.font = `400 24px ${MONO}`;
            ctx.fillText(timing.footer, W / 2, H * 0.615);
          }
        }
        ctx.restore();
        paintGrain(f, 0.05);
        paintVignette(0.8);
        return;
      }
      if (isFinal) {
        // Quiet end: typed mono phrase, caret, then the sign-off.
        if (WORLD === 'venue') paintBeam(t, 0.2, style.titleAccent || CYAN);
        const lay = layoutMono(line, { size: 74 });
        ctx.save();
        ctx.translate(W / 2, H * 0.46);
        for (const wd of lay.words) paintWord(wd, t, { accent: CYAN, popIn: 0.1 });
        const on = Math.floor(t * 2.6) % 2 === 0;
        const last = lay.words[lay.words.length - 1];
        if (on && t > line.t0) {
          const cw = textW(last.word, `${last.weight} ${last.size}px ${last.family}`);
          ctx.fillStyle = CYAN;
          ctx.fillRect(last.x + cw / 2 + 12, last.y - last.size * 0.42, 7, last.size * 0.84);
        }
        ctx.restore();
        const a = span(t, line.t1 + 0.8, line.t1 + 1.6);
        if (a > 0) {
          ctx.save();
          ctx.globalAlpha = a;
          ctx.font = `${DW} 36px ${DISPLAY}`;
          ctx.letterSpacing = '8px';
          ctx.textAlign = 'center';
          ctx.fillStyle = INK;
          ctx.fillText(timing.title.toUpperCase(), W / 2, H * 0.60);
          ctx.font = `500 30px ${TEXTY}`;
          ctx.letterSpacing = '12px';
          ctx.fillStyle = DIM;
          ctx.fillText(timing.artist.toUpperCase(), W / 2, H * 0.66);
          ctx.letterSpacing = '0px';
          if (timing.footer) {
            ctx.font = `400 24px ${MONO}`;
            ctx.fillStyle = `rgba(${rgb(DIM)},0.8)`;
            ctx.fillText(timing.footer, W / 2, H * 0.72);
          }
          ctx.restore();
        }
      } else {
        // Mid-song echo: the phrase glows alone over the live room.
        paintWorld(t, { panels: 0.6, live: 1, beam: 0.9, color: CYAN });
        const lay = layoutFor(line, 'chant');
        const held = span(t, line.t0, line.t0 + 0.5);
        ctx.save();
        ctx.translate(W / 2, H / 2);
        const pump = 1 + atSm('bass', t, 3) * 0.05 * PUMP_K;
        ctx.scale(pump * lerp(0.96, 1, easeOutCubic(held)), pump * lerp(0.96, 1, easeOutCubic(held)));
        for (const wd of lay.words) {
          paintWord(wd, t, { accent: CYAN, slam: true, popIn: 0.14, shadow: true });
        }
        ctx.restore();
      }
      paintGrain(f, 0.05);
      paintVignette(1);
    };
  }

  /**
   * An instrumental stretch: the song's own world, carried through it.
   *
   * There used to be two "drop" scenes here for the breaks — a wall of stage
   * lights and a rush of rainbow streaks — and they cut to the same venue
   * furniture no matter where the song lived. A road song arrived at its
   * bridge and jumped to a coloured stage; a candle song did too. Rich named
   * it exactly: always the same, and distracting. A break in the singing is
   * not a change of place.
   *
   * So the break stays where the song is, and the world opens up a little to
   * carry it: the horizon runs on, the candle keeps burning, the rain keeps
   * falling. Everything here reads the music, so a loud break looks loud
   * without anything being bolted on for it.
   */
  function interludeScene(section) {
    const accent = (style.verseAccents || [CYAN])[0];
    return (t, f) => {
      paintBackdrop();
      const settle = easeOutCubic(span(t, section.t0, section.t0 + 1.4));
      const lift = atSm('bass', t, 4);
      const kick = onsetKick(t, 0.12) * KICK_K;
      paintWorld(t, {
        // Roomier than a verse, because nothing is competing with the words
        // now, and breathing on the low end rather than on a clock.
        panels: 0.36 + settle * 0.22 + lift * 0.16,
        live: 0.62 + settle * 0.28,
        cam: {
          x: Math.sin(t * 0.16) * 90 * settle,
          y: Math.cos(t * 0.13) * 34 * settle,
          scale: 1 + settle * 0.05 + lift * 0.04 * PUMP_K + kick * 0.02,
        },
        beam: 0.55 + settle * 0.3,
        color: accent,
      });
      paintGrain(f, 0.05 + kick * 0.02);
      paintVignette(1);
    };
  }

  /** The outro: pull back until every sung line hangs as a constellation.
      Placement is a padded slot grid, one line per slot, sized to read —
      round one's judges found the free-scatter version piling into knots. */
  function outroScene(section) {
    const rand2 = mulberry32(0xBADA55);
    // One star per distinct phrase, first sighting wins.
    const seen = new Set();
    const stars = [];
    for (const m of memory) {
      const key = m.line.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      stars.push(m);
    }
    // 5x3 slots; the centre three belong to the credits.
    const slots = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 5; c++) {
        if (r === 1 && c >= 1 && c <= 3) continue;
        slots.push({
          x: (c - 2) * W * 0.235 + (rand2() - 0.5) * W * 0.05,
          y: (r - 1) * H * 0.33 + (rand2() - 0.5) * H * 0.07,
          z: 0.95 + rand2() * 0.45,
        });
      }
    }
    // Deterministic shuffle so neighbours in time are not neighbours in space.
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rand2() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    // Assign stars to slots with collision rejection: clamping into frame
    // must never push one line into another (round three's near-miss).
    // The credits own the middle — seed it as already-occupied ground.
    // Chorus plates pick first: the constellation needs its warm anchors.
    const placed = [{ x: 0, y: 0, w: W * 0.70, h: H * 0.235 }];
    const ordered = [...stars].sort((a, b) => (a.line.kind === 'chorus' ? -1 : 0) - (b.line.kind === 'chorus' ? -1 : 0));
    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i];
      const lay = layoutFor(m.line);
      let done = false;
      for (let k = 0; k < slots.length && !done; k++) {
        const s = slots[(i + k) % slots.length];
        if (s.used) continue;
        const sc = Math.max(0.16, 0.30 / s.z) * (m.line.kind === 'chorus' ? 1.15 : 1);
        const bw = lay.w * sc + 70;
        const bh = lay.h * sc + 56;
        const limX = W * 0.40 - (lay.w * sc) / 2;
        const limY = H * 0.40 - (lay.h * sc) / 2;
        const px = Math.max(-limX, Math.min(limX, s.x / s.z));
        const py = Math.max(-limY, Math.min(limY, s.y / s.z));
        const hits = placed.some((p) => Math.abs(p.x - px) < (p.w + bw) / 2
          && Math.abs(p.y - py) < (p.h + bh) / 2);
        if (!hits) {
          s.used = true;
          m.star = { px, py, sc };
          placed.push({ x: px, y: py, w: bw, h: bh });
          done = true;
        }
      }
      // No collision-free slot: this star sits out rather than overprints.
    }
    return (t, f) => {
      paintBackdrop();
      const u = span(t, section.t0, section.t1 - 4);
      const pull = easeInOutCubic(u);
      // Through the song's own world, dimming as the camera pulls back. This
      // used to light the venue's panel wall whatever the song was, so a
      // candle song ended on a grid of coloured squares.
      paintWorld(t, {
        panels: 0.5 - 0.3 * pull,
        live: lerp(1, 0.3, pull),
        cam: { x: 0, y: 0, scale: 1 - pull * 0.2 },
        beam: 0.7 - pull * 0.45,
        color: style.titleAccent || AMBER,
      });

      const zoom = lerp(1.65, 0.9, pull);
      ctx.save();
      ctx.translate(W / 2, H / 2 - pull * H * 0.03);
      ctx.scale(zoom, zoom);
      for (const m of stars) {
        if (!m.star) continue; // no collision-free home; better absent than garbled
        const lay = layoutFor(m.line);
        // A star only shows once it is fully inside frame at the current
        // zoom — round three's judges caught letters camping on the edges
        // through the pull-back. It fades up as the camera clears it.
        const exW = (Math.abs(m.star.px) + (lay.w * m.star.sc) / 2) * zoom;
        const exH = (Math.abs(m.star.py) + (lay.h * m.star.sc) / 2) * zoom;
        const inside = Math.min((W * 0.485 - exW) / 70, (H * 0.485 - exH) / 55);
        if (inside <= 0) continue;
        ctx.save();
        ctx.translate(m.star.px, m.star.py);
        ctx.scale(m.star.sc, m.star.sc);
        ctx.globalAlpha = clamp01(inside) * clamp01(0.8 * pull + 0.05)
          * (m.line.kind === 'chorus' ? 0.95 : 0.6);
        for (const wd of lay.words) {
          paintWord(wd, Math.max(t, wd.t1 + 1), { accent: AMBER, ghost: m.line.kind !== 'chorus' });
        }
        ctx.restore();
      }
      ctx.restore();

      // Credits settle once the constellation is out.
      const a = span(t, section.t0 + (section.t1 - section.t0) * 0.55, section.t0 + (section.t1 - section.t0) * 0.72);
      if (a > 0) {
        ctx.save();
        ctx.globalAlpha = a;
        ctx.font = `800 84px ${TEXTY}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = INK;
        ctx.fillText(timing.title.toUpperCase(), W / 2, H * 0.47);
        ctx.font = `500 30px ${TEXTY}`;
        ctx.letterSpacing = '12px';
        ctx.fillStyle = DIM;
        ctx.fillText(timing.artist.toUpperCase(), W / 2, H * 0.55);
        ctx.letterSpacing = '0px';
        ctx.restore();
      }
      paintGrain(f, 0.05);
      paintVignette(1);
    };
  }

  /** After the last word: the quiet sign-off holds to black. */
  function endcardScene(section) {
    return (t, f) => {
      paintBackdrop();
      paintWorld(t, { panels: 0.1, live: 0.25, cam: { x: 0, y: 0, scale: 1 }, beam: 0.15, color: style.titleAccent || AMBER });
      const a = easeOutCubic(span(t, section.t0, section.t0 + 1));
      const fade = 1 - easeInOutCubic(span(t, DUR2 - 1.2, DUR2 - 0.2));
      ctx.save();
      ctx.globalAlpha = a * fade;
      ctx.font = `500 34px ${TEXTY}`;
      ctx.letterSpacing = '14px';
      ctx.textAlign = 'center';
      ctx.fillStyle = INK;
      ctx.fillText(timing.artist.toUpperCase(), W / 2, H * 0.49);
      ctx.letterSpacing = '0px';
      if (timing.footer) {
        ctx.font = `400 25px ${MONO}`;
        ctx.fillStyle = DIM;
        ctx.fillText(timing.footer, W / 2, H * 0.56);
      }
      ctx.restore();
      paintGrain(f, 0.04);
      paintVignette(1);
    };
  }

  /* -------------------------------------------------------------- painter */

  /** The broadcast credit: song and artist, lower-left, early in the film. */
  function paintCredit(t) {
    const a = Math.min(span(t, 1.6, 2.6), 1 - span(t, 8.6, 10.2));
    if (a <= 0) return;
    ctx.save();
    ctx.globalAlpha = easeOutCubic(clamp01(a));
    ctx.textAlign = 'left';
    ctx.font = `${DW} 34px ${DISPLAY}`;
    ctx.letterSpacing = '6px';
    ctx.fillStyle = INK;
    ctx.fillText(timing.title.toUpperCase(), W * 0.055, H * 0.875);
    ctx.font = `500 24px ${TEXTY}`;
    ctx.letterSpacing = '8px';
    ctx.fillStyle = DIM;
    ctx.fillText(timing.artist.toUpperCase(), W * 0.055, H * 0.915);
    ctx.letterSpacing = '0px';
    if (timing.footer) {
      ctx.font = `400 20px ${MONO}`;
      ctx.fillStyle = `rgba(${rgb(DIM)},0.8)`;
      ctx.fillText(timing.footer, W * 0.055, H * 0.948);
    }
    ctx.restore();
  }

  function paint(f) {
    const t = f / FPS;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const scene = scenes.find((s) => t >= s.t0 && t < s.t1) || scenes[scenes.length - 1];
    scene.paint(t, f);
    if (style.world !== 'visualizer') paintCredit(t);
    const out = span(t, DUR2 - 0.8, DUR2 - 0.05);
    if (out > 0) {
      ctx.fillStyle = `rgba(0,0,0,${easeInOutCubic(out).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  return { paint, frames, scenes };
}
