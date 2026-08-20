/* ============================================
   Palette Fixer — app logic
   ============================================ */

/* ---------- color math ---------- */
function normalizeHex(hex) {
  hex = hex.trim();
  if (hex[0] !== '#') hex = '#' + hex;
  if (/^#([A-Fa-f0-9]{3})$/.test(hex)) {
    hex = '#' + hex.slice(1).split('').map(c => c + c).join('');
  }
  return hex.toUpperCase();
}
function isValidHex(hex) { return /^#([A-Fa-f0-9]{6})$/.test(hex); }

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}
function hslToRgb({ h, s, l }) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}
function hslToHex(hsl) { return rgbToHex(hslToRgb(hsl)); }

function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const [R, G, B] = [r, g, b].map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrastRatio(hexA, hexB) {
  const L1 = relativeLuminance(hexA), L2 = relativeLuminance(hexB);
  const lighter = Math.max(L1, L2), darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

const INK_TEXT = '#2B2930';
const PAPER_TEXT = '#FEFCF8';

/* ---------- state ---------- */
let palette = [];
let idCounter = 1;
let dismissedIssues = new Set();
let selectedPairings = new Set();
let suggestionSeed = 0;

/* file-import state */
let uploadedFiles = [];      // { name, content, originalSize }
let extractedColors = [];    // { hex, variants:Set<string>, files:Set<number>, selected:bool }

const STARTER = [
  { hex: '#FCAC9E', role: 'hero' },
  { hex: '#ECC995', role: 'accent' },
  { hex: '#EEBBD2', role: 'accent' },
  { hex: '#78CCD4', role: 'accent' },
  { hex: '#EAC4F6', role: 'accent' },
  { hex: '#D6B9EF', role: 'accent' },
  { hex: '#FEFCF8', role: 'light' },
  { hex: '#4C4C4C', role: 'dark' },
];

/* ---------- DOM refs ---------- */
const paletteGrid = document.getElementById('paletteGrid');
const emptyNote = document.getElementById('emptyNote');
const hexInput = document.getElementById('hexInput');
const colorPicker = document.getElementById('colorPicker');
const roleInput = document.getElementById('roleInput');
const toastEl = document.getElementById('toast');

/* ---------- toast ---------- */
let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

/* ---------- palette CRUD ---------- */
function addColor(hex, role, extra) {
  hex = normalizeHex(hex);
  if (!isValidHex(hex)) { showToast('Enter a valid hex code, like #5B3DF6'); return null; }
  const entry = { id: idCounter++, hex, role: role || 'accent', ...(extra || {}) };
  palette.push(entry);
  renderAll();
  return entry;
}
function removeColor(id) {
  palette = palette.filter(c => c.id !== id);
  renderAll();
}
function setRole(id, role) {
  const c = palette.find(c => c.id === id);
  if (c) { c.role = role; renderAll(); }
}
function replaceColor(id, newHex) {
  const c = palette.find(c => c.id === id);
  if (!c) return;
  newHex = normalizeHex(newHex);
  let filesUpdated = 0;
  if (c.files && c.files.size) {
    filesUpdated = applyColorFixToFiles(c, newHex);
  }
  c.hex = newHex;
  renderAll();
  showToast(filesUpdated > 0
    ? `Applied fix — updated in ${filesUpdated} file${filesUpdated === 1 ? '' : 's'} ✓`
    : 'Applied fix ✓');
}

/* ---------- render: palette grid ---------- */
function renderPalette() {
  paletteGrid.innerHTML = '';
  emptyNote.style.display = palette.length ? 'none' : 'block';
  const roleLabels = { hero: 'Hero', accent: 'Accent', light: 'Light Neutral', dark: 'Dark Neutral' };

  palette.forEach(c => {
    const card = document.createElement('div');
    card.className = 'swatch-card';
    const fromFile = c.files && c.files.size > 0;
    card.innerHTML = `
      <div class="swatch-fill" style="background:${c.hex}">
        <button class="swatch-remove" title="Remove color" aria-label="Remove ${c.hex}">✕</button>
      </div>
      <div class="swatch-meta">
        <div class="swatch-hex">${c.hex}</div>
        ${fromFile ? `<div class="swatch-source">from ${c.files.size} file${c.files.size === 1 ? '' : 's'}</div>` : ''}
        <select class="swatch-role">
          ${Object.entries(roleLabels).map(([v, l]) => `<option value="${v}" ${c.role === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
    `;
    card.querySelector('.swatch-remove').onclick = () => removeColor(c.id);
    card.querySelector('.swatch-role').onchange = (e) => setRole(c.id, e.target.value);
    paletteGrid.appendChild(card);
  });
}

/* ---------- health score ---------- */
function computeHealth() {
  const checks = [];

  checks.push({
    label: 'Add 3+ colors', sub: `${palette.length} color${palette.length === 1 ? '' : 's'} added`,
    pass: palette.length >= 3
  });
  checks.push({
    label: 'Add a light neutral', sub: 'For backgrounds and light UI elements',
    pass: palette.some(c => c.role === 'light')
  });
  checks.push({
    label: 'Add a dark neutral', sub: 'For text and dark UI elements',
    pass: palette.some(c => c.role === 'dark')
  });

  const coverage = contrastCoverage();
  checks.push({
    label: 'Achieve 75% contrast coverage', sub: `${coverage.percent}% of colors meet WCAG AA`,
    pass: coverage.percent >= 75
  });

  checks.push({
    label: 'Select 4+ contrast pairings', sub: `${selectedPairings.size} pairing${selectedPairings.size === 1 ? '' : 's'} selected`,
    pass: selectedPairings.size >= 4
  });

  const passed = checks.filter(c => c.pass).length;
  const percent = Math.round((passed / checks.length) * 100);
  return { checks, percent };
}

function contrastCoverage() {
  if (palette.length === 0) return { percent: 0 };
  let passing = 0;
  palette.forEach(c => {
    const rInk = contrastRatio(c.hex, INK_TEXT);
    const rPaper = contrastRatio(c.hex, PAPER_TEXT);
    if (rInk >= 4.5 || rPaper >= 4.5) passing++;
  });
  return { percent: Math.round((passing / palette.length) * 100) };
}

function renderHealth() {
  const { checks, percent } = computeHealth();
  document.getElementById('healthPercent').textContent = percent;

  const circumference = 326.7; // 2*pi*52
  const offset = circumference - (percent / 100) * circumference;
  const ring = document.getElementById('ringProgress');
  ring.style.strokeDashoffset = offset;
  ring.style.stroke = percent >= 80 ? 'var(--green)' : percent >= 45 ? 'var(--violet)' : 'var(--amber)';

  const list = document.getElementById('checklist');
  list.innerHTML = checks.map(c => `
    <li>
      <span class="check-icon ${c.pass ? 'pass' : 'fail'}">${c.pass ? '✓' : '✕'}</span>
      <span>
        <span class="check-label">${c.label}</span>
        <span class="check-sub">${c.sub}</span>
      </span>
    </li>
  `).join('');
}

/* ---------- harmony check ---------- */
function computeHarmonyIssues() {
  const scoreable = palette.filter(c => c.role !== 'light' && c.role !== 'dark');
  if (scoreable.length < 2) return [];

  const sats = scoreable.map(c => rgbToHsl(hexToRgb(c.hex)).s);
  const median = [...sats].sort((a, b) => a - b)[Math.floor(sats.length / 2)];

  const issues = [];
  scoreable.forEach(c => {
    if (dismissedIssues.has(c.id)) return;
    const hsl = rgbToHsl(hexToRgb(c.hex));
    const deviation = hsl.s - median;
    if (deviation > 28 && hsl.s > 55) {
      // suggest pulling saturation toward the palette's median, keep hue & lightness
      const targetS = median + (deviation) * 0.35;
      const suggested = hslToHex({ h: hsl.h, s: Math.max(targetS, 0), l: hsl.l });
      const safeAgainstInk = contrastRatio(suggested, INK_TEXT) >= 4.5;
      issues.push({
        id: c.id, current: c.hex, suggested,
        title: 'Too vibrant compared to palette',
        desc: 'Adjust saturation to harmonize with the palette',
        contrastSafe: safeAgainstInk
      });
    }
  });
  return issues.slice(0, 3);
}

function renderHarmony() {
  const issues = computeHarmonyIssues();
  const box = document.getElementById('harmonyIssues');
  const summary = document.getElementById('harmonySummary');

  if (palette.length < 2) {
    summary.textContent = 'Add at least two colors to run a harmony scan.';
    box.innerHTML = '';
    return;
  }
  if (issues.length === 0) {
    summary.textContent = 'Scan for colors that don\'t fit your palette\'s harmony.';
    box.innerHTML = `<div class="harmony-clean">✓ Your palette is balanced — nothing to fix.</div>`;
    return;
  }
  summary.innerHTML = `<span style="color:var(--amber); font-weight:700;">${issues.length}</span> color${issues.length === 1 ? '' : 's'} could be balanced`;

  box.innerHTML = issues.map(issue => `
    <div class="harmony-issue" data-id="${issue.id}" style="margin-bottom:12px;">
      <div class="harmony-swatches">
        <div class="harmony-col">
          <div class="harmony-col-label">Current</div>
          <div class="harmony-swatch" style="background:${issue.current}"></div>
          <div class="harmony-hex">${issue.current}</div>
        </div>
        <div class="harmony-col">
          <div class="harmony-col-label">Suggested</div>
          <div class="harmony-swatch" style="background:${issue.suggested}"></div>
          <div class="harmony-hex">${issue.suggested}</div>
        </div>
      </div>
      <div class="harmony-title">${issue.title}</div>
      <div class="harmony-desc">${issue.desc}</div>
      ${issue.contrastSafe ? '<div class="harmony-tag">✓ Contrast-safe</div>' : ''}
      <div class="harmony-actions">
        <button class="btn-dismiss" data-action="dismiss">Dismiss</button>
        <button class="btn-fix" data-action="apply">Apply</button>
      </div>
    </div>
  `).join('');

  box.querySelectorAll('.harmony-issue').forEach(el => {
    const id = Number(el.dataset.id);
    el.querySelector('[data-action="apply"]').onclick = () => {
      const issue = issues.find(i => i.id === id);
      replaceColor(id, issue.suggested);
    };
    el.querySelector('[data-action="dismiss"]').onclick = () => {
      dismissedIssues.add(id);
      renderAll();
    };
  });
}

/* ---------- smart suggestions ---------- */
function averageHue(colors) {
  if (colors.length === 0) return 250;
  let x = 0, y = 0;
  colors.forEach(c => {
    const h = rgbToHsl(hexToRgb(c.hex)).h * Math.PI / 180;
    x += Math.cos(h); y += Math.sin(h);
  });
  let angle = Math.atan2(y, x) * 180 / Math.PI;
  if (angle < 0) angle += 360;
  return angle;
}

function generateSuggestions() {
  const jitter = (n) => (suggestionSeed % 7) - 3 + n; // small deterministic variation per shuffle
  const hue = (averageHue(palette) + suggestionSeed * 17) % 360;

  const light = { h: hue, s: 18 + (suggestionSeed % 3) * 4, l: 96 };
  const dark = { h: hue, s: 10 + (suggestionSeed % 3) * 3, l: 20 };
  const accentHue = (hue + 150 + (suggestionSeed % 2) * 30) % 360;
  const accent = { h: accentHue, s: 68, l: 62 };

  return [
    { kind: 'Light Neutral', role: 'light', hex: hslToHex(light), desc: 'Gentle off-white tuned to your palette\'s hue' },
    { kind: 'Dark Neutral', role: 'dark', hex: hslToHex(dark), desc: 'Deep neutral that stays readable as text' },
    { kind: 'Harmony Color', role: 'accent', hex: hslToHex(accent), desc: 'Vibrant accent to round out your palette' },
  ];
}

function renderSuggestions() {
  const box = document.getElementById('suggestions');
  if (palette.length === 0) {
    box.innerHTML = `<p class="card-sub" style="margin:0;">Add a color to get personalized suggestions.</p>`;
    return;
  }
  const suggestions = generateSuggestions();
  box.innerHTML = suggestions.map((s, idx) => `
    <div class="suggestion-row">
      <div class="suggestion-swatch" style="background:${s.hex}"></div>
      <div class="suggestion-body">
        <div class="suggestion-kind">${s.kind}</div>
        <div class="suggestion-hex">${s.hex}</div>
        <div class="suggestion-desc">${s.desc}</div>
      </div>
      <div class="suggestion-actions">
        <button class="btn-fix" data-idx="${idx}">+ Add</button>
      </div>
    </div>
  `).join('');
  box.querySelectorAll('[data-idx]').forEach(btn => {
    btn.onclick = () => {
      const s = suggestions[Number(btn.dataset.idx)];
      addColor(s.hex, s.role);
      showToast(`Added ${s.hex} to palette`);
    };
  });
}

/* ---------- contrast testing ---------- */
function buildContrastPairs() {
  const pairs = [];
  palette.forEach(c => {
    const rInk = contrastRatio(c.hex, INK_TEXT);
    const rPaper = contrastRatio(c.hex, PAPER_TEXT);
    const useInk = rInk >= rPaper;
    const ratio = useInk ? rInk : rPaper;
    const textColor = useInk ? INK_TEXT : PAPER_TEXT;
    pairs.push({
      key: `${c.id}`, bg: c.hex, text: textColor, ratio: Math.round(ratio * 10) / 10,
      pass: ratio >= 4.5
    });
  });
  return pairs;
}

function renderContrast() {
  const pairs = buildContrastPairs();
  const list = document.getElementById('contrastList');
  const passing = pairs.filter(p => p.pass).length;
  document.getElementById('contrastCount').textContent = `${passing} / ${pairs.length} AA`;

  if (pairs.length === 0) {
    list.innerHTML = `<p class="card-sub" style="margin:0;">Add colors to test contrast pairings.</p>`;
    return;
  }

  list.innerHTML = pairs.map(p => `
    <label class="contrast-row">
      <input type="checkbox" data-key="${p.key}" ${selectedPairings.has(p.key) ? 'checked' : ''}>
      <span class="contrast-swatch" style="background:${p.bg}; color:${p.text}">Aa Text on ${p.bg}</span>
      <span class="contrast-badge ${p.pass ? 'aa' : 'fail'}">${p.pass ? 'AA' : 'FAIL'}</span>
      <span class="contrast-score">${p.ratio}</span>
    </label>
  `).join('');

  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) selectedPairings.add(cb.dataset.key);
      else selectedPairings.delete(cb.dataset.key);
      renderHealth();
    };
  });
}

/* ---------- file import: extract colors from uploaded HTML/CSS ---------- */
const HEX_RE = /#[0-9a-fA-F]{6}(?![0-9a-fA-F])|#[0-9a-fA-F]{3}(?![0-9a-fA-F])/g;
const RGB_RE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)/g;

function extractColorsFromText(text) {
  const found = []; // { match, hex }
  let m;
  HEX_RE.lastIndex = 0;
  while ((m = HEX_RE.exec(text))) {
    found.push({ match: m[0], hex: normalizeHex(m[0]) });
  }
  RGB_RE.lastIndex = 0;
  while ((m = RGB_RE.exec(text))) {
    const hex = rgbToHex({ r: +m[1], g: +m[2], b: +m[3] });
    found.push({ match: m[0], hex });
  }
  return found;
}

function recomputeExtractedColors() {
  const map = new Map(); // hex -> { variants:Set, files:Set }
  uploadedFiles.forEach((file, idx) => {
    extractColorsFromText(file.content).forEach(({ match, hex }) => {
      if (!isValidHex(hex)) return;
      if (!map.has(hex)) map.set(hex, { variants: new Set(), files: new Set() });
      map.get(hex).variants.add(match);
      map.get(hex).files.add(idx);
    });
  });
  const prevSelected = new Map(extractedColors.map(c => [c.hex, c.selected]));
  extractedColors = [...map.entries()].map(([hex, v]) => ({
    hex, variants: v.variants, files: v.files,
    selected: prevSelected.has(hex) ? prevSelected.get(hex) : true
  }));
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

async function handleFiles(fileList) {
  const files = [...fileList].filter(f => /\.(html?|css)$/i.test(f.name));
  if (files.length === 0) { showToast('Only .html and .css files are supported'); return; }
  for (const f of files) {
    try {
      const content = await readFileAsText(f);
      uploadedFiles.push({ name: f.name, content, originalSize: f.size });
    } catch (e) { showToast(`Couldn't read ${f.name}`); }
  }
  recomputeExtractedColors();
  renderUploadPanels();
  showToast(`Parsed ${files.length} file${files.length === 1 ? '' : 's'} — found ${extractedColors.length} unique color${extractedColors.length === 1 ? '' : 's'}`);
}

function applyColorFixToFiles(colorObj, newHex) {
  if (!colorObj.files || !colorObj.variants) return 0;
  let updatedCount = 0;
  colorObj.files.forEach(fileIdx => {
    const file = uploadedFiles[fileIdx];
    if (!file) return;
    let changed = false;
    colorObj.variants.forEach(variant => {
      if (file.content.includes(variant)) {
        file.content = file.content.split(variant).join(newHex);
        changed = true;
      }
    });
    if (changed) updatedCount++;
  });
  colorObj.variants = new Set([newHex]); // future edits target the new value
  return updatedCount;
}

function renderUploadPanels() {
  const extractedPanel = document.getElementById('extractedPanel');
  const filesPanel = document.getElementById('filesPanel');

  if (extractedColors.length === 0) {
    extractedPanel.innerHTML = '';
  } else {
    const selectedCount = extractedColors.filter(c => c.selected).length;
    extractedPanel.innerHTML = `
      <div class="extracted-wrap">
        <div class="extracted-head">
          <h4>Found ${extractedColors.length} color${extractedColors.length === 1 ? '' : 's'}</h4>
          <button class="btn-primary" id="addExtractedBtn">Add ${selectedCount} to palette</button>
        </div>
        <div class="extracted-grid">
          ${extractedColors.map((c, i) => `
            <label class="extracted-chip">
              <input type="checkbox" data-idx="${i}" ${c.selected ? 'checked' : ''}>
              <span class="extracted-swatch" style="background:${c.hex}"></span>
              <span class="extracted-info">
                <span class="extracted-hex">${c.hex}</span><br>
                <span class="extracted-count">${c.files.size} file${c.files.size === 1 ? '' : 's'}</span>
              </span>
            </label>
          `).join('')}
        </div>
      </div>
    `;
    extractedPanel.querySelectorAll('.extracted-chip input').forEach(cb => {
      cb.onchange = () => {
        extractedColors[Number(cb.dataset.idx)].selected = cb.checked;
        renderUploadPanels();
      };
    });
    document.getElementById('addExtractedBtn').onclick = addExtractedColorsToPalette;
  }

  if (uploadedFiles.length === 0) {
    filesPanel.innerHTML = '';
  } else {
    filesPanel.innerHTML = `
      <div class="files-wrap">
        ${uploadedFiles.map((f, i) => {
      const colorsInFile = extractedColors.filter(c => c.files.has(i)).length;
      return `
            <div class="file-row">
              <div class="file-icon">${f.name.split('.').pop().toUpperCase().slice(0, 3)}</div>
              <div class="file-meta">
                <div class="file-name">${f.name}</div>
                <div class="file-sub">${colorsInFile} color${colorsInFile === 1 ? '' : 's'} found · ${(f.originalSize / 1024).toFixed(1)} KB</div>
              </div>
              <button class="btn-ghost small" data-download="${i}">Download fixed</button>
            </div>
          `;
    }).join('')}
      </div>
    `;
    filesPanel.querySelectorAll('[data-download]').forEach(btn => {
      btn.onclick = () => {
        const f = uploadedFiles[Number(btn.dataset.download)];
        downloadFile(f.name, f.content, f.name.endsWith('.css') ? 'text/css' : 'text/html');
        showToast(`Downloaded ${f.name}`);
      };
    });
  }
}

function addExtractedColorsToPalette() {
  const toAdd = extractedColors.filter(c => c.selected);
  let added = 0;
  toAdd.forEach(c => {
    if (palette.some(p => p.hex === c.hex)) return; // already in palette
    addColor(c.hex, 'accent', { variants: new Set(c.variants), files: new Set(c.files) });
    added++;
  });
  showToast(added > 0 ? `Added ${added} color${added === 1 ? '' : 's'} to palette` : 'Those colors are already in your palette');
}

/* ---------- design image: dominant color extraction ---------- */
let designImage = null;      // { dataUrl, name }
let designColors = [];       // { hex, weight, selected }

function extractDominantColors(imgEl, k = 6) {
  const size = 120;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  const buckets = new Map(); // key -> {count, r,g,b}
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const qr = Math.round(r / 24) * 24, qg = Math.round(g / 24) * 24, qb = Math.round(b / 24) * 24;
    const key = `${qr},${qg},${qb}`;
    if (!buckets.has(key)) buckets.set(key, { count: 0, r: 0, g: 0, b: 0 });
    const bucket = buckets.get(key);
    bucket.count++; bucket.r += r; bucket.g += g; bucket.b += b;
  }

  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  const total = sorted.reduce((s, b) => s + b.count, 0) || 1;
  return sorted.slice(0, k).map(b => ({
    hex: rgbToHex({ r: b.r / b.count, g: b.g / b.count, b: b.b / b.count }),
    weight: Math.round((b.count / total) * 100)
  }));
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve({ img, dataUrl: reader.result });
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleDesignImage(file) {
  if (!file.type.startsWith('image/')) { showToast('Please upload an image file'); return; }
  try {
    const { img, dataUrl } = await loadImageFile(file);
    designImage = { dataUrl, name: file.name };
    designColors = extractDominantColors(img, 6).map(c => ({ ...c, selected: true }));
    renderDesignPanel();
    showToast(`Extracted ${designColors.length} colors from ${file.name}`);
  } catch (e) {
    showToast('Could not read that image');
  }
}

function removeDesignImage() {
  designImage = null;
  designColors = [];
  renderDesignPanel();
}

function addDesignColorsToPalette() {
  const toAdd = designColors.filter(c => c.selected);
  let added = 0;
  toAdd.forEach(c => {
    if (palette.some(p => p.hex === c.hex)) return;
    addColor(c.hex, 'accent');
    added++;
  });
  showToast(added > 0 ? `Added ${added} color${added === 1 ? '' : 's'} to palette` : 'Those colors are already in your palette');
}

function renderDesignPanel() {
  const panel = document.getElementById('designPreviewPanel');

  if (!designImage) {
    panel.innerHTML = '';
    return;
  }
  const selectedCount = designColors.filter(c => c.selected).length;
  panel.innerHTML = `
    <div class="design-preview">
      <img class="design-thumb" src="${designImage.dataUrl}" alt="Uploaded design preview">
      <div class="design-swatches">
        <div class="design-swatches-head">
          <h4>Dominant colors</h4>
          <button class="btn-primary" id="addDesignColorsBtn">Add ${selectedCount} to palette</button>
        </div>
        <div class="design-chip-list">
          ${designColors.map((c, i) => `
            <label class="design-chip">
              <input type="checkbox" data-idx="${i}" ${c.selected ? 'checked' : ''}>
              <span class="design-swatch" style="background:${c.hex}"></span>
              <span class="design-chip-hex">${c.hex}</span>
              <span class="design-chip-weight">${c.weight}%</span>
            </label>
          `).join('')}
        </div>
        <button class="btn-ghost small design-remove-img" id="removeDesignImgBtn">Remove image</button>
      </div>
    </div>
  `;
  panel.querySelectorAll('.design-chip input').forEach(cb => {
    cb.onchange = () => {
      designColors[Number(cb.dataset.idx)].selected = cb.checked;
      renderDesignPanel();
    };
  });
  document.getElementById('addDesignColorsBtn').onclick = addDesignColorsToPalette;
  document.getElementById('removeDesignImgBtn').onclick = removeDesignImage;
}

/* ---------- free instant review (rule-based, no API needed) ---------- */
function nearestPaletteDistance(hex, list) {
  const a = hexToRgb(hex);
  let best = Infinity;
  list.forEach(h => {
    const b = hexToRgb(h);
    const d = Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
    if (d < best) best = d;
  });
  return best;
}

function generateFreeReview() {
  const bullets = [];
  const health = computeHealth();

  // 1. overall health
  if (health.percent >= 80) {
    bullets.push(`Your palette's in good shape — **${health.percent}% health score**, with most of the essentials covered.`);
  } else if (health.percent >= 45) {
    bullets.push(`Your palette is **${health.percent}% complete**. A few checklist items in the Health card are still unmet — worth closing those out before you ship it.`);
  } else {
    bullets.push(`Health score is **${health.percent}%** — this palette is still early. Add more colors and a light/dark neutral to round it out.`);
  }

  // 2. color count / composition
  if (palette.length < 3) {
    bullets.push(`Only **${palette.length} color${palette.length === 1 ? '' : 's'}** in the palette. Most interfaces need at least a hero, one or two accents, and a neutral pair to feel intentional.`);
  } else if (palette.length > 9) {
    bullets.push(`**${palette.length} colors** is a lot to keep consistent. Consider consolidating near-duplicates into a smaller, more disciplined set — it usually reads as more confident design, not less.`);
  }
  if (!palette.some(c => c.role === 'light')) bullets.push(`No **light neutral** assigned — you'll want one for backgrounds and light surfaces.`);
  if (!palette.some(c => c.role === 'dark')) bullets.push(`No **dark neutral** assigned — you'll want one for body text and dark UI elements.`);

  // 3. harmony
  const harmonyIssues = computeHarmonyIssues();
  if (harmonyIssues.length) {
    const issue = harmonyIssues[0];
    bullets.push(`**${issue.current}** reads noticeably more saturated than the rest of the palette. Try pulling it toward **${issue.suggested}** to keep the set feeling cohesive.`);
    if (harmonyIssues.length > 1) {
      bullets.push(`${harmonyIssues.length - 1} other color${harmonyIssues.length > 2 ? 's' : ''} could use the same treatment — see the Harmony Check card for each fix.`);
    }
  } else if (palette.length >= 2) {
    bullets.push(`Saturation is consistent across the palette — no jarring outliers pulling focus.`);
  }

  // 4. contrast
  const coverage = contrastCoverage();
  if (palette.length > 0) {
    if (coverage.percent >= 90) {
      bullets.push(`Accessibility looks solid: **${coverage.percent}%** of your colors have at least one WCAG AA-passing text pairing.`);
    } else if (coverage.percent >= 60) {
      bullets.push(`**${coverage.percent}%** of colors pass AA contrast against dark or light text. Check the Contrast Testing card for the ones that don't — they'll be hard to read as text or on top of text.`);
    } else {
      bullets.push(`Only **${coverage.percent}%** of colors pass AA contrast — accessibility needs attention here before this palette goes into a real interface.`);
    }
  }

  // 5. hero/accent balance
  const heroCount = palette.filter(c => c.role === 'hero').length;
  const accentCount = palette.filter(c => c.role === 'accent').length;
  if (heroCount > 1) {
    bullets.push(`**${heroCount} colors** are marked Hero. Usually one hero color anchors a design best — the rest read more clearly as accents.`);
  }
  if (heroCount === 0 && accentCount > 0) {
    bullets.push(`No color is marked **Hero**. Picking one primary color to lead the palette usually makes a design feel more intentional than an even spread of accents.`);
  }

  // 6. tie to uploaded design, if present
  if (designImage && designColors.length) {
    const paletteHexes = palette.map(c => c.hex);
    const matched = designColors.filter(d => nearestPaletteDistance(d.hex, paletteHexes) < 40).length;
    if (paletteHexes.length === 0) {
      bullets.push(`Your uploaded design has its own dominant colors — add them to the palette above so the rest of this review can check them too.`);
    } else if (matched === 0) {
      bullets.push(`None of the dominant colors pulled from your uploaded image closely match your current palette — the design and the palette may have drifted apart.`);
    } else if (matched < designColors.length) {
      bullets.push(`${matched} of ${designColors.length} dominant colors from your design match the palette — the rest may be worth folding in or reconciling.`);
    } else {
      bullets.push(`Every dominant color in your uploaded design is represented in the palette — good consistency between the two.`);
    }
  }

  return bullets;
}

function renderFreeReview() {
  const out = document.getElementById('freeReviewOutput');
  if (palette.length === 0 && !designImage) {
    out.innerHTML = `<div class="feedback-error">Add some colors or upload a design image first, so there's something to review.</div>`;
    return;
  }
  freeReviewHasRun = true;
  const bullets = generateFreeReview();
  const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out.innerHTML = `<div class="feedback-text"><ul>${bullets.map(b => `<li>${bold(b)}</li>`).join('')}</ul></div>`;
}

document.getElementById('getFreeReviewBtn').onclick = renderFreeReview;

/* ---------- AI design feedback (bring-your-own key, multiple providers) ---------- */
const PROVIDERS = {
  gemini: {
    storageKey: 'paletteFixer_geminiKey',
    keyPlaceholder: 'AIza...',
    note: 'Get a free key at <strong>aistudio.google.com/apikey</strong> — no credit card needed. Free tier supports image input and roughly 15 requests/minute.'
  },
  openrouter: {
    storageKey: 'paletteFixer_openrouterKey',
    keyPlaceholder: 'sk-or-v1-...',
    note: 'Get a free key at <strong>openrouter.ai/keys</strong> — no credit card needed. Uses free, community-hosted models with modest rate limits (they rotate over time).'
  },
  openai: {
    storageKey: 'paletteFixer_openaiKey',
    keyPlaceholder: 'sk-...',
    note: 'Get a key at <strong>platform.openai.com/api-keys</strong> — separate from your chatgpt.com login, needs a funded API account, and costs a small amount per request.'
  }
};

const apiKeyInput = document.getElementById('apiKeyInput');
const saveKeyToggle = document.getElementById('saveKeyToggle');
const clearKeyBtn = document.getElementById('clearKeyBtn');
const feedbackOutput = document.getElementById('feedbackOutput');
const providerSelect = document.getElementById('providerSelect');
const providerNote = document.getElementById('providerNote');

function currentProvider() { return PROVIDERS[providerSelect.value]; }

function loadKeyForProvider() {
  const provider = currentProvider();
  apiKeyInput.placeholder = provider.keyPlaceholder;
  providerNote.innerHTML = provider.note;
  const stored = localStorage.getItem(provider.storageKey);
  if (stored) {
    apiKeyInput.value = stored;
    clearKeyBtn.style.display = 'inline-block';
  } else {
    apiKeyInput.value = '';
    clearKeyBtn.style.display = 'none';
  }
}
loadKeyForProvider();
providerSelect.addEventListener('change', loadKeyForProvider);

document.getElementById('toggleKeyVisibility').onclick = (e) => {
  const btn = e.currentTarget;
  const showing = apiKeyInput.type === 'text';
  apiKeyInput.type = showing ? 'password' : 'text';
  btn.textContent = showing ? 'Show' : 'Hide';
};
clearKeyBtn.onclick = () => {
  localStorage.removeItem(currentProvider().storageKey);
  apiKeyInput.value = '';
  clearKeyBtn.style.display = 'none';
  showToast('Removed saved key from this device');
};

function renderFeedbackMarkdownish(text) {
  // lightweight markdown: **bold**, bullet lines starting with -/*, paragraphs
  const lines = text.split('\n').map(l => l.trim());
  let html = ''; let inList = false;
  lines.forEach(line => {
    if (!line) { if (inList) { html += '</ul>'; inList = false; } return; }
    const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${bold(line.replace(/^[-*]\s+/, ''))}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${bold(line)}</p>`;
    }
  });
  if (inList) html += '</ul>';
  return html;
}

function buildPromptText() {
  const paletteDesc = palette.length
    ? palette.map(c => `${c.hex} (${c.role})`).join(', ')
    : 'No palette colors added yet.';
  return `Review this color palette for a design project: ${paletteDesc}.\n` +
    `Give concise, specific feedback in 4-6 short bullet points: harmony, contrast/accessibility, and one or two concrete hex-level suggestions. ` +
    (designImage ? 'An image of the design is attached — comment on how the palette is actually used in it too.' : '');
}

const SYSTEM_PROMPT = 'You are a senior graphic designer and color-theory consultant. Be specific, reference actual hex codes given to you, and keep feedback tight and actionable.';

async function callOpenAICompatible(baseUrl, key, extraHeaders) {
  const userContent = [{ type: 'text', text: buildPromptText() }];
  if (designImage) userContent.push({ type: 'image_url', image_url: { url: designImage.dataUrl } });

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, ...(extraHeaders || {}) },
    body: JSON.stringify({
      model: baseUrl.includes('openrouter') ? 'openrouter/free' : 'gpt-4o-mini',
      max_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ]
    })
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `Request failed (HTTP ${res.status}).`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('No feedback came back — try again.');
  return text;
}

async function callGemini(key) {
  const parts = [{ text: `${SYSTEM_PROMPT}\n\n${buildPromptText()}` }];
  if (designImage) {
    const [meta, base64] = designImage.dataUrl.split(',');
    const mimeMatch = meta.match(/data:(.*);base64/);
    parts.push({ inline_data: { mime_type: mimeMatch ? mimeMatch[1] : 'image/png', data: base64 } });
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }] })
    }
  );
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `Request failed (HTTP ${res.status}).`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim();
  if (!text) throw new Error('No feedback came back — try again.');
  return text;
}

async function getDesignFeedback() {
  const key = apiKeyInput.value.trim();
  const providerKey = providerSelect.value;

  if (!key) {
    feedbackOutput.innerHTML = `<div class="feedback-error">Enter an API key first for the selected provider.</div>`;
    return;
  }
  if (palette.length === 0 && !designImage) {
    feedbackOutput.innerHTML = `<div class="feedback-error">Add some colors or upload a design image first, so there's something to review.</div>`;
    return;
  }

  if (saveKeyToggle.checked) {
    localStorage.setItem(currentProvider().storageKey, key);
    clearKeyBtn.style.display = 'inline-block';
  } else {
    localStorage.removeItem(currentProvider().storageKey);
    clearKeyBtn.style.display = 'none';
  }

  feedbackOutput.innerHTML = `
    <div class="feedback-loading"><span class="feedback-spinner"></span> Asking your AI reviewer for feedback…</div>
  `;
  document.getElementById('aiStaleNote').style.display = 'none';

  try {
    let text;
    if (providerKey === 'gemini') {
      text = await callGemini(key);
    } else if (providerKey === 'openrouter') {
      text = await callOpenAICompatible('https://openrouter.ai/api/v1', key, {
        'HTTP-Referer': location.origin || 'https://sandy-color-palette-fixer.local',
        'X-Title': 'Sandy Color Palette Fixer'
      });
    } else {
      text = await callOpenAICompatible('https://api.openai.com/v1', key);
    }
    feedbackOutput.innerHTML = `<div class="feedback-text">${renderFeedbackMarkdownish(text)}</div>`;
    aiFeedbackSnapshot = currentReviewSnapshot();
  } catch (err) {
    feedbackOutput.innerHTML = `<div class="feedback-error">${err.message || `Couldn't reach the provider from this browser. Check your connection and API key, then try again.`}</div>`;
  }
}

document.getElementById('getFeedbackBtn').onclick = getDesignFeedback;

/* ---------- image upload events ---------- */
const imageDropzone = document.getElementById('imageDropzone');
const imageInput = document.getElementById('imageInput');

imageDropzone.addEventListener('click', () => imageInput.click());
imageDropzone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); imageInput.click(); }
});
imageInput.addEventListener('change', e => {
  if (e.target.files.length) handleDesignImage(e.target.files[0]);
  imageInput.value = '';
});
['dragover', 'dragenter'].forEach(evt => {
  imageDropzone.addEventListener(evt, e => { e.preventDefault(); imageDropzone.classList.add('dragover'); });
});
['dragleave', 'drop'].forEach(evt => {
  imageDropzone.addEventListener(evt, e => { e.preventDefault(); imageDropzone.classList.remove('dragover'); });
});
imageDropzone.addEventListener('drop', e => {
  if (e.dataTransfer.files.length) handleDesignImage(e.dataTransfer.files[0]);
});

