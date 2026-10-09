#!/usr/bin/env node
// Renders the profile README widgets as animated SVGs.
//   node scripts/generate.mjs static   -> assets/*.svg (header, contacts, titles, stack, quote)
//   node scripts/generate.mjs metrics  -> dist/metrics-{dark,light}.svg (needs GITHUB_TOKEN)
// No dependencies; Node 18+.
//
// Type: Doto (dot-matrix display: nick, section titles, big numbers) and Fira Code (everything else).
// Motion lives only in the header (decoding text, LED ripple) plus one ambient pulse in metrics.
// README images animate on page load, so anything below the fold would play unseen. Every frame
// is a complete composition: decoding text starts and ends on its real value, nothing fades in.
// Widgets are 840 wide and shrink to ~40% on phones, so nothing is set below 12px.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const USER = process.env.GH_USER || '3x6dll9ff';
const W = 840;

// ---------- tokens ----------
const THEMES = {
  dark: {
    surface: '#0f141b', line: '#262c36', text: '#f0f3f6', muted: '#848d97', faint: '#3d444d',
    accent: '#a371f7', glow: 0.6, halo: 0.16, dotBase: 0.26, matrixDim: 0.22,
  },
  light: {
    surface: '#f6f8fa', line: '#d0d7de', text: '#1f2328', muted: '#59636e', faint: '#c8d1da',
    accent: '#8250df', glow: 0, halo: 0.07, dotBase: 0.3, matrixDim: 0.13,
  },
};
const T = { micro: 12, small: 13, body: 15, label: 16 }; // utility sizes (Fira Code)
const MONO = 0.6; // Doto and Fira Code advance, in em

// Family names are quoted and deliberately unlike CSS generic keywords
// (an unquoted `Serif`, say, would silently mean the system serif).
const FONT = { mono: "'FiraSub'", dot: "'DotoSub'" };

