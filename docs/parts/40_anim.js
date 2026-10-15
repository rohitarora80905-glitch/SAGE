/* ---------------------------------------------------------------- hero constellation */
(function () {
  const svg = $('heroBg'); if (!svg || reduced) return;
  const N = 14, nodes = [], rnd = Math.random;
  for (let i = 0; i < N; i++) nodes.push({ x0: 40 + rnd() * 1120, y0: 30 + rnd() * 460, ax: 16 + rnd() * 28, ay: 10 + rnd() * 22, w1: .2 + rnd() * .3, w2: .18 + rnd() * .3, p1: rnd() * 6.3, p2: rnd() * 6.3, r: 3.5 + rnd() * 3, x: 0, y: 0 });
  const edgeG = svgEl('g', {}, svg), circles = nodes.map(nd => svgEl('circle', { r: nd.r, class: 'amb-node' }, svg));
  const edges = []; let last = 0, nextEdge = 0, cyc = null, on = true;
  onActive(svg.parentElement, v => on = v);
  const frame = (t) => {
    requestAnimationFrame(frame);
    if (!on || document.hidden || t - last < 33) return;
    last = t; const s = t / 1000;
    nodes.forEach((nd, i) => { nd.x = nd.x0 + nd.ax * Math.sin(s * nd.w1 + nd.p1); nd.y = nd.y0 + nd.ay * Math.cos(s * nd.w2 + nd.p2); circles[i].setAttribute('cx', nd.x.toFixed(1)); circles[i].setAttribute('cy', nd.y.toFixed(1)); });
    if (s > nextEdge) {
      nextEdge = s + .5 + rnd(); const a = Math.floor(rnd() * N); let b = Math.floor(rnd() * N); if (b === a) b = (a + 1) % N;
      edges.push({ a, b, line: svgEl('line', { class: 'amb-edge' }, edgeG), born: s, ttl: 2.5 + rnd() * 3 });
      if (!cyc && rnd() < .3) { edges.push({ a: b, b: a, line: svgEl('line', { class: 'amb-edge' }, edgeG), born: s, ttl: 2.4 }); cyc = { a, b, until: s + 2.4 }; }
    }
    for (let k = edges.length - 1; k >= 0; k--) {
      const e = edges[k], age = s - e.born; if (age > e.ttl) { e.line.remove(); edges.splice(k, 1); continue; }
      const A = nodes[e.a], B = nodes[e.b]; e.line.setAttribute('x1', A.x.toFixed(1)); e.line.setAttribute('y1', A.y.toFixed(1)); e.line.setAttribute('x2', B.x.toFixed(1)); e.line.setAttribute('y2', B.y.toFixed(1));
      e.line.style.opacity = Math.min(1, age / .6, (e.ttl - age) / .6); e.line.classList.toggle('cyc', !!(cyc && ((e.a === cyc.a && e.b === cyc.b) || (e.a === cyc.b && e.b === cyc.a))));
    }
    if (cyc && s > cyc.until) cyc = null;
    circles.forEach((c, i) => c.classList.toggle('cyc', !!(cyc && (i === cyc.a || i === cyc.b))));
  };
  requestAnimationFrame(frame);
})();