/* ---------- export ---------- */
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function exportCSSVars() {
  const roleCounts = {};
  const lines = palette.map(c => {
    const base = c.role;
    roleCounts[base] = (roleCounts[base] || 0) + 1;
    const name = roleCounts[base] > 1 ? `${base}-${roleCounts[base]}` : base;
    return `  --${name}: ${c.hex};`;
  });
  const css = `:root{\n${lines.join('\n')}\n}\n`;
  downloadFile('palette.css', css, 'text/css');
  showToast('Downloaded palette.css');
}

function exportJSONFile() {
  const data = {
    generated: new Date().toISOString(),
    colors: palette.map(c => ({ hex: c.hex, role: c.role }))
  };
  downloadFile('palette.json', JSON.stringify(data, null, 2), 'application/json');
  showToast('Downloaded palette.json');
}

function exportSVGFile() {
  const w = 160, h = 160, cols = Math.min(palette.length, 4) || 1;
  const rows = Math.ceil(palette.length / cols) || 1;
  let inner = '';
  palette.forEach((c, i) => {
    const x = (i % cols) * w, y = Math.floor(i / cols) * h;
    inner += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c.hex}"/>`;
    inner += `<text x="${x + 12}" y="${y + h - 16}" font-family="monospace" font-size="13" fill="${contrastRatio(c.hex, '#000000') > contrastRatio(c.hex, '#FFFFFF') ? '#000' : '#FFF'}">${c.hex}</text>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols * w} ${rows * h}">${inner}</svg>`;
  downloadFile('palette.svg', svg, 'image/svg+xml');
  showToast('Downloaded palette.svg');
}

function copyHexList() {
  const text = palette.map(c => c.hex).join(', ');
  if (!text) { showToast('Add colors first'); return; }
  navigator.clipboard.writeText(text).then(() => showToast('Copied hex codes ✓'))
    .catch(() => showToast('Could not copy — select and copy manually'));
}

/* ---------- color-blind safety check ---------- */
// Simplified simulation matrices (approximate; applied directly to sRGB 0-1,
// not linearized — good enough for a quick design-time warning, not a
// clinically precise simulator).
const CB_MATRICES = {
  protanopia: { label: 'Protanopia (red-weak)', m: [[0.567, 0.433, 0], [0.558, 0.442, 0], [0, 0.242, 0.758]] },
  deuteranopia: { label: 'Deuteranopia (green-weak)', m: [[0.625, 0.375, 0], [0.7, 0.3, 0], [0, 0.3, 0.7]] },
  tritanopia: { label: 'Tritanopia (blue-weak)', m: [[0.95, 0.05, 0], [0, 0.433, 0.567], [0, 0.475, 0.525]] },
};

function colorDistance(hexA, hexB) {
  // "redmean" — a cheap but much more perceptually accurate distance than plain Euclidean RGB
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  const rMean = (a.r + b.r) / 2;
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}

function simulateColorBlindness(hex, matrix) {
  const { r, g, b } = hexToRgb(hex);
  const R = r / 255, G = g / 255, B = b / 255;
  const nr = matrix[0][0] * R + matrix[0][1] * G + matrix[0][2] * B;
  const ng = matrix[1][0] * R + matrix[1][1] * G + matrix[1][2] * B;
  const nb = matrix[2][0] * R + matrix[2][1] * G + matrix[2][2] * B;
  return rgbToHex({ r: nr * 255, g: ng * 255, b: nb * 255 });
}

function findColorBlindConfusions() {
  const unique = [...new Map(palette.map(c => [c.hex, c])).values()];
  const results = [];
  Object.entries(CB_MATRICES).forEach(([key, { label, m }]) => {
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const a = unique[i], b = unique[j];
        const originalDist = colorDistance(a.hex, b.hex);
        if (originalDist < 100) continue; // already similar in typical vision — not a CB-specific issue
        const simA = simulateColorBlindness(a.hex, m);
        const simB = simulateColorBlindness(b.hex, m);
        const simDist = colorDistance(simA, simB);
        // flag when the simulated distance both drops sharply relative to normal vision
        // and lands in an absolute range where colors read as near-identical
        if (simDist < 220 && simDist < originalDist * 0.65) {
          results.push({ type: key, label, a: a.hex, b: b.hex });
        }
      }
    }
  });
  return results.slice(0, 4);
}

