/* Besucherlenkung Graubünden – Dashboard
 * Lädt vier JSON-Quellen, berechnet die Ampel und zeichnet Karte, Detail, Fieberkurve und Tabellen.
 * Für den Echtbetrieb nur die URLs in DATA auf die eigene API zeigen lassen (Format siehe README.md).
 */
const DATA = {
  orte: 'data/orte.json',
  auslastung: 'data/auslastung.json',
  kampagnen: 'data/kampagnen.json',
  umriss: 'data/kantonsumriss.json',
  wetter: 'data/wetter.json',
  land: 'data/landesgrenze.json',
};

const fmtDay = new Intl.DateTimeFormat('de-CH', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' });
const fmtShort = new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtNum = new Intl.NumberFormat('de-CH');
const D = (s) => new Date(s + 'T00:00:00Z');
const SC = { 'grün': 'var(--ok)', orange: 'var(--warn)', rot: 'var(--bad)' };
const KC = { aktiv: 'var(--ok)', reduziert: 'var(--warn)', gestoppt: 'var(--bad)', pausiert: 'var(--bad)', beendet: 'var(--chart-muted)' };
const simBadge = () => Object.assign(document.createElement('span'), { className: 'badge sim', textContent: 'Simulation' });
const $ = (id) => document.getElementById(id);

let DB = null;
const state = { datum: null, thema: 'alle', ort: null, vergleich: null };

/* ---------- Logik ---------- */

// Ampel und Steuerungsregeln kommen aus js/regeln.js (eine Quelle der Wahrheit für Dashboard und Server)
const berechneAmpel = Regeln.berechneAmpel;

// Letzter Stand jeder Kampagne an einem Datum
function standAm(kampagnen, datum) {
  const by = {};
  for (const r of kampagnen) if (r.datum_ab <= datum && (!by[r.kampagne_id] || by[r.kampagne_id].datum_ab < r.datum_ab)) by[r.kampagne_id] = r;
  return by;
}

// Substitutionskette eines Ortes bis zum Schluss (Schutz gegen versehentliche Kreise)
function kette(ort, byOrt) {
  const out = [];
  for (let id = ort.substitut; id && byOrt[id] && id !== ort.ort_id && !out.some((o) => o.ort_id === id); id = byOrt[id].substitut) out.push(byOrt[id]);
  return out;
}

/* ---------- Zustand in der URL (teilbare Links) ---------- */

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const k of ['datum', 'thema', 'ort']) if (h.get(k)) state[k] = h.get(k);
}
// Ort- und Themenwechsel landen im Verlauf (Zurück-Knopf), das Ziehen am Zeitregler nicht
function set(patch) {
  const schritt = (patch.ort && patch.ort !== state.ort) || (patch.thema && patch.thema !== state.thema);
  if (patch.ort && patch.ort !== state.ort) state.vergleich = null;
  Object.assign(state, patch);
  const url = '#' + new URLSearchParams({ datum: state.datum, thema: state.thema, ort: state.ort });
  if (schritt) history.pushState(null, '', url); else history.replaceState(null, '', url);
  render();
}
// Zurück/Vorwärts und von Hand geänderte Adressen (#datum=…) übernehmen, ohne neu zu laden
function folgeAdresse() {
  const vorher = state.ort;
  readHash();
  if (state.ort !== vorher) state.vergleich = null;
  render();
}
window.addEventListener('popstate', folgeAdresse);
window.addEventListener('hashchange', folgeAdresse);

/* ---------- Hilfen ---------- */

function pill(text, color) {
  const s = document.createElement('span');
  s.className = 'pill';
  const i = document.createElement('i');
  i.className = 'dot';
  i.style.background = color;
  s.append(i, document.createTextNode(text));
  return s;
}
// Status einer Kampagne; „pausiert“ als roter Ring, damit es nicht wie grau (keine Daten) aussieht
function statusPill(status) {
  const s = pill(status, KC[status]);
  if (status === 'pausiert') { const i = s.firstChild; i.style.background = 'transparent'; i.style.boxShadow = 'inset 0 0 0 2px var(--bad)'; }
  return s;
}
function tipShow(tip, box, ev, head, lines) {
  const h = document.createElement('div');
  h.className = 'tip-h';
  h.textContent = head;
  tip.replaceChildren(h, ...lines.map((l) => { const d = document.createElement('div'); typeof l === 'string' ? (d.textContent = l) : d.append(l); return d; }));
  tip.hidden = false;
  const b = box.getBoundingClientRect();
  const x = ev.clientX - b.left, y = ev.clientY - b.top;
  tip.style.left = Math.max(4, Math.min(box.clientWidth - tip.offsetWidth - 4, x + 12)) + 'px';
  tip.style.top = (y + 12) + 'px';
}
// Wettersymbol als kleines SVG (Strichzeichnung in der aktuellen Textfarbe)
const WX = {
  sonnig: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  wechselhaft: '<circle cx="9" cy="8.5" r="3.2"/><path d="M9 2.3v1.6M3 8.5h1.6M4.8 4.3l1.1 1.1M13.2 4.3l-1.1 1.1"/><path d="M7.5 20h9.5a3.6 3.6 0 0 0 .2-7.2 5 5 0 0 0-9.3 1.4 2.9 2.9 0 0 0-.4 5.8z" style="fill:var(--wx-fill, var(--panel))"/>',
  regnerisch: '<path d="M7 15h10a3.6 3.6 0 0 0 .2-7.2 5 5 0 0 0-9.3 1.4A2.9 2.9 0 0 0 7 15z"/><path d="M9 17.5l-1 3M13 17.5l-1 3M17 17.5l-1 3"/>',
};
function wxIcon(wetter, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.7');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = WX[wetter] || WX.wechselhaft;
  return s;
}
const fmtDez = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 1 });
function wxText(w) {
  return `${w.wetter}, ${w.tmax} °C, ${fmtDez.format(w.sonnenstunden)} h Sonne` + (w.niederschlag_mm ? `, ${fmtDez.format(w.niederschlag_mm)} mm Regen` : '');
}