/* ---------------------------------------------------------------- I. printer and scanner */
(function () {
  const svg = $('dgProblem'), cap = $('dgProblemCap'); if (!svg) return;
  const P1 = svgEl('circle', { cx: 110, cy: 150, r: 34, class: 'proc' }, svg), P2 = svgEl('circle', { cx: 410, cy: 150, r: 34, class: 'proc' }, svg);
  svgText(svg, 110, 146, 'P1', { 'text-anchor': 'middle' }); svgText(svg, 110, 162, 'writer', { 'text-anchor': 'middle', class: 'small' });
  svgText(svg, 410, 146, 'P2', { 'text-anchor': 'middle' }); svgText(svg, 410, 162, 'scanner-first', { 'text-anchor': 'middle', class: 'small' });
  const R1 = svgEl('rect', { x: 230, y: 40, width: 60, height: 44, rx: 4, class: 'res' }, svg), R2 = svgEl('rect', { x: 230, y: 216, width: 60, height: 44, rx: 4, class: 'res' }, svg);
  svgText(svg, 260, 67, 'printer', { 'text-anchor': 'middle', class: 'mono' }); svgText(svg, 260, 243, 'scanner', { 'text-anchor': 'middle', class: 'mono' });
  const edgeG = svgEl('g', {}, svg);
  const steps = [
    { cap: 'P1 acquires the printer.', do: () => { R1.classList.add('held'); edge(130, 128, 232, 70, 'alloc'); } },
    { cap: 'P2 acquires the scanner.', do: () => { R2.classList.add('held'); edge(388, 172, 288, 232, 'alloc'); } },
    { cap: 'P1 requests the scanner: held by P2, so P1 blocks. One wait-for edge, no cycle yet.', do: () => { P1.classList.add('wait'); edge(130, 172, 232, 232, ''); } },
    { cap: 'P2 requests the printer: held by P1, so P2 blocks. The wait-for graph now has a cycle. Reactive detection finds it here and aborts a victim; Banker\'s would have refused step 2 if both processes had declared they may need both resources; SAGE queues the request in step 2 or 3 because its rollouts end in this picture.', do: () => { P2.classList.add('wait'); edge(388, 128, 288, 70, ''); P1.classList.add('cyc'); P2.classList.add('cyc'); edgeG.querySelectorAll('.edge:not(.alloc)').forEach(e => e.classList.add('cyc')); } },
    { cap: 'Reset.', do: () => { reset(); } },
  ];
  function edge(x1, y1, x2, y2, cls) { const mx = (x1 + x2) / 2 + (y2 - y1) * 0.12, my = (y1 + y2) / 2 - (x2 - x1) * 0.12; svgEl('path', { d: `M${x1},${y1}Q${mx},${my} ${x2},${y2}`, class: 'edge ' + cls, 'marker-end': 'url(#arrowP)' }, edgeG); }
  const defs = svgEl('defs', {}, svg); defs.innerHTML = '<marker id="arrowP" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="context-stroke"/></marker>';
  function reset() { edgeG.innerHTML = ''; R1.classList.remove('held'); R2.classList.remove('held'); P1.setAttribute('class', 'proc'); P2.setAttribute('class', 'proc'); }
  let k = 0, on = true, timer = null;
  const tick = () => { if (!on) return; const st = steps[k]; st.do(); cap.innerHTML = ''; cap.append(h('b', {}, String(k + 1 > 4 ? '·' : k + 1)), h('span', {}, st.cap)); if (!reduced) cap.style.animation = 'none', void cap.offsetWidth, cap.style.animation = ''; k = (k + 1) % steps.length; timer = setTimeout(tick, k === 4 ? 3800 : k === 0 ? 900 : 1700); };
  onActive(svg.parentElement, v => { on = v; if (v && !timer) tick(); if (!v && timer) { clearTimeout(timer); timer = null; } });
})();