function renderColorBlindCheck() {
  const box = document.getElementById('colorBlindResults');
  const unique = [...new Map(palette.map(c => [c.hex, c])).values()];
  if (unique.length < 2) {
    box.innerHTML = `<p class="card-sub" style="margin:0;">Add at least two colors to run this check.</p>`;
    return;
  }
  const issues = findColorBlindConfusions();
  if (issues.length === 0) {
    box.innerHTML = `<div class="cb-clean">✓ No confusable pairs detected across common color-vision types.</div>`;
    return;
  }
  box.innerHTML = issues.map(issue => `
    <div class="cb-issue">
      <span class="cb-tag">${issue.type.slice(0, 4)}</span>
      <span class="cb-swatches">
        <span class="cb-swatch" style="background:${issue.a}"></span>
        <span class="cb-swatch" style="background:${issue.b}"></span>
      </span>
      <span class="cb-desc"><strong>${issue.a}</strong> and <strong>${issue.b}</strong> may look nearly identical under ${issue.label}.</span>
    </div>
  `).join('');
}

/* ---------- render orchestration ---------- */
/* ---------- staleness tracking for reviews ---------- */
let freeReviewHasRun = false;
let aiFeedbackSnapshot = null; // set when an AI review last succeeded

function currentReviewSnapshot() {
  return JSON.stringify(palette.map(c => `${c.hex}:${c.role}`)) + '|' +
    (designImage ? `${designImage.name}:${designImage.dataUrl.length}` : 'no-image');
}

