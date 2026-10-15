/* Lenkungsfluss – Substitutionsketten pro Thema als Fluss von links (Ausgangspunkt) nach rechts (Substitute).
 * drawFluss(el, { orte, ampel, kampagnen, datum, thema, ortId, onSelect })
 */
(function () {
  const SC = { 'grün': 'var(--ok)', orange: 'var(--warn)', rot: 'var(--bad)' };
  const fmtNum = new Intl.NumberFormat('de-CH');
  const NW = 172, NH = 62, GAP = 64, ROW = 80, PAD_X = 8, PAD_ARC = 34, PAD = 14;

  // Letzter Stand jeder Kampagne an einem Datum
  function standAm(kampagnen, datum) {
    const by = {};
    for (const r of kampagnen) if (r.datum_ab <= datum && (!by[r.kampagne_id] || by[r.kampagne_id].datum_ab < r.datum_ab)) by[r.kampagne_id] = r;
    return by;
  }

  // Tatsächliche Budgetflüsse an einem Tag, Glied für Glied entlang der Substitutionskette.
  // Ein laufendes Paid übernimmt Budget von gestoppten Orten (budget_von); war der gestoppte Ort
  // selbst Empfänger, reicht er dieses Budget weiter. Ergebnis: Kanten "von>nach" und Durchreicher.
  function budgetFluesse(kampagnen, datum, orte) {
    const by = Object.fromEntries(orte.map((o) => [o.ort_id, o]));
    const stand = standAm(kampagnen, datum);
    const laeuft = (id) => ['aktiv', 'reduziert'].includes((stand[id + '-paid'] || {}).status);
    const gestoppt = (id) => (stand[id + '-paid'] || {}).status === 'gestoppt';
    const out = new Set(), besucht = new Set();
    const quellen = (id) => [...new Set(kampagnen.filter((r) => r.art === 'Paid' && r.ort_id === id && r.budget_von && r.datum_ab <= datum).flatMap((r) => r.budget_von.split(',')).filter(gestoppt))];
    const strecke = (von, nach) => {
      for (let id = von, n = 0; id && id !== nach && n < orte.length; id = (by[id] || {}).substitut, n++) {
        const next = (by[id] || {}).substitut;
        if (!next) return;
        out.add(id + '>' + next);
      }
    };
    const zurueck = (id) => {
      if (besucht.has(id)) return;
      besucht.add(id);
      for (const q of quellen(id)) { strecke(q, id); zurueck(q); }
    };
    for (const o of orte) if (laeuft(o.ort_id)) zurueck(o.ort_id);
    // Durchreicher: Budget fliesst hinein und wieder hinaus
    const kanten = [...out].map((k) => k.split('>'));
    const weiter = new Set(kanten.filter(([von]) => kanten.some(([, nach]) => nach === von)).map(([von]) => von));
    return { out, weiter, stand };
  }

  // Spalten linksbündig: Ausgangspunkte (kein Ort leitet zu ihnen um) links,
  // jeder andere Ort eine Spalte rechts von seinem am weitesten rechts stehenden Vorgänger.
  function layout(orte) {
    const by = Object.fromEntries(orte.map((o) => [o.ort_id, o]));
    const subsOf = (o) => (o.substitut && by[o.substitut] ? [o.substitut] : []);
    const col = {};
    const c = (o) => col[o.ort_id] ?? (col[o.ort_id] = Math.max(0, ...orte.filter((p) => subsOf(p).includes(o.ort_id)).map((p) => 1 + c(p))));
    orte.forEach(c);
    const maxRank = Math.max(0, ...Object.values(col));
    const themen = [...new Set(orte.map((o) => o.thema))].sort();
    return { by, subsOf, maxRank, blocks: themen.map((thema) => {
      const os = orte.filter((o) => o.thema === thema);
      const pos = {};
      let rows = 0;
      for (let c = 0; c <= maxRank; c++) {
        const inCol = os.filter((o) => col[o.ort_id] === c).map((o) => {
          const parents = os.filter((p) => subsOf(p).includes(o.ort_id) && pos[p.ort_id]);
          return { o, want: parents.length ? parents.reduce((s, p) => s + pos[p.ort_id].row, 0) / parents.length : Infinity };
        }).sort((a, b) => a.want - b.want);
        let prev = -1;
        for (const n of inCol) {
          const row = Math.max(prev + 1, n.want === Infinity ? prev + 1 : n.want);
          pos[n.o.ort_id] = { col: c, row };
          prev = row;
          rows = Math.max(rows, row + 1);
        }
      }
      return { thema, orte: os, pos, rows: Math.ceil(rows) };
    }) };
  }

  // Orte zwischen Start und Ziel, die eine direkte Linie berühren würde (mit 10 px Rand)
  function imWeg(b, s, t) {
    const lo = Math.min(s.row, t.row) * ROW + NH / 2, hi = Math.max(s.row, t.row) * ROW + NH / 2;
    return b.orte.map((o) => b.pos[o.ort_id]).filter((n) => n.col > s.col && n.col < t.col && n.row * ROW - 10 < hi && n.row * ROW + NH + 10 > lo);
  }

  function drawFluss(el, { orte, ampel, kampagnen, datum, thema, ortId, stuecke, onSelect }) {
    el.replaceChildren();
    const L = layout(orte);
    const amp = Object.fromEntries(ampel.filter((a) => a.datum === datum).map((a) => [a.ort_id, a]));
    let { out: fluss, weiter, stand } = budgetFluesse(kampagnen, datum, orte);
    // Mit Budgetstücken aus den Regeln (js/regeln.js): Weg jedes Stücks vom Ausgangsort bis zum Halter
    if (stuecke) {
      fluss = new Set();
      for (const k of stuecke) {
        if (!k.bei) continue;
        for (let id = k.von, n = 0; id && id !== k.bei && n < orte.length; id = (L.by[id] || {}).substitut, n++) {
          const next = (L.by[id] || {}).substitut;
          if (!next) break;
          fluss.add(id + '>' + next);
        }
      }
      const kanten = [...fluss].map((x) => x.split('>'));
      weiter = new Set(kanten.filter(([von]) => kanten.some(([, nach]) => nach === von)).map(([von]) => von));
    }
    const W = PAD_X * 2 + (L.maxRank + 1) * NW + L.maxRank * GAP;
    const blocks = L.blocks.filter((b) => thema === 'alle' || b.thema === thema);

    for (const b of blocks) {
      // Platz für Umgehungen oben (aus der ersten Reihe) bzw. unten (aus den übrigen Reihen)
      const umweg = b.orte.flatMap((o) => [o.substitut].filter((id) => b.pos[id] && imWeg(b, b.pos[o.ort_id], b.pos[id]).length).map(() => b.pos[o.ort_id].row));
      const PAD_TOP = umweg.some((r) => r === 0) ? PAD_ARC : PAD;
      const H = PAD_TOP + (b.rows - 1) * ROW + NH + (umweg.some((r) => r > 0) ? PAD_ARC : PAD);
      const wrap = document.createElement('div');
      wrap.className = 'fluss-block';
      const h = document.createElement('h3');
      h.textContent = b.thema;
      wrap.append(h);
      const scroll = document.createElement('div');
      scroll.className = 'fluss-scroll';
      wrap.append(scroll);
      el.append(wrap);

      const svg = d3.select(scroll).append('svg').attr('width', W).attr('height', H).attr('viewBox', `0 0 ${W} ${H}`)
        .attr('role', 'img').attr('aria-label', `Lenkungsfluss ${b.thema}`);
      const mk = 'pfeil-' + b.thema.replace(/\W/g, '');
      svg.append('defs').append('marker').attr('id', mk).attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5)
        .attr('markerWidth', 7).attr('markerHeight', 7).attr('orient', 'auto-start-reverse')
        .append('path').attr('d', 'M0,0L10,5L0,10z').style('fill', 'var(--flow)');
      const X = (p) => PAD_X + p.col * (NW + GAP);
      const Y = (p) => PAD_TOP + p.row * ROW;

      // Kanten: Substitutionskette dünn, Budgetfluss kräftig mit Pfeil. Ist ein Ort gewählt,
      // bleibt seine Kette bis zum Schluss deutlich, der Rest tritt zurück.
      const kette = new Set();
      for (let id = b.pos[ortId] ? ortId : null; id && !kette.has(id); id = (L.by[id] || {}).substitut) kette.add(id);
      const edges = [];
      for (const o of b.orte) if (o.substitut && b.pos[o.substitut]) edges.push({ from: o.ort_id, to: o.substitut, flow: fluss.has(o.ort_id + '>' + o.substitut) });
      edges.sort((a, c) => a.flow - c.flow);
      for (const e of edges) {
        const s = b.pos[e.from], t = b.pos[e.to];
        const x1 = X(s) + NW, y1 = Y(s) + NH / 2, x2 = X(t) - (e.flow ? 2 : 0), y2 = Y(t) + NH / 2;
        let d;
        const weg = imWeg(b, s, t);
        if (weg.length) {
          // Ort im Weg: in der Lücke ab- bzw. aufsteigen und mit Abstand an den Blöcken vorbei
          const oben = s.row === 0;
          const yb = oben ? Math.min(...weg.map((n) => Y(n))) - 16 : Math.max(...weg.map((n) => Y(n) + NH)) + 16;
          d = `M${x1},${y1} C${x1 + 28},${y1} ${x1 + 12},${yb} ${x1 + 40},${yb} L${x2 - 40},${yb} C${x2 - 12},${yb} ${x2 - 28},${y2} ${x2},${y2}`;
        } else {
          const mx = (x1 + x2) / 2;
          d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
        }
        const dim = kette.size > 0 && !kette.has(e.from);
        const p = svg.append('path').attr('d', d).style('fill', 'none')
          .style('stroke', e.flow ? 'var(--flow)' : 'var(--chart-muted)').attr('stroke-width', e.flow ? 3 : 1.25)
          .style('opacity', dim ? 0.3 : 1);
        if (e.flow) p.attr('marker-end', `url(#${mk})`);
      }

      // Knoten
      for (const o of b.orte) {
        const p = b.pos[o.ort_id], a = amp[o.ort_id], paid = stand[o.ort_id + '-paid'];
        const isSel = o.ort_id === ortId;
        const g = svg.append('g').attr('transform', `translate(${X(p)},${Y(p)})`).style('cursor', 'pointer')
          .attr('tabindex', 0).attr('role', 'button')
          .attr('aria-label', `${o.name}: ${a ? a.status + ', ' + a.auslastung_pct + ' %' : 'keine Daten'}`);
        g.append('rect').attr('width', NW).attr('height', NH).attr('rx', 2)
          .style('fill', 'var(--panel)').style('stroke', isSel ? 'var(--sel)' : 'var(--line)').attr('stroke-width', isSel ? 2.5 : 1);
        g.append('rect').attr('x', 0).attr('y', 0).attr('width', 6).attr('height', NH).attr('rx', 1)
          .style('fill', a ? SC[a.status] : 'var(--chart-muted)');
        g.append('text').attr('x', 16).attr('y', 21).attr('font-size', 13).style('font-weight', 700).style('fill', 'var(--ink)').text(o.name);
        const zeile = (a ? `${a.auslastung_pct} % ${a.status}` : 'keine Daten') + ' · ' +
          (!paid ? 'kein Paid' : paid.status === 'gestoppt' ? 'Paid gestoppt' : `Paid ${fmtNum.format(paid.budget_chf_woche)}/Wo.`);
        g.append('text').attr('x', 16).attr('y', 39).attr('font-size', 12).style('fill', 'var(--muted)').text(zeile);
        if (weiter.has(o.ort_id)) g.append('text').attr('x', 16).attr('y', 54).attr('font-size', 12).style('font-weight', 700).style('fill', 'var(--flow)').text('gibt Budget weiter →');
        g.on('click', () => onSelect && onSelect(o.ort_id))
          .on('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect && onSelect(o.ort_id); } });
      }
    }
  }

  window.drawFluss = drawFluss;
  window.budgetFluesse = budgetFluesse;
})();