/* ---------------------------------------------------------------- III. pipeline with a travelling token */
(function () {
  const svg = $('dgPipe'), cap = $('pipeCap'), list = $('stageList'), scen = $('scenarios'); if (!svg) return;
  const defs = svgEl('defs', {}, svg); defs.innerHTML = '<marker id="arrowW" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="context-stroke"/></marker>';
  const nodes = {
    REQ: { x: 20, y: 150, w: 150, h: 64, t: 'Request', s: 'free resource r' },
    DRAIN: { x: 210, y: 40, w: 170, h: 64, t: 'Starvation guard', s: 'another request overdue?' },
    CONF: { x: 210, y: 150, w: 170, h: 64, t: 'Confidence check', s: 'cold · uncertain · drift · learned' },
    ROLL: { x: 440, y: 80, w: 170, h: 64, t: 'Rollout', s: 'K futures × H steps' },
    GATE: { x: 660, y: 80, w: 140, h: 64, t: 'risk ≥ τ ?', s: 'share deadlocked' },
    FALL: { x: 440, y: 240, w: 170, h: 64, t: 'Learned claims', s: "Banker's safety check" },
    SAFE: { x: 660, y: 240, w: 140, h: 64, t: 'safe ?', s: 'every process can finish' },
    GRANT: { x: 850, y: 110, w: 130, h: 54, t: 'Grant', s: 'resource allocated' },
    QUEUE: { x: 850, y: 210, w: 130, h: 54, t: 'Queue', s: 're-evaluated on release' },
  };
  const els = {};
  for (const k in nodes) { const n = nodes[k]; els[k] = svgEl('rect', { x: n.x, y: n.y, width: n.w, height: n.h, class: 'node' }, svg); svgText(svg, n.x + n.w / 2, n.y + 26, n.t, { 'text-anchor': 'middle', style: 'font-weight:600' }); svgText(svg, n.x + n.w / 2, n.y + 44, n.s, { 'text-anchor': 'middle', class: 'small' }); }
  const mid = (k, side) => { const n = nodes[k]; return side === 'r' ? [n.x + n.w, n.y + n.h / 2] : side === 'l' ? [n.x, n.y + n.h / 2] : side === 't' ? [n.x + n.w / 2, n.y] : [n.x + n.w / 2, n.y + n.h]; };
  const paths = {}, pathG = svgEl('g', {}, svg);
  function link(name, a, sa, b, sb, cls) { const [x1, y1] = mid(a, sa), [x2, y2] = mid(b, sb); const d = Math.abs(y2 - y1) < 2 ? `M${x1},${y1}L${x2},${y2}` : `M${x1},${y1}C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`; paths[name] = svgEl('path', { d, class: 'path ' + (cls || ''), 'marker-end': 'url(#arrowW)' }, pathG); }
  link('req-conf', 'REQ', 'r', 'CONF', 'l'); link('req-drain', 'REQ', 'r', 'DRAIN', 'l'); link('conf-roll', 'CONF', 'r', 'ROLL', 'l'); link('conf-fall', 'CONF', 'r', 'FALL', 'l');
  link('roll-gate', 'ROLL', 'r', 'GATE', 'l'); link('gate-grant', 'GATE', 'r', 'GRANT', 'l'); link('gate-queue', 'GATE', 'r', 'QUEUE', 'l'); link('fall-safe', 'FALL', 'r', 'SAFE', 'l'); link('safe-grant', 'SAFE', 'r', 'GRANT', 'l'); link('safe-queue', 'SAFE', 'r', 'QUEUE', 'l'); link('drain-queue', 'DRAIN', 'r', 'QUEUE', 't');
  const back = svgEl('path', { d: `M${nodes.QUEUE.x + nodes.QUEUE.w / 2},${nodes.QUEUE.y + nodes.QUEUE.h}C${nodes.QUEUE.x + 60},340 120,340 ${nodes.REQ.x + nodes.REQ.w / 2},${nodes.REQ.y + nodes.REQ.h}`, class: 'path dashed', 'marker-end': 'url(#arrowW)' }, pathG);
  svgText(svg, 520, 352, 'a release re-evaluates the queue in arrival order; when nothing is runnable the stall handler force-grants the queued request with the lowest re-scored risk', { 'text-anchor': 'middle', class: 'small' });
  const token = svgEl('circle', { r: 8, class: 'token', cx: -20, cy: -20 }, svg);
  const SC = [
    { name: 'Learned, low risk', steps: [['REQ', 'P4 asks for R6, which is free.'], ['req-conf', 'CONF', 'P4 has 481 transitions of history, a fitted log-likelihood of −0.10 and no drift: its model is trusted.'], ['conf-roll', 'ROLL', 'K = 100 copies of the live state are rolled forward H = 30 steps with the grant applied.'], ['roll-gate', 'GATE', '2 of 100 futures put P4 on a wait-for cycle: risk 0.02, below τ = 0.1.'], ['gate-grant', 'GRANT', 'Granted. The whole decision took about 3 ms.']], end: 'good' },
    { name: 'Learned, high risk', steps: [['REQ', 'P6 asks for R2, which is free.'], ['req-conf', 'CONF', 'Model trusted: learned path.'], ['conf-roll', 'ROLL', 'The futures diverge; in many of them P1 takes R4 next and P6 asks for it while holding R2.'], ['roll-gate', 'GATE', '22 of 100 futures deadlock the requester: risk 0.22 ≥ τ. The simulation stopped as soon as τ was reached.'], ['gate-queue', 'QUEUE', 'Queued. At the next release the request is scored again on the new state.']], end: 'bad' },
    { name: 'Uncertain, fallback', steps: [['REQ', 'P2, a bursty process, asks for R7.'], ['req-conf', 'CONF', 'Its fitted log-likelihood is −4.5, far below min_ll = −1: the process is close to random, so a rollout would be noise.'], ['conf-fall', 'FALL', "Learned claims: P2 may still need every resource it was ever seen to request, unless it already holds its learned limit."], ['fall-safe', 'SAFE', 'The safety sequence finds an order in which every process can finish.'], ['safe-grant', 'GRANT', 'Granted on the fallback path, without a declaration from anyone.']], end: 'good' },
    { name: 'Starvation guard', steps: [['REQ', 'P3, holding nothing, asks for R1.'], ['req-drain', 'DRAIN', 'P5 has been waiting 400 ticks in one go: it is overdue. Starting new work would keep its request risky.'], ['drain-queue', 'QUEUE', 'P3 is held back (drain). The holders run on and release until P5 gets through, then P3 is re-evaluated.']], end: 'bad' },
  ];
  let si = 0, step = 0, on = true, timer = null, raf = null;
  SC.forEach((s, k) => scen.appendChild(h('button', { class: 'chip' + (k === 0 ? ' on' : ''), type: 'button', onclick: () => { si = k; step = 0; scen.querySelectorAll('.chip').forEach((c, j) => c.classList.toggle('on', j === k)); clearTimeout(timer); cancelAnimationFrame(raf); run(); } }, s.name)));
  function renderStages() { list.innerHTML = ''; SC[si].steps.forEach((st, k) => list.appendChild(h('div', { class: 'stage' + (k === step ? ' on' : ''), 'data-k': k }, h('b', {}, String(k + 1)), h('span', {}, nodes[st.length === 3 ? st[1] : st[0]].t)))); }
  function setNode(key, cls) { for (const k in els) els[k].setAttribute('class', 'node'); if (key) els[key].setAttribute('class', 'node ' + (cls || 'on')); for (const p in paths) paths[p].classList.remove('on'); }
  function travel(pathName, done) {
    const p = paths[pathName]; p.classList.add('on'); const L = p.getTotalLength(), t0 = performance.now(), dur = reduced ? 1 : 900;
    const fr = (t) => { const q = Math.min(1, (t - t0) / dur), e = q < .5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2, pt = p.getPointAtLength(L * e); token.setAttribute('cx', pt.x); token.setAttribute('cy', pt.y); if (q < 1) raf = requestAnimationFrame(fr); else done(); };
    raf = requestAnimationFrame(fr);
  }
  function run() {
    if (!on) return;
    const sc = SC[si], st = sc.steps[step]; renderStages();
    const show = (key, text) => { setNode(key, step === sc.steps.length - 1 ? (sc.end === 'good' ? 'good' : 'amber') : 'on'); token.setAttribute('class', 'token' + (step === sc.steps.length - 1 ? ' ' + (sc.end === 'good' ? 'good' : 'bad') : '')); const [cx, cy] = [nodes[key].x + nodes[key].w / 2, nodes[key].y + nodes[key].h / 2]; token.setAttribute('cx', cx); token.setAttribute('cy', cy); cap.innerHTML = ''; cap.append(h('b', {}, String(step + 1)), h('span', {}, text)); if (!reduced) { cap.style.animation = 'none'; void cap.offsetWidth; cap.style.animation = ''; } };
    if (st.length === 3) travel(st[0], () => { show(st[1], st[2]); next(); }); else { show(st[0], st[1]); next(); }
    function next() { timer = setTimeout(() => { step++; if (step >= sc.steps.length) { step = 0; si = (si + 1) % SC.length; scen.querySelectorAll('.chip').forEach((c, j) => c.classList.toggle('on', j === si)); } run(); }, step === sc.steps.length - 1 ? 3200 : 2000); }
  }
  onActive(svg.parentElement, v => { on = v; if (v) run(); else { clearTimeout(timer); cancelAnimationFrame(raf); } });
})();