const b64 = (f) => readFileSync(join(ROOT, 'assets/fonts', f)).toString('base64');
const FACES = {
  mono: `@font-face{font-family:${FONT.mono};font-weight:700;src:url(data:font/woff2;base64,${b64('fira-Bold.woff2')}) format('woff2')}
@font-face{font-family:${FONT.mono};font-weight:400;src:url(data:font/woff2;base64,${b64('fira-Regular.woff2')}) format('woff2')}`,
  dot: `@font-face{font-family:${FONT.dot};src:url(data:font/woff2;base64,${b64('doto-blackround.woff2')}) format('woff2')}`,
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (n) => (Math.round(n * 10) / 10).toString();

function svg({ w = W, h, t, css = '', body, title, faces }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>
${faces.map((f) => FACES[f]).join('\n')}
text{fill:${t.text};font-family:${FONT.mono},ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:400}
.b{font-weight:700}.m{fill:${t.muted}}.a{fill:${t.accent}}
.dot{font-family:${FONT.dot},${FONT.mono},ui-monospace,monospace}
${css}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
${body}
</svg>`;
}

const card = (w, h, t) => `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="16" fill="${t.surface}" stroke="${t.line}"/>`;
// ---------- decoding text ----------
// Seeded noise and per-file ids so regenerated files diff cleanly.
let seed = 7, uid = 0;
const fresh = () => { seed = 7; uid = 0; };
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const NOISE = '01#%&$@!?<>/{}[]=+*~^';

// A strip of frames scrolled one line per step. The first and last frames are the real
// value, so with animation disabled or frozen the real value is what you see.
function strip({ x, y, size, frames, cls, dur, delay }) {
  const lh = Math.round(size * 1.3);
  const n = frames.length - 1;
  const id = `s${uid++}`;
  return {
    css: `@keyframes ${id}{to{transform:translateY(-${n * lh}px)}}.${id}{animation:${id} ${dur.toFixed(2)}s steps(${n},end) ${delay.toFixed(2)}s both}`,
    markup: `<g class="${id}">${frames.map((g, k) => `<text x="${f1(x)}" y="${y + k * lh}" class="${cls}" font-size="${size}">${esc(g)}</text>`).join('')}</g>`,
  };
}
const clipLine = (x, y, size, chars) => {
  const id = `c${uid++}`, w = chars * size * MONO;
  return { id, def: `<clipPath id="${id}"><rect x="${f1(x - 4)}" y="${f1(y - size * 0.98)}" width="${f1(w + 8)}" height="${f1(size * 1.28)}"/></clipPath>` };
};

// One glyph that scrambles through `steps` frames of noise and lands back on itself.
const slot = ({ final, steps, ...o }) => strip({
  ...o, frames: [final, ...Array.from({ length: steps }, () => NOISE[Math.floor(rnd() * NOISE.length)]), final],
});

// Several values that tick together, e.g. epoch and loss of the same training run.
function ticker({ y, size, cls, dur, delay, series }) {
  let css = '', defs = '', markup = '';
  for (const { x, frames } of series) {
    const all = [frames.at(-1), ...frames];
    const c = clipLine(x, y, size, Math.max(...all.map((f) => f.length)));
    const st = strip({ x, y, size, frames: all, cls, dur, delay });
    css += st.css; defs += c.def; markup += `<g clip-path="url(#${c.id})">${st.markup}</g>`;
  }
  return { css, defs, markup };
}

// A monospace string whose glyphs decode from noise in turn, clipped to its own line.
function decode({ x, y, size, text, cls, delay = 0, base = 0.5, stagger = 0.1 }) {
  let css = '', markup = '';
  [...text].forEach((ch, i) => {
    const cx = x + i * size * MONO;
    if (ch === ' ') {
      markup += `<text x="${f1(cx)}" y="${y}" class="${cls}" font-size="${size}">${esc(ch)}</text>`;
      return;
    }
    const s = slot({ x: cx, y, size, final: ch, cls, delay, dur: base + i * stagger, steps: 7 + i * 2 });
    css += s.css; markup += s.markup;
  });
  const c = clipLine(x, y, size, text.length);
  return {
    css,
    defs: c.def,
    markup: `<g clip-path="url(#${c.id})">${markup}</g>`,
    end: delay + base + (text.length - 1) * stagger,
  };
}

// ---------- header ----------
// The whole card is an LED panel: a field of dim dots with a signal rippling out
// from the nick, which is set in the same dot-matrix face.
function header(t) {
  fresh();
  const H = 312, mid = W / 2;
  const ns = 104, ny = 190; // nick (Doto)
  const ls = T.small + 1, ly = 72; // training log (Fira)

  const nick = decode({ x: mid - (USER.length * ns * MONO) / 2, y: ny, size: ns, text: USER, cls: 'dot nk', delay: 0.25, base: 0.55, stagger: 0.12 });
  const done = nick.end;

  // training log: epoch and loss tick together while the nick decodes; loss falls from
  // ln(10), the cross-entropy of a 10-class guess, to its final value
  const EPOCHS = 9, FINAL = 0.0042;
  const epochs = Array.from({ length: EPOCHS }, (_, i) => String(i + 1));
  const losses = epochs.map((_, i) => (Math.LN10 * Math.pow(FINAL / Math.LN10, i / (EPOCHS - 1))).toFixed(4));
  const seg = [['epoch ', 'm'], [epochs, 'tick'], [`/${EPOCHS}`, 'm'], ['   ', ''], ['loss ', 'm'], [losses, 'tick'], ['   ', ''], ['converged', 'ok']];
  const len = (v) => (Array.isArray(v) ? v.at(-1).length : v.length);
  let cx = mid - (seg.reduce((a, [v]) => a + len(v), 0) * ls * MONO) / 2, log = '';
  const series = [];
  for (const [v, kind] of seg) {
    if (kind === 'm') log += `<text x="${f1(cx)}" y="${ly}" class="m" font-size="${ls}">${esc(v)}</text>`;
    else if (kind === 'ok') log += `<text x="${f1(cx)}" y="${ly}" class="b a ok" font-size="${ls}">${v}</text>`;
    else if (kind === 'tick') series.push({ x: cx, frames: v });
    cx += len(v) * ls * MONO;
  }
  const tick = ticker({ y: ly, size: ls, cls: 'b', delay: 0.25, dur: done - 0.25, series });
  log += tick.markup;
  const logDefs = tick.defs, logCss = tick.css;

  // LED panel, built to be cheap to repaint: SVG in <img> is re-rasterised whole on every
  // frame, so the field is one pattern-filled rect (not 1300 nodes), the ripple is a single
  // ellipse whose stroke is painted with brighter dots, the edge fade is a plain gradient
  // overlay (no mask), and the glow is a stroke under the dots (no blur filter).
  const gap = 14, cy = ny - ns * 0.35, ox = (W % gap) / 2, oy = (H % gap) / 2;
  const dots = (id, op) => `<pattern id="${id}" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse" x="${ox}" y="${oy}"><circle cx="${gap / 2}" cy="${gap / 2}" r="1.7" fill="${t.accent}" fill-opacity="${op}"/></pattern>`;
  const period = 4.2, reach = 560;
  const ripple = `<ellipse class="ring" cx="${mid}" cy="${f1(cy)}" rx="0" ry="0" fill="none" stroke="url(#lit)" stroke-width="44">
<animate attributeName="rx" values="0;${reach}" dur="${period}s" begin="${done.toFixed(2)}s" repeatCount="indefinite"/>
<animate attributeName="ry" values="0;${f1(reach / 1.6)}" dur="${period}s" begin="${done.toFixed(2)}s" repeatCount="indefinite"/>
<animate attributeName="stroke-opacity" values="1;0.85;0" keyTimes="0;0.6;1" dur="${period}s" begin="${done.toFixed(2)}s" repeatCount="indefinite"/>
</ellipse>`;

  const css = `${nick.css}${logCss}
.nk{fill:${t.text}${t.glow ? `;stroke:${t.accent};stroke-opacity:.32;stroke-width:${f1(ns * 0.07)};paint-order:stroke` : ''}}
.ok{animation:ok ${done.toFixed(2)}s step-end both}
@keyframes ok{0%{opacity:1}${(25 / done).toFixed(1)}%{opacity:0}100%{opacity:1}}
@media (prefers-reduced-motion:reduce){.ring{display:none}}`;

  const body = `<defs>${nick.defs}${logDefs}
<clipPath id="cd"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="16"/></clipPath>
${dots('dim', t.dotBase)}${dots('lit', 1)}
<radialGradient id="edge" cx="0.5" cy="0.5" r="0.62"><stop offset="0.45" stop-color="${t.surface}" stop-opacity="0"/><stop offset="1" stop-color="${t.surface}"/></radialGradient>
<radialGradient id="hush" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${t.surface}" stop-opacity=".8"/><stop offset="1" stop-color="${t.surface}" stop-opacity="0"/></radialGradient>
<radialGradient id="halo" cx="0.5" cy="0.55" r="0.5"><stop offset="0" stop-color="${t.accent}" stop-opacity="${t.halo}"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0"/></radialGradient>
</defs>
${card(W, H, t)}
<g clip-path="url(#cd)">
<rect width="${W}" height="${H}" fill="url(#halo)"/>
<rect width="${W}" height="${H}" fill="url(#dim)"/>
${ripple}
<rect width="${W}" height="${H}" fill="url(#edge)"/>
<ellipse cx="${mid}" cy="${ny - 30}" rx="${f1(USER.length * ns * MONO * 0.58)}" ry="${f1(ns * 0.8)}" fill="url(#hush)"/>
<ellipse cx="${mid}" cy="${ny + 64}" rx="320" ry="40" fill="url(#hush)"/>
<ellipse cx="${mid}" cy="${ly - 5}" rx="240" ry="20" fill="url(#hush)"/>
</g>
${log}
${nick.markup}
<text x="${mid}" y="${ny + 58}" class="b" font-size="24" text-anchor="middle">Machine Learning Engineer</text>
<text x="${mid}" y="${ny + 92}" class="m" font-size="${T.body}" text-anchor="middle">deep learning · mlops · 4+ years shipping production software</text>`;
  return svg({ h: H, t, css, body, title: `${USER} — Machine Learning Engineer`, faces: ['mono', 'dot'] });
}

// ---------- contacts: one clickable plate per network ----------
// Each plate carries its network's mark as an 11×11 LED matrix, the same dots as the header.
// The README sets them two per row, edge to edge (no whitespace, 50% each), so the gutter
// is a transparent margin inside each SVG. Glyphs smaller than the matrix are centred.
const MATRIX = 11;
const GLYPHS = {
  telegram: [ // paper plane in outline (the "send" shape): reads at 11×11 where a filled one blurs
    '.........##',
    '.......####',
    '....###.##.',
    '..##...#.#.',
    '##....#.#..',
    '..####..#..',
    '.....#..#..',
    '.....#.#...',
    '.....#.#...',
    '......#....',
    '......#....',
  ],
  linkedin: [
    '##.......',
    '##.......',
    '.........',
    '##.##.##.',
    '##.######',
    '##.##..##',
    '##.##..##',
    '##.##..##',
    '##.##..##',
  ],
  x: [
    '##.....##',
    '.##...##.',
    '..##.##..',
    '...###...',
    '....#....',
    '...###...',
    '..##.##..',
    '.##...##.',
    '##.....##',
  ],
  email: [
    '#########',
    '##.....##',
    '#.#...#.#',
    '#..#.#..#',
    '#...#...#',
    '#.......#',
    '#########',
  ],
};
const padGlyph = (rows) => {
  const top = Math.floor((MATRIX - rows.length) / 2), left = Math.floor((MATRIX - rows[0].length) / 2);
  return Array.from({ length: MATRIX }, (_, r) => {
    const src = rows[r - top];
    return src ? '.'.repeat(left) + src + '.'.repeat(MATRIX - left - src.length) : '.'.repeat(MATRIX);
  });
};
// [glyph, name on the plate, where it leads (for the accessible title)]
const CONTACTS = [
  ['telegram', 'Telegram', '@threex6dll9ff'],
  ['linkedin', 'LinkedIn', 'in/3x6dll9ff'],
  ['x', 'X', '@3x6dll9ff'],
  ['email', 'Mail', 'danila.kardashevskii@gmail.com'],
];
function contact(t, [glyph, name, handle]) {
  const pw = 410, ph = 84, m = 5;
  const pitch = 5.6, gx = 20, gy = (ph - (MATRIX - 1) * pitch) / 2; // matrix vertically centred
  let lit = '', dim = '';
  padGlyph(GLYPHS[glyph]).forEach((row, r) => [...row].forEach((c, k) => {
    const dot = `<circle cx="${f1(gx + k * pitch)}" cy="${f1(gy + r * pitch)}" r="1.9"/>`;
    if (c === '#') lit += dot; else dim += dot;
  }));
  const css = t.glow ? `.lit{stroke:${t.accent};stroke-opacity:.35;stroke-width:2.2;paint-order:stroke}` : '';
  const body = `<g transform="translate(${m},${m})">${card(pw, ph, t)}
<g fill="${t.accent}" opacity="${t.matrixDim}">${dim}</g>
<g class="lit" fill="${t.accent}">${lit}</g>
<rect x="${f1(gx + (MATRIX - 1) * pitch + 16)}" y="18" width="1" height="${ph - 36}" fill="${t.line}"/>
<text x="100" y="${ph / 2 + 7}" class="b" font-size="20">${esc(name)}</text>
<path d="M${pw - 36} ${ph / 2 + 6} L${pw - 24} ${ph / 2 - 6} M${pw - 34} ${ph / 2 - 6} H${pw - 24} V${ph / 2 + 4}" fill="none" stroke="${t.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</g>`;
  return svg({ w: pw + 2 * m, h: ph + 2 * m, t, css, body, title: `${name}: ${handle}`, faces: ['mono'] });
}

// ---------- section title ----------
function title(t, label) {
  const h = 60, size = 34;
  const tw = label.length * size * MONO;
  const body = `<defs><linearGradient id="ln" x1="0" x2="1"><stop offset="0" stop-color="${t.accent}" stop-opacity=".8"/><stop offset=".3" stop-color="${t.line}"/><stop offset="1" stop-color="${t.line}" stop-opacity="0"/></linearGradient></defs>
<text x="0" y="42" class="dot" font-size="${size}">${esc(label)}</text>
<rect x="${f1(tw + 20)}" y="31" width="${f1(W - tw - 20)}" height="1" fill="url(#ln)"/>`;
  return svg({ h, t, body, title: label, faces: ['dot'] });
}

// ---------- tech stack ----------
// The stack drawn as a literal stack: layers from tooling at the bottom to models on top,
// each a plate with some thickness. Tools used daily are lit; occasional ones are dimmed.
// [layer, what it is for (shown when the plate has room), items: [icon, label, daily?]]
const LAYERS = [
  ['models', 'training · fine-tuning · research', [['pytorch', 'PyTorch', 1]]],
  ['languages', '', [['python', 'Python', 1], ['c_plus', 'C++', 1], ['swift', 'Swift'], ['c_sharp', 'C#'], ['go', 'Go'], ['js', 'JavaScript']]],
  ['data', 'storage · queries', [['postgresql', 'PostgreSQL']]],
  ['tooling', 'build · ship · collaborate', [['docker', 'Docker', 1], ['github', 'GitHub', 1], ['vs_code', 'VS Code', 1], ['postman', 'Postman']]],
];
const ICONS = Object.fromEntries(LAYERS.flatMap(([, , items]) => items).map(([f]) => [f, readFileSync(join(ROOT, `ico/skills/${f}.png`)).toString('base64')]));

function stack(t) {
  const lx = 0, px0 = 150, px1 = W - 2, slabH = 62, depth = 6, gap = 16, top = 2;
  const icon = 28, fs = T.body, pad = 24;
  const H = top + LAYERS.length * (slabH + depth + gap) - gap + 30;
  let body = `<defs><filter id="sil" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 0.94  0 0 0 0 0.95  0 0 0 0 0.96  -0.33 -0.33 -0.33 1 0"/></filter></defs>`;
  LAYERS.forEach(([layer, role, items], i) => {
    const y = top + i * (slabH + depth + gap), cy = y + slabH / 2;
    // plate: a darker underside offset below, then the face
    body += `<rect x="${px0 + 0.5}" y="${y + depth + 0.5}" width="${px1 - px0 - 1}" height="${slabH - 1}" rx="12" fill="${t.line}"/>
<rect x="${px0 + 0.5}" y="${y + 0.5}" width="${px1 - px0 - 1}" height="${slabH - 1}" rx="12" fill="${t.surface}" stroke="${t.line}"/>
<text x="${lx}" y="${cy + 8}" class="dot" font-size="22">${layer}</text>`;
    // lay the items out left to right; gaps shrink if a layer is crowded
    const widths = items.map(([, label]) => icon + 10 + label.length * fs * MONO);
    const room = px1 - px0 - 2 * pad - widths.reduce((a, b) => a + b, 0);
    const between = items.length > 1 ? Math.min(40, room / (items.length - 1)) : 0;
    const used = widths.reduce((a, b) => a + b, 0) + between * (items.length - 1);
    if (role && px1 - px0 - 2 * pad - used > role.length * T.small * MONO + 32)
      body += `<text x="${px1 - pad}" y="${cy + 5}" class="m" font-size="${T.small}" text-anchor="end">${esc(role)}</text>`;
    let x = px0 + pad;
    items.forEach(([file, label, daily], k) => {
      const sil = file === 'github' && t.glow ? ' filter="url(#sil)"' : '';
      body += `<g${daily ? '' : ' opacity=".5"'}><image x="${f1(x)}" y="${cy - icon / 2}" width="${icon}" height="${icon}" href="data:image/png;base64,${ICONS[file]}"${sil}/>
<text x="${f1(x + icon + 10)}" y="${cy + 5}" class="${daily ? 'b' : ''}" font-size="${fs}">${esc(label)}</text></g>`;
      x += widths[k] + between;
    });
  });
  body += `<text x="${px1}" y="${H - 6}" class="m" font-size="${T.micro}" text-anchor="end">bright — every day · dim — now and then</text>`;
  const desc = LAYERS.map(([l, , items]) => `${l}: ${items.map((x) => x[1] + (x[2] ? '' : ' (occasionally)')).join(', ')}`).join('; ');
  return svg({ h: H, t, body, title: `Stack, top to bottom — ${desc}`, faces: ['mono', 'dot'] });
}

// ---------- closing quote ----------
function quote(t) {
  const H = 116, q = '"The best way to predict the future is to invent it."';
  const body = `<text x="${W / 2}" y="56" font-size="20" text-anchor="middle">${esc(q)}</text>
<text x="${W / 2}" y="88" class="m" font-size="${T.small}" text-anchor="middle">— Alan Kay</text>`;
  return svg({ h: H, t, body, title: `${q} — Alan Kay`, faces: ['mono'] });
}

// ---------- metrics ----------
const IGNORE = new Set(['Makefile', 'CMake', 'Dockerfile', 'HTML', 'CSS', 'SCSS', 'Shell', 'Batchfile', 'PowerShell', 'Jupyter Notebook', 'Procfile', 'Roff']);

async function fetchStats() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const query = `query($login:String!){user(login:$login){
    repositories(ownerAffiliations:OWNER,privacy:PUBLIC,isFork:false,first:100){totalCount nodes{
      languages(first:10,orderBy:{field:SIZE,direction:DESC}){edges{size node{name}}}}}
    contributionsCollection{totalPullRequestContributions
      contributionCalendar{totalContributions weeks{contributionDays{contributionCount date}}}}}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': USER },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GitHub API: ${res.status} ${JSON.stringify(json.errors || json)}`);
  const u = json.data.user;
  const cal = u.contributionsCollection.contributionCalendar;
  const days = cal.weeks.flatMap((w) => w.contributionDays);
  if (!days.length) throw new Error('GitHub API returned an empty contribution calendar');

  let longest = 0, run = 0;
  for (const d of days) { run = d.contributionCount ? run + 1 : 0; longest = Math.max(longest, run); }
  let current = 0, i = days.length - 1;
  if (!days[i].contributionCount) i--; // today isn't over yet
  for (; i >= 0 && days[i].contributionCount; i--) current++;

  const langs = new Map();
  for (const r of u.repositories.nodes)
    for (const e of r.languages.edges)
      if (!IGNORE.has(e.node.name)) langs.set(e.node.name, (langs.get(e.node.name) || 0) + e.size);
  const total = [...langs.values()].reduce((a, b) => a + b, 0) || 1;
  const top = [...langs].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, size]) => ({ name, pct: (size / total) * 100 }));
  const rest = 100 - top.reduce((a, l) => a + l.pct, 0);
  if (rest > 0.5) top.push({ name: 'other', pct: rest });

  return {
    contributions: cal.totalContributions, longest, current,
    prs: u.contributionsCollection.totalPullRequestContributions,
    repos: u.repositories.totalCount,
    days: days.map((d) => d.date),
    weeks: cal.weeks.map((w) => w.contributionDays.reduce((a, d) => a + d.contributionCount, 0)),
    weekStart: cal.weeks.map((w) => days.indexOf(w.contributionDays[0])),
    langs: top,
  };
}

