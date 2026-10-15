/* Minimal SVG charts for the SAGE console: grouped bars, lines with crosshair, histograms,
   bar lists. Thin marks, hairline grid, legends for two or more series, tooltips on every
   mark, and a table view behind every chart. Colours come from CSS custom properties so the
   charts follow the theme. */
window.Charts = (function () {
  const NS = 'http://www.w3.org/2000/svg';
  const registry = new Map();              // element -> render function (re-run on resize / theme)

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function color(key) { return css('--s-' + key) || css('--s-grey'); }
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, str, attrs) {
    const t = el('text', Object.assign({ x, y }, attrs || {}), parent);
    t.textContent = str;
    return t;
  }
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
  function niceTicks(lo, hi, n) {
    if (hi <= lo) hi = lo + 1;
    const span = hi - lo, raw = span / (n || 5), p = Math.pow(10, Math.floor(Math.log10(raw)));
    const steps = [1, 2, 2.5, 5, 10];
    let step = p;
    for (const s of steps) { if (raw / p <= s) { step = s * p; break; } }
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function logTicks(lo, hi) {
    const out = [], e0 = Math.floor(Math.log10(lo)), e1 = Math.ceil(Math.log10(hi));
    const mults = e1 - e0 > 2 ? [1] : [1, 2, 5];
    for (let e = e0; e <= e1; e++) {
      for (const m of mults) { const v = m * Math.pow(10, e); if (v >= lo / 1.001 && v <= hi * 1.001) out.push(v); }
    }
    return out;
  }
  const logFmt = v => v >= 1 ? compact(v) : String(+v.toPrecision(2));

  // ---- tooltip
  const tip = document.getElementById('tooltip');
  function showTip(x, y, title, rows) {
    tip.innerHTML = '';
    if (title) { const t = document.createElement('div'); t.className = 'tt-title'; t.textContent = title; tip.appendChild(t); }
    for (const r of rows) {
      const d = document.createElement('div'); d.className = 'tt-row';
      if (r.color) { const i = document.createElement('i'); i.style.background = r.color; d.appendChild(i); }
      const b = document.createElement('b'); b.textContent = r.value; d.appendChild(b);
      const s = document.createElement('span'); s.textContent = r.label; d.appendChild(s);
      tip.appendChild(d);
    }
    tip.hidden = false; tip.classList.add('show');
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }
  function hideTip() { tip.classList.remove('show'); }
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('go'); if (e.target.parentElement) e.target.parentElement.dataset.seen = '1'; io.unobserve(e.target); }
  }, { threshold: 0.12 }) : null;
  function arm(container, svg) {
    svg.classList.add('anim');
    if (!io || reduced || container.dataset.seen === '1') { requestAnimationFrame(() => svg.classList.add('go')); return; }
    io.observe(svg);
    setTimeout(() => svg.classList.add('go'), 3000);
  }

  // ---- chrome shared by charts
  function frame(container, opts) {
    container.innerHTML = '';
    const W = Math.max(240, container.clientWidth || 480);
    const H = opts.height || 240;
    const m = Object.assign({ top: 14, right: 16, bottom: 36, left: 46 }, opts.margin || {});
    const svg = el('svg', { class: 'viz', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' }, container);
    if (opts.title) { const t = el('title', {}, svg); t.textContent = opts.title; }
    const g = el('g', { transform: `translate(${m.left},${m.top})` }, svg);
    return { svg, g, W, H, iw: W - m.left - m.right, ih: H - m.top - m.bottom, m };
  }
  function yAxis(f, scale, ticks, format) {
    const grid = el('g', { class: 'grid' }, f.g);
    const ax = el('g', { class: 'axis' }, f.g);
    for (const v of ticks) {
      const y = scale(v);
      el('line', { x1: 0, x2: f.iw, y1: y, y2: y }, grid);
      text(ax, -8, y + 4, format ? format(v) : compact(v), { 'text-anchor': 'end', class: 'tick' }).classList.add('tick');
    }
    el('line', { x1: 0, x2: f.iw, y1: f.ih, y2: f.ih }, ax);
  }
  function legend(container, series, onToggle) {
    if (series.length < 2) return null;
    const lg = document.createElement('div'); lg.className = 'legend';
    series.forEach((s, k) => {
      const sp = document.createElement('span');
      const i = document.createElement('i'); i.style.background = s.color; if (s.kind === 'line') i.className = 'line';
      sp.appendChild(i); sp.appendChild(document.createTextNode(s.label));
      sp.addEventListener('click', () => { sp.classList.toggle('off'); onToggle && onToggle(k, !sp.classList.contains('off')); });
      lg.appendChild(sp);
    });
    container.appendChild(lg);
    return lg;
  }
  function tableToggle(container, headers, rows) {
    const foot = document.createElement('div'); foot.className = 'chart-foot';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn btn-ghost'; btn.textContent = 'Table view';
    const wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.hidden = true;
    wrap.appendChild(tableEl(headers, rows));
    btn.addEventListener('click', () => { wrap.hidden = !wrap.hidden; btn.textContent = wrap.hidden ? 'Table view' : 'Hide table'; });
    foot.appendChild(document.createElement('span')); foot.appendChild(btn);
    container.appendChild(foot); container.appendChild(wrap);
  }
  function tableEl(headers, rows, opts) {
    const t = document.createElement('table'); t.className = 'tbl';
    const th = document.createElement('tr');
    headers.forEach((hd, k) => { const c = document.createElement('th'); c.textContent = typeof hd === 'string' ? hd : hd.label; if ((typeof hd !== 'string' && hd.num) || (opts && opts.numFrom !== undefined && k >= opts.numFrom)) c.className = 'num'; th.appendChild(c); });
    t.appendChild(th);
    rows.forEach((r, ri) => {
      const tr = document.createElement('tr'); tr.className = 'row-in'; tr.style.setProperty('--i', Math.min(ri, 24));
      r.forEach((v, k) => {
        const c = document.createElement('td');
        if (v && v.nodeType) c.appendChild(v);
        else if (typeof v === 'number') { c.textContent = Number.isInteger(v) ? fmt(v, 0) : fmt(v); c.className = 'num'; }
        else c.textContent = v === null || v === undefined ? '–' : String(v);
        if (typeof headers[k] !== 'string' && headers[k].num) c.classList.add('num');
        tr.appendChild(c);
      });
      t.appendChild(tr);
    });
    return t;
  }
  function roundTopPath(x, y, w, h, r) {
    if (h <= 0.5) return `M${x},${y + h}h${w}v0h${-w}z`;
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}V${y + h}z`;
  }

  // ---- grouped bars: categories on x, one bar per series inside each category
  function groupedBars(container, opts) {
    const render = () => {
      const series = opts.series.filter(s => s.values);
      const hidden = new Set();
      const hasSd = series.some(s => s.sd && s.sd.some(x => x));
      const showLabels = opts.directLabels && series.length <= 4 && (!hasSd || opts.forceLabels);
      const f = frame(container, Object.assign({ height: 240, margin: { top: showLabels ? 24 : 14, right: 16, bottom: 36, left: 46 } }, opts));
      const cats = opts.categories;
      const vals = series.flatMap(s => s.values.map((v, k) => (v || 0) + (s.sd ? (s.sd[k] || 0) : 0)));
      let lo = 0, hi = Math.max(1e-9, ...vals.filter(v => v !== null && !Number.isNaN(v)));
      let scale, ticks;
      if (opts.log) {
        const pos = series.flatMap(s => s.values).filter(v => v > 0);
        lo = Math.min(...pos) / 2; hi = Math.max(...pos) * 1.5;
        scale = v => f.ih - (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * f.ih;
        ticks = logTicks(lo, hi);
      } else {
        ticks = niceTicks(0, hi, 5); hi = ticks[ticks.length - 1] || hi;
        scale = v => f.ih - (v / hi) * f.ih;
      }
      yAxis(f, scale, ticks, opts.tickFormat || (opts.log ? logFmt : compact));
      if (opts.yLabel) text(f.g, -f.m.left + 10, -4, opts.yLabel, { class: 'axis-title' });
      const band = f.iw / cats.length, inner = band * 0.78, bw = Math.min(24, (inner - 2 * (series.length - 1)) / series.length);
      const total = bw * series.length + 2 * (series.length - 1);
      const bars = [];
      cats.forEach((c, ci) => {
        const x0 = ci * band + (band - total) / 2;
        text(f.g, ci * band + band / 2, f.ih + 18, opts.catLabels ? opts.catLabels[ci] : c, { 'text-anchor': 'middle', class: 'cat' });
        series.forEach((s, si) => {
          const v = s.values[ci];
          if (v === null || v === undefined || Number.isNaN(v)) return;
          const x = x0 + si * (bw + 2), y = scale(v), h = f.ih - y;
          const p = el('path', { d: roundTopPath(x, y, bw, h, 4), fill: s.color, class: 'bar', 'data-s': si }, f.g);
          p.style.setProperty('--i', ci * series.length + si);
          bars.push([p, si]);
          if (s.sd && s.sd[ci]) {
            const y1 = scale(Math.max(v - s.sd[ci], opts.log ? lo : 0)), y2 = scale(v + s.sd[ci]);
            el('line', { x1: x + bw / 2, x2: x + bw / 2, y1, y2, class: 'err' }, f.g);
          }
          if (showLabels) { const topY = s.sd && s.sd[ci] ? Math.min(y, scale(v + s.sd[ci])) : y; text(f.g, x + bw / 2, Math.max(topY - 4, 9), opts.format ? opts.format(v) : compact(v), { 'text-anchor': 'middle', class: 'dlabel' }); }
          const hit = el('rect', { x: x - 1, y: 0, width: bw + 2, height: f.ih, class: 'hit' }, f.g);
          const show = ev => showTip(ev.clientX, ev.clientY, opts.catLabels ? opts.catLabels[ci] : c, [{ color: s.color, value: (opts.format ? opts.format(v) : fmt(v)) + (s.sd && s.sd[ci] ? ' ± ' + fmt(s.sd[ci]) : ''), label: s.label }]);
          hit.addEventListener('pointermove', show); hit.addEventListener('pointerleave', hideTip);
          hit.addEventListener('pointerenter', () => p.style.filter = 'brightness(1.15)'); hit.addEventListener('pointerleave', () => p.style.filter = '');
        });
      });
      legend(container, series.map(s => ({ label: s.label, color: s.color })), (k, on) => {
        if (on) hidden.delete(k); else hidden.add(k);
        bars.forEach(([p, si]) => p.classList.toggle('dim', hidden.has(si)));
      });
      arm(container, f.svg);
      tableToggle(container, [opts.catTitle || 'Category', ...series.map(s => ({ label: s.label, num: true }))],
        cats.map((c, ci) => [opts.catLabels ? opts.catLabels[ci] : c, ...series.map(s => s.values[ci])]));
    };
    registry.set(container, render); render();
  }

  // ---- bars by entity: one bar per item, coloured by the item (policies compared)
  function entityBars(container, opts) {
    groupedBars(container, Object.assign({}, opts, {
      categories: opts.items.map(i => i.key), catLabels: opts.items.map(i => i.label),
      series: [{ label: opts.yLabel || 'value', color: css('--s-grey'), values: opts.items.map(i => i.value), sd: opts.items.map(i => i.sd || 0) }],
      directLabels: true, forceLabels: true,
    }));
    // recolour bars by entity
    const bars = container.querySelectorAll('path.bar');
    bars.forEach((b, k) => b.setAttribute('fill', opts.items[k] ? opts.items[k].color : css('--s-grey')));
    const render = registry.get(container);
    registry.set(container, () => { render(); container.querySelectorAll('path.bar').forEach((b, k) => b.setAttribute('fill', opts.items[k] ? opts.items[k].color : css('--s-grey'))); });
  }

  // ---- lines with crosshair
  function lineChart(container, opts) {
    const render = () => {
      const series = opts.series.filter(s => s.values && s.values.length);
      const endLabels = opts.endLabels !== false && series.length <= 4;
      const f = frame(container, Object.assign({ height: 240, margin: { top: 14, right: endLabels ? 44 : 16, bottom: 36, left: 46 } }, opts));
      const xs = opts.x;
      const n = xs.length;
      const allv = series.flatMap(s => s.values).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
      let lo = opts.yMin !== undefined ? opts.yMin : Math.min(0, ...allv), hi = Math.max(1e-9, ...allv, opts.refY ? opts.refY.value : 0);
      if (opts.yMax !== undefined) hi = opts.yMax;
      let yscale, ticks;
      if (opts.log) {
        const pos = allv.filter(v => v > 0); lo = Math.min(...pos) / 1.5; hi = Math.max(...pos) * 1.5;
        yscale = v => f.ih - (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * f.ih; ticks = logTicks(lo, hi);
      } else {
        ticks = niceTicks(lo, hi, 5); hi = ticks[ticks.length - 1]; lo = ticks[0];
        yscale = v => f.ih - ((v - lo) / (hi - lo)) * f.ih;
      }
      const xnum = xs.every(v => typeof v === 'number') && !opts.xEven;
      let xscale;
      if (xnum && opts.xLog) { const xl = Math.min(...xs), xh = Math.max(...xs); xscale = v => (Math.log10(v) - Math.log10(xl)) / (Math.log10(xh) - Math.log10(xl)) * f.iw; }
      else if (xnum) { const xl = Math.min(...xs), xh = Math.max(...xs); xscale = v => (v - xl) / Math.max(xh - xl, 1e-9) * f.iw; }
      else xscale = (v, k) => n > 1 ? k / (n - 1) * f.iw : f.iw / 2;
      yAxis(f, yscale, ticks, opts.tickFormat || (opts.log ? logFmt : compact));
      if (opts.yLabel) text(f.g, -f.m.left + 10, -4, opts.yLabel, { class: 'axis-title' });
      // x ticks
      const ax = el('g', { class: 'axis' }, f.g);
      const nt = Math.min(n, Math.max(2, Math.floor(f.iw / 70)));
      const idxs = (xnum && opts.xLog) || (!xnum && n <= 12) ? xs.map((_, k) => k) : Array.from({ length: nt }, (_, k) => Math.round(k * (n - 1) / (nt - 1)));
      for (const k of idxs) { const x = xscale(xs[k], k); text(ax, x, f.ih + 18, opts.xFormat ? opts.xFormat(xs[k]) : String(xs[k]), { 'text-anchor': 'middle', class: 'tick' }); }
      if (opts.xLabel) text(f.g, f.iw, f.ih + 32, opts.xLabel, { 'text-anchor': 'end', class: 'axis-title' });
      // reference line
      if (opts.refY) { const y = yscale(opts.refY.value); el('line', { x1: 0, x2: f.iw, y1: y, y2: y, class: 'ref' }, f.g); text(f.g, f.iw - 2, y - 4, opts.refY.label, { 'text-anchor': 'end', class: 'ref-label' }); }
      if (opts.refX) { const k = xs.findIndex(v => v >= opts.refX.value); if (k >= 0) { const x = xscale(xs[k], k); el('line', { x1: x, x2: x, y1: 0, y2: f.ih, class: 'ref' }, f.g); text(f.g, x + 4, 10, opts.refX.label, { class: 'ref-label' }); } }
      // marks (events on the x axis)
      if (opts.marks) for (const mk of opts.marks) { const k = xs.findIndex(v => v >= mk.x); if (k >= 0) el('rect', { x: xscale(xs[k], k) - 1, y: f.ih - 6, width: 2, height: 6, class: 'mark' }, f.g); }
      const paths = [];
      series.forEach((s, si) => {
        let d = '', started = false;
        s.values.forEach((v, k) => { if (v === null || v === undefined || Number.isNaN(v)) { started = false; return; } const x = xscale(xs[k], k), y = yscale(v); d += (started ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1); started = true; });
        if (opts.area && series.length === 1) {
          let a = '';
          s.values.forEach((v, k) => { if (v === null) return; a += (a ? 'L' : 'M') + xscale(xs[k], k).toFixed(1) + ',' + yscale(v).toFixed(1); });
          if (a) el('path', { d: a + `L${xscale(xs[n - 1], n - 1).toFixed(1)},${f.ih}L${xscale(xs[0], 0).toFixed(1)},${f.ih}z`, fill: s.color, class: 'area' }, f.g);
        }
        const p = el('path', { d, class: 'line', stroke: s.color, 'stroke-dasharray': s.dashed ? '4 3' : 'none' }, f.g);
        try { p.style.setProperty('--len', Math.ceil(p.getTotalLength() || 3000)); } catch (e) { }
        paths.push(p);
        if (s.markers || n <= 12) s.values.forEach((v, k) => { if (v !== null && v !== undefined) el('circle', { cx: xscale(xs[k], k), cy: yscale(v), r: 4, fill: s.color, class: 'dot' }, f.g); });
        if (endLabels) {
          let last = s.values.length - 1; while (last >= 0 && (s.values[last] === null || s.values[last] === undefined)) last--;
          if (last >= 0) text(f.g, xscale(xs[last], last) + 5, yscale(s.values[last]) + 4, opts.format ? opts.format(s.values[last]) : compact(s.values[last]), { class: 'dlabel' });
        }
      });
      // crosshair
      const cross = el('line', { x1: 0, x2: 0, y1: 0, y2: f.ih, class: 'crosshair', visibility: 'hidden' }, f.g);
      const dots = series.map(s => el('circle', { r: 5, fill: s.color, class: 'dot', visibility: 'hidden' }, f.g));
      const hit = el('rect', { x: 0, y: 0, width: f.iw, height: f.ih, class: 'hit' }, f.g);
      hit.addEventListener('pointermove', ev => {
        const pt = f.svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
        const loc = pt.matrixTransform(f.svg.getScreenCTM().inverse());
        const px = loc.x - f.m.left;
        let best = 0, bd = Infinity;
        for (let k = 0; k < n; k++) { const d = Math.abs(xscale(xs[k], k) - px); if (d < bd) { bd = d; best = k; } }
        const x = xscale(xs[best], best);
        cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
        series.forEach((s, si) => { const v = s.values[best]; if (v === null || v === undefined) dots[si].setAttribute('visibility', 'hidden'); else { dots[si].setAttribute('cx', x); dots[si].setAttribute('cy', yscale(v)); dots[si].setAttribute('visibility', 'visible'); } });
        showTip(ev.clientX, ev.clientY, (opts.xTitle ? opts.xTitle + ' ' : '') + (opts.xFormat ? opts.xFormat(xs[best]) : xs[best]),
          series.map(s => ({ color: s.color, value: opts.format ? opts.format(s.values[best]) : fmt(s.values[best]), label: s.label })));
      });
      hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); hideTip(); });
      legend(container, series.map(s => ({ label: s.label, color: s.color, kind: 'line' })), (k, on) => { paths[k].style.opacity = on ? 1 : 0.15; });
      arm(container, f.svg);
      tableToggle(container, [opts.xTitle || 'x', ...series.map(s => ({ label: s.label, num: true }))], xs.map((x, k) => [opts.xFormat ? opts.xFormat(x) : x, ...series.map(s => s.values[k])]));
    };
    registry.set(container, render); render();
  }

  // ---- histogram
  function histogram(container, opts) {
    const render = () => {
      const f = frame(container, Object.assign({ height: 220 }, opts));
      const counts = opts.counts, n = counts.length;
      const hi = Math.max(1, ...counts), ticks = niceTicks(0, hi, 4), top = ticks[ticks.length - 1];
      const scale = v => f.ih - (v / top) * f.ih;
      yAxis(f, scale, ticks, compact);
      const bw = f.iw / n;
      counts.forEach((c, k) => {
        const y = scale(c);
        const p = el('path', { d: roundTopPath(k * bw + 1, y, bw - 2, f.ih - y, 3), fill: opts.color || css('--s-sage'), class: 'bar' }, f.g);
        p.style.setProperty('--i', k);
        const hit = el('rect', { x: k * bw, y: 0, width: bw, height: f.ih, class: 'hit' }, f.g);
        hit.addEventListener('pointermove', ev => showTip(ev.clientX, ev.clientY, `${fmt(opts.edges[k], 2)} – ${fmt(opts.edges[k + 1], 2)}`, [{ color: opts.color, value: String(c), label: opts.label || 'decisions' }]));
        hit.addEventListener('pointerleave', hideTip);
        hit.addEventListener('pointerenter', () => p.style.filter = 'brightness(1.15)'); hit.addEventListener('pointerleave', () => p.style.filter = '');
      });
      const ax = el('g', { class: 'axis' }, f.g);
      for (let k = 0; k <= n; k += Math.max(1, Math.round(n / 5))) text(ax, k * bw, f.ih + 18, fmt(opts.edges[k], 1), { 'text-anchor': 'middle', class: 'tick' });
      if (opts.refX !== undefined) { const x = (opts.refX - opts.edges[0]) / (opts.edges[n] - opts.edges[0]) * f.iw; el('line', { x1: x, x2: x, y1: 0, y2: f.ih, class: 'ref' }, f.g); text(f.g, x + 4, 10, opts.refLabel || '', { class: 'ref-label' }); }
      if (opts.xLabel) text(f.g, f.iw, f.ih + 32, opts.xLabel, { 'text-anchor': 'end', class: 'axis-title' });
      tableToggle(container, ['Bin', { label: opts.label || 'count', num: true }], counts.map((c, k) => [`${fmt(opts.edges[k], 2)} – ${fmt(opts.edges[k + 1], 2)}`, c]));
      arm(container, f.svg);
    };
    registry.set(container, render); render();
  }

  // ---- horizontal bar list (HTML)
  function barList(container, opts) {
    container.innerHTML = '';
    const max = Math.max(1e-9, ...opts.items.map(i => i.value));
    const t = document.createElement('table'); t.className = 'tbl';
    for (const it of opts.items) {
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.textContent = it.label; if (it.sub) { const s = document.createElement('div'); s.className = 'sd'; s.textContent = it.sub; a.appendChild(s); }
      const b = document.createElement('td'); b.className = 'num'; b.style.width = '55%';
      const bar = document.createElement('span'); bar.className = 'bar'; bar.style.width = '0%'; bar.style.maxWidth = '70%'; bar.style.background = it.color || css('--s-sage');
      const target = Math.max(2, 100 * it.value / max) + '%';
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = target; }));
      b.appendChild(bar); b.appendChild(document.createTextNode(opts.format ? opts.format(it.value) : fmt(it.value, 0)));
      tr.appendChild(a); tr.appendChild(b); t.appendChild(tr);
    }
    if (!opts.items.length) { const d = document.createElement('div'); d.className = 'no-data'; d.textContent = 'No data'; container.appendChild(d); }
    container.appendChild(t);
  }

  function refresh() { for (const [c, r] of registry) if (c.isConnected) r(); }
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(refresh, 120); });

  return { groupedBars, entityBars, lineChart, histogram, barList, tableEl, color, css, fmt, compact, refresh, showTip, hideTip };
})();