/* ---------------------------------------------------------------- IV. twin replay */
(function () {
  const T = D.twin.sage.ticks;
  function prep(p) {
    const idx = new Array(T + 1).fill(-1); p.trace.forEach((e, k) => { idx[e.t] = k; }); for (let t = 1; t <= T; t++) if (idx[t] < 0) idx[t] = idx[t - 1];
    const cumDl = [], cumQ = []; let dl = 0, q = 0; p.trace.forEach(e => { if (e.dl) dl++; if (e.dec && e.dec.d === 'wait') q++; cumDl.push(dl); cumQ.push(q); });
    return { p, idx, cumDl, cumQ, byProc: p.programs };
  }
  const R = { reactive: prep(D.twin.reactive), sage: prep(D.twin.sage) };
  const names = (p) => p.processes.map(q => q.name), res = D.twin.sage.resources;
  function build(host, R, cls) {
    const p = R.p, n = p.n, m = p.m;
    host.innerHTML = '';
    host.appendChild(h('div', { class: 'rp-head' }, h('span', { class: 't' }, p.policy_label + (p.config.model === 'lstm' && p.policy === 'sage' ? ' · LSTM engine' : '')),
      h('div', { class: 'rp-counters' }, h('span', { class: 'dl' }, h('b', { id: cls + 'Dl' }, '0'), 'deadlocks'), h('span', { class: 'q' }, h('b', { id: cls + 'Q' }, '0'), 'queued'), h('span', {}, h('b', { id: cls + 'Done' }, '0'), 'lives done'))));
    const ev = h('div', { class: 'rp-event' }); host.appendChild(ev);
    const panels = h('div', { class: 'rp-panels' }), al = h('div', { class: 'alloc' }), gr = h('div', { class: 'wfg' }); panels.append(al, gr); host.appendChild(panels);
    // allocation grid
    const cs = 22, left = 44, top = 20, W = left + m * cs + 6, H = top + n * cs + 4;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}` }, al);
    for (let r = 0; r < m; r++) svgText(svg, left + r * cs + cs / 2, 13, res[r].length > 3 ? res[r].slice(0, 3) : res[r], { 'text-anchor': 'middle' });
    const cells = [], pnames = [];
    for (let i = 0; i < n; i++) { pnames.push(svgText(svg, left - 5, top + i * cs + cs / 2 + 4, names(p)[i], { 'text-anchor': 'end', class: 'pn' })); const row = []; for (let r = 0; r < m; r++) { const rect = svgEl('rect', { x: left + r * cs + 2, y: top + i * cs + 2, width: cs - 4, height: cs - 4, rx: 3, class: 'cell' }, svg); rect.appendChild(svgEl('title')); row.push(rect); } cells.push(row); }
    // wait-for graph
    const GW = 300, GH = 220, cx = GW / 2, cy = GH / 2 + 2, rad = Math.min(GW, GH) / 2 - 30;
    const g = svgEl('svg', { viewBox: `0 0 ${GW} ${GH}` }, gr);
    const defs = svgEl('defs', {}, g); defs.innerHTML = `<marker id="arrow-${cls}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="context-stroke"/></marker>`;
    const edgeLayer = svgEl('g', {}, g), pos = [], gnodes = [];
    for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + 2 * Math.PI * i / n, x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a); pos.push([x, y]); const ring = svgEl('circle', { cx: x, cy: y, r: 16, class: 'ring' }, g), c = svgEl('circle', { cx: x, cy: y, r: 16, class: 'node' }, g); svgText(g, x, y - 1, names(p)[i]); const s = svgText(g, x, y + 9, '', { class: 'sub' }); gnodes.push({ ring, c, s }); }
    const edges = new Map();
    let prevAlloc = null, lastK = -1;
    const edgePath = (P, Q) => { const [x1, y1] = P, [x2, y2] = Q, dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L; const sx = x1 + ux * 18, sy = y1 + uy * 18, ex = x2 - ux * 20, ey = y2 - uy * 20, mx = (sx + ex) / 2 - uy * 14, my = (sy + ey) / 2 + ux * 14; return `M${sx.toFixed(1)},${sy.toFixed(1)}Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`; };
    const OUT = { grant: ['granted', 'good'], wait: ['queued', 'warn'], blocked: ['blocked', 'warn'], deadlock: ['deadlock', 'bad'], release: ['released', 'plain'], exit: ['life complete', 'info'], forced: ['forced grant', 'warn'], held: ['already held', 'plain'], die: ['rolled back', 'bad'], timeout: ['timed out', 'bad'] };
    return {
      show(tick) {
        const k = R.idx[tick]; if (k < 0 || k === lastK) return; const e = p.trace[k]; const flash = e.dl && lastK >= 0; lastK = k;
        $(cls + 'Dl').textContent = R.cumDl[k]; $(cls + 'Q').textContent = R.cumQ[k]; $(cls + 'Done').textContent = e.done.reduce((a, b) => a + b, 0);
        ev.innerHTML = ''; const o = OUT[e.out] || [e.out, 'plain'];
        ev.append(h('span', { class: 'tk' }, 'event ' + e.t), h('b', {}, names(p)[e.i]), h('span', {}, e.op === 0 ? 'requests ' + res[e.r] : e.op === 1 ? 'releases ' + res[e.r] : e.op === 2 ? 'exits' : e.out === 'forced' ? 'force-granted' : ''), badge(o[0], o[1]));
        if (e.path) ev.appendChild(badge(PATH_LABEL[e.path] || e.path, PATH_CLASS[e.path] || 'plain'));
        if (e.risk !== undefined && e.risk !== null) ev.appendChild(h('span', { class: 'mono small' }, 'risk ' + fmt(e.risk, 2)));
        if (e.dl) ev.appendChild(h('span', { class: 'small' }, 'cycle ' + e.dl.cycle.map(i => names(p)[i]).join(' → ') + (e.dl.victim >= 0 ? ' · victim ' + names(p)[e.dl.victim] : '')));
        if (flash && !reduced) { ev.classList.remove('flash'); void ev.offsetWidth; ev.classList.add('flash'); }
        for (let i = 0; i < n; i++) {
          pnames[i].setAttribute('font-weight', i === e.i ? '600' : '400');
          for (let r = 0; r < m; r++) { const held = (e.alloc[i] >> r) & 1, want = e.status[i] === 1 && e.pending[i] === r, was = prevAlloc ? (prevAlloc[i] >> r) & 1 : held; const rect = cells[i][r]; rect.setAttribute('class', 'cell' + (held ? ' held' : want ? (e.reason[i] === 1 ? ' blocked' : ' want') : '') + (held && !was ? ' just' : '')); rect.style.opacity = e.status[i] === 2 ? .4 : 1; rect.firstChild.textContent = names(p)[i] + ' / ' + res[r] + ': ' + (held ? 'held' : want ? 'waiting' : 'free'); }
        }
        prevAlloc = e.alloc.slice();
        const cyc = new Set(e.dl ? e.dl.cycle : []), keep = new Set();
        for (let i = 0; i < n; i++) {
          if (e.status[i] !== 1 || e.reason[i] !== 1 || e.pending[i] < 0) continue; const r = e.pending[i]; let hld = -1; for (let j = 0; j < n; j++) if ((e.alloc[j] >> r) & 1) hld = j; if (hld < 0) continue;
          const key = i + '>' + hld; keep.add(key); let path = edges.get(key); if (!path) { path = svgEl('path', { d: edgePath(pos[i], pos[hld]), 'marker-end': `url(#arrow-${cls})` }, edgeLayer); edges.set(key, path); } path.setAttribute('class', 'edge' + (cyc.has(i) && cyc.has(hld) ? ' cycle' : ''));
        }
        for (const [key, path] of edges) if (!keep.has(key)) { edges.delete(key); path.classList.add('out'); setTimeout(() => path.remove(), 320); }
        for (let i = 0; i < n; i++) { const gn = gnodes[i], c = e.status[i] === 2 ? 'done' : cyc.has(i) ? 'cycle' : e.status[i] === 1 ? (e.reason[i] === 1 ? 'blocked' : 'waiting') : ''; gn.c.setAttribute('class', 'node ' + c + (i === e.i ? ' actor' : '')); gn.ring.setAttribute('class', 'ring' + (i === e.i ? ' on' : '')); const held = []; for (let r = 0; r < m; r++) if ((e.alloc[i] >> r) & 1) held.push(res[r]); gn.s.textContent = e.status[i] === 1 ? '⏳ ' + res[e.pending[i]] : held.length > 2 ? held.slice(0, 2).join(' ') + ' +' + (held.length - 2) : held.length ? held.join(' ') : '·'; }
        return e;
      }
    };
  }
  const vr = build($('rpReactive'), R.reactive, 'rr'), vs = build($('rpSage'), R.sage, 'rs');
  // decision panel for SAGE
  const dec = $('rpDecision');
  function gauge(risk, tau) {
    const r = 40, C = Math.PI * r, arc = 'M10,50 A40,40 0 0 1 90,50', svg = svgEl('svg', { viewBox: '0 0 100 58', class: 'gauge' });
    svgEl('path', { d: arc, class: 'track' }, svg); const val = svgEl('path', { d: arc, class: 'val ' + (risk >= tau ? 'bad' : 'good'), 'stroke-dasharray': C, 'stroke-dashoffset': C }, svg);
    const th = Math.PI * (1 - Math.min(tau, 1)); svgEl('line', { x1: 50 + 34 * Math.cos(th), y1: 50 - 34 * Math.sin(th), x2: 50 + 47 * Math.cos(th), y2: 50 - 47 * Math.sin(th), class: 'tau' }, svg); svgText(svg, 50, 52, fmt(risk, 2));
    requestAnimationFrame(() => requestAnimationFrame(() => val.setAttribute('stroke-dashoffset', C * (1 - Math.min(risk, 1)))));
    return svg;
  }
  function showDecision(e) {
    dec.innerHTML = ''; const p = D.twin.sage, tau = p.config.tau;
    if (!e) return;
    const d = e.dec;
    if (!d) { dec.appendChild(h('p', { class: 'muted small', style: 'margin:0' }, e.out === 'blocked' ? 'No decision: the resource is held, so the requester blocks under every policy.' : e.out === 'deadlock' ? 'A cycle closed; the victim was aborted and rolled back.' : e.out === 'release' || e.out === 'exit' ? 'No decision: a release re-evaluates the queued requests in arrival order.' : 'No decision at this event.')); return; }
    dec.appendChild(h('p', { style: 'margin:0 0 4px' }, p.processes[e.i].name + ' → ' + res[e.r] + ': ', badge(d.d === 'wait' ? 'queued' : 'granted', d.d === 'wait' ? 'warn' : 'good'), ' ', badge(PATH_LABEL[d.path] || d.path, PATH_CLASS[d.path] || 'plain')));
    if (d.risk !== null && d.risk !== undefined) {
      dec.appendChild(gauge(d.risk, tau)); dec.appendChild(h('p', { class: 'small muted', style: 'margin:4px 0 0' }, 'share of futures in which ' + p.processes[e.i].name + ' ends on a wait-for cycle · amber tick: τ = ' + tau));
      if (d.fut) { const mx = Math.max(1, ...d.fut.steps); dec.appendChild(h('div', { class: 'fut' }, ...d.fut.steps.map((c, k) => h('i', { style: 'height:' + Math.max(1, 100 * c / mx) + '%', title: c + ' futures first deadlocked at step ' + (k + 1) })))); dec.appendChild(h('p', { class: 'small muted', style: 'margin:4px 0 0' }, d.fut.dead + ' of ' + d.fut.K + ' futures deadlocked within H = ' + d.fut.H + '; bars: step of the first deadlock' + (d.d === 'wait' ? ' (stopped once τ was reached)' : ''))); }
    } else dec.appendChild(h('p', { class: 'small muted', style: 'margin:0' }, d.path === 'drain' ? 'Another request is overdue; a process holding nothing is held back.' : 'The model was not trusted (' + (PATH_LABEL[d.path] || d.path) + '); the learned-claims safety check decided.'));
    if (d.ms !== undefined) dec.appendChild(h('p', { class: 'small muted', style: 'margin:6px 0 0' }, 'decided in ' + fmt(d.ms, 2) + ' ms'));
  }
  // summary table
  const sm = $('rpSummary'), S = D.twin.sage.summary, Q = D.twin.reactive.summary;
  sm.appendChild(Charts.tableEl(['Metric', { label: 'Reactive', num: true }, { label: 'SAGE', num: true }], [['Deadlocks', Q.deadlocks, S.deadlocks], ['Deadlocks per 1,000 events', Q.deadlock_rate, S.deadlock_rate], ['Completed lives', Q.completed, S.completed], ['Requests queued (%)', Q.queue_rate, S.queue_rate], ['Blocked on a held resource', Q.blocked, S.blocked], ['Rollbacks per 1,000 events', Q.rollback_rate, S.rollback_rate], ['Starved slots', Q.starved, S.starved], ['Decision latency (ms)', Q.latency_ms, S.latency_ms]]));
  // controls
  const range = $('rpRange'), marks = $('rpMarks'), tickPill = $('rpTick');
  range.max = T; marks.setAttribute('viewBox', '0 0 1000 12');
  D.twin.reactive.deadlocks.forEach(d => svgEl('rect', { x: 1000 * d.t / T - 1.5, y: 0, width: 3, height: 12, class: 'dl' }, marks));
  D.twin.sage.decisions.forEach(d => { if (d.d === 'wait') svgEl('rect', { x: 1000 * d.t / T - 1, y: 4, width: 2, height: 8, class: 'q' }, marks); });
  const head = svgEl('rect', { x: 0, y: 0, width: 2, height: 12, class: 'head' }, marks);
  let tick = 1, playing = true, timer = null, on = true;
  function show() { range.value = tick; head.setAttribute('x', 1000 * tick / T - 1); tickPill.lastChild.textContent = 'event ' + tick + ' of ' + T; vr.show(tick); const e = vs.show(tick); if (e) showDecision(e); }
  function play() { playing = true; $('rpPlay').textContent = 'Pause'; clearInterval(timer); timer = setInterval(() => { if (!on) return; tick = tick >= T ? 1 : tick + 1; show(); }, Number($('rpSpeed').value)); }
  function pause() { playing = false; $('rpPlay').textContent = 'Play'; clearInterval(timer); timer = null; }
  $('rpPlay').addEventListener('click', () => playing ? pause() : play());
  $('rpPrev').addEventListener('click', () => { pause(); tick = Math.max(1, tick - 1); show(); });
  $('rpNext').addEventListener('click', () => { pause(); tick = Math.min(T, tick + 1); show(); });
  $('rpJump').addEventListener('click', () => { const nxt = D.twin.reactive.deadlocks.map(d => d.t).find(t => t > tick) || (D.twin.reactive.deadlocks[0] || {}).t; if (nxt) { pause(); tick = nxt; show(); } });
  $('rpSpeed').addEventListener('change', () => { if (playing) play(); });
  range.addEventListener('input', () => { pause(); tick = Number(range.value); show(); });
  show(); onActive($('replay'), v => { on = v; }); if (!reduced) play(); else pause();
  const lede = $('replayLede'); if (lede) lede.textContent = `One seeded ${FAM_LABEL[D.twin.sage.family].toLowerCase()} workload (seed ${D.twin.sage.seed}, ${T} events), identical programs and scheduler draws. Left: reactive detection grants everything and reached ${Q.deadlocks} deadlocks. Right: SAGE${D.twin.sage.config.model === 'lstm' ? ' with the LSTM engine' : ''} queued ${pct(S.queue_rate)} of the free-resource requests and reached ${S.deadlocks}. The replay is a recording of two real runs embedded in this page.`;
})();

