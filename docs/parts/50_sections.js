/* ---------------------------------------------------------------- VI. Markov table, gate, accuracy */
(function () {
  const p = D.twin.sage, m = p.m, res = p.resources;
  const prog = (p.programs || []).find(q => q.i === 0) || p.programs[0]; const tbl = $('mkTable'); if (!prog || !tbl) return;
  const code = (op, r) => op === 0 ? r : op === 1 ? m + r : 2 * m;
  const name = (c) => c === 2 * m + 1 ? 'start' : c === 2 * m ? 'exit' : c < m ? 'req ' + res[c] : 'rel ' + res[c - m];
  const events = prog.ops.map(([op, r]) => code(op, r)), START = 2 * m + 1;
  const states = [START, ...events.filter((c, k) => events.indexOf(c) === k && c !== 2 * m)], nexts = events.filter((c, k) => events.indexOf(c) === k);
  const counts = {}; states.forEach(s => { counts[s] = {}; nexts.forEach(e => counts[s][e] = 0); });
  const cell = {};
  const head = h('tr', {}, h('th', { class: 'row' }, 'from \\ to'), ...nexts.map(e => h('th', {}, name(e)))); tbl.appendChild(head);
  states.forEach(s => { const tr = h('tr', {}, h('th', { class: 'row' }, name(s))); nexts.forEach(e => { const td = h('td', {}, '0'); cell[s + ':' + e] = td; tr.appendChild(td); }); tbl.appendChild(tr); });
  $('mkSub').textContent = `${p.processes[0].name} (${p.processes[0].personality_label.toLowerCase()}): one life of ${events.length} events from the replay, streamed into the transition table twice`;
  const stream = $('mkStream'), note = $('mkNote');
  let k = 0, pass = 0, prev = START, on = true, timer = null;
  const chip = (c) => h('span', { class: 'op ' + (c === 2 * m ? 'exit' : c < m ? 'req' : 'rel') }, name(c));
  function step() {
    if (!on) { timer = setTimeout(step, 400); return; }
    const e = events[k];
    const row = counts[prev]; const tot = Object.values(row).reduce((a, b) => a + b, 0);
    let pred = null, pmax = 0; for (const x in row) if (row[x] > pmax) { pmax = row[x]; pred = +x; }
    Object.values(cell).forEach(td => td.className = ''); nexts.forEach(x => { const td = cell[prev + ':' + x]; if (td) td.classList.add('row-on'); });
    if (pred !== null) { const td = cell[prev + ':' + pred]; if (td) td.classList.add('pred'); }
    note.innerHTML = '';
    note.append(h('p', {}, h('strong', {}, 'State: '), name(prev), '. ', tot ? `Seen ${tot} time${tot > 1 ? 's' : ''}; the most likely next event is ` : 'Never seen before: no prediction yet.'), tot ? h('p', {}, h('strong', {}, name(pred)), ` with probability ${fmt(pmax / tot, 2)}. The actual next event is `, h('strong', {}, name(e)), pred === e ? ' (a hit).' : ' (a miss, so the count moves).') : h('span'));
    note.append(h('p', { class: 'muted' }, pass === 0 ? 'First pass: the table is being filled; predictions appear as soon as a state repeats.' : 'Second pass: the pattern is known, every prediction is right, and the chain is at 100% on this process.'));
    counts[prev][e]++; const td = cell[prev + ':' + e]; if (td) { td.textContent = counts[prev][e]; td.classList.add('hot'); }
    stream.appendChild(chip(e)); while (stream.children.length > 16) stream.removeChild(stream.firstChild);
    prev = e === 2 * m ? START : e; k++;
    if (k >= events.length) { k = 0; pass = (pass + 1) % 2; if (pass === 0) { for (const s in counts) for (const x in counts[s]) counts[s][x] = 0; Object.values(cell).forEach(td => td.textContent = '0'); stream.innerHTML = ''; } }
    timer = setTimeout(step, pass === 0 ? 520 : 420);
  }
  onActive($('models'), v => { on = v; }); step();

  // the gate
  const chips = $('gateChips'), chart = $('gateChart');
  const draw = (g) => {
    const x = g.lstm.map((_, k) => k * g.step), bands = []; let start = null;
    g.on.forEach((v, k) => { if (v && start === null) start = x[k]; if (!v && start !== null) { bands.push([start, x[k]]); start = null; } }); if (start !== null) bands.push([start, x[x.length - 1]]);
    Charts.lineChart(chart, { x, xTitle: 'event', series: [{ label: 'network (decayed prequential log-likelihood)', color: color('sage_lstm'), values: g.lstm }, { label: 'Markov tables', color: color('sage'), values: g.ref }], bands, format: v => fmt(v, 1), refX: { value: g.warm, label: 'live run starts' } });
  };
  D.gates.forEach((g, k) => chips.appendChild(h('button', { class: 'chip' + (k === 0 ? ' on' : ''), type: 'button', onclick: (ev) => { chips.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); ev.currentTarget.classList.add('on'); draw(g); } }, `${g.name} · ${g.type}` + (g.final && g.final.engine === 'lstm' ? ' · network in use' : ''))));
  const first = D.gates.find(g => g.on.some(Boolean)) || D.gates[0]; if (first) { chips.querySelectorAll('.chip').forEach((c, k) => c.classList.toggle('on', D.gates[k] === first)); draw(first); }

  // accuracy and engines
  $('accTable').appendChild(Charts.tableEl(['Process type', { label: 'Events', num: true }, { label: 'Markov tables %', num: true }, { label: 'Network alone %', num: true }, { label: 'Gated engine %', num: true }], D.accuracy.map(a => [FAM_LABEL[a.personality] || a.personality, a.events, a.markov, a.lstm, a.gated])));
  $('engineTable').appendChild(Charts.tableEl(['Process', 'Type', 'Engine in use', { label: 'Support', num: true }, { label: 'Top-1 acc. %', num: true }, 'Path now'], p.processes.map(q => [q.name, q.personality_label, badge(q.engine || '–', q.engine === 'lstm' ? 'info' : 'plain'), q.support, q.accuracy, badge(PATH_LABEL[q.path_now] || q.path_now || '–', PATH_CLASS[q.path_now] || 'plain')])));
})();

