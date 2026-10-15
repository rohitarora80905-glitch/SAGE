/* ---------------------------------------------------------------- core: helpers, charts, reveal, nav */
'use strict';
const $ = (id) => document.getElementById(id);
const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const k in attrs || {}) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'style') e.style.cssText = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
function svgText(parent, x, y, str, attrs) { const t = svgEl('text', Object.assign({ x, y }, attrs || {}), parent); t.textContent = str; return t; }
function fmt(v, d) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  if (d === undefined) d = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return Number(v).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function compact(v) {
  if (v === null || v === undefined) return '–';
  if (Number.isInteger(v) && Math.abs(v) < 1e4) return fmt(v, 0);
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
  return fmt(v, a >= 10 ? 0 : a >= 1 ? 1 : 2);
}
const pct = (v, d) => v === null || v === undefined ? '–' : fmt(v, d === undefined ? 1 : d) + '%';
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function color(key) { return css('--s-' + key) || css('--s-grey'); }
const POLICY_LABEL = { sage: 'SAGE', bankers: "Banker's algorithm", bankers_nodecl: "Banker's, no declaration", reactive: 'Reactive detection', timeout: 'Timeout', wait_die: 'Wait-die', wound_wait: 'Wound-wait', sage_lstm: 'SAGE (LSTM engine)' };
const POLICY_ORDER = ['sage', 'bankers', 'reactive', 'bankers_nodecl', 'wound_wait', 'wait_die', 'timeout', 'sage_lstm'];
const FAM_LABEL = { fixed: 'Fixed-pattern', bursty: 'Bursty / random', escalating: 'Gradually escalating', mixed: 'Mixed', shift: 'Behaviour shift' };
const PATH_LABEL = { learned: 'learned', cold: 'cold start', uncertain: 'uncertain', drift: 'drift', drain: 'starvation guard', bankers: "Banker's", reactive: 'reactive' };
const PATH_CLASS = { learned: 'info', cold: 'plain', uncertain: 'warn', drift: 'warn', drain: 'warn' };
function badge(txt, cls) { return h('span', { class: 'badge ' + (cls || 'plain') }, txt); }
function swatch(key) { return h('span', { class: 'sw', style: 'background:' + color(key) }); }