/* ---------------------------------------------------------------- V. futures cascade */
(function () {
  const p = D.twin.sage, tau = p.config.tau;
  const cands = p.trace.filter(e => e.dec && e.dec.fut), best = cands.reduce((a, e) => (!a || e.dec.fut.dead > a.dec.fut.dead) ? e : a, null);
  const grid = $('kgrid'); if (!best || !grid) return;
  const f = best.dec.fut, K = f.K, Hh = f.H;
  $('futLede').textContent = `Event ${best.t} of the run above: ${p.processes[best.i].name} asks for ${p.resources[best.r]}. ${f.dead} of ${K} simulated futures put it on a wait-for cycle within H = ${Hh} steps, so with τ = ${tau} the request was queued. Each cell is one future; it turns red at the step in which the requester first lands on a cycle.`;
  $('kgridCap').textContent = `${K} futures, H = ${Hh} steps. Settled futures (the requester finished its life) stay dark; the simulation stops as soon as the verdict is certain.`;
  const cells = []; for (let k = 0; k < K; k++) cells.push(h('i')); grid.style.gridTemplateColumns = `repeat(${Math.ceil(Math.sqrt(K))}, 1fr)`; cells.forEach(c => grid.appendChild(c));
  let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const order = cells.map((_, k) => k).sort(() => rnd() - .5);
  const bar = $('futBar'), tauEl = $('futTau'), stepEl = $('futStep'), riskEl = $('futRisk'), verdict = $('futVerdict');
  tauEl.style.left = (100 * tau) + '%';
  let timer = null, on = true;
  function runOnce() {
    cells.forEach(c => c.className = ''); let dead = 0, ptr = 0, step = 0; verdict.className = 'verdict'; verdict.textContent = 'Simulating K futures in lock-step…';
    const stepFn = () => {
      if (!on) { timer = setTimeout(stepFn, 500); return; }
      if (step >= Hh) { finish(false); return; }
      const nd = f.steps[step] || 0; for (let q = 0; q < nd && ptr < K; q++) cells[order[ptr++]].classList.add('dead'); dead += nd; step++;
      stepEl.firstChild.textContent = step; riskEl.textContent = fmt(dead / K, 2); bar.style.width = (100 * dead / K) + '%';
      if (dead / K >= tau) { finish(true); return; }
      timer = setTimeout(stepFn, 260);
    };
    const finish = (queued) => { verdict.className = 'verdict ' + (queued ? 'q' : 'g'); verdict.textContent = queued ? `Risk ${fmt(dead / K, 2)} ≥ τ at step ${step}: the comparison is settled, the simulation stops, the request is queued.` : `Horizon exhausted with risk ${fmt(dead / K, 2)} < τ: granted.`; timer = setTimeout(runOnce, 3600); };
    timer = setTimeout(stepFn, 600);
  }
  onActive($('futures'), v => { on = v; }); runOnce();
  const rh = p.risk_hist; if (rh && rh.n) Charts.histogram($('riskHist'), { edges: rh.edges, counts: rh.counts, color: color('sage'), label: 'decisions', xLabel: 'risk of the learned-path decisions in the run', refX: tau, refLabel: 'τ' });
})();