/* ---------------------------------------------------------------- VII. trust: CUSUM, shift, Banker's, rollback */
(function () {
  const c = D.cusum;
  if (c && c.values.length) {
    const x = c.ticks.slice(0, c.values.length), marks = [];
    if (c.flagged) marks.push({ x: c.flagged, label: 'flagged' }); if (c.recovered) marks.push({ x: c.recovered, label: 'recovered' });
    Charts.lineChart($('cusumChart'), { x, xTitle: 'event', series: [{ label: 'CUSUM of surprise', color: color('sage'), values: c.values }], refY: { value: c.drift_h, label: 'drift_h = ' + c.drift_h }, refX: { value: c.shift_first || c.shift_tick, label: 'shift' }, marks, format: v => fmt(v, 1), yMin: 0, area: true });
    $('cusumSub').textContent = `CUSUM of surprise of process P${c.process + 1} in the shift workload (seed 0), one point per event of that process`;
    $('cusumCap').textContent = `The process changes its pattern at event ${c.shift_first}; the statistic crosses drift_h at event ${c.flagged}, ${c.flagged - c.shift_first} events later, and the learned path resumes at event ${c.recovered} once the new pattern has enough history and the statistic has fallen back below 1. Between the two, every decision of the process goes to the fallback.`;
  }
  const ss = (D.archive.shift_series || []).map(r => ({ bin: +r.bin, acc: r.accuracy_mean, fb: r.fallback_mean })).sort((a, b) => a.bin - b.bin);
  if (ss.length) Charts.lineChart($('shiftChart'), { x: ss.map(r => r.bin), xTitle: 'event', series: [{ label: 'next-event accuracy of the shifted processes (%)', color: color('sage'), values: ss.map(r => r.acc) }, { label: 'their decisions sent to the fallback (%)', color: color('reactive'), values: ss.map(r => r.fb) }], yMin: 0, yMax: 100, format: v => fmt(v, 0), refX: { value: (D.archive.config || {}).shift_tick || 600, label: 'shift' } });

  // Banker's with learned claims: the printer/scanner pair, two cases
  const host = $('bankers'); if (!host) return;
  const R = ['printer', 'scanner'];
  const cases = [
    { title: 'P1 holds nothing; P2 asks for the scanner', alloc: [[0, 0], [0, 1]], claim: [[1, 1], [1, 1]], avail: [1, 0], verdict: 'safe: P2 can finish (it needs only the printer, which is free), then P1. Granted.', ok: true },
    { title: 'P1 holds the printer; P2 asks for the scanner', alloc: [[1, 0], [0, 1]], claim: [[1, 1], [1, 1]], avail: [0, 0], verdict: 'unsafe: nothing is free, and each process may still need the other\'s resource. Queued, and the deadlock in Section I never forms.', ok: false },
    { title: 'P1 was never seen holding two at once', alloc: [[1, 0], [0, 1]], claim: [[1, 0], [1, 1]], avail: [0, 0], verdict: 'safe: P1 is at its learned limit, so it is taken to release before asking for more; P2 can then finish. Granted.', ok: true },
  ];
  const bits = (row, cls) => h('span', { class: 'bits' }, ...row.map(v => h('i', { class: v ? (cls || 'on') : '' })));
  let ci = 0, on = true, timer = null;
  function render() {
    const cs = cases[ci]; host.innerHTML = '';
    host.appendChild(h('p', { style: 'margin:0 0 8px' }, h('strong', {}, 'Case ' + (ci + 1) + ': '), cs.title));
    const t = h('table'); t.appendChild(h('tr', {}, h('th'), h('th', {}, 'holds'), h('th', {}, 'claim'), h('th', {}, 'still needs'), h('th', {}, 'finish')));
    const rows = cs.alloc.map((a, i) => { const need = cs.claim[i].map((c, r) => c && !a[r] ? 1 : 0); const tr = h('tr', {}, h('td', { class: 'name' }, 'P' + (i + 1)), h('td', {}, bits(a)), h('td', {}, bits(cs.claim[i])), h('td', {}, bits(need)), h('td', { class: 'fin-cell' }, '·')); t.appendChild(tr); return { tr, need, a }; });
    host.appendChild(t);
    const work = cs.avail.slice(), workEl = h('div', { class: 'bk-work' }, h('span', { class: 'muted' }, 'free (work):'), bits(work, 'work')); host.appendChild(workEl);
    const out = h('p', { class: 'small', style: 'margin:8px 0 0' }, 'Running the safety sequence…'); host.appendChild(out);
    const fin = rows.map(() => false); let progress = true, steps = 0;
    const tickFn = () => {
      if (!on) { timer = setTimeout(tickFn, 500); return; }
      let moved = false;
      for (let i = 0; i < rows.length && !moved; i++) { if (fin[i]) continue; if (rows[i].need.every((n, r) => !n || work[r])) { fin[i] = true; rows[i].a.forEach((v, r) => { if (v) work[r] = 1; }); rows[i].tr.classList.add('fin'); rows[i].tr.querySelector('.fin-cell').textContent = '✓ ' + (++steps); workEl.replaceChild(bits(work, 'work'), workEl.lastChild); moved = true; } }
      if (moved && fin.some(f => !f)) { timer = setTimeout(tickFn, 900); return; }
      rows.forEach((r, i) => { if (!fin[i]) { r.tr.classList.add('stuck'); r.tr.querySelector('.fin-cell').textContent = '✗'; } });
      out.innerHTML = ''; out.appendChild(badge(cs.ok ? 'safe' : 'unsafe', cs.ok ? 'good' : 'bad')); out.append(' ' + cs.verdict);
      timer = setTimeout(() => { ci = (ci + 1) % cases.length; render(); }, 4200);
    };
    timer = setTimeout(tickFn, 900);
  }
  onActive($('confidence'), v => { on = v; }); render();

  // partial rollback
  const rb = $('rollback'); if (!rb) return;
  const ops = [['req', 'R1'], ['req', 'R2'], ['rel', 'R2'], ['rel', 'R1'], ['req', 'R1'], ['req', 'R3'], ['rel', 'R3'], ['rel', 'R1'], ['exit', '']];
  const strip = h('div', { class: 'chips' }); const chips = ops.map(([o, r]) => { const c = h('span', { class: 'op ' + (o === 'req' ? 'req' : o === 'rel' ? 'rel' : 'exit') }, o === 'exit' ? 'exit' : o + ' ' + r); strip.appendChild(c); return c; });
  const capEl = h('p', { class: 'small muted', style: 'margin:8px 0 0' }); rb.append(strip, capEl);
  const frames = [[0, 'The program runs: request R1.'], [1, 'Request R2.'], [2, 'Release R2.'], [3, 'Release R1: the process holds nothing. This is a checkpoint.'], [4, 'Request R1 again.'], [5, 'Request R3: a cycle closes and this process is the victim.'], [4, 'Rollback: everything is released and the program resumes from the checkpoint. Two steps are undone (wasted); the first cycle of work is kept.'], [5, 'Second attempt: R3 is requested again, this time without a cycle.'], [6, 'Release R3.'], [7, 'Release R1.'], [8, 'Exit: a life completed; the slot respawns with a fresh program.']];
  let fi = 0, rbOn = true, rbTimer = null;
  const frame = () => { if (!rbOn) { rbTimer = setTimeout(frame, 500); return; } const [pc, text] = frames[fi]; chips.forEach((c, k) => { c.classList.toggle('pc', k === pc); c.classList.toggle('done', k < pc); }); capEl.textContent = text; fi = (fi + 1) % frames.length; rbTimer = setTimeout(frame, fi === 0 ? 2600 : fi === 7 ? 3200 : 1300); };
  onActive($('confidence'), v => { rbOn = v; }); frame();
})();