function td(content, cls) {
  const c = document.createElement('td');
  if (cls) c.className = cls;
  content instanceof Node ? c.append(content) : (c.textContent = content);
  return c;
}

/* ---------- Karte ---------- */

function drawMap(el, umriss, land, orte, amp, datum, thema, ortId) {
  el.replaceChildren();
  const W = el.clientWidth;
  if (!W) return;
  const kx = Math.cos(46.65 * Math.PI / 180);
  const P = (lon, lat) => [lon * kx, -lat];
  const ring = (rows) => rows.slice().sort((a, b) => a.punkt - b.punkt).map((r) => P(Number(r.lon), Number(r.lat)));
  const pts = ring(umriss);
  // Ausschnitt: Kanton mit etwas Rand, damit die Nachbarländer sichtbar sind
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minx = Math.min(...xs) - 0.05, maxx = Math.max(...xs) + 0.05, miny = Math.min(...ys) - 0.05, maxy = Math.max(...ys) + 0.05;
  const s = W / (maxx - minx);
  const H = Math.round((maxy - miny) * s);
  const T = ([x, y]) => [(x - minx) * s, (y - miny) * s];
  const path = (ps) => 'M' + ps.map((p) => T(p).map((v) => v.toFixed(1)).join(',')).join('L') + 'Z';
  const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Karte Graubünden mit Ampel pro Attraktion');
  el.style.minHeight = H + 'px';
  // Ausland weiss, Schweiz granit hell, Graubünden mit granatroter Grenze (Styleguide 3.2 Kartenintegration)
  svg.append('rect').attr('width', W).attr('height', H).style('fill', 'var(--map-out)');
  if (land.length) svg.append('path').attr('d', path(ring(land))).style('fill', 'var(--map-ch)').style('stroke', 'var(--chart-muted)').attr('stroke-width', 0.75);
  svg.append('path').attr('d', path(pts)).style('fill', 'var(--map-gr)').style('stroke', 'var(--head)').attr('stroke-width', 2).attr('stroke-linejoin', 'round');
  for (const [name, lon, lat] of [['SCHWEIZ', 8.83, 46.93], ['ITALIEN', 9.62, 46.21], ['ÖSTERREICH', 10.2, 47.06]]) {
    const [x, y] = T(P(lon, lat));
    if (x > 30 && x < W - 30 && y > 8 && y < H - 4) svg.append('text').attr('x', x).attr('y', y).attr('text-anchor', 'middle').attr('font-size', 10)
      .style('letter-spacing', '0.12em').style('fill', 'var(--map-label)').text(name);
  }
  const tip = $('maptip'), box = el.parentElement;
  const nodes = orte.map((o) => {
    const [x, y] = T(P(Number(o.lon), Number(o.lat)));
    return { o, x, y, a: amp[o.ort_id + '_' + datum], on: thema === 'alle' || o.thema === thema };
  }).sort((a, b) => (a.o.ort_id === ortId) - (b.o.ort_id === ortId));
  const placed = nodes.map((n) => ({ x: n.x - 9, y: n.y - 9, width: 18, height: 18 }));
  const groups = new Map();
  for (const n of nodes) {
    const isSel = n.o.ort_id === ortId;
    const g = svg.append('g').style('cursor', 'pointer').style('opacity', n.on ? 1 : 0.25)
      .attr('tabindex', 0).attr('role', 'button').attr('aria-label', `${n.o.name}: ${n.a ? n.a.status + ', ' + n.a.auslastung_pct + ' %' : 'keine Daten'}`);
    if (isSel) g.append('circle').attr('cx', n.x).attr('cy', n.y).attr('r', 13).style('fill', 'none').style('stroke', 'var(--sel)').attr('stroke-width', 2.5);
    g.append('circle').attr('cx', n.x).attr('cy', n.y).attr('r', 7.5).style('fill', n.a ? SC[n.a.status] : 'var(--chart-muted)').style('stroke', '#fff').attr('stroke-width', 2);
    g.on('click', () => set({ ort: n.o.ort_id }))
      .on('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); set({ ort: n.o.ort_id }); } })
      .on('mousemove', (ev) => tipShow(tip, box, ev, n.o.name, [n.a ? pill(`${n.a.status}, ${n.a.auslastung_pct} %`, SC[n.a.status]) : 'keine Daten', `${n.o.region}, ${n.o.thema}`]))
      .on('mouseleave', () => { tip.hidden = true; });
    groups.set(n, g);
  }
  // Namen erst nach allen Punkten setzen, gewählter Ort zuerst. Kein Name fällt weg:
  // ohne freien Platz gewinnt die Lage mit der kleinsten Überlappung, weit weg mit Hinweislinie.
  const cands = [];
  for (const d of [12, 24]) cands.push([d, 4, 'start'], [-d, 4, 'end'], [0, -d - 2, 'middle'], [0, d + 10, 'middle'], [d - 3, -d + 3, 'start'], [-d + 3, -d + 3, 'end'], [d - 3, d + 7, 'start'], [-d + 3, d + 7, 'end']);
  const overlap = (b) => placed.reduce((sum, p) => sum + Math.max(0, Math.min(b.x + b.width, p.x + p.width) - Math.max(b.x, p.x)) * Math.max(0, Math.min(b.y + b.height, p.y + p.height) - Math.max(b.y, p.y)), 0);
  const order = nodes.filter((n) => n.on || n.o.ort_id === ortId).sort((a, b) => (b.o.ort_id === ortId) - (a.o.ort_id === ortId));
  for (const n of order) {
    const isSel = n.o.ort_id === ortId;
    const g = groups.get(n);
    const t = g.append('text').text(n.o.name).attr('font-size', 12).style('fill', isSel ? 'var(--head)' : 'var(--ink)').style('font-weight', isSel ? 700 : 400)
      .attr('paint-order', 'stroke').style('stroke', 'var(--map-gr)').attr('stroke-width', 3);
    let best = null;
    for (const [dx, dy, anc] of cands) {
      t.attr('x', n.x + dx).attr('y', n.y + dy).attr('text-anchor', anc);
      const bb = t.node().getBBox();
      const b = { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
      if (b.x < 0 || b.x + b.width > W || b.y < 0 || b.y + b.height > H) continue;
      const o = overlap(b);
      if (!best || o < best.o) best = { o, dx, dy, anc, b };
      if (!o) break;
    }
    if (!best) continue;
    t.attr('x', n.x + best.dx).attr('y', n.y + best.dy).attr('text-anchor', best.anc);
    placed.push(best.b);
    if (Math.abs(best.dx) > 12 || Math.abs(best.dy) > 18) {
      const cx = Math.max(best.b.x, Math.min(n.x, best.b.x + best.b.width)), cy = Math.max(best.b.y, Math.min(n.y, best.b.y + best.b.height));
      const len = Math.hypot(cx - n.x, cy - n.y) || 1;
      g.insert('line', 'text').attr('x1', n.x + (cx - n.x) * 10 / len).attr('y1', n.y + (cy - n.y) * 10 / len).attr('x2', cx).attr('y2', cy).style('stroke', 'var(--muted)').attr('stroke-width', 0.75);
    }
  }
}

/* ---------- Fieberkurve ---------- */

function drawCurve(el, rows, subs, ort, hiId, events, datum, dates, wx) {
  el.replaceChildren();
  const W = el.clientWidth;
  if (!W) return;
  const H = 320;
  const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', `Fieberkurve ${ort.name}`);
  const meas = (txt) => { const t = svg.append('text').attr('font-size', 12).text(txt); const w = t.node().getComputedTextLength(); t.remove(); return w; };
  const hi = subs.find((s) => s.o.ort_id === hiId) || null;
  const endW = Math.max(meas(ort.name + ' 100 %'), hi ? meas(hi.o.name + ' 100 %') : 0);
  const m = { top: 30, right: Math.min(endW + 10, W * 0.35), bottom: 46, left: meas('100 %') + 8 };
  const x = d3.scalePoint(dates, [m.left, W - m.right]).padding(0.4);
  const y = d3.scaleLinear([0, 100], [H - m.bottom, m.top]);
  const so = Number(ort.schwelle_orange), sr = Number(ort.schwelle_rot);
  const band = (a, b, c, op) => svg.append('rect').attr('x', m.left).attr('width', W - m.left - m.right).attr('y', y(b)).attr('height', y(a) - y(b)).style('fill', c).style('opacity', op);
  band(0, so, 'var(--ok)', 0.08); band(so, sr, 'var(--warn)', 0.12); band(sr, 100, 'var(--bad)', 0.12);
  for (const v of [0, 25, 50, 75, 100]) {
    svg.append('line').attr('x1', m.left).attr('x2', W - m.right).attr('y1', y(v)).attr('y2', y(v)).style('stroke', 'var(--grid)');
    svg.append('text').attr('x', m.left - 6).attr('y', y(v) + 4).attr('text-anchor', 'end').attr('font-size', 12).style('fill', 'var(--muted)').text(v + ' %');
  }
  for (const [v, lab] of [[so, `orange ab ${so} %`], [sr, `rot ab ${sr} %`]]) {
    svg.append('line').attr('x1', m.left).attr('x2', W - m.right).attr('y1', y(v)).attr('y2', y(v)).style('stroke', 'var(--muted)').attr('stroke-dasharray', '4 3');
    svg.append('text').attr('x', m.left + 4).attr('y', y(v) - 4).attr('font-size', 11).style('fill', 'var(--muted)').text(lab);
  }
  const step = x.step();
  const every = Math.max(1, Math.ceil(56 / step));
  dates.forEach((d, i) => {
    if (i % every) return;
    svg.append('text').attr('x', x(d)).attr('y', H - 8).attr('text-anchor', 'middle').attr('font-size', 12).style('fill', 'var(--muted)').text(fmtShort.format(D(d)));
  });
  // Wetter pro Spitzentag unter der Kurve, Prognosen blasser
  const wsz = Math.max(10, Math.min(16, step - 2));
  for (const d of dates) {
    const w = wx[d];
    if (!w) continue;
    svg.append(() => wxIcon(w.wetter, wsz)).attr('x', x(d) - wsz / 2).attr('y', H - m.bottom + 7)
      .style('color', 'var(--muted)').style('opacity', w.prognose ? 0.55 : 1);
  }
  const firstProg = dates.findIndex((d) => (rows.find((r) => r.datum === d) || {}).prognose);
  if (firstProg > 0) {
    const xm = (x(dates[firstProg - 1]) + x(dates[firstProg])) / 2;
    svg.append('line').attr('x1', xm).attr('x2', xm).attr('y1', m.top).attr('y2', H - m.bottom).style('stroke', 'var(--muted)').attr('stroke-dasharray', '2 3');
    svg.append('text').attr('x', xm + 4).attr('y', y(100) + 12).attr('font-size', 11).style('fill', 'var(--muted)').text('Prognose');
  }
  svg.append('line').attr('x1', x(datum)).attr('x2', x(datum)).attr('y1', m.top).attr('y2', H - m.bottom).style('stroke', 'var(--sel)').style('opacity', 0.6).attr('stroke-width', 1.5);
  const line = d3.line().x((r) => x(r.datum)).y((r) => y(r.auslastung_pct));
  const series = (rs, color, width, opacity = 1) => {
    const g = svg.append('g').style('opacity', opacity);
    const ist = rs.filter((r) => !r.prognose), prog = rs.filter((r) => r.prognose);
    g.append('path').attr('d', line(ist)).style('fill', 'none').style('stroke', color).attr('stroke-width', width).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
    if (prog.length && ist.length) g.append('path').attr('d', line([ist[ist.length - 1], ...prog])).style('fill', 'none').style('stroke', color).attr('stroke-width', width).attr('stroke-dasharray', '5 4');
    return g;
  };
  const labels = [];
  // Substitute: alle dünn und blass, das gewählte kräftig und beschriftet
  for (const s of [...subs].sort((a, b) => (a === hi) - (b === hi))) {
    if (!s.rows.length) continue;
    series(s.rows, s === hi ? 'var(--flow)' : 'var(--chart-muted)', s === hi ? 2 : 1.25, s === hi ? 1 : 0.7);
    if (s !== hi) continue;
    const l = s.rows[s.rows.length - 1];
    labels.push({ y: y(l.auslastung_pct), t: `${s.o.name} ${l.auslastung_pct} %`, c: 'var(--flow)' });
  }
  series(rows, 'var(--ink)', 2);
  for (const r of rows) svg.append('circle').attr('cx', x(r.datum)).attr('cy', y(r.auslastung_pct)).attr('r', r.datum === datum ? 6 : 3.5).style('fill', SC[r.status]).style('stroke', 'var(--panel)').attr('stroke-width', 1.5);
  if (rows.length) { const l = rows[rows.length - 1]; labels.push({ y: y(l.auslastung_pct), t: `${ort.name} ${l.auslastung_pct} %`, c: 'var(--ink)' }); }
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
  for (const l of labels) svg.append('text').attr('x', W - m.right + 6).attr('y', l.y + 4).attr('font-size', 12).style('fill', l.c).text(l.t);
  const byDay = d3.group(events.filter((e) => x(e.datum_ab) !== undefined), (e) => e.datum_ab);
  for (const [d, evs] of byDay) evs.forEach((e, i) => {
    const cx = x(d) + (i - (evs.length - 1) / 2) * 11;
    const paid = e.art === 'Paid';
    svg.append('path').attr('d', d3.symbol(paid ? d3.symbolTriangle : d3.symbolCircle, paid ? 60 : 40)())
      .attr('transform', `translate(${cx},${m.top - 14}) rotate(${paid ? 180 : 0})`)
      .style('fill', e.status === 'pausiert' ? 'none' : KC[e.status] || 'var(--muted)').style('stroke', e.status === 'pausiert' ? 'var(--bad)' : 'none').attr('stroke-width', 2);
  });
  const tip = $('curvetip'), box = el.parentElement;
  const byRow = Object.fromEntries(rows.map((r) => [r.datum, r]));
  const bySub = subs.map((s) => ({ o: s.o, by: Object.fromEntries(s.rows.map((r) => [r.datum, r])) }));
  svg.append('g').selectAll('rect').data(dates).join('rect')
    .attr('x', (d) => x(d) - step / 2).attr('width', step).attr('y', 0).attr('height', H - m.bottom).style('fill', 'transparent').style('cursor', 'pointer')
    .on('mousemove', (ev, d) => {
      const r = byRow[d];
      if (!r) return;
      const lines = [pill(`${ort.name}: ${r.auslastung_pct} %, ${r.status}`, SC[r.status])];
      for (const s of bySub) if (s.by[d]) lines.push(pill(`${s.o.name}: ${s.by[d].auslastung_pct} %, ${s.by[d].status}`, SC[s.by[d].status]));
      if (wx[d]) lines.push('Wetter: ' + wxText(wx[d]));
      for (const e of byDay.get(d) || []) lines.push(`${e.art} ${e.status}: ${e.hinweis}`);
      tipShow(tip, box, ev, fmtDay.format(D(d)) + (r.prognose ? ' (Prognose)' : ''), lines);
    })
    .on('mouseleave', () => { tip.hidden = true; })
    .on('click', (ev, d) => {
      // Klick nahe an einer Substitut-Linie hebt diese hervor, sonst wird der Tag gewählt
      const my = d3.pointer(ev, svg.node())[1];
      const near = bySub.filter((s) => s.by[d]).map((s) => ({ s, dist: Math.abs(y(s.by[d].auslastung_pct) - my) })).sort((a, b) => a.dist - b.dist)[0];
      if (near && near.dist < 10 && (!byRow[d] || Math.abs(y(byRow[d].auslastung_pct) - my) > near.dist)) { state.vergleich = near.s.o.ort_id; render(); }
      else set({ datum: d });
    });
}

/* ---------- Seite ---------- */

function render() {
  if (!DB) return;
  const { orte, auslastung, kampagnen, umriss, land, wetter, ampel, dates, stand } = DB;
  const byOrt = Object.fromEntries(orte.map((r) => [r.ort_id, r]));
  const amp = Object.fromEntries(ampel.map((r) => [r.key, r]));
  const themen = ['alle', ...[...new Set(orte.map((r) => r.thema))].sort()];
  if (!dates.includes(state.datum)) state.datum = stand;
  if (!themen.includes(state.thema)) state.thema = 'alle';
  if (!byOrt[state.ort]) state.ort = orte[0].ort_id;
  const { datum, thema, ort: ortId } = state;
  const inThema = (o) => thema === 'alle' || o.thema === thema;

  // Themen
  $('themes').replaceChildren(...themen.map((t) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = t === 'alle' ? 'Alle Themen' : t;
    b.setAttribute('aria-pressed', String(t === thema));
    b.addEventListener('click', () => {
      const cur = byOrt[state.ort];
      const next = t === 'alle' || cur.thema === t ? state.ort : orte.find((r) => r.thema === t).ort_id;
      set({ thema: t, ort: next });
    });
    return b;
  }));

  // Zeitregler
  const slider = $('slider');
  slider.max = String(dates.length - 1);
  slider.value = String(dates.indexOf(datum));
  const progDay = ampel.some((r) => r.datum === datum && r.prognose);
  $('day').textContent = fmtDay.format(D(datum));
  if (progDay) { const s = document.createElement('span'); s.className = 'badge'; s.textContent = 'Prognose'; $('day').append(s); }
  $('stand').textContent = 'Stand: ' + fmtDay.format(D(stand));
  // Wetter des gewählten Ortes über jedem Spitzentag des Reglers
  $('wxrow').replaceChildren(...dates.map((d, i) => {
    const w = wetter[ortId + '_' + d];
    const sp = document.createElement('span');
    sp.style.left = `calc(8px + (100% - 16px) * ${dates.length > 1 ? i / (dates.length - 1) : 0})`;
    if (w) { sp.append(wxIcon(w.wetter, 14)); sp.title = `${fmtDay.format(D(d))}: ${wxText(w)}${w.prognose ? ' (Prognose)' : ''}`; }
    if (w && w.prognose) sp.className = 'prog';
    if (d === datum) sp.classList.add('cur');
    return sp;
  }));
  $('wxlabel').textContent = 'Wetter ' + byOrt[ortId].name;

  // Kernaussage
  const heute = ampel.filter((r) => r.datum === datum && inThema(byOrt[r.ort_id]));
  const n = (s) => heute.filter((r) => r.status === s).length;
  const take = $('take');
  take.replaceChildren();
  const b = (v) => { const e = document.createElement('b'); e.textContent = v; return e; };
  take.append(`Am ${fmtDay.format(D(datum))}${thema === 'alle' ? '' : ' (Thema ' + thema + ')'}: `, b(n('rot')), ' rot, ', b(n('orange')), ' orange, ', b(n('grün')), ' grün. Ziel ist orange: ausgelastet, aber nicht überlastet.');

  // Budget-Übersicht aus den Regeln: was läuft, was ist umgeleitet, was ruht, wie viele Orte im Ziel
  const tag = DB.regeln.tage[datum];
  const imThema = (id) => byOrt[id] && inThema(byOrt[id]);
  const einsatz = Object.entries(tag.orte).filter(([id]) => imThema(id)).reduce((sum, [, o]) => sum + o.paid, 0);
  const umgeleitet = tag.stuecke.filter((k) => k.bei && imThema(k.bei)).reduce((sum, k) => sum + k.betrag, 0);
  const ruht = tag.stuecke.filter((k) => imThema(k.von)).reduce((sum, k) => sum + Math.round(k.basis * k.faktor) - k.betrag, 0);
  const sim = datum > stand;
  const kachel = (titel, wert, zusatz) => {
    const d = document.createElement('div');
    d.className = 'kpi';
    const t = document.createElement('div'); t.className = 'kpi-t'; t.textContent = titel;
    const w = document.createElement('div'); w.className = 'kpi-w'; w.textContent = wert;
    const z = document.createElement('div'); z.className = 'kpi-z'; z.textContent = zusatz;
    d.append(t, w, z);
    return d;
  };
  $('kpis').replaceChildren(
    kachel('Paid im Einsatz', 'CHF ' + fmtNum.format(einsatz), 'pro Woche' + (sim ? ', Simulation' : '')),
    kachel('davon bei Substituten', 'CHF ' + fmtNum.format(umgeleitet), 'umgeleitetes Budget'),
    kachel('ruht', 'CHF ' + fmtNum.format(ruht), 'gestoppt, nicht weitergegeben'),
    kachel('Orte im Ziel', `${n('orange')} von ${heute.length}`, 'orange: ausgelastet, nicht überlastet'),
  );

  // Karte
  drawMap($('map'), umriss, land, orte, amp, datum, thema, ortId);

  // Detail
  const ort = byOrt[ortId];
  const ar = amp[ortId + '_' + datum];
  $('o-name').textContent = ort.name;
  $('o-meta').textContent = `${ort.region}, ${ort.thema}`;
  $('o-status').textContent = ar ? ar.status : '—';
  $('o-dot').style.background = ar ? SC[ar.status] : 'var(--chart-muted)';
  $('o-pct').textContent = ar ? ar.auslastung_pct : '—';
  $('o-mess').textContent = `${ar ? fmtNum.format(ar.messwert) : '—'} von ${fmtNum.format(ort.kapazitaet)} ${ort.messgroesse}`;
  $('o-quelle').textContent = ort.datenquelle;
  $('o-schwellen').textContent = `orange ab ${ort.schwelle_orange} %, rot ab ${ort.schwelle_rot} %`;

  // Wetter am gewählten Tag und Prognose für die nächsten Spitzentage
  const wHeute = wetter[ortId + '_' + datum];
  $('o-wx').replaceChildren(...(wHeute ? [wxIcon(wHeute.wetter, 20), document.createTextNode(wxText(wHeute) + (wHeute.prognose ? ' (Prognose)' : ''))] : [document.createTextNode('Keine Wetterdaten.')]));
  const progRows = ampel.filter((r) => r.ort_id === ortId && r.prognose).sort((a, b2) => a.datum.localeCompare(b2.datum));
  $('o-prog').replaceChildren(...(progRows.length ? progRows.map((r) => {
    const w = wetter[ortId + '_' + r.datum];
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    if (r.datum === datum) tr.className = 'sel';
    const go = () => set({ datum: r.datum });
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    const wc = document.createElement('span');
    wc.className = 'pill';
    if (w) wc.append(wxIcon(w.wetter, 16), `${w.tmax} °C, ${fmtDez.format(w.sonnenstunden)} h`);
    tr.append(td(fmtDay.format(D(r.datum))), td(wc), td(pill(`${r.auslastung_pct} % ${r.status}`, SC[r.status]), 'r'));
    return tr;
  }) : [Object.assign(document.createElement('tr'), { innerHTML: '<td class="note">Keine Prognose vorhanden.</td>' })]));
  const latest = standAm(kampagnen, datum);
  for (const art of ['paid', 'owned']) {
    const box = $('c-' + art);
    const r = latest[`${ortId}-${art}`];
    if (!r) { box.textContent = art === 'paid' ? 'Keine Paid-Kampagne' : '—'; continue; }
    const info = document.createElement('div');
    info.className = 'note';
    info.textContent = (art === 'paid' && r.budget_chf_woche ? `CHF ${fmtNum.format(r.budget_chf_woche)} pro Woche. ` : '') + r.hinweis;
    box.replaceChildren(statusPill(r.status), ...(r.sim ? [simBadge()] : []), info);
  }

  // Substitutionskette als Entscheid in Sätzen: das Budget wandert bis zum ersten grünen Ort
  const chain = kette(ort, byOrt);
  const target = ar && ar.status !== 'grün' ? chain.find((c) => (amp[c.ort_id + '_' + datum] || {}).status === 'grün') : null;
  const paidStopp = (latest[`${ortId}-paid`] || {}).status === 'gestoppt';
  const lage = (a) => a ? `${a.status}, ${a.auslastung_pct} %` : 'keine Daten';
  const step = (num, o, a, text, cls) => {
    const li = document.createElement('li');
    if (cls) li.className = cls;
    const nr = document.createElement('span');
    nr.className = 'nr';
    nr.textContent = num;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link' + (cls === 'target' ? ' target' : '');
    btn.addEventListener('click', () => set({ ort: o.ort_id }));
    btn.append(pill(`${o.name} (${lage(a)})`, a ? SC[a.status] : 'var(--chart-muted)'));
    const t = document.createElement('span');
    t.className = 'what';
    t.textContent = text;
    li.append(nr, btn, t);
    return li;
  };
  const steps = [];
  if (ar) steps.push(step('', ort, ar, ar.status === 'grün' ? 'kein Substitut nötig, Paid darf laufen.' : paidStopp ? 'Paid gestoppt, das Budget geht weiter:' : 'falls Paid gestoppt wird, ginge das Budget so weiter:', 'self'));
  let erreicht = false;
  chain.forEach((c, i) => {
    const ca = amp[c.ort_id + '_' + datum];
    let text, cls = 'skip';
    if (!ar || ar.status === 'grün') text = 'steht bereit, falls es hier voll wird.';
    else if (erreicht) text = 'wartet auf Budget.';
    else if (target && target.ort_id === c.ort_id) { const anteil = `${c.uebernahme_pct ?? 75} % des Budgets`; text = paidStopp ? `ist grün und erhält ${anteil}.` : `ist grün und würde ${anteil} erhalten.`; cls = 'target'; erreicht = true; }
    else text = ca ? `ist selbst ${ca.status}, gibt weiter.` : 'ohne Daten, gibt weiter.';
    steps.push(step(`${i + 1}.`, c, ca, text, cls));
  });
  const ol = document.createElement('ol');
  ol.className = 'steps';
  ol.append(...steps);
  $('chain').replaceChildren(chain.length ? ol : document.createTextNode('Kein Substitut hinterlegt: Budget bleibt reserviert.'));
  $('verdict').textContent = ar && ar.status !== 'grün' && chain.length && !target ? 'Kein Ort der Kette ist grün: keine Umleitung, Hochsaison.' : '';

  // Substitutionsketten und Budgetfluss (nur gezeichnet, wenn aufgeklappt)
  if ($('lenkung').open) drawFluss($('fluss'), { orte, ampel, kampagnen, datum, thema, ortId, stuecke: DB.regeln.tage[datum].stuecke, onSelect: (id) => set({ ort: id }) });

  // Fieberkurve: alle Substitute als Vergleich, eines hervorgehoben (Standard: wohin das Budget geht)
  $('f-name').textContent = ort.name;
  const sortD = (a, b2) => a.datum.localeCompare(b2.datum);
  const rows = ampel.filter((r) => r.ort_id === ortId).sort(sortD);
  const subs = chain.map((c) => ({ o: c, rows: ampel.filter((r) => r.ort_id === c.ort_id).sort(sortD) }));
  if (!chain.some((c) => c.ort_id === state.vergleich)) state.vergleich = (target || chain[0] || {}).ort_id || null;
  $('vergleich').replaceChildren(...(subs.length ? [document.createTextNode('Vergleich mit:'), ...subs.map((s, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip sub-chip';
    btn.setAttribute('aria-pressed', String(s.o.ort_id === state.vergleich));
    const sw = document.createElement('i');
    sw.className = 'swatch';
    btn.append(sw, `${i + 1}. ${s.o.name}`);
    btn.addEventListener('click', () => { state.vergleich = s.o.ort_id; render(); });
    return btn;
  })] : [document.createTextNode('Kein Substitut hinterlegt.')]));
  const evs = kampagnen.filter((r) => r.ort_id === ortId && !(r.art === 'Owned' && r.hinweis === 'Saisonstart'));
  const wxOrt = Object.fromEntries(dates.map((d) => [d, wetter[ortId + '_' + d]]).filter(([, w]) => w));
  drawCurve($('curve'), rows, subs, ort, state.vergleich, evs, datum, dates, wxOrt);

  // Kampagnen am gewählten Tag
  const cur = Object.values(latest).filter((r) => byOrt[r.ort_id] && inThema(byOrt[r.ort_id]))
    .sort((a, b2) => (b2.ort_id === ortId) - (a.ort_id === ortId) || a.ort.localeCompare(b2.ort) || b2.art.localeCompare(a.art));
  $('ktable').replaceChildren(...cur.map((r) => {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    if (r.ort_id === ortId) tr.className = 'sel';
    const go = () => set({ ort: r.ort_id });
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    const stc = document.createElement('span');
    stc.append(statusPill(r.status), ...(r.sim ? [simBadge()] : []));
    tr.append(td(r.ort), td(r.art), td(stc), td(fmtNum.format(r.budget_chf_woche), 'r'), td(fmtShort.format(D(r.datum_ab)), 'hide-sm'), td(r.hinweis, 'hide-sm'));
    return tr;
  }));

  // Verlauf des gewählten Ortes
  $('v-name').textContent = ort.name;
  $('v-note').textContent = 'Alle Entscheide für diesen Ort in der Saison. Blass: Entscheide nach dem gewählten Tag.' + (kampagnen.some((r) => r.ort_id === ortId && r.sim) ? ' Zeilen mit „Simulation“ sind keine getroffenen Entscheide, sondern was die Regeln an Prognosetagen vorschlagen würden.' : '');
  // Regelprüfung: gespeicherte Entscheide gegen die Regeln
  const abw = DB.abweichungen;
  const pr = $('pruefung');
  if (!abw.length) { pr.className = 'pruefung ok'; pr.textContent = `✓ Regelprüfung: Alle gespeicherten Entscheide bis ${fmtShort.format(D(stand))} entsprechen den Regeln.`; }
  else {
    const hier = abw.filter((x) => x.ort_id === ortId);
    pr.className = 'pruefung warn';
    pr.textContent = `Regelprüfung: ${abw.length} Abweichung${abw.length === 1 ? '' : 'en'} insgesamt` + (hier.length ? `, hier: ` + hier.map((x) => `${fmtShort.format(D(x.datum))} ${x.art} gespeichert „${x.gespeichert}“, Regel „${x.erwartet}“`).join('; ') : ', keine bei diesem Ort.');
  }
  const hist = kampagnen.filter((r) => r.ort_id === ortId).sort((a, b2) => a.datum_ab.localeCompare(b2.datum_ab) || b2.art.localeCompare(a.art));
  $('vtable').replaceChildren(...hist.map((r) => {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    if (r.datum_ab > datum) tr.className = 'future';
    const go = () => { if (dates.includes(r.datum_ab)) set({ datum: r.datum_ab }); };
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    const stv = document.createElement('span');
    stv.append(statusPill(r.status), ...(r.sim ? [simBadge()] : []));
    tr.append(td(fmtShort.format(D(r.datum_ab))), td(r.art), td(stv), td(fmtNum.format(r.budget_chf_woche), 'r'), td(r.hinweis));
    return tr;
  }));
}

/* ---------- Start ---------- */

async function load() {
  try {
    const [orte, auslastung, kampagnen, umriss] = await Promise.all(
      [DATA.orte, DATA.auslastung, DATA.kampagnen, DATA.umriss].map((u) => fetch(u, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); })));
    const ampel = berechneAmpel(auslastung, orte);
    const dates = [...new Set(ampel.map((r) => r.datum))].sort();
    const ist = dates.filter((d) => !ampel.some((r) => r.datum === d && r.prognose));
    // Landesgrenze ist nur Hintergrund: fehlt sie, bleibt die Karte trotzdem nutzbar
    const land = await fetch(DATA.land, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    // Wetter ist Zusatzinformation: ohne Datei läuft das Dashboard einfach ohne Symbole
    const wetter = await fetch(DATA.wetter, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    // Regeln rechnen: gespeicherte Entscheide prüfen, nach dem Stand simulieren
    const standDatum = ist[ist.length - 1] || dates[0];
    const regeln = Regeln.rechne(orte, ampel, dates);
    const abweichungen = Regeln.pruefe(kampagnen, regeln.zeilen.filter((r) => r.datum_ab <= standDatum), ist);
    const simulation = regeln.zeilen.filter((r) => r.datum_ab > standDatum).map((r) => ({ ...r, sim: true }));
    DB = { orte, auslastung, kampagnen: [...kampagnen, ...simulation], gespeichert: kampagnen, regeln, abweichungen, umriss, land, wetter: Object.fromEntries(wetter.map((w) => [w.ort_id + '_' + w.datum, w])), ampel, dates, stand: ist[ist.length - 1] || dates[0] };
    readHash();
    render();
  } catch (err) {
    const t = $('take');
    t.className = 'lead take error';
    t.textContent = `Die Daten konnten nicht geladen werden (${err.message}). Die Seite muss über einen Webserver laufen, nicht direkt als Datei. Siehe README.md.`;
  }
}

$('lenkung').addEventListener('toggle', render);
$('slider').addEventListener('input', (e) => { if (DB) set({ datum: DB.dates[Number(e.target.value)] }); });
let rt;
new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(render, 120); }).observe(document.querySelector('.page'));
load();