function updateAiStaleNote() {
  const note = document.getElementById('aiStaleNote');
  if (!note) return;
  const stale = aiFeedbackSnapshot !== null && aiFeedbackSnapshot !== currentReviewSnapshot();
  note.style.display = stale ? 'block' : 'none';
}

function renderAll() {
  renderPalette();
  renderHealth();
  renderHarmony();
  renderSuggestions();
  renderContrast();
  renderColorBlindCheck();
  if (freeReviewHasRun) renderFreeReview(); // keep the free review in sync with the live palette
  updateAiStaleNote();
}

/* ---------- events ---------- */
document.getElementById('addColorBtn').onclick = () => {
  const hex = hexInput.value.trim() || colorPicker.value;
  addColor(hex, roleInput.value);
  hexInput.value = '';
};
hexInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { document.getElementById('addColorBtn').click(); }
});
colorPicker.addEventListener('input', () => { hexInput.value = colorPicker.value.toUpperCase(); });

document.getElementById('clearBtn').onclick = () => {
  palette = []; dismissedIssues.clear(); selectedPairings.clear();
  renderAll();
};
document.getElementById('importBtn').onclick = () => {
  palette = STARTER.map(c => ({ ...c, id: idCounter++ }));
  dismissedIssues.clear(); selectedPairings.clear();
  renderAll();
  showToast('Imported starter palette');
};
document.getElementById('rescanBtn').onclick = () => {
  dismissedIssues.clear();
  renderHarmony();
  showToast('Rescanned for harmony issues');
};

document.getElementById('exportCopy').onclick = copyHexList;
document.getElementById('exportCSS').onclick = exportCSSVars;
document.getElementById('exportJSON').onclick = exportJSONFile;
document.getElementById('exportSVG').onclick = exportSVGFile;

/* suggestion shuffle-on-add: nudge seed so re-generating gives new picks */
document.addEventListener('click', (e) => {
  if (e.target.closest('.suggestion-row [data-idx]')) suggestionSeed++;
});

/* ---------- file upload events ---------- */
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', e => {
  if (e.target.files.length) handleFiles(e.target.files);
  fileInput.value = '';
});
['dragover', 'dragenter'].forEach(evt => {
  dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('dragover'); });
});
['dragleave', 'drop'].forEach(evt => {
  dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('dragover'); });
});
dropzone.addEventListener('drop', e => {
  if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

/* ---------- init ---------- */
palette = STARTER.map(c => ({ ...c, id: idCounter++ }));
renderAll();