/* ---------------------------------------------------------------- VIII. rivals, IX. workloads */
(function () {
  const rivals = [
    ['bankers', "Avoidance with declared maxima. The benchmark gives it every process's true per-life maximum, its most favourable setting. It never deadlocks and never rolls back; it refuses many requests and needs the declaration."],
    ['bankers_nodecl', 'Avoidance when nothing is declared: every process is assumed to need every resource. Safe, and so conservative that it queues more than a third of all requests.'],
    ['reactive', 'Grant whenever the resource is free; detect cycles in the wait-for graph on every block; abort a victim and roll it back. No queueing, the most deadlocks, and the rollbacks that go with them.'],
    ['timeout', 'No detection at all: a process blocked longer than the timeout is rolled back. Cheap, and the rollback rate shows what guessing costs.'],
    ['wait_die', 'Prevention with timestamps, non-pre-emptive: an older requester waits for a younger holder; a younger requester dies and restarts. No deadlock by construction, many restarts.'],
    ['wound_wait', 'Prevention with timestamps, pre-emptive: an older requester wounds a younger holder, which is rolled back and gives up the resource; a younger requester waits. No deadlock, fewer restarts than wait-die, still far more than SAGE.'],
  ];
  const rc = $('rivalCards'); rivals.forEach(([k, text]) => rc.appendChild(h('div', { class: 'card' }, h('span', { class: 'card-title' }, swatch(k), POLICY_LABEL[k]), h('p', { class: 'small muted', style: 'margin:8px 0 0' }, text))));
  const wl = $('workloadCards');
  const strips = {
    fixed: ['req R2', 'req R5', 'req R3', 'rel R3', 'rel R5', 'rel R2', 'req R2', 'req R5', 'req R3', 'rel R3', 'rel R5', 'rel R2', '…', 'exit'],
    escalating: ['req R1', 'rel R1', 'req R1', 'req R2', 'rel R2', 'rel R1', 'req R1', 'req R2', 'req R3', 'rel R3', 'rel R2', 'rel R1', 'exit'],
    bursty: ['req R7', 'req R4', 'rel R4', 'req R1', 'rel R7', 'rel R1', 'req R6', 'req R2', 'rel R2', 'rel R6', '…', 'exit'],
    shift: ['req A', 'req B', 'req C', 'rel C', 'rel B', 'rel A', '│ shift │', 'req A', 'req D', 'req E', 'rel E', 'rel D', 'rel A'],
  };
  const desc = {
    fixed: ['Fixed pattern', 'Takes the same 2 to 3 resources in the same order, 4 to 8 cycles per life. Perfectly predictable after one life; the chain is at 97% on unseen lives.'],
    escalating: ['Gradually escalating', 'Level 1 takes one resource, level 2 two, and so on up to a random number of levels, then exits. The context tables tell "another level" from "exit".'],
    bursty: ['Bursty / random', 'Random requests in bursts and random releases, holding at most two at a time. Unpredictable by design: the model is "uncertain" and the fallback decides.'],
    shift: ['Behaviour shift', 'Half the processes follow A→B→C and switch at event 600 to A→D→E, which conflicts with the others\' E→D order. Tests drift detection and recovery.'],
  };
  for (const k in desc) { const card = h('div', { class: 'card' }, h('span', { class: 'card-title' }, desc[k][0]), h('p', { class: 'small muted', style: 'margin:6px 0 10px' }, desc[k][1]), h('div', { class: 'chips', 'data-strip': k })); wl.appendChild(card); }
  const strip = (card, k) => { const box = card.querySelector('[data-strip]'); box.innerHTML = ''; strips[k].forEach((o, i) => { const c = h('span', { class: 'op ' + (o.startsWith('req') ? 'req' : o.startsWith('rel') ? 'rel' : 'exit'), style: 'opacity:0' }, o); box.appendChild(c); setTimeout(() => { c.style.transition = 'opacity .3s'; c.style.opacity = 1; }, reduced ? 0 : 140 * i); }); };
  [...wl.children].forEach((card, k) => whenVisible(card, () => strip(card, Object.keys(desc)[k])));
})();