// Monotone cubic (Fritsch–Carlson) so the curve never dips below zero.
function monotonePath(pts) {
  const n = pts.length, dx = [], m = [], tg = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
  tg[0] = m[0]; tg[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) tg[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  let d = `M${f1(pts[0][0])},${f1(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], h = dx[i] / 3;
    d += `C${f1(x0 + h)},${f1(y0 + tg[i] * h)} ${f1(x1 - h)},${f1(y1 - tg[i + 1] * h)} ${f1(x1)},${f1(y1)}`;
  }
  return d;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function metrics(t, s) {
  fresh();
  const H = 368;
  let css = '', defs = '', body = '';

  // left column: the year's total in Doto, then the supporting numbers
  const big = s.contributions.toLocaleString('en-US');
  body += `<text x="34" y="46" class="m" font-size="${T.small}">contributions · 12 months</text>
<text x="32" y="108" class="dot bloom" font-size="64">${big}</text>`;
  if (t.glow) css += `.bloom{stroke:${t.accent};stroke-opacity:.32;stroke-width:4.5;paint-order:stroke}`;

  const rows = [['longest streak', `${s.longest}d`], ['current streak', `${s.current}d`], ['pull requests', String(s.prs)], ['public repos', String(s.repos)]];
  rows.forEach(([k, v], i) => {
    const y = 152 + i * 31, vs = T.label, right = 244;
    body += `<text x="34" y="${y}" class="m" font-size="${T.small}">${k}</text>`;
    body += `<text x="${right}" y="${y}" class="b" font-size="${vs}" text-anchor="end">${v}</text>`;
  });

  // right column: weekly activity, x positioned by calendar day so months line up
  const cx0 = 304, cx1 = 808, cy0 = 66, cy1 = 234, span = s.days.length - 1;
  const xAt = (dayIdx) => cx0 + (dayIdx / span) * (cx1 - cx0);
  const max = Math.max(1, ...s.weeks);
  const pts = s.weeks.map((n, i) => [xAt(Math.min(span, s.weekStart[i] + 3)), cy1 - (n / max) * (cy1 - cy0)]);
  pts[0][0] = cx0; pts[pts.length - 1][0] = cx1;
  const line = monotonePath(pts);
  const [px, py] = pts[s.weeks.indexOf(max)];
  const [ex, ey] = pts[pts.length - 1];
  defs += `<linearGradient id="ar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.accent}" stop-opacity="${t.glow ? 0.35 : 0.22}"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0"/></linearGradient>`;
  body += `<rect x="274" y="28" width="1" height="${cy1 + 8}" fill="${t.line}"/>
<text x="${cx0}" y="46" class="m" font-size="${T.small}">per week</text>
<text x="${cx1}" y="46" class="m" font-size="${T.small}" text-anchor="end">peak <tspan class="b" fill="${t.text}">${max}</tspan></text>`;
  for (let g = 0; g <= 2; g++) body += `<rect x="${cx0}" y="${cy0 + ((cy1 - cy0) * g) / 2}" width="${cx1 - cx0}" height="1" fill="${t.line}" opacity="${g === 2 ? 1 : 0.45}"/>`;
  s.days.forEach((d, i) => {
    const x = xAt(i);
    if (d.endsWith('-01') && x > cx0 + 14 && x < cx1 - 14)
      body += `<text x="${f1(x)}" y="${cy1 + 22}" class="m" font-size="${T.micro}" text-anchor="middle">${MONTHS[Number(d.slice(5, 7)) - 1]}</text>`;
  });
  body += `<path d="${line}L${cx1},${cy1}L${cx0},${cy1}Z" fill="url(#ar)"/>
<path d="${line}" fill="none" stroke="${t.accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${f1(px)}" cy="${f1(py)}" r="3.5" fill="${t.surface}" stroke="${t.text}" stroke-width="1.5"/>
<circle class="pulse" cx="${f1(ex)}" cy="${f1(ey)}" r="4" fill="none" stroke="${t.accent}"/>
<circle cx="${f1(ex)}" cy="${f1(ey)}" r="4" fill="${t.accent}"/>`;
  css += `.pulse{transform-box:fill-box;transform-origin:center;animation:pulse 2.4s ease-out infinite;opacity:0}
@keyframes pulse{0%{opacity:.7;transform:scale(1)}100%{opacity:0;transform:scale(3.2)}}`;

  // languages
  const ly = 302, bx0 = 168, bx1 = 808, fs = T.small;
  body += `<rect x="24" y="${ly - 30}" width="${W - 48}" height="1" fill="${t.line}"/>
<text x="34" y="${ly + 9}" class="b" font-size="${T.label}">languages</text>`;
  defs += `<clipPath id="bar"><rect x="${bx0}" y="${ly}" width="${bx1 - bx0}" height="8" rx="4"/></clipPath>`;
  const shades = [1, 0.72, 0.5, 0.34, 0.22, 0.12];
  // Fit the legend to the bar: drop decimals first, then fold the smallest languages into "other".
  let langs = s.langs, digits = 1;
  const pct = (l) => `${l.pct.toFixed(digits)}%`;
  const lw = (l) => 14 + `${l.name} ${pct(l)}`.length * fs * MONO;
  const room = () => bx1 - bx0 - langs.reduce((a, l) => a + lw(l), 0) - 18 * (langs.length - 1);
  if (room() < 0) digits = 0;
  while (room() < 0 && langs.length > 2) {
    const named = langs.filter((l) => l.name !== 'other');
    const folded = named.pop().pct + (langs.find((l) => l.name === 'other')?.pct ?? 0);
    langs = [...named, { name: 'other', pct: folded }];
  }
  const gap = langs.length > 1 ? Math.min(28, (room() + 18 * (langs.length - 1)) / (langs.length - 1)) : 0;
  let x = bx0, lx = bx0, bar = '';
  langs.forEach((l, i) => {
    const w = ((bx1 - bx0) * l.pct) / 100;
    const other = l.name === 'other';
    const fill = other ? t.faint : t.accent, op = other ? 1 : shades[i];
    bar += `<rect x="${f1(x)}" y="${ly}" width="${f1(Math.max(0, w - 2))}" height="8" fill="${fill}" opacity="${op}"/>`;
    body += `<g><rect x="${f1(lx)}" y="${ly + 26}" width="8" height="8" rx="2" fill="${fill}" opacity="${op}"/>
<text x="${f1(lx + 14)}" y="${ly + 35}" font-size="${fs}">${esc(l.name)} <tspan class="m">${pct(l)}</tspan></text></g>`;
    lx += lw(l) + gap;
    x += w;
  });
  body += `<g clip-path="url(#bar)">${bar}</g>`;

  return svg({
    h: H, t, css, body: `<defs>${defs}</defs>${card(W, H, t)}${body}`, faces: ['mono', 'dot'],
    title: `${s.contributions} contributions in the last 12 months, longest streak ${s.longest} days, current streak ${s.current} days, ${s.prs} pull requests, ${s.repos} public repos. Languages: ${s.langs.map((l) => `${l.name} ${l.pct.toFixed(0)}%`).join(', ')}.`,
  });
}

// ---------- main ----------
const write = (rel, content) => {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  console.log('wrote', rel, `${(Buffer.byteLength(content) / 1024).toFixed(1)}kB`);
};
const mode = process.argv[2] || 'static';

if (mode === 'static') {
  for (const [name, t] of Object.entries(THEMES)) {
    write(`assets/header-${name}.svg`, header(t));
    write(`assets/stack-${name}.svg`, stack(t));
    write(`assets/quote-${name}.svg`, quote(t));
    for (const c of CONTACTS) write(`assets/contact-${c[0]}-${name}.svg`, contact(t, c));
    for (const s of ['about', 'stack', 'activity']) write(`assets/title-${s}-${name}.svg`, title(t, s));
  }
} else if (mode === 'metrics') {
  const out = process.argv[3] || 'dist';
  const stats = await fetchStats();
  for (const [name, t] of Object.entries(THEMES)) write(`${out}/metrics-${name}.svg`, metrics(t, stats));
} else {
  console.error('usage: generate.mjs static|metrics [outdir]');
  process.exit(1);
}
