/* SAGE console front end. Plain JavaScript, no framework: a state object, a router over
   the eight sections, fetch + server-sent events for jobs, streamed text for the analyst. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const C = window.Charts;
  const S = {
    meta: null, archive: null, view: null, spec: null, specTitle: null,
    run: null, runJob: null, compare: null, compareJob: null, sweep: null, chat: [], runs: [],
    replay: null, decPage: 0,
  };
  const POLICY_ORDER = ['sage', 'bankers', 'reactive', 'bankers_nodecl', 'wound_wait', 'wait_die', 'timeout', 'sage_lstm'];
  const FAM_LABEL = { fixed: 'Fixed-pattern', bursty: 'Bursty / random', escalating: 'Gradually escalating', mixed: 'Mixed', shift: 'Behaviour shift', custom: 'Custom scenario' };
  const PATH_LABEL = { learned: 'learned', cold: 'cold start', uncertain: 'uncertain', drift: 'drift', drain: 'starvation guard', bankers: "Banker's", reactive: 'reactive', grant_all: 'grant', wait_die: 'wait-die', wound_wait: 'wound-wait', timeout: 'timeout' };
  const PATH_CLASS = { learned: 'info', cold: 'plain', uncertain: 'warn', drift: 'warn', drain: 'gold', bankers: 'plain', reactive: 'plain' };

  // ---------------------------------------------------------------- utilities
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
  const fmt = C.fmt;
  const pct = (v, d) => v === null || v === undefined ? '–' : fmt(v, d === undefined ? 1 : d) + '%';
  function badge(txt, cls) { return h('span', { class: 'badge ' + (cls || 'plain') }, txt); }
  function toast(msg, bad) {
    const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
    $('toasts').appendChild(t); setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, bad ? 7000 : 4000);
  }
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function staggerChildren(el, from) {
    if (!el || reduced) return;
    let k = from || 0;
    for (const c of el.children) { c.classList.remove('stagger-item'); void c.offsetWidth; c.style.setProperty('--i', Math.min(k++, 14)); c.classList.add('stagger-item'); }
  }
  function animateView(section) {
    if (!section || reduced) return;
    let k = 0;
    const mark = (c) => { c.classList.remove('stagger-item'); void c.offsetWidth; c.style.setProperty('--i', Math.min(k++, 14)); c.classList.add('stagger-item'); };
    for (const c of section.children) {
      if (c.matches('.grid-2, .grid-3, .kpi-row, .sim-layout, .studio-layout, .analyst-layout, .hero, .sim-results')) { for (const g of c.children) mark(g); }
      else mark(c);
    }
  }
  function moveNavIndicator() {
    const nav = $('nav'), on = nav.querySelector('a.on');
    let ind = nav.querySelector('.nav-indicator');
    if (!ind) { ind = h('span', { class: 'nav-indicator' }); nav.appendChild(ind); }
    if (on) { ind.style.top = on.offsetTop + 'px'; ind.style.height = on.offsetHeight + 'px'; }
  }
  function setRunning(label) { S.running = (S.running || 0) + 1; S.runningLabel = label; renderStatus(); }
  function clearRunning() { S.running = Math.max(0, (S.running || 0) - 1); renderStatus(); }
  function checkMark(ok) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 52 52'); svg.setAttribute('class', 'ck ' + (ok ? 'ok' : 'fail'));
    const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', 26); c.setAttribute('cy', 26); c.setAttribute('r', 23);
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', ok ? 'M15 27 l8 8 l15 -16' : 'M17 17 l18 18 M35 17 l-18 18');
    svg.append(c, p); return svg;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  // small Markdown renderer for the analyst's output and the method page
  function md(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    let out = '', i = 0, inList = null, para = [];
    const flushP = () => { if (para.length) { out += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
    const closeList = () => { if (inList) { out += '</' + inList + '>'; inList = null; } };
    const inline = (t) => esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+|#[^)\s]*)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    while (i < lines.length) {
      const ln = lines[i];
      if (/^```/.test(ln)) { flushP(); closeList(); let code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); out += '<pre>' + esc(code.join('\n')) + '</pre>'; i++; continue; }
      const hm = /^(#{1,4})\s+(.*)$/.exec(ln);
      if (hm) { flushP(); closeList(); out += `<h${hm[1].length + 1}>${inline(hm[2])}</h${hm[1].length + 1}>`; i++; continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(ln)) {
        flushP();
        const ordered = /^\s*\d+\./.test(ln), tag = ordered ? 'ol' : 'ul';
        if (inList !== tag) { closeList(); out += '<' + tag + '>'; inList = tag; }
        out += '<li>' + inline(ln.replace(/^\s*([-*]|\d+\.)\s+/, '')) + '</li>'; i++; continue;
      }
      if (/^\s*\|/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-+/.test(lines[i + 1])) {
        flushP(); closeList();
        const cells = (l) => l.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim());
        out += '<table><tr>' + cells(ln).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr>'; i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) { out += '<tr>' + cells(lines[i]).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>'; i++; }
        out += '</table>'; continue;
      }
      if (/^\s*>/.test(ln)) { flushP(); closeList(); out += '<blockquote>' + inline(ln.replace(/^\s*>\s?/, '')) + '</blockquote>'; i++; continue; }
      if (/^\s*(---|\*\*\*)\s*$/.test(ln)) { flushP(); closeList(); out += '<hr class="rule">'; i++; continue; }
      if (!ln.trim()) { flushP(); closeList(); i++; continue; }
      closeList(); para.push(ln.trim()); i++;
    }
    flushP(); closeList();
    return out;
  }
  const api = {
    async get(url) { const r = await fetch(url); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText); return r.json(); },
    async post(url, body) { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail || r.statusText)); return j; },
    async del(url) { const r = await fetch(url, { method: 'DELETE' }); return r.ok; },
    async stream(url, body, onChunk) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(typeof j.detail === 'string' ? j.detail : r.statusText); }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let acc = '';
      for (;;) { const { done, value } = await reader.read(); if (done) break; acc += dec.decode(value, { stream: true }); onChunk(acc); }
      return acc;
    },
  };
  function streamInto(el, url, body) {
    el.innerHTML = '<div class="skeleton w80"></div><div class="skeleton w95"></div><div class="skeleton w60"></div>';
    let first = true;
    return api.stream(url, body, (acc) => { if (first) { first = false; el.classList.add('fade-in'); } el.innerHTML = md(acc) + '<span class="cursor"></span>'; })
      .then(acc => { el.innerHTML = md(acc); return acc; })
      .catch(e => { el.innerHTML = md('**Error:** ' + e.message); });
  }
  function offlineNotice(el, inline) {
    el.innerHTML = '';
    const box = h('div', { class: 'offline' }, h('p', {}, h('strong', {}, 'The analyst is offline. '), S.meta.ai.error || 'No Groq API key is configured.'));
    if (inline) { const host = h('div', { class: 'ai-inline' }); renderAiPanel(host); box.appendChild(host); }
    else box.appendChild(h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: openAiSettings }, 'Connect Groq'));
    el.appendChild(box);
  }
  function kpi(label, value, unit, opts) {
    opts = opts || {};
    const isNum = typeof value === 'number' && Number.isFinite(value);
    const val = h('p', { class: 'k-value' }, isNum ? fmt(0, opts.digits) : (value === null || value === undefined ? '–' : value), unit ? h('span', { class: 'k-unit' }, unit) : null);
    const k = h('div', { class: 'kpi' + (opts.accent ? ' accent' : '') }, h('p', { class: 'k-label' }, label), val);
    if (opts.note) k.appendChild(h('p', { class: 'k-delta ' + (opts.tone || '') }, opts.note));
    if (isNum) countUp(val.firstChild, value, opts.digits);
    return k;
  }
  function countUp(node, value, digits, ms) {
    if (reduced) { node.textContent = fmt(value, digits); return; }
    const t0 = performance.now(), dur = ms || 950;
    const step = (t) => { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3); node.textContent = fmt(value * e, digits); if (p < 1) requestAnimationFrame(step); else node.textContent = fmt(value, digits); };
    requestAnimationFrame(step);
  }
  function table(headers, rows, opts) { const t = C.tableEl(headers, rows, opts); return t; }
  function swatch(key) { return h('span', { class: 'sw', style: 'background:' + C.color(key) }); }
  function policyLabel(key) { if (key === 'sage_lstm') return 'SAGE (LSTM engine)'; const p = (S.meta.policies || []).find(x => x.key === key); return p ? p.label : key; }
  function procName(i) { return S.run && S.run.processes[i] ? S.run.processes[i].name : 'P' + (i + 1); }
  function resName(r) { return S.run && S.run.resources[r] ? S.run.resources[r] : 'R' + (r + 1); }
  function ago(ts) { const s = Math.max(0, (Date.now() / 1000 - ts)); return s < 60 ? Math.round(s) + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; }

  // ---------------------------------------------------------------- jobs (SSE)
  function watchJob(id, onProgress) {
    return new Promise((resolve, reject) => {
      const es = new EventSource('/api/jobs/' + id + '/events');
      es.onmessage = (ev) => {
        const j = JSON.parse(ev.data);
        onProgress && onProgress(j);
        if (j.status === 'done') { es.close(); api.get('/api/jobs/' + id + '/result').then(resolve, reject); }
        else if (j.status === 'error') { es.close(); reject(new Error(j.error + (j.message ? '\n' + j.message.split('\n').slice(-3).join('\n') : ''))); }
        else if (j.status === 'cancelled') { es.close(); reject(new Error('cancelled')); }
      };
      es.onerror = () => { es.close(); /* fall back to polling */ const t = setInterval(async () => { try { const j = await api.get('/api/jobs/' + id); onProgress && onProgress(j); if (j.status === 'done') { clearInterval(t); resolve(await api.get('/api/jobs/' + id + '/result')); } else if (j.status === 'error' || j.status === 'cancelled') { clearInterval(t); reject(new Error(j.error || j.status)); } } catch (e) { clearInterval(t); reject(e); } }, 600); };
    });
  }
  function progressUI(prefix, j) {
    const box = $(prefix + 'Progress'); box.hidden = false;
    box.querySelector('.progress-bar span').style.width = Math.round(100 * (j.progress || 0)) + '%';
    box.querySelector('.progress-text').textContent = (j.message ? j.message + ' · ' : '') + Math.round(100 * (j.progress || 0)) + '%' + (j.elapsed ? ' · ' + fmt(j.elapsed, 1) + ' s' : '');
  }

  // ---------------------------------------------------------------- routing & chrome
  const TITLES = { overview: ['Section I', 'Overview'], simulator: ['Section II', 'Simulator'], compare: ['Section III', 'Compare policies'], studio: ['Section IV', 'Workload studio'], archive: ['Section V', 'Benchmark archive'], verify: ['Section VI', 'Verification'], analyst: ['Section VII', 'Analyst'], method: ['Section VIII', 'Method'] };
  const rendered = {};
  function show(view) {
    if (!TITLES[view]) view = 'overview';
    S.view = view;
    document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-' + view);
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.view === view));
    $('topEyebrow').textContent = TITLES[view][0]; $('topTitle').textContent = TITLES[view][1];
    $('sidebar').classList.remove('open');
    if (!rendered[view]) { rendered[view] = true; ({ overview: renderOverview, archive: renderArchive, simulator: initSimulator, compare: initCompare, studio: initStudio, verify: initVerify, analyst: initAnalyst, method: renderMethod })[view](); }
    else C.refresh();
    animateView(document.getElementById('view-' + view));
    moveNavIndicator();
    if (view === 'overview') startAmbient(); else stopAmbient();
    window.scrollTo({ top: 0 });
  }
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));


  function renderStatus() {
    const ai = S.meta.ai, box = $('sideStatus'); box.innerHTML = '';
    const cls = ai.status === 'ok' ? 'ok' : ai.status === 'missing' || ai.status === 'unchecked' ? 'warn' : 'bad';
    const label = { ok: 'Groq · ' + (ai.model || ''), missing: 'Groq: add a key', invalid: 'Groq key rejected', offline: 'Groq unreachable', unavailable: 'groq package missing', error: 'Groq error', unchecked: 'Groq unchecked' }[ai.status] || ai.status;
    box.appendChild(h('span', { class: 'pill clickable ' + cls, title: (ai.error || '') + ' · click to configure', onclick: openAiSettings }, h('i', { class: 'dot' }), label));
    box.appendChild(h('span', { class: 'pill ' + (S.meta.torch.available ? 'ok' : 'warn') }, h('i', { class: 'dot' }), S.meta.torch.available ? 'LSTM engine · torch ' + S.meta.torch.version : 'torch missing: Markov only'));
    if (S.running) box.appendChild(h('span', { class: 'pill ok' }, h('i', { class: 'dot live' }), S.runningLabel || 'Running…'));
    const top = $('topPills'); top.innerHTML = '';
    top.appendChild(h('span', { class: 'pill' }, 'SAGE v' + (S.meta.version || '3.0') + ' · Python ' + S.meta.python));
    top.appendChild(h('span', { class: 'pill' }, S.meta.config.n + ' processes · ' + S.meta.config.m + ' resources · ' + S.meta.config.ticks + ' events (defaults)'));
    if (S.running) top.appendChild(h('span', { class: 'pill ok' }, h('i', { class: 'dot live' }), S.runningLabel || 'Running…'));
    const btn = $('aiBtn'); btn.textContent = ai.status === 'ok' ? 'AI: ' + (ai.model || 'connected') : 'Connect AI'; btn.className = 'btn btn-sm ' + (ai.status === 'ok' ? 'btn-outline' : 'btn-primary');
    $('reportLink').hidden = !S.meta.report;
  }

  // ---- ambient scene behind the hero: processes drifting, wait-for edges forming, a cycle flashing and resolving
  let amb = null;
  function startAmbient() {
    if (reduced) return;
    if (amb) { amb.on = true; return; }
    const hero = document.querySelector('#view-overview .hero'); if (!hero) return;
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'hero-bg'); svg.setAttribute('viewBox', '0 0 1000 420'); svg.setAttribute('preserveAspectRatio', 'xMidYMid slice'); svg.setAttribute('aria-hidden', 'true');
    hero.insertBefore(svg, hero.firstChild);
    const N = 12, nodes = [], rnd = Math.random;
    for (let i = 0; i < N; i++) nodes.push({ x0: 50 + rnd() * 900, y0: 30 + rnd() * 360, ax: 16 + rnd() * 26, ay: 10 + rnd() * 20, w1: .22 + rnd() * .3, w2: .18 + rnd() * .3, p1: rnd() * 6.3, p2: rnd() * 6.3, r: 3.5 + rnd() * 3, x: 0, y: 0 });
    const edgeG = document.createElementNS(ns, 'g'); svg.appendChild(edgeG);
    const circles = nodes.map(nd => { const c = document.createElementNS(ns, 'circle'); c.setAttribute('r', nd.r); c.setAttribute('class', 'amb-node'); svg.appendChild(c); return c; });
    const edges = []; let last = 0, nextEdge = 0, cyc = null;
    amb = { on: true, svg };
    const frame = (t) => {
      if (!amb) return;
      requestAnimationFrame(frame);
      if (!amb.on || document.hidden || t - last < 33) return;
      last = t; const s = t / 1000;
      nodes.forEach((nd, i) => { nd.x = nd.x0 + nd.ax * Math.sin(s * nd.w1 + nd.p1); nd.y = nd.y0 + nd.ay * Math.cos(s * nd.w2 + nd.p2); circles[i].setAttribute('cx', nd.x.toFixed(1)); circles[i].setAttribute('cy', nd.y.toFixed(1)); });
      if (s > nextEdge) {
        nextEdge = s + .6 + rnd() * 1.1;
        const a = Math.floor(rnd() * N); let b = Math.floor(rnd() * N); if (b === a) b = (a + 1) % N;
        const line = document.createElementNS(ns, 'line'); line.setAttribute('class', 'amb-edge'); edgeG.appendChild(line); edges.push({ a, b, line, born: s, ttl: 2.5 + rnd() * 3 });
        if (!cyc && rnd() < .28) { const back = document.createElementNS(ns, 'line'); back.setAttribute('class', 'amb-edge'); edgeG.appendChild(back); edges.push({ a: b, b: a, line: back, born: s, ttl: 2.4 }); cyc = { a, b, until: s + 2.4 }; }
      }
      for (let k = edges.length - 1; k >= 0; k--) {
        const e = edges[k], age = s - e.born;
        if (age > e.ttl) { e.line.remove(); edges.splice(k, 1); continue; }
        const A = nodes[e.a], B = nodes[e.b];
        e.line.setAttribute('x1', A.x.toFixed(1)); e.line.setAttribute('y1', A.y.toFixed(1)); e.line.setAttribute('x2', B.x.toFixed(1)); e.line.setAttribute('y2', B.y.toFixed(1));
        e.line.style.opacity = Math.min(1, age / .6, (e.ttl - age) / .6);
        const inCyc = cyc && ((e.a === cyc.a && e.b === cyc.b) || (e.a === cyc.b && e.b === cyc.a));
        e.line.classList.toggle('cyc', !!inCyc);
      }
      if (cyc && s > cyc.until) cyc = null;
      circles.forEach((c, i) => c.classList.toggle('cyc', !!(cyc && (i === cyc.a || i === cyc.b))));
    };
    requestAnimationFrame(frame);
  }
  function stopAmbient() { if (amb) amb.on = false; }
  function splitHero() {
    const h2 = document.querySelector('#view-overview .hero-text h2');
    if (!h2 || h2.dataset.split || reduced) return;
    const words = h2.textContent.trim().split(/\s+/); h2.textContent = '';
    words.forEach((w, k) => { h2.appendChild(h('span', { class: 'w', style: '--i:' + k }, w)); h2.appendChild(document.createTextNode(' ')); });
    h2.dataset.split = '1';
  }

  // ---------------------------------------------------------------- I. overview
  async function loadArchive() { if (!S.archive) S.archive = await api.get('/api/archive').catch(() => ({})); return S.archive; }
  function hs(fam, pol, key) { const r = (S.archive.headline_summary || []).find(x => x.family === fam && x.policy === pol); return r ? r[key] : null; }
  async function renderOverview() {
    splitHero(); startAmbient();
    await loadArchive();
    const A = S.archive;
    const facts = $('heroFacts'); facts.innerHTML = '';
    facts.appendChild(h('p', { class: 'label' }, 'At a glance'));
    const cfg = A.config || S.meta.config;
    [['Processes × resources', cfg.n + ' × ' + cfg.m], ['Events per run', cfg.ticks], ['Futures × horizon', cfg.K + ' × ' + cfg.H], ['Risk threshold τ', cfg.tau], ['Seeds in the headline benchmark', (cfg.seeds || []).length || 20], ['Runs in the full comparison', A.compare_all_runs || '–'], ['Behaviour engines', 'Markov chain · LSTM (gated)']].forEach(([k, v]) => facts.appendChild(h('div', { class: 'fact' }, h('span', {}, k), h('b', {}, String(v)))));
    const k = $('ovKpis'); k.innerHTML = '';
    if (A.headline_summary) {
      const dS = hs('mixed', 'sage', 'deadlock_rate_mean'), dR = hs('mixed', 'reactive', 'deadlock_rate_mean');
      k.appendChild(kpi('Deadlocks per 1,000 events · SAGE, mixed workload', dS, '', { accent: true, digits: 2, note: dR !== null ? 'reactive detection: ' + fmt(dR, 1) : '', tone: 'good' }));
      k.appendChild(kpi('Throughput · SAGE, mixed', hs('mixed', 'sage', 'throughput_mean'), 'lives / 1,000 events', { digits: 1, note: "Banker's (true maxima declared): " + fmt(hs('mixed', 'bankers', 'throughput_mean'), 1) }));
      k.appendChild(kpi('Requests queued · SAGE, mixed', hs('mixed', 'sage', 'queue_rate_mean'), '%', { digits: 1, note: "Banker's: " + pct(hs('mixed', 'bankers', 'queue_rate_mean')) }));
      k.appendChild(kpi('Decision latency · SAGE', hs('mixed', 'sage', 'latency_ms_mean'), 'ms', { digits: 2, note: 'K = ' + cfg.K + ' futures, H = ' + cfg.H + ' steps' }));
      k.appendChild(kpi('Starved process slots · SAGE', hs('mixed', 'sage', 'starved_mean'), '', { digits: 2, note: 'slots that never completed a life' }));
      staggerChildren(k);
      const fams = ['fixed', 'bursty', 'escalating', 'mixed'];
      const mk = (id, metric, opts) => C.groupedBars($(id), Object.assign({ categories: fams, catLabels: fams.map(f => FAM_LABEL[f]), catTitle: 'Workload',
        series: ['sage', 'bankers', 'reactive'].map(p => ({ key: p, label: policyLabel(p), color: C.color(p), values: fams.map(f => hs(f, p, metric + '_mean')), sd: fams.map(f => hs(f, p, metric + '_sd')) })) }, opts || {}));
      mk('ovDeadlock', 'deadlock_rate', { format: v => fmt(v, 2) });
      mk('ovThroughput', 'throughput', { format: v => fmt(v, 1) });
      mk('ovQueue', 'queue_rate', { format: v => fmt(v, 1) });
      mk('ovLatency', 'latency_ms', { log: true, format: v => v < 0.01 ? String(+v.toPrecision(2)) : fmt(v, v < 1 ? 3 : 2) });
    } else {
      k.appendChild(h('div', { class: 'empty-state' }, h('p', { class: 'muted' }, 'No benchmark archive found in results/. Run python -m experiments.run_all to produce it, or use the simulator.')));
    }
    const rank = $('ovRank'); rank.innerHTML = '';
    if (A.compare_all) {
      const by = {};
      for (const r of A.compare_all) { const b = by[r.policy] = by[r.policy] || { n: 0 }; for (const m of ['throughput', 'deadlock_rate', 'rollback_rate', 'queue_rate', 'starved', 'latency_ms']) b[m] = (b[m] || 0) + (r[m + '_mean'] || 0); b.n++; }
      const rows = Object.keys(by).map(p => { const b = by[p]; return { p, thr: b.throughput / b.n, dl: b.deadlock_rate / b.n, rb: b.rollback_rate / b.n, q: b.queue_rate / b.n, st: b.starved / b.n, lat: b.latency_ms / b.n }; }).sort((a, b) => b.thr - a.thr);
      rank.appendChild(table(['#', 'Policy', { label: 'Throughput', num: true }, { label: 'Deadlocks / 1,000', num: true }, { label: 'Rollbacks / 1,000', num: true }, { label: 'Queued %', num: true }, { label: 'Starved slots', num: true }, { label: 'Latency ms', num: true }],
        rows.map((r, k) => [k + 1, h('span', {}, swatch(r.p), policyLabel(r.p)), r.thr, r.dl, r.rb, r.q, r.st, r.lat])));
      $('ovRankSub').textContent = 'Mean over the five workload families of the full comparison (' + (A.compare_all_runs || '') + ' runs), ranked by completed work';
    } else rank.appendChild(h('p', { class: 'muted' }, 'compare_all.csv not found; run python -m experiments.compare_all.'));
  }

  // ---------------------------------------------------------------- forms
  function field(def) {
    const wrap = h('label', { class: 'field' }, def.label);
    let input;
    if (def.type === 'select') { input = h('select', { class: 'select', name: def.name }); for (const o of def.options) input.appendChild(h('option', { value: o.value }, o.label)); input.value = def.value; }
    else if (def.type === 'range') {
      input = h('input', { type: 'range', name: def.name, min: def.min, max: def.max, step: def.step, value: def.value });
      const num = h('input', { class: 'input input-sm', type: 'number', min: def.min, max: def.max, step: def.step, value: def.value });
      input.addEventListener('input', () => num.value = input.value); num.addEventListener('input', () => input.value = num.value);
      const row = h('div', { class: 'range-row' }, input, num); wrap.appendChild(row); if (def.hint) wrap.appendChild(h('span', { class: 'hint' }, def.hint)); return wrap;
    }
    else input = h('input', { class: 'input', type: 'number', name: def.name, min: def.min, max: def.max, step: def.step || 1, value: def.value });
    wrap.appendChild(input); if (def.hint) wrap.appendChild(h('span', { class: 'hint' }, def.hint));
    return wrap;
  }
  function formValues(form) {
    const o = {};
    for (const el of form.querySelectorAll('[name]')) { if (el.type === 'checkbox') { if (el.checked) (o[el.name] = o[el.name] || []).push(el.value); } else o[el.name] = el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value; }
    return o;
  }
  function simSchema() {
    const c = S.meta.config, pol = S.meta.policies.map(p => ({ value: p.key, label: p.label }));
    const fam = S.meta.families.map(f => ({ value: f.key, label: f.label })); if (S.spec) fam.unshift({ value: 'custom', label: 'Custom: ' + (S.spec.title || 'studio scenario') });
    return [
      { section: 'Policy and workload' },
      { name: 'policy', label: 'Policy', type: 'select', options: pol, value: 'sage' },
      { name: 'family', label: 'Workload', type: 'select', options: fam, value: S.spec ? 'custom' : 'mixed' },
      { name: 'model', label: 'Behaviour engine (SAGE)', type: 'select', options: S.meta.models.map(m => ({ value: m.key, label: m.label })), value: 'markov' },
      { name: 'seed', label: 'Seed', min: 0, max: 99999, value: 0, hint: 'Same seed, same programs and schedule for every policy' },
      { section: 'System' },
      { row: [{ name: 'n', label: 'Processes', min: 2, max: 16, value: c.n }, { name: 'm', label: 'Resources', min: 2, max: 16, value: c.m }] },
      { name: 'ticks', label: 'Events per run', min: 50, max: 6000, step: 50, value: c.ticks },
      { section: 'SAGE' },
      { name: 'tau', label: 'Risk threshold τ', type: 'range', min: 0, max: 1.01, step: 0.01, value: c.tau, hint: 'Queue when the share of deadlocked futures reaches τ' },
      { row: [{ name: 'K', label: 'Futures K', min: 5, max: 500, value: c.K }, { name: 'H', label: 'Horizon H', min: 3, max: 120, value: c.H }] },
      { row: [{ name: 'h_min', label: 'Min. history', min: 1, max: 500, value: c.h_min }, { name: 'drift_h', label: 'Drift threshold', min: 0.5, max: 100, step: 0.5, value: c.drift_h }] },
      { row: [{ name: 'min_ll', label: 'Predictability floor', min: -10, max: 0, step: 0.1, value: c.min_ll }, { name: 'fallback', label: 'Fallback', type: 'select', options: [{ value: 'claims', label: 'Learned claims' }, { value: 'reactive', label: 'Reactive (grant)' }], value: c.fallback }] },
      { row: [{ name: 'aging', label: 'Aging (ticks)', min: 0, max: 10000, step: 50, value: c.aging }, { name: 'life_aging', label: 'Life aging', min: 0, max: 20000, step: 50, value: c.life_aging }] },
      { section: 'Recovery and warm-up' },
      { row: [{ name: 'recovery', label: 'Rollback', type: 'select', options: [{ value: 'partial', label: 'Partial' }, { value: 'restart', label: 'Restart' }], value: c.recovery }, { name: 'timeout', label: 'Timeout (policy)', min: 5, max: 2000, value: c.timeout }] },
      { name: 'warmup_lives', label: 'Warm-up lives per model', min: 0, max: 5, value: c.warmup_lives },
      { section: 'LSTM engine' },
      { row: [{ name: 'lstm_hidden', label: 'Hidden units', min: 8, max: 128, value: c.lstm_hidden }, { name: 'lstm_train_every', label: 'Train every n events', min: 1, max: 64, value: c.lstm_train_every }] },
    ];
  }
  function buildForm(form, schema) {
    form.innerHTML = '';
    for (const d of schema) {
      if (d.section) form.appendChild(h('div', { class: 'form-section' }, d.section));
      else if (d.row) form.appendChild(h('div', { class: 'field-row' }, ...d.row.map(field)));
      else form.appendChild(field(d));
    }
  }

  // ---------------------------------------------------------------- II. simulator
  function initSimulator() {
    buildForm($('simForm'), simSchema());
    $('simReset').addEventListener('click', () => buildForm($('simForm'), simSchema()));
    $('simRun').addEventListener('click', runSimulation);
    $('simCancel').addEventListener('click', () => { if (S.runJob) api.del('/api/jobs/' + S.runJob); });
    $('simAnalyse').addEventListener('click', () => analyseRun());
    $('simAiAgain').addEventListener('click', () => analyseRun());
    $('simDownload').addEventListener('click', () => { if (!S.run) return; const b = new Blob([JSON.stringify(S.run)], { type: 'application/json' }); const a = h('a', { href: URL.createObjectURL(b), download: 'sage-run-' + S.run.policy + '-' + S.run.family + '-' + S.run.seed + '.json' }); document.body.appendChild(a); a.click(); a.remove(); });
    $('decFilter').addEventListener('change', () => { S.decPage = 0; renderDecisions(); });
    $('decProc').addEventListener('change', () => { S.decPage = 0; renderDecisions(); });
    refreshRecent();
    const form = $('simForm');
    form.addEventListener('change', (e) => { if (e.target.name === 'family') { const custom = e.target.value === 'custom'; form.querySelector('[name=n]').disabled = custom; form.querySelector('[name=m]').disabled = custom; } });
  }
  async function refreshRecent() {
    const list = await api.get('/api/jobs').catch(() => []);
    const runs = list.filter(j => j.kind === 'run' && j.status === 'done');
    const box = $('simRecent'); box.innerHTML = '';
    if (!runs.length) return;
    box.appendChild(h('p', { class: 'label' }, 'Recent runs'));
    for (const j of runs.slice(0, 8)) {
      const p = j.params;
      box.appendChild(h('div', { class: 'recent-item' + (S.runJob === j.id ? ' on' : ''), onclick: async () => { S.runJob = j.id; renderRun(await api.get('/api/jobs/' + j.id + '/result')); refreshRecent(); } },
        h('span', {}, policyLabel(p.policy) + ' · ' + (p.title || FAM_LABEL[p.family] || p.family) + ' · seed ' + p.seed + (p.model === 'lstm' ? ' · LSTM' : '')), h('span', { class: 'when' }, ago(j.finished || j.created))));
    }
  }
  async function runSimulation() {
    const v = formValues($('simForm'));
    const body = Object.assign({}, v);
    if (v.family === 'custom') { if (!S.spec) { toast('Design or load a workload in the studio first', true); return; } body.workload = S.spec; delete body.family; delete body.n; delete body.m; }
    const btn = $('simRun'); btn.disabled = true; btn.classList.add('running'); btn.textContent = 'Simulating…'; $('simCancel').hidden = false;
    $('simLive').hidden = false; $('simLiveText').textContent = (body.policy === 'sage' ? 'K = ' + v.K + ' futures of H = ' + v.H + ' steps for every request of a free resource' : policyLabel(body.policy) + ' on ' + (body.workload ? (S.spec.title || 'the custom scenario') : FAM_LABEL[v.family])) + ' · ' + v.ticks.toLocaleString() + ' events…';
    setRunning('Simulating');
    try {
      const job = await api.post('/api/jobs/run', body);
      S.runJob = job.id; progressUI('sim', job);
      const payload = await watchJob(job.id, j => progressUI('sim', j));
      renderRun(payload);
      toast('Run finished in ' + fmt(payload.wall_s, 1) + ' s');
    } catch (e) { toast('Run failed: ' + e.message, true); }
    finally { btn.disabled = false; btn.classList.remove('running'); btn.textContent = 'Run simulation'; $('simCancel').hidden = true; $('simProgress').hidden = true; $('simLive').hidden = true; clearRunning(); refreshRecent(); }
  }
  function renderRun(p) {
    S.run = p; S.decPage = 0;
    $('simEmpty').hidden = true; $('simBody').hidden = false; $('simAiCard').hidden = true; $('simAiOut').innerHTML = '';
    const s = p.summary, cfg = p.config;
    $('simRunEyebrow').textContent = p.policy_label + (p.policy === 'sage' ? ' · ' + (cfg.model === 'lstm' ? 'LSTM engine' : 'Markov engine') : '') + ' · seed ' + p.seed;
    $('simRunTitle').textContent = (p.family === 'custom' ? (p.config.title || 'Custom scenario') : p.family_label) + ', ' + p.ticks.toLocaleString() + ' events';
    $('simRunSub').textContent = p.n + ' processes, ' + p.m + ' resources' + (p.policy === 'sage' ? ' · K = ' + cfg.K + ', H = ' + cfg.H + ', τ = ' + cfg.tau + ', fallback: ' + cfg.fallback : '') + ' · recovery: ' + cfg.recovery + ' · ' + fmt(p.wall_s, 1) + ' s wall time';
    const k = $('simKpis'); k.innerHTML = '';
    k.appendChild(kpi('Deadlocks', p.counts.deadlocks, '', { accent: true, digits: 0, note: fmt(s.deadlock_rate, 2) + ' per 1,000 events', tone: p.counts.deadlocks ? 'bad' : 'good' }));
    k.appendChild(kpi('Completed lives', p.counts.completed, '', { digits: 0, note: fmt(s.throughput, 1) + ' per 1,000 events' }));
    k.appendChild(kpi('Requests queued by the policy', s.queue_rate, '%', { digits: 1, note: p.counts.policy_waits + ' of ' + p.counts.free_requests + ' free-resource requests' }));
    k.appendChild(kpi('Blocked on a held resource', p.counts.blocked, '', { digits: 0, note: 'waits that every policy incurs' }));
    k.appendChild(kpi('Decision latency', s.latency_ms, 'ms', { digits: s.latency_ms < 0.1 ? 4 : 2, note: 'max ' + fmt(s.latency_ms_max, 2) + ' ms' }));
    k.appendChild(kpi('Fallback decisions', s.fallback_rate, '%', { digits: 1, note: p.paths.filter(x => x.path !== 'learned').reduce((a, x) => a + x.grant + x.wait, 0) + ' through cold / uncertain / drift / guard' }));
    k.appendChild(kpi('Rollbacks', p.counts.restarts, '', { digits: 0, note: p.counts.wasted + ' program steps undone' }));
    k.appendChild(kpi('Starved slots', s.starved, '', { digits: 0, note: 'least served slot completed ' + s.min_slot_completed + ' lives', tone: s.starved ? 'bad' : 'good' }));
    staggerChildren(k);
    const b = p.series, x = b.start.map(v => v + b.width);
    C.lineChart($('simCum'), { x, xTitle: 'event', series: [{ label: 'deadlocks (cumulative)', color: C.color('reactive'), values: b.cum_deadlocks }, { label: 'completed lives (cumulative)', color: C.color('sage'), values: b.cum_completions }], format: v => fmt(v, 0), marks: p.deadlocks.map(d => ({ x: d.t })) });
    C.groupedBars($('simDecisions'), { categories: x, catLabels: x.map((v, k) => k % Math.ceil(x.length / 8) === 0 ? String(v) : ''), catTitle: 'window end', series: [{ label: 'granted', color: C.color('sage'), values: b.granted }, { label: 'queued', color: C.css('--amber'), values: b.queued }], format: v => fmt(v, 0) });
    C.lineChart($('simRisk'), { x, xTitle: 'event', series: [{ label: 'mean risk of learned-path decisions', color: C.color('sage'), values: b.risk_mean }], yMin: 0, yMax: 1, format: v => fmt(v, 2), refY: { value: cfg.tau, label: 'τ = ' + cfg.tau }, area: true });
    C.lineChart($('simWaiting'), { x, xTitle: 'event', series: [{ label: 'processes waiting (mean per window)', color: C.css('--amber'), values: b.waiting_mean }], yMin: 0, format: v => fmt(v, 1), area: true });
    C.barList($('simPaths'), { items: p.paths.map(q => ({ label: q.label, value: q.grant + q.wait, sub: q.grant + ' granted · ' + q.wait + ' queued', color: q.path === 'learned' ? C.color('sage') : q.path === 'drain' ? C.css('--amber') : C.color('bankers') })) });
    if (p.risk_hist.n) C.histogram($('simRiskHist'), { edges: p.risk_hist.edges, counts: p.risk_hist.counts, color: C.color('sage'), label: 'decisions', xLabel: 'risk', refX: cfg.tau, refLabel: 'τ' });
    else $('simRiskHist').innerHTML = '<div class="no-data">No rollout decisions (fallback or baseline policy)</div>';
    const dl = $('simDeadlocks'); dl.innerHTML = '';
    $('simDlSub').textContent = p.deadlocks.length ? p.deadlocks.length + ' detected; victim aborted and rolled back' : 'None in this run';
    if (p.deadlocks.length) dl.appendChild(table(['Event', 'Cycle', 'Victim'], p.deadlocks.slice(0, 60).map(d => [d.t, d.cycle.map(procName).join(' → '), d.victim >= 0 ? procName(d.victim) : 'left to timeout'])));
    else dl.appendChild(h('p', { class: 'muted small' }, 'No wait-for cycle appeared.'));
    renderProcesses(p);
    const dp = $('decProc'); dp.innerHTML = ''; dp.appendChild(h('option', { value: '' }, 'Every process')); p.processes.forEach(q => dp.appendChild(h('option', { value: q.i }, q.name)));
    renderDecisions();
    initReplay(p);
    animateView($('simBody'));
    C.refresh();
  }
  function renderProcesses(p) {
    const box = $('simProcs'); box.innerHTML = '';
    const rows = p.processes.map(q => {
      const m = q.model || {};
      const eng = m.engine || '–';
      const engBadge = badge(eng, eng === 'lstm' ? 'gold' : eng.startsWith('markov+') ? 'info' : 'plain');
      const pathB = q.path_now ? badge(PATH_LABEL[q.path_now] || q.path_now, PATH_CLASS[q.path_now] || 'plain') : h('span', { class: 'muted' }, '–');
      const pattern = q.pattern ? h('span', { class: 'chips' }, ...q.pattern.slice(0, 10).map(x => h('span', { class: 'op ' + (/^rel/.test(x) ? 'rel' : 'req') }, x)), q.pattern.length > 10 ? h('span', { class: 'muted small' }, '… +' + (q.pattern.length - 10)) : null) : h('span', { class: 'muted small' }, 'random requests, up to ' + (q.max_held || 2) + ' held');
      let gate = '–';
      if (m.lstm) { const L = m.lstm; gate = h('span', { class: 'small' }, 'network ' + fmt(L.lstm_ll, 2) + ' vs tables ' + fmt(L.ref_ll, 2) + ' nats/event', h('div', { class: 'sd' }, L.train_steps + ' training steps · ' + L.switches + ' switches')); }
      return [h('b', {}, q.name), q.personality_label, pattern, q.completed, q.aborts, q.accuracy === null ? '–' : pct(q.accuracy), engBadge, m.support !== undefined ? m.support : '–', m.fit_loglik !== undefined ? fmt(m.fit_loglik, 2) : '–', m.cusum !== undefined ? fmt(m.cusum, 1) : '–', pathB, gate];
    });
    box.appendChild(table(['Process', 'Type', 'Pattern', { label: 'Lives', num: true }, { label: 'Aborted', num: true }, { label: 'Top-1 acc.', num: true }, 'Engine', { label: 'Support', num: true }, { label: 'Fit log-lik', num: true }, { label: 'CUSUM', num: true }, 'Path now', 'LSTM gate'], rows));
  }
  function renderDecisions() {
    const p = S.run; if (!p) return;
    const f = $('decFilter').value, pf = $('decProc').value;
    let items = p.decisions.map((d, k) => Object.assign({ k }, d));
    if (f === 'wait') items = items.filter(d => d.d === 'wait');
    else if (f === 'learned') items = items.filter(d => d.path === 'learned');
    else if (f === 'fallback') items = items.filter(d => ['cold', 'uncertain', 'drift'].includes(d.path));
    else if (f === 'drain') items = items.filter(d => d.path === 'drain');
    if (pf !== '') items = items.filter(d => String(d.i) === pf);
    $('simDecSub').textContent = items.length + ' of ' + p.decisions.length + ' decisions' + (S.meta.ai.status === 'ok' ? ' · click a row for the analyst\'s explanation' : '');
    const per = 40, pages = Math.max(1, Math.ceil(items.length / per)); S.decPage = Math.min(S.decPage, pages - 1);
    const page = items.slice(S.decPage * per, (S.decPage + 1) * per);
    const box = $('simDecisionsTable'); box.innerHTML = '';
    const t = table(['Event', 'Process', 'Resource', 'Decision', 'Risk', 'Path', { label: 'Latency ms', num: true }, ''], page.map(d => [d.t, procName(d.i), resName(d.r), badge(d.d === 'wait' ? 'queued' : d.d === 'fallback' ? 'granted (fallback)' : 'granted', d.d === 'wait' ? 'warn' : 'good'),
      d.risk === null ? h('span', { class: 'muted' }, '–') : h('span', {}, h('span', { class: 'bar', style: 'width:' + Math.round(60 * d.risk) + 'px;background:' + (d.risk >= p.config.tau ? 'var(--bad)' : 'var(--accent)') }), fmt(d.risk, 2)),
      badge(PATH_LABEL[d.path] || d.path, PATH_CLASS[d.path] || 'plain'), fmt(d.ms, d.ms < 0.1 ? 4 : 2), d.reeval ? h('span', { class: 'muted small' }, 're-evaluation') : '']));
    [...t.querySelectorAll('tr')].slice(1).forEach((tr, k) => { tr.classList.add('clickable'); tr.addEventListener('click', () => explainDecision(page[k])); });
    box.appendChild(t);
    const pg = $('decPager'); pg.innerHTML = '';
    if (pages > 1) { pg.appendChild(h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { S.decPage = Math.max(0, S.decPage - 1); renderDecisions(); } }, 'Previous')); pg.appendChild(h('span', {}, 'page ' + (S.decPage + 1) + ' of ' + pages)); pg.appendChild(h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { S.decPage = Math.min(pages - 1, S.decPage + 1); renderDecisions(); } }, 'Next')); }
  }
  function explainDecision(d) {
    const p = S.run;
    const title = 'Event ' + d.t + ': ' + procName(d.i) + ' requests ' + resName(d.r) + ' → ' + (d.d === 'wait' ? 'queued' : 'granted');
    openModal(title);
    const body = $('modalBody');
    const facts = h('p', { class: 'muted small' }, 'Path: ' + (PATH_LABEL[d.path] || d.path) + (d.risk !== null ? ' · risk ' + fmt(d.risk, 2) + ' against τ = ' + p.config.tau : '') + ' · latency ' + fmt(d.ms, 3) + ' ms');
    body.innerHTML = ''; body.appendChild(facts);
    if (S.meta.ai.status !== 'ok') { const o = h('div', {}); body.appendChild(o); offlineNotice(o, true); return; }
    const out = h('div', { class: 'prose' }); body.appendChild(out);
    streamInto(out, '/api/ai/explain', { job_id: S.runJob, index: d.k });
  }
  function analyseRun() {
    if (!S.runJob) return;
    $('simAiCard').hidden = false;
    $('simAiSub').textContent = 'Groq · ' + (S.meta.ai.model || '') + ' · reads the metrics, paths, deadlocks and model diagnostics of this run';
    if (S.meta.ai.status !== 'ok') { offlineNotice($('simAiOut')); $('simAiCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    $('simAiCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    streamInto($('simAiOut'), '/api/ai/analyse', { job_id: S.runJob, focus: $('simAiFocus').value.trim() || null });
  }
  function openModal(title) { $('modalTitle').textContent = title; $('modal').hidden = false; }
  function closeModal() { $('modal').hidden = true; $('modalBody').innerHTML = ''; }
  $('modalClose').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

  // ---------------------------------------------------------------- replay
  function initReplay(p) {
    if (S.replay && S.replay.timer) clearInterval(S.replay.timer);
    const tr = p.trace || [];
    const R = S.replay = { p, tr, idx: 0, timer: null, playing: false };
    const range = $('replayRange'); range.max = Math.max(0, tr.length - 1); range.value = 0;
    range.oninput = () => { R.idx = Number(range.value); drawReplay(); };
    const jump = $('replayJump'); jump.innerHTML = ''; jump.appendChild(h('option', { value: '' }, 'Jump to…'));
    tr.forEach((e, k) => { if (e.dl) jump.appendChild(h('option', { value: k }, 'Deadlock at ' + e.t + ': ' + e.dl.cycle.map(procName).join(' → '))); });
    tr.forEach((e, k) => { if (e.decision && e.decision.d === 'wait' && e.decision.path === 'learned') jump.appendChild(h('option', { value: k }, 'Queued at ' + e.t + ': ' + procName(e.i) + ' → ' + resName(e.r) + ' (risk ' + fmt(e.decision.risk, 2) + ')')); });
    tr.forEach((e, k) => { if (e.out === 'forced') jump.appendChild(h('option', { value: k }, 'Forced grant at ' + e.t)); });
    jump.onchange = () => { if (jump.value !== '') { R.idx = Number(jump.value); drawReplay(); } jump.value = ''; };
    buildAlloc(p); buildGraph(p);
    $('replaySpeed').onchange = () => { if (R.playing) { stopReplay(); playReplay(); } };
    document.querySelectorAll('#replayControls [data-act]').forEach(b => b.onclick = () => {
      const a = b.dataset.act;
      if (a === 'first') R.idx = 0; else if (a === 'last') R.idx = tr.length - 1; else if (a === 'prev') R.idx = Math.max(0, R.idx - 1); else if (a === 'next') R.idx = Math.min(tr.length - 1, R.idx + 1);
      else if (a === 'play') { if (R.playing) stopReplay(); else playReplay(); return; }
      stopReplay(); drawReplay();
    });
    // marks under the scrubber
    const marks = $('replayMarks'); marks.innerHTML = ''; marks.setAttribute('viewBox', '0 0 1000 14');
    tr.forEach((e, k) => { const x = tr.length > 1 ? 1000 * k / (tr.length - 1) : 0; if (e.dl) marks.appendChild(svgRect(x - 1.5, 0, 3, 14, 'dl')); else if (e.decision && e.decision.d === 'wait') marks.appendChild(svgRect(x - 1, 4, 2, 10, 'q')); });
    R.head = svgRect(0, 0, 2, 14, 'head'); marks.appendChild(R.head);
    drawReplay();
  }
  function svgRect(x, y, w, hh, cls) { const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', hh); r.setAttribute('class', cls); return r; }
  function playReplay() { const R = S.replay; if (!R || !R.tr.length) return; R.playing = true; $('replayPlay').textContent = 'Pause'; R.timer = setInterval(() => { if (R.idx >= R.tr.length - 1) { stopReplay(); return; } R.idx++; drawReplay(); }, Number($('replaySpeed').value)); }
  function stopReplay() { const R = S.replay; if (!R) return; R.playing = false; $('replayPlay').textContent = 'Play'; if (R.timer) clearInterval(R.timer); R.timer = null; }
  function programAt(i, t) { const P = S.run.programs || []; let best = null; for (const q of P) if (q.i === i && q.t <= t) best = q; return best ? best.ops : []; }
  function opLabel(k, r) { return k === 0 ? 'req ' + resName(r) : k === 1 ? 'rel ' + resName(r) : 'exit'; }
  function drawReplay() {
    const R = S.replay, p = R.p, e = R.tr[R.idx];
    $('replayRange').value = R.idx;
    const ev = $('replayEvent'); ev.innerHTML = '';
    if (!e) { ev.textContent = 'No trace for this run.'; return; }
    const outcome = { grant: ['granted', 'good'], wait: ['queued by the policy', 'warn'], blocked: ['blocked: resource held', 'warn'], deadlock: ['deadlock', 'bad'], release: ['released', 'plain'], exit: ['exit: life complete', 'info'], forced: ['forced grant (stall)', 'gold'], held: ['already held', 'plain'], die: ['rolled back (die)', 'bad'], timeout: ['timed out: rolled back', 'bad'] }[e.out] || [e.out, 'plain'];
    ev.appendChild(h('span', { class: 't' }, 'event ' + e.t + ' / ' + p.ticks));
    ev.appendChild(h('b', {}, procName(e.i)));
    ev.appendChild(h('span', {}, e.op === 0 ? 'requests ' + resName(e.r) : e.op === 1 ? 'releases ' + resName(e.r) : e.op === 2 ? 'exits' : e.out === 'forced' ? 'is force-granted ' + resName(e.r) : ''));
    ev.appendChild(badge(outcome[0], outcome[1]));
    if (e.path) ev.appendChild(badge(PATH_LABEL[e.path] || e.path, PATH_CLASS[e.path] || 'plain'));
    if (e.risk !== undefined && e.risk !== null) ev.appendChild(h('span', { class: 'mono' }, 'risk ' + fmt(e.risk, 2)));
    if (e.correct !== undefined) ev.appendChild(h('span', { class: 'muted small' }, 'model ' + (e.correct ? 'predicted it' : 'did not predict it')));
    if (e.dl) ev.appendChild(h('span', { class: 'small' }, 'cycle ' + e.dl.cycle.map(procName).join(' → ') + (e.dl.victim >= 0 ? '; victim ' + procName(e.dl.victim) : '')));
    if (e.aborts) e.aborts.forEach(a => ev.appendChild(h('span', { class: 'muted small' }, procName(a.i) + ' rolled back ' + a.undone + (a.undone === 1 ? ' step' : ' steps'))));
    if (e.reevals) e.reevals.forEach(r => ev.appendChild(h('span', { class: 'muted small' }, procName(r.i) + ' re-evaluated for ' + resName(r.r) + ': ' + (r.d === 'wait' ? 'still queued' : 'granted'))));
    if (R.head) R.head.setAttribute('x', R.tr.length > 1 ? 1000 * R.idx / (R.tr.length - 1) - 1 : 0);
    updateAlloc(e); updateGraph(e); drawDecision(e); drawProcs(e);
  }
  function buildAlloc(p) {
    const R = S.replay, n = p.n, m = p.m, cs = 24, left = 64, top = 22, W = left + m * cs + 8, H = top + n * cs + 6, ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const t = (x, y, s, cls) => { const q = document.createElementNS(ns, 'text'); q.setAttribute('x', x); q.setAttribute('y', y); if (cls) q.setAttribute('class', cls); q.textContent = s; svg.appendChild(q); return q; };
    for (let r = 0; r < m; r++) { const q = t(left + r * cs + cs / 2, 14, p.resources[r].length > 4 ? p.resources[r].slice(0, 4) : p.resources[r]); q.setAttribute('text-anchor', 'middle'); }
    R.allocNames = []; R.cells = []; R.prevAlloc = null;
    for (let i = 0; i < n; i++) {
      const q = t(left - 6, top + i * cs + cs / 2 + 4, procName(i).slice(0, 8), 'pn'); q.setAttribute('text-anchor', 'end'); R.allocNames.push(q);
      const row = [];
      for (let r = 0; r < m; r++) {
        const rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', left + r * cs + 2); rect.setAttribute('y', top + i * cs + 2); rect.setAttribute('width', cs - 4); rect.setAttribute('height', cs - 4); rect.setAttribute('rx', 3); rect.setAttribute('class', 'cell');
        rect.appendChild(document.createElementNS(ns, 'title')); svg.appendChild(rect); row.push(rect);
      }
      R.cells.push(row);
    }
    const box = $('replayAlloc'); box.innerHTML = ''; box.appendChild(svg);
    box.appendChild(h('p', { class: 'muted small', style: 'margin:6px 0 0' }, 'Filled: held · gold ring: queued by the policy · red ring: blocked on a held resource'));
  }
  function updateAlloc(e) {
    const R = S.replay, p = S.run;
    for (let i = 0; i < p.n; i++) {
      R.allocNames[i].setAttribute('font-weight', i === e.i ? '600' : '400');
      for (let r = 0; r < p.m; r++) {
        const held = (e.alloc[i] >> r) & 1, want = e.status[i] === 1 && e.pending[i] === r, rect = R.cells[i][r];
        const was = R.prevAlloc ? (R.prevAlloc[i] >> r) & 1 : held;
        rect.setAttribute('class', 'cell' + (held ? ' held' : want ? (e.reason[i] === 1 ? ' blocked' : ' want') : '') + (held && !was ? ' just' : ''));
        rect.style.opacity = e.status[i] === 2 ? .4 : 1;
        rect.firstChild.textContent = procName(i) + ' / ' + p.resources[r] + ': ' + (held ? 'held' : want ? (e.reason[i] === 1 ? 'waiting (held by another process)' : 'waiting (queued by the policy)') : 'free of this process');
      }
    }
    R.prevAlloc = e.alloc.slice();
  }
  function buildGraph(p) {
    const R = S.replay, n = p.n, ns = 'http://www.w3.org/2000/svg';
    const W = 320, H = 250, cx = W / 2, cy = H / 2 + 4, rad = Math.min(W, H) / 2 - 34;
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const defs = document.createElementNS(ns, 'defs'); defs.innerHTML = '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="context-stroke"/></marker>'; svg.appendChild(defs);
    const edgeLayer = document.createElementNS(ns, 'g'); edgeLayer.setAttribute('class', 'edges'); svg.appendChild(edgeLayer);
    R.gpos = []; R.gnodes = []; R.gedges = new Map(); R.gedgeLayer = edgeLayer;
    const mk = (tag, attrs) => { const el = document.createElementNS(ns, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); svg.appendChild(el); return el; };
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + 2 * Math.PI * i / n, x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a); R.gpos.push([x, y]);
      const ring = mk('circle', { cx: x, cy: y, r: 18, class: 'ring' });
      const c = mk('circle', { cx: x, cy: y, r: 18, class: 'node' });
      const t = mk('text', { x, y: y - 1 }); t.textContent = procName(i).slice(0, 6);
      const s = mk('text', { x, y: y + 10, class: 'sub' });
      R.gnodes.push({ ring, c, s });
    }
    const box = $('replayGraph'); box.innerHTML = ''; box.appendChild(svg);
    box.appendChild(h('p', { class: 'muted small', style: 'margin:6px 0 0' }, 'Arrow: waits for a resource held by. Gold: queued by the policy; amber: blocked; red: on the deadlock cycle.'));
  }
  function edgePath(P, Q) {
    const [x1, y1] = P, [x2, y2] = Q, dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    const sx = x1 + ux * 20, sy = y1 + uy * 20, ex = x2 - ux * 22, ey = y2 - uy * 22, mx = (sx + ex) / 2 - uy * 16, my = (sy + ey) / 2 + ux * 16;
    return `M${sx.toFixed(1)},${sy.toFixed(1)}Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`;
  }
  function updateGraph(e) {
    const R = S.replay, p = S.run, n = p.n, ns = 'http://www.w3.org/2000/svg', cyc = new Set(e.dl ? e.dl.cycle : []), keep = new Set();
    for (let i = 0; i < n; i++) {
      if (e.status[i] !== 1 || e.reason[i] !== 1 || e.pending[i] < 0) continue;
      const r = e.pending[i]; let hld = -1; for (let j = 0; j < n; j++) if ((e.alloc[j] >> r) & 1) hld = j;
      if (hld < 0) continue;
      const key = i + '>' + hld; keep.add(key);
      let path = R.gedges.get(key);
      if (!path) {
        path = document.createElementNS(ns, 'path'); path.setAttribute('d', edgePath(R.gpos[i], R.gpos[hld])); path.setAttribute('marker-end', 'url(#arrow)');
        path.appendChild(document.createElementNS(ns, 'title')); R.gedgeLayer.appendChild(path); R.gedges.set(key, path);
      }
      path.setAttribute('class', 'edge' + (cyc.has(i) && cyc.has(hld) ? ' cycle' : ''));
      path.firstChild.textContent = procName(i) + ' waits for ' + resName(r) + ', held by ' + procName(hld);
    }
    for (const [key, path] of R.gedges) if (!keep.has(key)) { R.gedges.delete(key); path.classList.add('out'); setTimeout(() => path.remove(), 320); }
    for (let i = 0; i < n; i++) {
      const g = R.gnodes[i];
      const cls = e.status[i] === 2 ? 'done' : cyc.has(i) ? 'cycle' : e.status[i] === 1 ? (e.reason[i] === 1 ? 'blocked' : 'waiting') : '';
      g.c.setAttribute('class', 'node ' + cls + (i === e.i ? ' actor' : ''));
      g.ring.setAttribute('class', 'ring' + (i === e.i ? ' on' : ''));
      const held = []; for (let r = 0; r < p.m; r++) if ((e.alloc[i] >> r) & 1) held.push(r);
      g.s.textContent = e.status[i] === 1 ? '⏳ ' + resName(e.pending[i]) : held.length > 2 ? held.slice(0, 2).map(resName).join(' ') + ' +' + (held.length - 2) : held.length ? held.map(resName).join(' ') : '·';
    }
  }
  function gauge(risk, tau) {
    const ns = 'http://www.w3.org/2000/svg', r = 40, C = Math.PI * r, arc = 'M10,50 A40,40 0 0 1 90,50';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 100 58'); svg.setAttribute('class', 'gauge');
    const mk = (tag, attrs) => { const el = document.createElementNS(ns, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); svg.appendChild(el); return el; };
    mk('path', { d: arc, class: 'track' });
    const val = mk('path', { d: arc, class: 'val ' + (risk >= tau ? 'bad' : 'good'), 'stroke-dasharray': C, 'stroke-dashoffset': C });
    const th = Math.PI * (1 - Math.min(tau, 1));
    mk('line', { x1: 50 + 34 * Math.cos(th), y1: 50 - 34 * Math.sin(th), x2: 50 + 47 * Math.cos(th), y2: 50 - 47 * Math.sin(th), class: 'tau' });
    const label = mk('text', { x: 50, y: 52 }); label.textContent = fmt(risk, 2);
    requestAnimationFrame(() => requestAnimationFrame(() => val.setAttribute('stroke-dashoffset', C * (1 - Math.min(risk, 1)))));
    return svg;
  }
  function drawDecision(e) {
    const box = $('replayDecision'); box.innerHTML = '';
    const d = e.decision;
    if (!d && e.out !== 'forced') { box.appendChild(h('div', { class: 'decision-box' }, h('p', { class: 'label' }, 'Decision'), h('p', { class: 'muted small', style: 'margin:0' }, e.out === 'blocked' ? 'No decision: the resource is held, so the requester blocks (every policy).' : e.out === 'deadlock' ? 'A cycle closed in the wait-for graph; the victim was aborted and rolled back.' : e.out === 'release' || e.out === 'exit' ? 'No decision: a release re-evaluates queued requests in arrival order.' : 'No decision at this event.'))); return; }
    const dd = d || { d: 'grant', risk: e.risk, path: 'forced' };
    const b = h('div', { class: 'decision-box' }, h('p', { class: 'label' }, d ? 'Decision' : 'Stall handler'));
    b.appendChild(h('p', {}, procName(e.i) + ' → ' + resName(e.r) + ': ', badge(dd.d === 'wait' ? 'queued' : 'granted', dd.d === 'wait' ? 'warn' : 'good'), ' ', badge(PATH_LABEL[dd.path] || dd.path, PATH_CLASS[dd.path] || 'gold')));
    if (dd.risk !== null && dd.risk !== undefined) {
      b.appendChild(gauge(dd.risk, S.run.config.tau));
      b.appendChild(h('p', { class: 'muted small' }, 'share of simulated futures in which ' + procName(e.i) + ' ends on a wait-for cycle · gold tick: τ = ' + S.run.config.tau));
      if (dd.fut) {
        const f = dd.fut, mx = Math.max(1, ...f.steps);
        b.appendChild(h('div', { class: 'fut' }, ...f.steps.map((c, k) => h('i', { style: 'height:' + Math.max(1, 100 * c / mx) + '%', title: c + ' futures first deadlocked at step ' + (k + 1) }))));
        b.appendChild(h('p', { class: 'fut-cap' }, f.dead + ' of ' + f.K + ' futures deadlocked within H = ' + f.H + ' steps; bars: step of the first deadlock' + (f.dead + 0 < f.K && dd.d === 'wait' ? ' (simulation stopped once τ was reached)' : '')));
      }
    } else if (dd.path === 'cold' || dd.path === 'uncertain' || dd.path === 'drift') b.appendChild(h('p', { class: 'muted small' }, 'The model was not trusted (' + PATH_LABEL[dd.path] + '), so the learned-claims safety check decided.'));
    else if (dd.path === 'drain') b.appendChild(h('p', { class: 'muted small' }, 'Another request is overdue; a process holding nothing is held back until it gets through.'));
    if (d && d.ms !== undefined) b.appendChild(h('p', { class: 'muted small', style: 'margin:6px 0 0' }, 'decided in ' + fmt(d.ms, 3) + ' ms'));
    box.appendChild(b);
  }
  function drawProcs(e) {
    const p = S.run, box = $('replayProcs'); box.innerHTML = '';
    for (let i = 0; i < p.n; i++) {
      const held = []; for (let r = 0; r < p.m; r++) if ((e.alloc[i] >> r) & 1) held.push(resName(r));
      let st = 'runnable'; if (e.status[i] === 2) st = 'done'; else if (e.status[i] === 1) st = (e.reason[i] === 1 ? 'blocked on ' : 'queued for ') + resName(e.pending[i]);
      const ops = programAt(i, e.t), pc = e.pc[i];
      const lo = Math.max(0, pc - 2), hi = Math.min(ops.length, pc + 7);
      const prog = h('div', { class: 'prog' }, lo > 0 ? h('span', { class: 'op done' }, '…') : null, ...ops.slice(lo, hi).map((o, k) => h('span', { class: 'op ' + (o[0] === 0 ? 'req' : o[0] === 1 ? 'rel' : 'exit') + (lo + k === pc ? ' pc' : lo + k < pc ? ' done' : '') }, opLabel(o[0], o[1]))), hi < ops.length ? h('span', { class: 'op' }, '…') : null);
      box.appendChild(h('div', { class: 'rp' + (i === e.i ? ' actor' : '') }, h('div', {}, h('div', { class: 'name' }, procName(i)), h('div', { class: 'st' }, p.processes[i].personality_label.split(' ')[0]), h('div', { class: 'st' }, e.done[i] + ' lives')),
        h('div', {}, h('div', {}, st, held.length ? h('span', { class: 'muted' }, ' · holds ' + held.join(', ')) : ''), prog)));
    }
  }
  document.addEventListener('keydown', (ev) => {
    if (S.view !== 'simulator' || !S.replay || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (ev.key === 'ArrowRight') { S.replay.idx = Math.min(S.replay.tr.length - 1, S.replay.idx + 1); drawReplay(); }
    else if (ev.key === 'ArrowLeft') { S.replay.idx = Math.max(0, S.replay.idx - 1); drawReplay(); }
    else if (ev.key === ' ') { ev.preventDefault(); if (S.replay.playing) stopReplay(); else playReplay(); }
  });

  // ---------------------------------------------------------------- III. compare
  function initCompare() {
    const form = $('cmpForm'); form.innerHTML = '';
    form.appendChild(h('div', { class: 'form-section' }, 'Policies'));
    const checks = h('div', { class: 'checks' });
    for (const key of POLICY_ORDER) checks.appendChild(h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'policies', value: key, checked: ['sage', 'sage_lstm', 'bankers', 'reactive'].includes(key) ? '' : null }), h('span', { class: 'sw', style: 'background:' + C.color(key) }), policyLabel(key)));
    form.appendChild(checks);
    form.appendChild(h('div', { class: 'form-section' }, 'Workload'));
    const fam = S.meta.families.map(f => ({ value: f.key, label: f.label })); if (S.spec) fam.unshift({ value: 'custom', label: 'Custom: ' + (S.spec.title || 'studio scenario') });
    form.appendChild(field({ name: 'family', label: 'Workload', type: 'select', options: fam, value: S.spec ? 'custom' : 'mixed' }));
    form.appendChild(h('div', { class: 'field-row' }, field({ name: 'seeds', label: 'Seeds', min: 1, max: 30, value: 3, hint: 'seeds 0 … n−1' }), field({ name: 'ticks', label: 'Events per run', min: 50, max: 6000, step: 50, value: 1000 })));
    form.appendChild(h('div', { class: 'field-row' }, field({ name: 'tau', label: 'τ', min: 0, max: 1.01, step: 0.01, value: S.meta.config.tau }), field({ name: 'K', label: 'K', min: 5, max: 500, value: S.meta.config.K })));
    $('cmpRun').addEventListener('click', runCompare);
    $('cmpCancel').addEventListener('click', () => { if (S.compareJob) api.del('/api/jobs/' + S.compareJob); });
    $('cmpAnalyse').addEventListener('click', () => { $('cmpAiCard').hidden = false; $('cmpAiSub').textContent = 'Groq · ' + (S.meta.ai.model || ''); if (S.meta.ai.status !== 'ok') { offlineNotice($('cmpAiOut')); return; } streamInto($('cmpAiOut'), '/api/ai/analyse', { job_id: S.compareJob }); });
    const sf = $('swpForm'); sf.innerHTML = '';
    sf.appendChild(field({ name: 'family', label: 'Workload', type: 'select', options: S.meta.families.filter(f => f.key !== 'shift').map(f => ({ value: f.key, label: f.label })), value: 'mixed' }));
    sf.appendChild(h('div', { class: 'field-row' }, field({ name: 'seeds', label: 'Seeds', min: 1, max: 10, value: 2 }), field({ name: 'ticks', label: 'Events', min: 50, max: 6000, step: 50, value: 800 })));
    sf.appendChild(h('label', { class: 'field' }, 'Thresholds τ', h('input', { class: 'input', name: 'taus', value: '0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1.01' })));
    sf.appendChild(field({ name: 'model', label: 'Engine', type: 'select', options: S.meta.models.map(m => ({ value: m.key, label: m.label })), value: 'markov' }));
    $('swpRun').addEventListener('click', runSweep);
  }
  async function runCompare() {
    const v = formValues($('cmpForm'));
    if (!v.policies || !v.policies.length) { toast('Choose at least one policy', true); return; }
    const body = { policies: v.policies, family: v.family, seeds: Array.from({ length: v.seeds }, (_, k) => k), ticks: v.ticks, overrides: { tau: v.tau, K: v.K } };
    if (v.family === 'custom') { body.workload = S.spec; delete body.family; }
    const btn = $('cmpRun'); btn.disabled = true; btn.classList.add('running'); btn.textContent = 'Comparing…'; $('cmpCancel').hidden = false; setRunning('Comparing policies');
    try {
      const job = await api.post('/api/jobs/compare', body); S.compareJob = job.id; progressUI('cmp', job);
      const res = await watchJob(job.id, j => progressUI('cmp', j));
      renderCompare(res); toast('Comparison finished');
    } catch (e) { toast('Comparison failed: ' + e.message, true); }
    finally { btn.disabled = false; btn.classList.remove('running'); btn.textContent = 'Run comparison'; $('cmpCancel').hidden = true; $('cmpProgress').hidden = true; clearRunning(); }
  }
  function renderCompare(res) {
    S.compare = res; $('cmpEmpty').hidden = true; $('cmpBody').hidden = false; $('swpBody').hidden = true; $('cmpAiCard').hidden = true;
    const order = POLICY_ORDER.filter(k => res.summary.some(s => s.key === k));
    const rows = order.map(k => res.summary.find(s => s.key === k));
    $('cmpEyebrow').textContent = rows.length + ' policies · ' + res.seeds.length + ' seeds · ' + res.config.ticks.toLocaleString() + ' events each';
    $('cmpTitle').textContent = (res.family === 'custom' ? (res.title || 'Custom scenario') : FAM_LABEL[res.family]) + ' workload';
    $('cmpSub').textContent = 'Identical programs and scheduler draws per seed; τ = ' + res.config.tau + ', K = ' + res.config.K + ', H = ' + res.config.H;
    const mk = (id, metric, fmtv) => C.entityBars($(id), { items: rows.map(r => ({ key: r.key, label: policyLabel(r.key).replace("Banker's algorithm", "Banker's").replace(' (Markov engine)', ''), color: C.color(r.key), value: r[metric + '_mean'], sd: r[metric + '_sd'] })), format: fmtv, catTitle: 'Policy' });
    mk('cmpDeadlock', 'deadlock_rate', v => fmt(v, 1)); mk('cmpThroughput', 'throughput', v => fmt(v, 0)); mk('cmpQueue', 'queue_rate', v => fmt(v, 0)); mk('cmpRollback', 'rollback_rate', v => fmt(v, 1));
    const t = $('cmpTable'); t.innerHTML = '';
    const ms = (r, m, d) => h('span', {}, fmt(r[m + '_mean'], d), h('span', { class: 'sd' }, ' ± ' + fmt(r[m + '_sd'], d)));
    t.appendChild(table(['Policy', { label: 'Deadlocks / 1,000', num: true }, { label: 'Throughput', num: true }, { label: 'Queued %', num: true }, { label: 'Rollbacks / 1,000', num: true }, { label: 'Wasted steps / 1,000', num: true }, { label: 'Starved slots', num: true }, { label: 'Fallback %', num: true }, { label: 'Latency ms', num: true }],
      rows.map(r => [h('span', {}, swatch(r.key), policyLabel(r.key)), ms(r, 'deadlock_rate', 2), ms(r, 'throughput', 1), ms(r, 'queue_rate', 1), ms(r, 'rollback_rate', 2), ms(r, 'wasted_rate', 1), ms(r, 'starved', 2), ms(r, 'fallback_rate', 1), ms(r, 'latency_ms', 3)])));
    animateView($('cmpBody'));
    C.refresh();
  }
  async function runSweep() {
    const v = formValues($('swpForm'));
    const taus = String(v.taus).split(/[,\s]+/).map(Number).filter(x => !Number.isNaN(x));
    const sbtn = $('swpRun'); sbtn.disabled = true; sbtn.classList.add('running'); sbtn.textContent = 'Sweeping…'; setRunning('Sweeping τ');
    try {
      const job = await api.post('/api/jobs/sweep', { family: v.family, seeds: Array.from({ length: v.seeds }, (_, k) => k), taus, ticks: v.ticks, model: v.model }); progressUI('swp', job);
      const res = await watchJob(job.id, j => progressUI('swp', j));
      S.sweep = res; S.compareJob = job.id; $('cmpEmpty').hidden = true; $('swpBody').hidden = false;
      const rows = res.summary.slice().sort((a, b) => a.rows ? 0 : 0);
      const taus2 = res.taus;
      const get = (tau, m) => { const r = res.summary.find(s => Math.abs(Number(s.key) - tau) < 1e-9); return r ? r[m + '_mean'] : null; };
      $('swpTitle').textContent = FAM_LABEL[res.family] + ' workload, ' + res.seeds.length + ' seeds';
      $('swpSub').textContent = 'SAGE with the ' + (res.config.model === 'lstm' ? 'LSTM' : 'Markov') + ' engine; every other parameter at its default';
      C.lineChart($('swpDeadlock'), { x: taus2, xEven: true, xTitle: 'τ', xFormat: v => String(v), series: [{ label: 'deadlocks per 1,000 events', color: C.color('reactive'), values: taus2.map(t => get(t, 'deadlock_rate')), markers: true }], format: v => fmt(v, 2) });
      C.lineChart($('swpQueue'), { x: taus2, xEven: true, xTitle: 'τ', xFormat: v => String(v), series: [{ label: 'requests queued (%)', color: C.css('--amber'), values: taus2.map(t => get(t, 'queue_rate')), markers: true }, { label: 'throughput (lives / 1,000 events)', color: C.color('sage'), values: taus2.map(t => get(t, 'throughput')), markers: true }], format: v => fmt(v, 1) });
      $('swpQueue').closest('figure').querySelector('.card-title').textContent = 'Queued requests and throughput against τ';
      $('swpQueue').closest('figure').querySelector('.card-sub').textContent = 'Both in their own units (percent and lives per 1,000 events) on a shared numeric axis';
      const t = $('swpTable'); t.innerHTML = '';
      t.appendChild(table([{ label: 'τ', num: true }, { label: 'Deadlocks / 1,000', num: true }, { label: 'Queued %', num: true }, { label: 'Throughput', num: true }, { label: 'Rollbacks / 1,000', num: true }, { label: 'Latency ms', num: true }], taus2.map(tau => [tau, get(tau, 'deadlock_rate'), get(tau, 'queue_rate'), get(tau, 'throughput'), get(tau, 'rollback_rate'), get(tau, 'latency_ms')])));
      animateView($('swpBody')); $('swpBody').scrollIntoView({ behavior: 'smooth' }); toast('Sweep finished');
    } catch (e) { toast('Sweep failed: ' + e.message, true); }
    finally { sbtn.disabled = false; sbtn.classList.remove('running'); sbtn.textContent = 'Sweep τ'; $('swpProgress').hidden = true; clearRunning(); }
  }

  // ---------------------------------------------------------------- IV. studio
  const PRESETS = [
    { title: 'Printer and scanner', m: 2, resources: ['printer', 'scanner'], processes: [{ name: 'P1', type: 'custom', ops: ['req 0', 'req 1', 'rel 1', 'rel 0'], cycles: [3, 6] }, { name: 'P2', type: 'custom', ops: ['req 1', 'req 0', 'rel 0', 'rel 1'], cycles: [3, 6] }], notes: 'The two-process textbook deadlock: opposite lock orders.' },
    { title: 'Dining philosophers', m: 5, resources: ['fork 1', 'fork 2', 'fork 3', 'fork 4', 'fork 5'], processes: [0, 1, 2, 3, 4].map(k => ({ name: 'Philosopher ' + (k + 1), type: 'custom', ops: ['req ' + k, 'req ' + ((k + 1) % 5), 'rel ' + ((k + 1) % 5), 'rel ' + k], cycles: [3, 5] })), notes: 'Five philosophers, each takes the left fork then the right one.' },
    { title: 'Database transactions', m: 4, resources: ['accounts', 'orders', 'inventory', 'audit log'], processes: [{ name: 'Checkout', type: 'custom', ops: ['req 1', 'req 2', 'req 0', 'rel 0', 'rel 2', 'rel 1'], cycles: [2, 4] }, { name: 'Restock', type: 'custom', ops: ['req 2', 'req 1', 'rel 1', 'rel 2'], cycles: [3, 5] }, { name: 'Audit', type: 'custom', ops: ['req 3', 'req 0', 'rel 0', 'rel 3'], cycles: [2, 3] }, { name: 'Report', type: 'escalating', order: [0, 1, 2, 3], levels: 3 }, { name: 'Ad hoc', type: 'bursty', max_held: 2 }], notes: 'Mixed transaction patterns with one conflicting pair.' },
    { title: 'Well-behaved', m: 4, resources: ['A', 'B', 'C', 'D'], processes: [{ name: 'P1', type: 'fixed', seq: [0, 1] }, { name: 'P2', type: 'fixed', seq: [0, 2] }, { name: 'P3', type: 'fixed', seq: [1, 3] }, { name: 'P4', type: 'escalating', order: [0, 1, 2, 3], levels: 4 }], notes: 'Every process respects one global lock order, so no cycle can form.' },
  ];
  function initStudio() {
    const ch = $('stPresets'); ch.innerHTML = '';
    for (const pr of PRESETS) ch.appendChild(h('span', { class: 'chip', onclick: () => { $('stSpec').value = JSON.stringify(pr, null, 2); validateSpec(); } }, pr.title));
    $('stDesign').addEventListener('click', designWorkload);
    $('stValidate').addEventListener('click', validateSpec);
    const pol = $('stPolicy'); pol.innerHTML = ''; S.meta.policies.forEach(p => pol.appendChild(h('option', { value: p.key }, p.label)));
    $('stRun').addEventListener('click', async () => { if (!(await validateSpec())) return; location.hash = 'simulator'; setTimeout(() => { buildForm($('simForm'), simSchema()); const f = $('simForm'); f.querySelector('[name=policy]').value = pol.value; f.querySelector('[name=family]').value = 'custom'; f.querySelector('[name=n]').disabled = true; f.querySelector('[name=m]').disabled = true; runSimulation(); }, 50); });
    $('stCompare').addEventListener('click', async () => { if (!(await validateSpec())) return; location.hash = 'compare'; setTimeout(() => { if (!rendered.compare) return; initCompareFamily(); runCompare(); }, 50); });
    if (!$('stSpec').value) { $('stSpec').value = JSON.stringify(PRESETS[0], null, 2); validateSpec(); }
  }
  function initCompareFamily() { const f = $('cmpForm').querySelector('[name=family]'); if (!f) return; if (![...f.options].some(o => o.value === 'custom')) f.insertBefore(h('option', { value: 'custom' }, 'Custom: ' + (S.spec.title || 'studio scenario')), f.firstChild); f.value = 'custom'; }
  async function designWorkload() {
    const desc = $('stDesc').value.trim(); if (!desc) { toast('Describe the scenario first', true); return; }
    if (S.meta.ai.status !== 'ok') { const st = $('stDesignStatus'); st.innerHTML = ''; st.append('The analyst is offline: ' + (S.meta.ai.error || 'no Groq key configured') + '. ', h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: openAiSettings }, 'Connect Groq'), ' or edit the JSON by hand.'); return; }
    $('stDesign').disabled = true; $('stDesignStatus').textContent = 'Designing with ' + S.meta.ai.model + '…';
    try {
      const r = await api.post('/api/ai/workload', { description: desc, n: Number($('stN').value) || null, m: Number($('stM').value) || null });
      $('stSpec').value = JSON.stringify(r.spec, null, 2); $('stDesignStatus').textContent = 'Designed by ' + r.model + (r.attempts > 1 ? ' after ' + r.attempts + ' attempts' : '') + '. ' + (r.spec.notes || '');
      await validateSpec();
    } catch (e) { $('stDesignStatus').textContent = 'Failed: ' + e.message; }
    finally { $('stDesign').disabled = false; }
  }
  async function validateSpec() {
    let spec;
    try { spec = JSON.parse($('stSpec').value); } catch (e) { $('stSpecStatus').textContent = 'Not valid JSON: ' + e.message; return false; }
    try {
      const v = await api.post('/api/workload/validate', { spec });
      S.spec = spec; S.spec.title = spec.title || 'Custom scenario';
      $('stSpecStatus').textContent = 'Valid: ' + v.n + ' processes, ' + v.m + ' resources (' + v.resources.join(', ') + ').';
      const pv = $('stPreview'); pv.innerHTML = '';
      v.processes.forEach((q, qi) => pv.appendChild(h('div', { class: 'proc-card', style: '--i:' + qi }, h('b', {}, q.name), h('div', { class: 'muted' }, q.label + ' · ' + q.length + ' ops in this sample life'), h('div', { class: 'ops' }, ...q.sample.slice(0, 24).map(o => h('span', { class: 'op ' + (/^req/.test(o) ? 'req' : /^rel/.test(o) ? 'rel' : 'exit') }, o)), q.sample.length > 24 ? h('span', { class: 'muted small' }, '…') : null))));
      if (rendered.simulator) buildForm($('simForm'), simSchema());
      return true;
    } catch (e) { $('stSpecStatus').textContent = 'Rejected: ' + e.message; S.spec = null; return false; }
  }

  // ---------------------------------------------------------------- V. archive
  async function renderArchive() {
    await loadArchive(); const A = S.archive;
    const cfg = $('arConfig'); cfg.innerHTML = '';
    if (A.config) cfg.appendChild(table(['Parameter', 'Value'], Object.entries(A.config).filter(([k]) => !['seeds', 'sweep_seeds', 'taus'].includes(k)).map(([k, v]) => [k, String(v)])));
    const sel = $('arMetric'); sel.innerHTML = '';
    [['throughput', 'Throughput (lives per 1,000 events)'], ['deadlock_rate', 'Deadlocks per 1,000 events'], ['rollback_rate', 'Rollbacks per 1,000 events'], ['wasted_rate', 'Wasted program steps per 1,000 events'], ['queue_rate', 'Requests queued (%)'], ['starved', 'Starved process slots'], ['latency_ms', 'Decision latency (ms)']].forEach(([k, l]) => sel.appendChild(h('option', { value: k }, l)));
    const draw = () => {
      if (!A.compare_all) { $('arCompare').innerHTML = '<div class="no-data">compare_all.csv not found</div>'; return; }
      const metric = sel.value, fams = ['fixed', 'bursty', 'escalating', 'mixed', 'shift'];
      const pols = POLICY_ORDER.filter(p => A.compare_all.some(r => r.policy === p));
      const get = (f, p) => { const r = A.compare_all.find(x => x.family === f && x.policy === p); return r ? r[metric + '_mean'] : null; };
      C.groupedBars($('arCompare'), { height: 320, categories: fams, catLabels: fams.map(f => FAM_LABEL[f]), catTitle: 'Workload', series: pols.map(p => ({ key: p, label: policyLabel(p), color: C.color(p), values: fams.map(f => get(f, p)) })), log: metric === 'latency_ms', format: v => fmt(v, metric === 'latency_ms' ? 3 : 1) });
      $('arCmpSub').textContent = sel.options[sel.selectedIndex].textContent + ' · mean over ' + Math.round((A.compare_all_runs || 0) / 35) + ' seeds per cell';
      const t = $('arCompareTable'); t.innerHTML = '';
      t.appendChild(table(['Policy', ...fams.map(f => ({ label: FAM_LABEL[f], num: true }))], pols.map(p => [h('span', {}, swatch(p), policyLabel(p)), ...fams.map(f => get(f, p))])));
    };
    sel.addEventListener('change', draw); draw();
    const sz = $('arSizes'); sz.innerHTML = '';
    if (A.compare_sizes) {
      const sizes = [...new Set(A.compare_sizes.map(r => r.size))], pols = POLICY_ORDER.filter(p => A.compare_sizes.some(r => r.policy === p));
      const get = (s, p) => { const rs = A.compare_sizes.filter(x => x.size === s && x.policy === p); return rs.length ? rs.reduce((a, r) => a + (r.deadlock_rate_mean || 0), 0) / rs.length : null; };
      sz.appendChild(table(['Policy', ...sizes.map(s => ({ label: s, num: true }))], pols.map(p => [h('span', {}, swatch(p), policyLabel(p)), ...sizes.map(s => get(s, p))])));
    }
    const ac = $('arAccuracy'); ac.innerHTML = '';
    if (A.accuracy) ac.appendChild(table(['Process type', { label: 'Held-out top-1 %', num: true }, { label: 'Held-out log-lik', num: true }, { label: 'In-run top-1 %', num: true }, { label: 'Update µs', num: true }, { label: 'Sample µs', num: true }], A.accuracy.map(r => [FAM_LABEL[r.personality] || r.personality, r.heldout_top1, r.heldout_loglik, r.top1_mean, r.update_us, r.sample_us])));
    const ld = $('arLead'); ld.innerHTML = '';
    if (A.leadtime) ld.appendChild(table(['Workload', { label: 'Deadlocks', num: true }, { label: 'Flagged %', num: true }, { label: 'Lead mean', num: true }, { label: 'Lead median', num: true }, { label: 'Lead max', num: true }], A.leadtime.map(r => [FAM_LABEL[r.family] || r.family, r.deadlocks, r.flagged_pct, r.lead_mean, r.lead_median, r.lead_max])));
    if (A.sweep) {
      const taus = [...new Set(A.sweep.map(r => r.tau))].sort((a, b) => a - b);
      const mean = (tau, m) => { const rs = A.sweep.filter(r => r.tau === tau); return rs.reduce((a, r) => a + r[m], 0) / rs.length; };
      C.lineChart($('arSweep'), { x: taus, xEven: true, xTitle: 'τ', xFormat: v => String(v), series: [{ label: 'deadlocks per 1,000 events', color: C.color('reactive'), values: taus.map(t => mean(t, 'deadlock_rate')), markers: true }, { label: 'requests queued (%)', color: C.css('--amber'), values: taus.map(t => mean(t, 'queue_rate')), markers: true }], format: v => fmt(v, 1) });
    }
    if (A.shift_series) {
      const bins = [...new Set(A.shift_series.map(r => r.bin))].sort((a, b) => a - b);
      const mean = (b, m) => { const rs = A.shift_series.filter(r => r.bin === b); return rs.reduce((a, r) => a + r[m], 0) / rs.length; };
      C.lineChart($('arShift'), { x: bins, xTitle: 'event', series: [{ label: 'next-event accuracy of the shifted processes (%)', color: C.color('sage'), values: bins.map(b => mean(b, 'accuracy')) }, { label: 'their decisions sent to the fallback (%)', color: C.color('reactive'), values: bins.map(b => mean(b, 'fallback')) }], yMin: 0, yMax: 100, format: v => fmt(v, 0), refX: { value: (A.config || {}).shift_tick || 600, label: 'shift' } });
    }
    if (A.latency) {
      const rows = A.latency.filter(r => r.H > 0), Hs = [...new Set(rows.map(r => r.H))].sort((a, b) => a - b), Ks = [...new Set(rows.map(r => r.K))].sort((a, b) => a - b);
      C.lineChart($('arLatency'), { x: Ks, xTitle: 'K', xLog: true, log: true, xFormat: v => String(v), series: Hs.map((H, k) => ({ label: 'H = ' + H, color: [C.color('sage'), C.color('bankers'), C.color('reactive'), C.color('sage_lstm')][k % 4], values: Ks.map(K => { const r = rows.find(x => x.H === H && x.K === K); return r ? r.latency_ms : null; }), markers: true })), format: v => fmt(v, 2) });
    }
    const st = $('arShiftTable'); st.innerHTML = '';
    if (A.shift) {
      const pols = ['sage', 'bankers', 'reactive'].filter(p => A.shift.some(r => r.policy === p));
      const mean = (p, m) => { const rs = A.shift.filter(r => r.policy === p && r[m] !== null); return rs.length ? rs.reduce((a, r) => a + r[m], 0) / rs.length : null; };
      st.appendChild(table(['Policy', { label: 'Deadlocks / run', num: true }, { label: 'In the 300-event window', num: true }, { label: 'Window queue %', num: true }, { label: 'Detection delay (events)', num: true }, { label: 'Recovery (ticks)', num: true }], pols.map(p => [h('span', {}, swatch(p), policyLabel(p)), mean(p, 'deadlocks'), mean(p, 'window_deadlocks'), mean(p, 'window_queue_rate'), mean(p, 'detection_delay_events'), mean(p, 'recovery_mean')])));
    }
    const pl = $('arPlots'); pl.innerHTML = '';
    for (const f of S.meta.plots) pl.appendChild(h('figure', {}, h('img', { src: '/plots/' + f, alt: f, loading: 'lazy' }), h('figcaption', {}, f)));
    if (A.run_log_tail) { const d = h('details', { class: 'details' }, h('summary', {}, 'Tail of results/run_log.txt'), h('pre', { class: 'pre' }, A.run_log_tail.join('\n'))); pl.parentElement.appendChild(d); }
  }

  // ---------------------------------------------------------------- VI. verification
  function initVerify() { $('vfRun').addEventListener('click', runVerify); }
  async function runVerify() {
    const vbtn = $('vfRun'); vbtn.disabled = true; vbtn.classList.add('running'); vbtn.textContent = 'Running…'; $('vfProgress').hidden = false; $('vfSummary').innerHTML = ''; $('vfCases').innerHTML = ''; setRunning('Verifying');
    try {
      const job = await api.post('/api/jobs/verify');
      const res = await watchJob(job.id);
      const ok = res.cases.filter(c => c.ok).length;
      $('vfSummary').appendChild(checkMark(res.ok));
      const big = h('span', { class: 'big', style: 'color:' + (res.ok ? 'var(--good)' : 'var(--bad)') }, '0 / ' + res.cases.length); $('vfSummary').appendChild(big);
      countUp(big.firstChild, ok, 0, 1200); setTimeout(() => { big.firstChild.textContent = ok + ' / ' + res.cases.length; }, 1300);
      $('vfSummary').appendChild(h('span', {}, res.ok ? 'every case passed' : 'some cases failed', h('div', { class: 'muted small' }, res.summary)));
      $('vfCases').appendChild(table(['#', 'Case', 'Result'], res.cases.map((c, k) => [k + 1, h('span', {}, c.name, c.detail ? h('div', { class: 'sd' }, c.detail) : null), badge(c.ok ? 'pass' : 'fail', c.ok ? 'good' : 'bad')])));
      $('vfRaw').hidden = false; $('vfOut').textContent = res.output;
    } catch (e) { toast('Verification failed to run: ' + e.message, true); }
    finally { vbtn.disabled = false; vbtn.classList.remove('running'); vbtn.textContent = 'Run the suite'; $('vfProgress').hidden = true; clearRunning(); }
  }

  // ---------------------------------------------------------------- VII. analyst and the AI connection panel
  const aiPanels = [];
  function renderAiPanel(host) {
    host.innerHTML = '';
    const status = h('div', { class: 'status-box' });
    const modelSel = h('select', { class: 'select' });
    const key = h('input', { class: 'input', type: 'password', placeholder: 'gsk_…', autocomplete: 'off', spellcheck: 'false' });
    const persist = h('input', { type: 'checkbox' });
    const save = h('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Use this key');
    const recheck = h('button', { class: 'btn btn-ghost btn-block', type: 'button' }, 'Re-check connection');
    const forget = h('a', { href: '#', class: 'small' }, 'Forget the key');
    host.append(status,
      h('label', { class: 'field' }, 'Model', modelSel, h('span', { class: 'hint' }, 'Listed from your Groq account once the key is accepted')),
      h('label', { class: 'field' }, 'Groq API key', key, h('span', { class: 'hint' }, 'Create one at console.groq.com → API Keys')),
      h('label', { class: 'check' }, persist, ' Save to sage_project/.env for next time'),
      h('div', { class: 'form-actions' }, save, recheck),
      h('p', { class: 'muted small' }, 'The key never leaves the server; the browser only sees its first and last characters. ', forget));
    const panel = { host, status, modelSel, key, persist, save, recheck };
    aiPanels.push(panel);
    const busy = (on, label) => { save.disabled = on; save.classList.toggle('running', on); save.textContent = on ? (label || 'Checking…') : 'Use this key'; };
    save.addEventListener('click', async () => {
      const k = key.value.trim(); if (!k) { toast('Paste a key first', true); key.focus(); return; }
      busy(true);
      try { S.meta.ai = await api.post('/api/ai/key', { key: k, persist: persist.checked }); key.value = ''; refreshAiPanels(); renderStatus(); toast(S.meta.ai.status === 'ok' ? 'Groq connected · ' + S.meta.ai.model : 'Key set, but: ' + (S.meta.ai.error || S.meta.ai.status), S.meta.ai.status !== 'ok'); }
      catch (e) { toast(e.message, true); }
      finally { busy(false); }
    });
    key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
    recheck.addEventListener('click', async () => { recheck.classList.add('running'); try { S.meta.ai = await api.get('/api/ai/status?refresh=true'); refreshAiPanels(); renderStatus(); } finally { recheck.classList.remove('running'); } });
    modelSel.addEventListener('change', async () => { S.meta.ai = await api.post('/api/ai/model', { model: modelSel.value }); refreshAiPanels(); renderStatus(); toast('Model: ' + S.meta.ai.model); });
    forget.addEventListener('click', async (e) => { e.preventDefault(); S.meta.ai = await api.post('/api/ai/key', { key: '', persist: persist.checked }); refreshAiPanels(); renderStatus(); toast('Key forgotten'); });
    fillAiPanel(panel);
    return panel;
  }
  function fillAiPanel(panel) {
    const ai = S.meta.ai, box = panel.status; box.innerHTML = '';
    const cls = ai.status === 'ok' ? 'good' : ai.status === 'missing' ? 'warn' : 'bad';
    box.appendChild(h('div', {}, badge({ ok: 'connected', missing: 'no key', invalid: 'key rejected', offline: 'offline', unavailable: 'sdk missing', error: 'error', unchecked: 'unchecked' }[ai.status] || ai.status, cls), ' ', ai.key_hint ? h('span', { class: 'mono' }, ai.key_hint) : '', ai.source ? h('span', { class: 'muted' }, ' from ' + ai.source) : ''));
    if (ai.error) box.appendChild(h('div', { class: 'muted' }, ai.error));
    if (ai.status === 'ok') box.appendChild(h('div', { class: 'muted' }, ai.models.length + ' chat models available · using ' + ai.model));
    if (ai.status === 'missing') box.appendChild(h('div', { class: 'muted' }, 'Paste a key below to enable the analyst, decision explanations, the workload designer and chat.'));
    const sel = panel.modelSel; sel.innerHTML = '';
    const info = ai.model_info || {};
    (ai.models.length ? ai.models : [ai.model || 'llama-3.3-70b-versatile']).forEach(m => sel.appendChild(h('option', { value: m }, m + (info[m] ? ' · ' + Math.round(info[m] / 1024) + 'k context' : ''))));
    if (ai.model) sel.value = ai.model;
    sel.disabled = ai.status !== 'ok';
  }
  function refreshAiPanels() { for (let k = aiPanels.length - 1; k >= 0; k--) { if (!aiPanels[k].host.isConnected) aiPanels.splice(k, 1); else fillAiPanel(aiPanels[k]); } }
  function openAiSettings() {
    openModal('AI connection');
    const body = $('modalBody'); body.innerHTML = '';
    body.appendChild(h('p', { class: 'muted small' }, 'Groq powers the analyst, the decision explanations, the workload designer and the chat. The simulator itself never depends on it.'));
    const host = h('div', {}); body.appendChild(host); renderAiPanel(host);
    setTimeout(() => { const k = host.querySelector('input[type=password]'); if (k && S.meta.ai.status !== 'ok') k.focus(); }, 80);
  }
  function initAnalyst() {
    renderAiPanel($('aiPanelHost'));
    $('chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
    $('chatText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
    $('chatClear').addEventListener('click', () => { S.chat = []; $('chatLog').innerHTML = ''; });
    const sg = $('chatSuggest'); sg.innerHTML = '';
    ['Explain the decision rule in two paragraphs.', 'When does SAGE fall back to the learned-claims check, and why is that safe?', 'How does the LSTM engine differ from the Markov tables, and when is it used?', 'What would you tune first if deadlocks remain on the mixed workload?', 'Compare SAGE with wound-wait on throughput and rollbacks.'].forEach(q => sg.appendChild(h('span', { class: 'chip', onclick: () => { $('chatText').value = q; sendChat(); } }, q)));
    refreshChatContext();
  }
  async function refreshChatContext() {
    const sel = $('chatContext'); sel.innerHTML = ''; sel.appendChild(h('option', { value: '' }, 'No run in context'));
    const list = await api.get('/api/jobs').catch(() => []);
    list.filter(j => j.status === 'done' && ['run', 'compare', 'sweep'].includes(j.kind)).slice(0, 10).forEach(j => { const p = j.params; sel.appendChild(h('option', { value: j.id }, (j.kind === 'run' ? policyLabel(p.policy) + ' · ' + (p.title || FAM_LABEL[p.family] || p.family) + ' · seed ' + p.seed : j.kind + ' · ' + (p.family || 'custom')) + ' · ' + ago(j.finished))); });
    if (S.runJob && [...sel.options].some(o => o.value === S.runJob)) sel.value = S.runJob;
  }
  function addMsg(role, text) { const m = h('div', { class: 'msg ' + role }, h('div', { class: 'who' }, role === 'user' ? 'You' : 'Analyst'), h('div', { class: 'prose' })); m.querySelector('.prose').innerHTML = md(text); $('chatLog').appendChild(m); $('chatLog').scrollTop = $('chatLog').scrollHeight; return m.querySelector('.prose'); }
  async function sendChat() {
    const text = $('chatText').value.trim(); if (!text) return;
    if (S.meta.ai.status !== 'ok') { const o = addMsg('assistant', ''); offlineNotice(o); return; }
    $('chatText').value = ''; S.chat.push({ role: 'user', content: text }); addMsg('user', text);
    const out = addMsg('assistant', ''); out.innerHTML = '<div class="skeleton w80"></div><div class="skeleton w60"></div>'; $('chatSend').disabled = true;
    const ctx = [...$('chatContext').selectedOptions].map(o => o.value).filter(Boolean);
    try { const full = await api.stream('/api/ai/chat', { messages: S.chat, job_ids: ctx }, acc => { out.innerHTML = md(acc) + '<span class="cursor"></span>'; $('chatLog').scrollTop = $('chatLog').scrollHeight; }); out.innerHTML = md(full); S.chat.push({ role: 'assistant', content: full }); }
    catch (e) { out.innerHTML = md('**Error:** ' + e.message); }
    finally { $('chatSend').disabled = false; }
  }

  // ---------------------------------------------------------------- VIII. method
  function renderMethod() {
    const c = S.meta.config;
    $('methodDoc').innerHTML = md(`# SAGE: Simulated Ahead-of-Time Grant Evaluator

**Version ${S.meta.version || '3.0'}.** The decision rule, the Markov engine and every default are those of v2, and the archived benchmark is reproduced exactly by this code; v3 adds the LSTM engine, this console, the analyst and custom workloads.

Deadlock avoidance in the textbook sense needs every process to declare its maximum demand in advance; Banker's algorithm then keeps the system in a *safe state*. Real processes rarely declare anything. SAGE removes the declaration: it learns, from each process's own request log, a model of what the process will do next, and before granting a request for a free resource it simulates what would follow.

## The decision rule

For a request by process *i* for a free resource *r*:

1. **Confidence check.** The requester's behaviour model is *trusted* only if it has seen at least \`h_min\` = ${c.h_min} transitions (otherwise *cold*), its fitted average log-likelihood is at least \`min_ll\` = ${c.min_ll} (otherwise *uncertain*: a near-random process), and its CUSUM of surprise is below \`drift_h\` = ${c.drift_h} (otherwise *drift*: the behaviour has changed).
2. **Rollout.** If trusted, the live state is copied K = ${c.K} times with the grant applied, and every copy is rolled forward H = ${c.H} steps by sampling each process's model, restricted to what it can do with what it holds. A future counts as deadlocked when the requester ends on a cycle of the wait-for graph. The **risk** is the share of deadlocked futures; the request is queued when risk ≥ τ = ${c.tau}. The simulation stops as soon as the comparison with τ is settled.
3. **Fallback.** If not trusted, a Banker's-style safety check runs with **learned claims**: a process may still need every resource it was ever seen to request, except that a process holding as many resources as it was ever seen holding at once is taken to release before asking for more. Nothing is declared.
4. **Starvation guard.** While some request has waited \`aging\` = ${c.aging} ticks in one go, or a process has gone \`life_aging\` = ${c.life_aging} ticks without completing a life, processes that hold nothing are held back (*drain*), so the overdue request becomes safe to grant. When nothing is runnable, the stall handler force-grants the queued request with the lowest re-scored risk.

Queued requests are re-evaluated, in arrival order, at every release. Deadlocks that occur anyway (under any policy) are detected exactly by a depth-first search of the wait-for graph on every block, and resolved by aborting the cycle member aborted least often, rolled back to the last point of its program at which it held nothing.

## Behaviour models

**Markov chain with context tables.** The baseline model is a first-order chain over the process's own events (request *r*, release *r*, exit), with predictions masked to the feasible events given the current holdings. Two context tables, indexed by the *episode peak* (most resources held since the process last held nothing) and the *episode count* (holding episodes completed in the current life), tell apart situations a first-order chain confuses: whether a process that has just released everything starts another level or exits. A context table is used only once it has beaten the plain table prequentially, on both log-likelihood and next-event hits.

**LSTM engine.** With \`model = lstm\`, each process additionally trains a small recurrent network (${c.lstm_hidden} hidden units) on its own event stream: input = last event, holdings, episode peak and count; output = the next event. Training is online and prequential (every event is scored before it is learned), with truncated back-propagation through time every ${c.lstm_train_every} events, four times as often during the first 256 events. The network is **gated**: it is used for a process only while it beats the Markov tables on a decayed prequential log-likelihood and on next-event hits, so the combined model is never worse than the chain for long. When the network is in use, the table the rollout samples from is conditioned on the whole history: the row of the actual state is the network's forecast, and every other row is the forecast after one hypothetical step.

Where does the network help? On processes whose next event depends on more than the last event and one context index: random "bursty" processes, where the network learns from the holdings and the episode structure how bursts end, gain measurably; fixed and escalating patterns are already predicted almost perfectly by the chain, and the gate keeps the chain in charge there.

## Baselines

| Policy | Strategy | Needs |
|---|---|---|
| Banker's algorithm | avoidance with declared maxima (the true per-life maxima, its most favourable setting) | declarations |
| Banker's, no declaration | avoidance assuming every process may need everything | nothing; very conservative |
| Reactive detection | grant whenever free; detect cycles; abort a victim | nothing; pays in rollbacks |
| Timeout | no detection; a process blocked too long is rolled back | a timeout value |
| Wait-die | timestamps: an older requester waits, a younger one dies | timestamps |
| Wound-wait | timestamps: an older requester wounds (rolls back) a younger holder | timestamps |

## Workloads

Process types: **fixed** (the same 2–3 resources in the same order, 4–8 cycles per life), **bursty** (random requests and releases, up to a limit held), **escalating** (level 1 … L of a fixed order, then exit) and **custom** (any program, from the studio or designed by the analyst). Families assign types to the slots: fixed, bursty, escalating, mixed, and *shift*, in which half the processes change their pattern at event ${c.shift_tick} to one that conflicts with the others. Every run is seeded: the same seed gives the same programs and scheduler draws for every policy.

## Metrics

*Deadlock rate*: deadlocks per 1,000 events. *Queue rate*: share of free-resource requests the policy refused for now. *Throughput*: completed process lives per 1,000 events. *Rollback and wasted rates*: rollbacks and undone program steps per 1,000 events. *Starved slots*: process slots that never completed a life. *Latency*: wall time per decision. The replay records, per event, the allocation, every process's status and program position, the decision with its risk and the outcome of each simulated future.

## The analyst

The language model (Groq) never takes part in a decision. It receives the numbers a run produced, as JSON, and writes the analysis, explains one decision from the state at that event, designs a workload specification from a description (validated by the server, retried on rejection) and answers questions with the selected runs in context. Its claims are only as good as the evidence it is given; it is instructed to quote numbers rather than invent them.

## Reproducing

\`\`\`
pip install -r requirements.txt
python tests/verify.py                # verification cases with known answers
python -m experiments.run_all         # the benchmark archive (about 20 minutes)
python -m experiments.compare_all     # every policy, 100 seeds (longer)
python -m server                      # this console
\`\`\`
`);
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    try { S.meta = await api.get('/api/meta'); } catch (e) { document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif">The server did not answer: ' + esc(e.message) + '</p>'; return; }
    renderStatus();
    $('aiBtn').addEventListener('click', openAiSettings);
    const sp = h('div', { class: 'scroll-progress' }); document.body.appendChild(sp);
    const upd = () => { const d = document.documentElement, max = d.scrollHeight - d.clientHeight; sp.style.width = (max > 0 ? 100 * d.scrollTop / max : 0) + '%'; };
    window.addEventListener('scroll', upd, { passive: true }); window.addEventListener('resize', () => { upd(); moveNavIndicator(); });
    show(location.hash.slice(1) || 'overview');
    setTimeout(moveNavIndicator, 200);
    setInterval(async () => { try { const ai = await api.get('/api/ai/status'); if (ai.status !== S.meta.ai.status || ai.model !== S.meta.ai.model) { S.meta.ai = ai; renderStatus(); refreshAiPanels(); } } catch (e) { } }, 60000);
  }
  boot();
})();