/* ---------------------------------------------------------------- X. results */
(function () {
  const A = D.archive, hs = (fam, pol, key) => { const r = (A.headline || []).find(x => x.family === fam && x.policy === pol); return r ? r[key] : null; };
  const fams = ['fixed', 'bursty', 'escalating', 'mixed'];
  const kp = $('resKpis');
  kp.appendChild(kpi('Deadlocks per 1,000 events, SAGE, mean over the four families', fams.reduce((a, f) => a + (hs(f, 'sage', 'deadlock_rate_mean') || 0), 0) / 4, '', { accent: true, digits: 2, note: 'reactive detection: ' + fmt(fams.reduce((a, f) => a + (hs(f, 'reactive', 'deadlock_rate_mean') || 0), 0) / 4, 1) }));
  kp.appendChild(kpi('Requests queued, SAGE', fams.reduce((a, f) => a + (hs(f, 'sage', 'queue_rate_mean') || 0), 0) / 4, '%', { digits: 1, note: "Banker's with declarations: " + pct(fams.reduce((a, f) => a + (hs(f, 'bankers', 'queue_rate_mean') || 0), 0) / 4) }));
  kp.appendChild(kpi('Throughput, SAGE', fams.reduce((a, f) => a + (hs(f, 'sage', 'throughput_mean') || 0), 0) / 4, 'lives / 1,000 events', { digits: 1, note: "Banker's: " + fmt(fams.reduce((a, f) => a + (hs(f, 'bankers', 'throughput_mean') || 0), 0) / 4, 1) + ' · reactive: ' + fmt(fams.reduce((a, f) => a + (hs(f, 'reactive', 'throughput_mean') || 0), 0) / 4, 1) }));
  kp.appendChild(kpi('Decision latency, SAGE', fams.reduce((a, f) => a + (hs(f, 'sage', 'latency_ms_mean') || 0), 0) / 4, 'ms', { digits: 2, note: 'K = ' + (A.config || D.config).K + ', H = ' + (A.config || D.config).H + ', one CPU core' }));
  const mk = (id, metric, opts) => Charts.groupedBars($(id), Object.assign({ categories: fams, catLabels: fams.map(f => FAM_LABEL[f]), catTitle: 'Workload', series: ['sage', 'bankers', 'reactive'].map(p => ({ label: POLICY_LABEL[p], color: color(p), values: fams.map(f => hs(f, p, metric + '_mean')), sd: fams.map(f => hs(f, p, metric + '_sd')) })) }, opts || {}));
  mk('hlDeadlock', 'deadlock_rate', { format: v => fmt(v, 2) }); mk('hlThroughput', 'throughput', { format: v => fmt(v, 1) }); mk('hlQueue', 'queue_rate', { format: v => fmt(v, 1) }); mk('hlLatency', 'latency_ms', { log: true, format: v => v < 0.01 ? String(+v.toPrecision(2)) : fmt(v, v < 1 ? 3 : 2) });
  // full comparison
  const sel = $('caMetric'); [['throughput', 'Throughput (lives per 1,000 events)'], ['deadlock_rate', 'Deadlocks per 1,000 events'], ['rollback_rate', 'Rollbacks per 1,000 events'], ['wasted_rate', 'Wasted program steps per 1,000 events'], ['queue_rate', 'Requests queued (%)'], ['starved', 'Starved process slots'], ['latency_ms', 'Decision latency (ms)']].forEach(([k, l]) => sel.appendChild(h('option', { value: k }, l)));
  const famsAll = ['fixed', 'bursty', 'escalating', 'mixed', 'shift'];
  const draw = () => {
    if (!A.compare_all) return; const metric = sel.value, pols = POLICY_ORDER.filter(p => A.compare_all.some(r => r.policy === p));
    const get = (f, p) => { const r = A.compare_all.find(x => x.family === f && x.policy === p); return r ? r[metric + '_mean'] : null; };
    Charts.groupedBars($('caChart'), { height: 320, categories: famsAll, catLabels: famsAll.map(f => FAM_LABEL[f]), catTitle: 'Workload', series: pols.map(p => ({ label: POLICY_LABEL[p], color: color(p), values: famsAll.map(f => get(f, p)) })), log: metric === 'latency_ms', format: v => fmt(v, metric === 'latency_ms' ? 3 : 1) });
    $('caSub').textContent = sel.options[sel.selectedIndex].textContent + ' · mean over ' + Math.round((A.compare_all_runs || 0) / 35) + ' seeds per cell';
    const t = $('caTable'); t.innerHTML = ''; t.appendChild(Charts.tableEl(['Policy', ...famsAll.map(f => ({ label: FAM_LABEL[f], num: true }))], pols.map(p => [h('span', {}, swatch(p), POLICY_LABEL[p]), ...famsAll.map(f => get(f, p))])));
  };
  sel.addEventListener('change', draw); draw();
  if (A.compare_all) {
    const by = {}; for (const r of A.compare_all) { const b = by[r.policy] = by[r.policy] || { n: 0 }; for (const m of ['throughput', 'deadlock_rate', 'rollback_rate', 'queue_rate', 'starved', 'latency_ms']) b[m] = (b[m] || 0) + (r[m + '_mean'] || 0); b.n++; }
    const rows = Object.keys(by).map(p => { const b = by[p]; return { p, thr: b.throughput / b.n, dl: b.deadlock_rate / b.n, rb: b.rollback_rate / b.n, q: b.queue_rate / b.n, st: b.starved / b.n, lat: b.latency_ms / b.n }; }).sort((a, b) => b.thr - a.thr);
    $('rankTable').appendChild(Charts.tableEl(['#', 'Policy', { label: 'Throughput', num: true }, { label: 'Deadlocks / 1,000', num: true }, { label: 'Rollbacks / 1,000', num: true }, { label: 'Queued %', num: true }, { label: 'Starved slots', num: true }, { label: 'Latency ms', num: true }], rows.map((r, k) => [k + 1, h('span', {}, swatch(r.p), POLICY_LABEL[r.p]), fmt(r.thr, 1), fmt(r.dl, 2), fmt(r.rb, 2), fmt(r.q, 1), fmt(r.st, 2), fmt(r.lat, 2)])));
  }
  if (A.sweep) { const rows = A.sweep.map(r => ({ tau: +r.tau, dl: r.deadlock_rate_mean, q: r.queue_rate_mean })).sort((a, b) => a.tau - b.tau); Charts.lineChart($('sweepChart'), { x: rows.map(r => r.tau), xEven: true, xTitle: 'τ', xFormat: v => String(v), series: [{ label: 'deadlocks per 1,000 events', color: color('reactive'), values: rows.map(r => r.dl), markers: true }, { label: 'requests queued (%)', color: css('--amber'), values: rows.map(r => r.q), markers: true }], format: v => fmt(v, 1) }); }
  if (A.latency) { const rows = A.latency.filter(r => r.H > 0), Hs = [...new Set(rows.map(r => r.H))].sort((a, b) => a - b), Ks = [...new Set(rows.map(r => r.K))].sort((a, b) => a - b); Charts.lineChart($('latencyChart'), { x: Ks, xTitle: 'K', xLog: true, log: true, xFormat: v => String(v), series: Hs.map((H, k) => ({ label: 'H = ' + H, color: [color('sage'), color('bankers'), color('reactive'), color('sage_lstm')][k % 4], values: Ks.map(K => { const r = rows.find(x => x.H === H && x.K === K); return r ? r.latency_ms : null; }), markers: true })), format: v => fmt(v, 2) }); }
  if (A.compare_sizes) { const sizes = [...new Set(A.compare_sizes.map(r => r.size))], pols = POLICY_ORDER.filter(p => A.compare_sizes.some(r => r.policy === p)); $('sizesTable').appendChild(Charts.tableEl(['Policy', ...sizes.map(s => ({ label: s, num: true }))], pols.map(p => [h('span', {}, swatch(p), POLICY_LABEL[p]), ...sizes.map(s => { const r = A.compare_sizes.find(x => x.size === s && x.policy === p); return r ? fmt(r.deadlock_rate_mean, 2) : '–'; })]))); }
  if (A.leadtime) $('leadTable').appendChild(Charts.tableEl(['Workload', { label: 'Deadlocks', num: true }, { label: 'Flagged %', num: true }, { label: 'Lead mean (events)', num: true }, { label: 'Lead median', num: true }, { label: 'Lead max', num: true }], A.leadtime.map(r => [FAM_LABEL[r.family] || r.family, r.deadlocks, r.flagged_pct, r.lead_mean, r.lead_median, r.lead_max])));
  const lede = $('resultsLede'); if (lede && A.config) lede.textContent = `Every number below comes from the CSV archive written by the experiment scripts: the headline benchmark over ${(A.config.seeds || []).length || 20} seeds per family with n = ${A.config.n}, m = ${A.config.m} and ${A.config.ticks.toLocaleString()} events per run, and the full comparison of seven policies on five families (${(A.compare_all_runs || 0).toLocaleString()} runs).`;
})();