// Markdown (headings, emphasis, lists, tables, code) for the analyst's text
function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let out = '', i = 0, inList = null, para = [];
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  const flushP = () => { if (para.length) { out += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
  const closeList = () => { if (inList) { out += '</' + inList + '>'; inList = null; } };
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```/.test(ln)) { flushP(); closeList(); const code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); out += '<pre>' + esc(code.join('\n')) + '</pre>'; i++; continue; }
    const hm = /^(#{1,4})\s+(.*)$/.exec(ln);
    if (hm) { flushP(); closeList(); out += `<h${hm[1].length + 1}>${inline(hm[2])}</h${hm[1].length + 1}>`; i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(ln)) { flushP(); const tag = /^\s*\d+\./.test(ln) ? 'ol' : 'ul'; if (inList !== tag) { closeList(); out += '<' + tag + '>'; inList = tag; } out += '<li>' + inline(ln.replace(/^\s*([-*]|\d+\.)\s+/, '')) + '</li>'; i++; continue; }
    if (/^\s*\|/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-+/.test(lines[i + 1])) {
      flushP(); closeList();
      const cells = (l) => l.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim());
      out += '<div class="table-wrap"><table><tr>' + cells(ln).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr>'; i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { out += '<tr>' + cells(lines[i]).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>'; i++; }
      out += '</table></div>'; continue;
    }
    if (/^\s*>/.test(ln)) { flushP(); closeList(); out += '<blockquote>' + inline(ln.replace(/^\s*>\s?/, '')) + '</blockquote>'; i++; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(ln)) { flushP(); closeList(); out += '<hr>'; i++; continue; }
    if (!ln.trim()) { flushP(); closeList(); i++; continue; }
    closeList(); para.push(ln.trim()); i++;
  }
  flushP(); closeList();
  return out;
}

// count-up for figures
function countUp(node, value, digits, ms) {
  if (reduced || !Number.isFinite(value)) { node.textContent = fmt(value, digits); return; }
  const t0 = performance.now(), dur = ms || 1100;
  const step = (t) => { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3); node.textContent = fmt(value * e, digits); if (p < 1) requestAnimationFrame(step); else node.textContent = fmt(value, digits); };
  requestAnimationFrame(step);
}
function kpi(label, value, unit, opts) {
  opts = opts || {};
  const isNum = typeof value === 'number' && Number.isFinite(value);
  const val = h('p', { class: 'k-value' }, isNum ? fmt(0, opts.digits) : (value === null || value === undefined ? '–' : value), unit ? h('span', { class: 'k-unit' }, unit) : null);
  const k = h('div', { class: 'kpi' + (opts.accent ? ' accent' : '') }, h('p', { class: 'k-label' }, label), val);
  if (opts.note) k.appendChild(h('p', { class: 'k-note' }, opts.note));
  if (isNum) whenVisible(k, () => countUp(val.firstChild, value, opts.digits));
  return k;
}

// visibility helpers: things below the fold animate when they arrive; things in view run now
const belowFold = (el) => el.getBoundingClientRect().top > window.innerHeight * 0.92;
const io = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { const f = e.target.__onvisible; if (f) { e.target.__onvisible = null; f(); } io.unobserve(e.target); }
}, { threshold: 0.12 }) : null;
function whenVisible(el, fn) {
  if (!io || reduced || !belowFold(el)) { fn(); return; }
  el.__onvisible = fn; io.observe(el);
  setTimeout(() => { if (el.__onvisible) { el.__onvisible = null; fn(); } }, 12000);
}
// section-aware animations: start/stop loops when their section is on screen
const activeIO = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => { for (const e of entries) { const f = e.target.__active; if (f) f(e.isIntersecting); } }, { threshold: 0.05 }) : null;
function onActive(el, fn) { el.__active = fn; if (activeIO) activeIO.observe(el); else fn(true); }

// ---------------------------------------------------------------- charts (SVG)
const Charts = (() => {
  const registry = new Map();
  const tip = $('tooltip');
  function showTip(x, y, title, rows) {
    tip.innerHTML = '';
    if (title) tip.appendChild(h('div', { class: 'tt-title' }, title));
    for (const r of rows) tip.appendChild(h('div', { class: 'tt-row' }, r.color ? h('i', { style: 'background:' + r.color }) : null, h('b', {}, r.value), h('span', {}, r.label)));
    tip.classList.add('show');
    const w = tip.offsetWidth, hh = tip.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + hh > window.innerHeight - 8) top = y - hh - 14;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }
  function hideTip() { tip.classList.remove('show'); }
  function niceTicks(lo, hi, n) {
    if (hi <= lo) hi = lo + 1;
    const raw = (hi - lo) / (n || 5), p = Math.pow(10, Math.floor(Math.log10(raw)));
    let step = p; for (const s of [1, 2, 2.5, 5, 10]) { if (raw / p <= s) { step = s * p; break; } }
    const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10)); return out;
  }
  function logTicks(lo, hi) { const out = [], e0 = Math.floor(Math.log10(lo)), e1 = Math.ceil(Math.log10(hi)); const mults = e1 - e0 > 2 ? [1] : [1, 2, 5]; for (let e = e0; e <= e1; e++) for (const m of mults) { const v = m * Math.pow(10, e); if (v >= lo / 1.001 && v <= hi * 1.001) out.push(v); } return out; }
  const logFmt = v => v >= 1 ? compact(v) : String(+v.toPrecision(2));
  function frame(container, opts) {
    container.innerHTML = '';
    const W = Math.max(240, container.clientWidth || 480), H = opts.height || 240;
    const m = Object.assign({ top: 14, right: 16, bottom: 36, left: 46 }, opts.margin || {});
    const svg = svgEl('svg', { class: 'viz', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' }, container);
    const g = svgEl('g', { transform: `translate(${m.left},${m.top})` }, svg);
    return { svg, g, W, H, iw: W - m.left - m.right, ih: H - m.top - m.bottom, m };
  }
  function yAxis(f, scale, ticks, format) {
    const grid = svgEl('g', { class: 'grid' }, f.g), ax = svgEl('g', { class: 'axis' }, f.g);
    for (const v of ticks) { const y = scale(v); svgEl('line', { x1: 0, x2: f.iw, y1: y, y2: y }, grid); const t = svgText(ax, -8, y + 4, format(v), { 'text-anchor': 'end' }); t.setAttribute('class', 'tick'); }
    svgEl('line', { x1: 0, x2: f.iw, y1: f.ih, y2: f.ih }, ax);
  }
  function tickText(parent, x, y, str, attrs) { const g = svgEl('g', { class: 'tick' }, parent); return svgText(g, x, y, str, attrs); }
  function legend(container, series, onToggle) {
    if (series.length < 2) return;
    const lg = h('div', { class: 'legend' });
    series.forEach((s, k) => { const sp = h('span', {}, h('i', { class: s.kind === 'line' ? 'line' : '', style: 'background:' + s.color }), s.label); sp.addEventListener('click', () => { sp.classList.toggle('off'); onToggle && onToggle(k, !sp.classList.contains('off')); }); lg.appendChild(sp); });
    container.appendChild(lg);
  }
  function tableEl(headers, rows) {
    const t = h('table', { class: 'tbl' });
    const tr = h('tr'); headers.forEach(hd => tr.appendChild(h('th', { class: typeof hd !== 'string' && hd.num ? 'num' : '' }, typeof hd === 'string' ? hd : hd.label))); t.appendChild(tr);
    rows.forEach((r, ri) => {
      const row = h('tr', { class: 'row-in', style: '--i:' + Math.min(ri, 24) });
      r.forEach((v, k) => { const c = h('td'); if (v && v.nodeType) c.appendChild(v); else if (typeof v === 'number') { c.textContent = Number.isInteger(v) ? fmt(v, 0) : fmt(v); c.className = 'num'; } else c.textContent = v === null || v === undefined ? '–' : String(v); if (typeof headers[k] !== 'string' && headers[k].num) c.classList.add('num'); row.appendChild(c); });
      t.appendChild(row);
    });
    return t;
  }
  function tableToggle(container, headers, rows) {
    const foot = h('div', { class: 'chart-foot' }), wrap = h('div', { class: 'table-wrap' }); wrap.hidden = true; wrap.appendChild(tableEl(headers, rows));
    const btn = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { wrap.hidden = !wrap.hidden; btn.textContent = wrap.hidden ? 'Table view' : 'Hide table'; } }, 'Table view');
    foot.appendChild(btn); container.appendChild(foot); container.appendChild(wrap);
  }
  function roundTop(x, y, w, hh, r) { if (hh <= 0.5) return `M${x},${y + hh}h${w}v0h${-w}z`; r = Math.min(r, w / 2, hh); return `M${x},${y + hh}V${y + r}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}V${y + hh}z`; }
  function arm(container, svg) { svg.classList.add('anim'); whenVisible(container, () => requestAnimationFrame(() => svg.classList.add('go'))); }

  function groupedBars(container, opts) {
    const render = () => {
      const series = opts.series.filter(s => s.values), hidden = new Set();
      const hasSd = series.some(s => s.sd && s.sd.some(x => x)), showLabels = opts.directLabels && series.length <= 4 && (!hasSd || opts.forceLabels);
      const f = frame(container, Object.assign({ height: 240, margin: { top: showLabels ? 24 : 14, right: 16, bottom: 36, left: 46 } }, opts));
      const cats = opts.categories;
      const vals = series.flatMap(s => s.values.map((v, k) => (v || 0) + (s.sd ? (s.sd[k] || 0) : 0))).filter(v => v !== null && !Number.isNaN(v));
      let lo = 0, hi = Math.max(1e-9, ...vals), scale, ticks;
      if (opts.log) { const pos = series.flatMap(s => s.values).filter(v => v > 0); lo = Math.min(...pos) / 2; hi = Math.max(...pos) * 1.5; scale = v => f.ih - (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * f.ih; ticks = logTicks(lo, hi); }
      else { ticks = niceTicks(0, hi, 5); hi = ticks[ticks.length - 1] || hi; scale = v => f.ih - (v / hi) * f.ih; }
      yAxis(f, scale, ticks, opts.log ? logFmt : compact);
      const band = f.iw / cats.length, inner = band * 0.78, bw = Math.min(24, (inner - 2 * (series.length - 1)) / series.length), total = bw * series.length + 2 * (series.length - 1);
      const bars = [];
      cats.forEach((c, ci) => {
        const x0 = ci * band + (band - total) / 2;
        svgText(f.g, ci * band + band / 2, f.ih + 18, opts.catLabels ? opts.catLabels[ci] : c, { 'text-anchor': 'middle', class: 'cat' });
        series.forEach((s, si) => {
          const v = s.values[ci]; if (v === null || v === undefined || Number.isNaN(v)) return;
          const x = x0 + si * (bw + 2), y = scale(v), hh = f.ih - y;
          const p = svgEl('path', { d: roundTop(x, y, bw, hh, 4), fill: s.color, class: 'bar' }, f.g); p.style.setProperty('--i', ci * series.length + si); bars.push([p, si]);
          if (s.sd && s.sd[ci]) svgEl('line', { x1: x + bw / 2, x2: x + bw / 2, y1: scale(Math.max(v - s.sd[ci], opts.log ? lo : 0)), y2: scale(v + s.sd[ci]), class: 'err' }, f.g);
          if (showLabels) { const topY = s.sd && s.sd[ci] ? Math.min(y, scale(v + s.sd[ci])) : y; svgText(f.g, x + bw / 2, Math.max(topY - 4, 9), opts.format ? opts.format(v) : compact(v), { 'text-anchor': 'middle', class: 'dlabel' }); }
          const hit = svgEl('rect', { x: x - 1, y: 0, width: bw + 2, height: f.ih, class: 'hit' }, f.g);
          hit.addEventListener('pointermove', ev => showTip(ev.clientX, ev.clientY, opts.catLabels ? opts.catLabels[ci] : c, [{ color: s.color, value: (opts.format ? opts.format(v) : fmt(v)) + (s.sd && s.sd[ci] ? ' ± ' + fmt(s.sd[ci]) : ''), label: s.label }]));
          hit.addEventListener('pointerleave', hideTip);
        });
      });
      legend(container, series.map(s => ({ label: s.label, color: s.color })), (k, on) => { if (on) hidden.delete(k); else hidden.add(k); bars.forEach(([p, si]) => p.classList.toggle('dim', hidden.has(si))); });
      tableToggle(container, [opts.catTitle || 'Category', ...series.map(s => ({ label: s.label, num: true }))], cats.map((c, ci) => [opts.catLabels ? opts.catLabels[ci] : c, ...series.map(s => s.values[ci])]));
      arm(container, f.svg);
    };
    registry.set(container, render); render();
  }
  function entityBars(container, opts) {
    const render = () => {
      groupedBars(container, Object.assign({}, opts, { categories: opts.items.map(i => i.key), catLabels: opts.items.map(i => i.label), series: [{ label: opts.yLabel || 'value', color: css('--s-grey'), values: opts.items.map(i => i.value), sd: opts.items.map(i => i.sd || 0) }], directLabels: true, forceLabels: true }));
      container.querySelectorAll('path.bar').forEach((b, k) => b.setAttribute('fill', opts.items[k] ? opts.items[k].color : css('--s-grey')));
      registry.set(container, render);
    };
    render();
  }
  function lineChart(container, opts) {
    const render = () => {
      const series = opts.series.filter(s => s.values && s.values.length), endLabels = opts.endLabels !== false && series.length <= 4;
      const f = frame(container, Object.assign({ height: 240, margin: { top: 14, right: endLabels ? 44 : 16, bottom: 36, left: 46 } }, opts));
      const xs = opts.x, n = xs.length;
      const allv = series.flatMap(s => s.values).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
      let lo = opts.yMin !== undefined ? opts.yMin : Math.min(0, ...allv), hi = Math.max(1e-9, ...allv, opts.refY ? opts.refY.value : 0);
      if (opts.yMax !== undefined) hi = opts.yMax;
      let yscale, ticks;
      if (opts.log) { const pos = allv.filter(v => v > 0); lo = Math.min(...pos) / 1.5; hi = Math.max(...pos) * 1.5; yscale = v => f.ih - (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * f.ih; ticks = logTicks(lo, hi); }
      else { ticks = niceTicks(lo, hi, 5); hi = ticks[ticks.length - 1]; lo = ticks[0]; yscale = v => f.ih - ((v - lo) / (hi - lo)) * f.ih; }
      const xnum = xs.every(v => typeof v === 'number') && !opts.xEven;
      let xscale;
      if (xnum && opts.xLog) { const xl = Math.min(...xs), xh = Math.max(...xs); xscale = v => (Math.log10(v) - Math.log10(xl)) / (Math.log10(xh) - Math.log10(xl)) * f.iw; }
      else if (xnum) { const xl = Math.min(...xs), xh = Math.max(...xs); xscale = v => (v - xl) / Math.max(xh - xl, 1e-9) * f.iw; }
      else xscale = (v, k) => n > 1 ? k / (n - 1) * f.iw : f.iw / 2;
      if (opts.bands) for (const [a, b] of opts.bands) { const ka = xs.findIndex(v => v >= a), kb = xs.findIndex(v => v >= b); if (ka >= 0) { const x1 = xscale(xs[ka], ka), x2 = xscale(xs[kb >= 0 ? kb : n - 1], kb >= 0 ? kb : n - 1); svgEl('rect', { x: x1, y: 0, width: Math.max(2, x2 - x1), height: f.ih, class: 'band' }, f.g); } }
      yAxis(f, yscale, ticks, opts.log ? logFmt : compact);
      const ax = svgEl('g', { class: 'axis' }, f.g), nt = Math.min(n, Math.max(2, Math.floor(f.iw / 70)));
      const idxs = (xnum && opts.xLog) || (!xnum && n <= 12) ? xs.map((_, k) => k) : Array.from({ length: nt }, (_, k) => Math.round(k * (n - 1) / (nt - 1)));
      for (const k of idxs) tickText(ax, xscale(xs[k], k), f.ih + 18, opts.xFormat ? opts.xFormat(xs[k]) : String(xs[k]), { 'text-anchor': 'middle' });
      if (opts.xLabel) svgText(f.g, f.iw, f.ih + 32, opts.xLabel, { 'text-anchor': 'end', class: 'axis-title' });
      if (opts.refY) { const y = yscale(opts.refY.value); svgEl('line', { x1: 0, x2: f.iw, y1: y, y2: y, class: 'ref' }, f.g); svgText(f.g, f.iw - 2, y - 4, opts.refY.label, { 'text-anchor': 'end', class: 'ref-label' }); }
      if (opts.refX) { const k = xs.findIndex(v => v >= opts.refX.value); if (k >= 0) { const x = xscale(xs[k], k); svgEl('line', { x1: x, x2: x, y1: 0, y2: f.ih, class: 'ref' }, f.g); svgText(f.g, x + 4, 10, opts.refX.label, { class: 'ref-label' }); } }
      if (opts.marks) for (const mk of opts.marks) { const k = xs.findIndex(v => v >= mk.x); if (k >= 0) { const x = xscale(xs[k], k); svgEl('rect', { x: x - 1, y: f.ih - 8, width: 2, height: 8, class: 'mark' }, f.g); if (mk.label) svgText(f.g, x + 4, f.ih - 10, mk.label, { class: 'ref-label' }); } }
      const paths = [];
      series.forEach((s) => {
        let d = '', started = false;
        s.values.forEach((v, k) => { if (v === null || v === undefined || Number.isNaN(v)) { started = false; return; } d += (started ? 'L' : 'M') + xscale(xs[k], k).toFixed(1) + ',' + yscale(v).toFixed(1); started = true; });
        if (opts.area && series.length === 1) { let a = ''; s.values.forEach((v, k) => { if (v === null) return; a += (a ? 'L' : 'M') + xscale(xs[k], k).toFixed(1) + ',' + yscale(v).toFixed(1); }); if (a) svgEl('path', { d: a + `L${xscale(xs[n - 1], n - 1).toFixed(1)},${f.ih}L${xscale(xs[0], 0).toFixed(1)},${f.ih}z`, fill: s.color, class: 'area' }, f.g); }
        const p = svgEl('path', { d, class: 'line', stroke: s.color, 'stroke-dasharray': s.dashed ? '4 3' : 'none' }, f.g);
        try { p.style.setProperty('--len', Math.ceil(p.getTotalLength() || 3000)); } catch (e) { }
        paths.push(p);
        if (s.markers || n <= 12) s.values.forEach((v, k) => { if (v !== null && v !== undefined) svgEl('circle', { cx: xscale(xs[k], k), cy: yscale(v), r: 4, fill: s.color, class: 'dot' }, f.g); });
        if (endLabels) { let last = s.values.length - 1; while (last >= 0 && (s.values[last] === null || s.values[last] === undefined)) last--; if (last >= 0) svgText(f.g, xscale(xs[last], last) + 5, yscale(s.values[last]) + 4, opts.format ? opts.format(s.values[last]) : compact(s.values[last]), { class: 'dlabel' }); }
      });
      const cross = svgEl('line', { x1: 0, x2: 0, y1: 0, y2: f.ih, class: 'crosshair', visibility: 'hidden' }, f.g);
      const dots = series.map(s => svgEl('circle', { r: 5, fill: s.color, class: 'dot', visibility: 'hidden' }, f.g));
      const hit = svgEl('rect', { x: 0, y: 0, width: f.iw, height: f.ih, class: 'hit' }, f.g);
      hit.addEventListener('pointermove', ev => {
        const pt = f.svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; const loc = pt.matrixTransform(f.svg.getScreenCTM().inverse()); const px = loc.x - f.m.left;
        let best = 0, bd = Infinity; for (let k = 0; k < n; k++) { const dd = Math.abs(xscale(xs[k], k) - px); if (dd < bd) { bd = dd; best = k; } }
        const x = xscale(xs[best], best); cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
        series.forEach((s, si) => { const v = s.values[best]; if (v === null || v === undefined) dots[si].setAttribute('visibility', 'hidden'); else { dots[si].setAttribute('cx', x); dots[si].setAttribute('cy', yscale(v)); dots[si].setAttribute('visibility', 'visible'); } });
        showTip(ev.clientX, ev.clientY, (opts.xTitle ? opts.xTitle + ' ' : '') + (opts.xFormat ? opts.xFormat(xs[best]) : xs[best]), series.map(s => ({ color: s.color, value: opts.format ? opts.format(s.values[best]) : fmt(s.values[best]), label: s.label })));
      });
      hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); hideTip(); });
      legend(container, series.map(s => ({ label: s.label, color: s.color, kind: 'line' })), (k, on) => { paths[k].style.opacity = on ? 1 : 0.15; });
      tableToggle(container, [opts.xTitle || 'x', ...series.map(s => ({ label: s.label, num: true }))], xs.map((x, k) => [opts.xFormat ? opts.xFormat(x) : x, ...series.map(s => s.values[k])]));
      arm(container, f.svg);
    };
    registry.set(container, render); render();
  }
  function histogram(container, opts) {
    const render = () => {
      const f = frame(container, Object.assign({ height: 200 }, opts)), counts = opts.counts, n = counts.length;
      const hi = Math.max(1, ...counts), ticks = niceTicks(0, hi, 4), top = ticks[ticks.length - 1], scale = v => f.ih - (v / top) * f.ih;
      yAxis(f, scale, ticks, compact);
      const bw = f.iw / n;
      counts.forEach((c, k) => {
        const y = scale(c), p = svgEl('path', { d: roundTop(k * bw + 1, y, bw - 2, f.ih - y, 3), fill: opts.color || color('sage'), class: 'bar' }, f.g); p.style.setProperty('--i', k);
        const hit = svgEl('rect', { x: k * bw, y: 0, width: bw, height: f.ih, class: 'hit' }, f.g);
        hit.addEventListener('pointermove', ev => showTip(ev.clientX, ev.clientY, `${fmt(opts.edges[k], 2)} – ${fmt(opts.edges[k + 1], 2)}`, [{ color: opts.color, value: String(c), label: opts.label || 'decisions' }]));
        hit.addEventListener('pointerleave', hideTip);
      });
      const ax = svgEl('g', { class: 'axis' }, f.g);
      for (let k = 0; k <= n; k += Math.max(1, Math.round(n / 5))) tickText(ax, k * bw, f.ih + 18, fmt(opts.edges[k], 1), { 'text-anchor': 'middle' });
      if (opts.refX !== undefined) { const x = (opts.refX - opts.edges[0]) / (opts.edges[n] - opts.edges[0]) * f.iw; svgEl('line', { x1: x, x2: x, y1: 0, y2: f.ih, class: 'ref' }, f.g); svgText(f.g, x + 4, 10, opts.refLabel || '', { class: 'ref-label' }); }
      if (opts.xLabel) svgText(f.g, f.iw, f.ih + 32, opts.xLabel, { 'text-anchor': 'end', class: 'axis-title' });
      arm(container, f.svg);
    };
    registry.set(container, render); render();
  }
  function refresh() { for (const [c, r] of registry) if (c.isConnected) r(); }
  let rt = null; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(refresh, 150); });
  return { groupedBars, entityBars, lineChart, histogram, tableEl, showTip, hideTip, refresh };
})();

// ---------------------------------------------------------------- reveal, nav, progress
(function () {
  const items = [...document.querySelectorAll('.reveal')];
  items.forEach((el, k) => { if (io && !reduced && belowFold(el)) { el.classList.add('pre'); el.__onvisible = () => { el.classList.remove('pre'); el.classList.add('in'); }; io.observe(el); } });
  setTimeout(() => items.forEach(el => { if (el.classList.contains('pre')) { el.classList.remove('pre'); el.classList.add('in'); el.__onvisible = null; } }), 12000);
  document.querySelectorAll('.stagger').forEach(g => [...g.children].forEach((c, k) => c.style.setProperty('--i', k)));
  const links = [...document.querySelectorAll('#nav a')], secs = links.map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  const prog = $('progress');
  const upd = () => {
    const d = document.documentElement, max = d.scrollHeight - d.clientHeight; prog.style.width = (max > 0 ? 100 * d.scrollTop / max : 0) + '%';
    let cur = null; for (const s of secs) if (s.getBoundingClientRect().top <= 120) cur = s;
    links.forEach(a => a.classList.toggle('on', cur && a.getAttribute('href') === '#' + cur.id));
    const on = links.find(a => a.classList.contains('on')); if (on && on.scrollIntoView) { const nav = $('nav'); const r = on.getBoundingClientRect(), nr = nav.getBoundingClientRect(); if (r.left < nr.left || r.right > nr.right) nav.scrollTo({ left: on.offsetLeft - 40, behavior: 'smooth' }); }
  };
  window.addEventListener('scroll', upd, { passive: true }); window.addEventListener('resize', upd); upd();
})();

// ---------------------------------------------------------------- figures from the data, filled into the prose
(function () {
  const c = D.config;
  const fill = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  fill('cfgK', c.K); fill('cfgH', c.H); fill('cfgTau', c.tau); fill('cfgAging', c.aging); fill('cfgLife', c.life_aging);
  fill('cfgHidden', c.lstm_hidden); fill('cfgTrainEvery', c.lstm_train_every); fill('cfgHmin', c.h_min); fill('cfgMinll', c.min_ll); fill('cfgDrift', c.drift_h);
  fill('heroDate', D.generated);
  const hs = (fam, pol, key) => { const r = (D.archive.headline || []).find(x => x.family === fam && x.policy === pol); return r ? r[key] : null; };
  const stats = $('heroStats');
  const dS = hs('mixed', 'sage', 'deadlock_rate_mean'), dR = hs('mixed', 'reactive', 'deadlock_rate_mean');
  stats.appendChild(kpi('Deadlocks per 1,000 events, SAGE on the mixed workload', dS, '', { accent: true, digits: 2, note: dR !== null ? 'reactive detection: ' + fmt(dR, 1) : '' }));
  stats.appendChild(kpi('Completed lives per 1,000 events, SAGE', hs('mixed', 'sage', 'throughput_mean'), '', { digits: 1, note: "Banker's with true maxima declared: " + fmt(hs('mixed', 'bankers', 'throughput_mean'), 1) }));
  stats.appendChild(kpi('Requests queued, SAGE', hs('mixed', 'sage', 'queue_rate_mean'), '%', { digits: 1, note: "Banker's: " + pct(hs('mixed', 'bankers', 'queue_rate_mean')) }));
  stats.appendChild(kpi('Verification cases passing', D.verify.cases.filter(x => x.ok).length, ' of ' + D.verify.cases.length, { digits: 0, note: 'tests/verify.py, known answers' }));
  stats.appendChild(kpi('Benchmark runs in the full comparison', D.archive.compare_all_runs || 0, '', { digits: 0, note: '7 policies × 5 workloads × 100 seeds' }));
  const sub = $('heroSub'); if (sub && !reduced) { const words = sub.textContent.trim().split(/\s+/); sub.textContent = ''; words.forEach((w, k) => { sub.appendChild(h('span', { class: 'w', style: '--i:' + k }, w)); sub.appendChild(document.createTextNode(' ')); }); }
})();