/* ---------------------------------------------------------------- XI. verification */
(function () {
  const box = $('vcases'); const ok = D.verify.cases.filter(c => c.ok).length;
  $('verifyLede').textContent = `${ok} of ${D.verify.cases.length} cases pass on the current code (output recorded when this document was built). The suite checks the pieces against answers that can be derived by hand: ` + $('verifyLede').textContent.split(': ')[1];
  D.verify.cases.forEach((c, k) => { const svg = svgEl('svg', { viewBox: '0 0 52 52' }); svgEl('circle', { cx: 26, cy: 26, r: 23 }, svg); svgEl('path', { d: c.ok ? 'M15 27 l8 8 l15 -16' : 'M17 17 l18 18 M35 17 l-18 18' }, svg); const el = h('div', { class: 'vcase reveal' + (c.ok ? '' : ' fail'), style: '--i:' + (k % 12) }, svg, h('div', {}, c.name, c.detail ? h('div', { class: 'd' }, c.detail) : null)); box.appendChild(el); if (io && !reduced && belowFold(el)) { el.classList.add('pre'); el.__onvisible = () => { el.classList.remove('pre'); el.classList.add('in'); }; io.observe(el); } });
})();

/* ---------------------------------------------------------------- XII. console gallery and architecture */
(function () {
  const shots = [['overview', 'Overview', 'headline numbers and charts from the benchmark archive, every method ranked'], ['simulator', 'Simulator', 'every parameter exposed; KPI tiles, time series, decision paths, risk histogram, process and model table, decision log'], ['replay', 'Replay', 'step through a run: allocation matrix, wait-for graph, the decision with its gauge and simulated futures'], ['compare', 'Compare', 'same workload and seeds for every selected policy, including both SAGE engines; mean ± s.d.'], ['studio', 'Workload studio', 'describe a scenario in words, let the analyst design the processes, validate, run'], ['archive', 'Benchmark archive', 'the CSVs aggregated and charted, the figures'], ['verify', 'Verification', 'the suite, case by case, with drawn check marks'], ['analyst', 'Analyst', 'chat with runs in context; key and model settings'], ['ai_dialog', 'Connect AI', 'the key and model dialog, reachable from every page'], ['method', 'Method', 'the decision rule, the models, baselines and metrics']];
  const g = $('gallery'), tabs = h('div', { class: 'tabs' }), fig = h('figure', { class: 'shot', style: 'margin:0' }), img = h('img', { alt: '' }), cap = h('figcaption');
  fig.append(img, cap); g.append(tabs, fig);
  let cur = 0; const show = (k) => { cur = k; img.src = 'img/' + shots[k][0] + '.jpg'; img.alt = shots[k][1] + ' section of the console'; cap.textContent = shots[k][1] + ': ' + shots[k][2]; tabs.querySelectorAll('button').forEach((b, j) => b.classList.toggle('on', j === k)); img.style.animation = 'none'; void img.offsetWidth; img.style.animation = ''; };
  shots.forEach(([k, t, d], j) => tabs.appendChild(h('button', { type: 'button', onclick: () => { show(j); auto = false; } }, t, h('small', {}, d.split(';')[0].split(',')[0]))));
  let auto = true; show(0); setInterval(() => { if (auto && document.visibilityState === 'visible') show((cur + 1) % shots.length); }, 4500);

  const svg = $('dgArch'); if (!svg) return;
  const lanes = [['Browser', 20], ['FastAPI', 216], ['Job thread', 412], ['Harness + models', 608], ['Groq', 804]];
  lanes.forEach(([t, x]) => { svgEl('rect', { x, y: 40, width: 176, height: 270, rx: 4, class: 'lane-bg' }, svg); svgText(svg, x + 88, 28, t, { 'text-anchor': 'middle', class: 'lane' }); });
  const mid = (k) => lanes[k][1] + 88;
  const msgs = [[0, 1, 70, 'POST /api/jobs/run', ''], [1, 2, 100, 'submit job', ''], [2, 3, 130, 'run(policy, workload, seed, trace=True)', ''], [3, 2, 160, 'progress(tick) every 25 events', 'back'], [2, 1, 160, '', 'back'], [1, 0, 190, 'server-sent events', 'back'], [3, 2, 220, 'run record → payload', 'back'], [1, 0, 250, 'GET result → KPIs, charts, replay', 'back'], [1, 4, 285, 'evidence JSON → streamed report', 'ai']];
  const paths = msgs.map(([a, b, y, label, kind]) => { const x1 = mid(a), x2 = mid(b); const p = svgEl('path', { d: `M${x1},${y}L${x2},${y}`, class: 'msg' }, svg); if (label) svgText(svg, (x1 + x2) / 2, y - 6, label, { 'text-anchor': 'middle', class: 'small' }); return { p, kind, x1, x2, y }; });
  const dot = svgEl('circle', { r: 6, class: 'dot', cx: mid(0), cy: 70 }, svg);
  let k = 0, on = true, raf = null;
  function go() { const mm = paths[k]; dot.setAttribute('class', 'dot' + (mm.kind === 'ai' ? ' ai' : '')); const t0 = performance.now(), dur = reduced ? 1 : 700; const fr = (t) => { if (!on) { raf = requestAnimationFrame(fr); return; } const q = Math.min(1, (t - t0) / dur); dot.setAttribute('cx', mm.x1 + (mm.x2 - mm.x1) * q); dot.setAttribute('cy', mm.y); if (q < 1) raf = requestAnimationFrame(fr); else { k = (k + 1) % paths.length; setTimeout(go, k === 0 ? 1800 : 350); } }; raf = requestAnimationFrame(fr); }
  onActive(svg.parentElement, v => { on = v; }); go();
})();

/* ---------------------------------------------------------------- XIII. the analyst */
(function () {
  const ai = D.ai || {};
  if (!ai.available) { $('aiReport').innerHTML = md('**No analyst report was available when this document was built.** Start the console with a Groq key and run docs/refresh_ai.py to embed one.'); $('aiLede').textContent = 'The analyst was offline when this document was generated; the console shows its reports live once a Groq key is connected.'; return; }
  $('aiReportSub').textContent = `written by ${ai.model} from the evidence of the run replayed in Section IV`;
  $('aiReport').innerHTML = md(ai.report);
  const p = D.twin.sage, d = ai.explained;
  $('aiExplainSub').textContent = d ? `event ${d.t}: ${p.processes[d.i].name} requests ${p.resources[d.r]} → ${d.d === 'wait' ? 'queued' : 'granted'} on the ${PATH_LABEL[d.path] || d.path} path` : '';
  $('aiExplain').innerHTML = md(ai.explain || '');
  const spec = ai.design;
  if (spec) {
    $('aiDesignSub').textContent = `"three writers each lock the printer then the scanner; two readers lock the scanner first and then the printer; one backup job takes the disk and the tape in random order" → validated on attempt ${ai.design_attempts || 1}`;
    const box = $('aiDesign'); box.appendChild(h('p', { class: 'small muted', style: 'margin:6px 0 8px' }, `${spec.title || 'scenario'} · ${spec.m} resources: ${(spec.resources || []).join(', ')}`));
    const list = h('div', { class: 'chips' }); (spec.processes || []).forEach(q => list.appendChild(h('span', { class: 'op ' + (q.type === 'custom' ? 'req' : 'rel') }, q.name + ' · ' + q.type + (q.ops ? ' · ' + q.ops.join(', ') : q.seq ? ' · ' + q.seq.join('→') : '')))); box.appendChild(list);
    if (spec.notes) box.appendChild(h('p', { class: 'small muted', style: 'margin:8px 0 0' }, spec.notes));
  }
})();

/* ---------------------------------------------------------------- XIV. configuration */
(function () {
  const c = D.config, desc = { n: 'process slots', m: 'single-instance resources', ticks: 'events per run', K: 'simulated futures per decision', H: 'steps per future', tau: 'risk threshold', h_min: 'transitions needed before a model is trusted', w: 'window of the prequential log-likelihood', drift_h: 'CUSUM drift threshold', min_ll: 'predictability floor (average log-likelihood)', floor: 'probability floor', shift_tick: 'event of the behaviour shift (shift family)', warmup_lives: 'earlier lives each model has seen', aging: 'ticks a request may wait before others are held back', life_aging: 'ticks without a completed life before the guard acts', fallback: "'claims' (learned-claims safety check) or 'reactive'", recovery: "'partial' or 'restart' rollback", timeout: 'timeout policy: ticks before a blocked process is rolled back', model: "'markov' or 'lstm'", lstm_hidden: 'LSTM hidden units', lstm_train_every: 'events between training steps', lstm_bptt: 'length of the training window' };
  $('cfgTable').appendChild(Charts.tableEl(['Parameter', 'Default', 'Meaning'], Object.keys(c).map(k => [k, String(c[k]), desc[k] || ''])));
})();
