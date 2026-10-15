/* Projekt Orange – Steuerungsregeln als Programm.
 * Einzige Quelle der Wahrheit für die Regeln aus FAQ und README. Läuft im Browser (window.Regeln)
 * und in Node (require), damit derselbe Code Beispieldaten erzeugt, im Dashboard prüft und simuliert
 * und später auf dem Server die echten Entscheide schreibt.
 *
 * Regeln pro Ort, nach jedem Spitzentag:
 *   grün                      Paid halten; 2× grün: reduziert → voll (Saisonstart-Budget, nie darüber)
 *   orange                    Paid voll → reduziert (halbes Budget)
 *   2× orange steigend        Paid stoppen
 *   1× rot                    Paid stoppen, Owned pausieren
 *   nach rot nicht mehr rot   Owned wieder aktiv
 *   gestoppt, dann 2× grün    mit halbem Budget wieder aufnehmen; am nächsten grünen Tag voll
 *   grau (keine Daten)        alles halten, Zählungen beginnen von vorn
 * Budget eines gestoppten Ortes: wandert die Substitutionskette entlang zum ersten Ort, der grün und
 * nicht gestoppt ist; dieser erhält seinen Übernahme-Anteil (uebernahme_pct). Das Budget bleibt dort,
 * bis dieser Ort selbst gestoppt wird. Für Empfänger gelten dieselben Regeln (orange halbiert ihr Paid).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Regeln = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const FAKTOR = { voll: 1, reduziert: 0.5, gestoppt: 0 };
  const rund10 = (v) => Math.round(v / 10) * 10;
  const fmt = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '’');

  // Ampel pro Ort und Tag; fehlende oder ungültige Werte ergeben keine Zeile (grau, nie grün)
  function berechneAmpel(auslastung, orte) {
    const ort = Object.fromEntries(orte.map((o) => [o.ort_id, o]));
    return auslastung.filter((r) => ort[r.ort_id] && r.auslastung_pct !== null && r.auslastung_pct !== '' && Number.isFinite(Number(r.auslastung_pct))).map((r) => {
      const o = ort[r.ort_id];
      const p = Number(r.auslastung_pct);
      const status = p >= Number(o.schwelle_rot) ? 'rot' : p >= Number(o.schwelle_orange) ? 'orange' : 'grün';
      return { key: r.ort_id + '_' + r.datum, ort_id: r.ort_id, datum: r.datum, auslastung_pct: p, messwert: r.messwert, prognose: !!r.prognose, status };
    });
  }

  // Wendet die Regeln Tag für Tag an. Ergebnis: Kampagnenzeilen (gleiches Format wie kampagnen.json)
  // und pro Tag der Zustand jedes Ortes samt Budgetstücken (wer hält wessen Budget).
  function rechne(orte, ampel, dates) {
    const by = Object.fromEntries(orte.map((o) => [o.ort_id, o]));
    const amp = Object.fromEntries(ampel.map((a) => [a.ort_id + '_' + a.datum, a]));
    const kette = (id) => {
      const out = [];
      for (let x = (by[id] || {}).substitut; x && by[x] && x !== id && !out.includes(x); x = by[x].substitut) out.push(x);
      return out;
    };
    const z = Object.fromEntries(orte.map((o) => [o.ort_id, { stufe: 'voll', zurueck: false, gruen: 0, vor: null, owned: 'aktiv', paidAlt: null, ownedAlt: null }]));
    const stuecke = []; // { von, basis, faktor, bei, betrag }
    const zeilen = [], tage = {};
    const name = (id) => (by[id] || {}).name || id;
    const basis = (id) => Number((by[id] || {}).paid_start_chf) || 0;

    dates.forEach((datum, i) => {
      const grund = {}, ownedGrund = {};
      // 1) Stufe jedes Ortes nach den Regeln
      for (const o of orte) {
        const s = z[o.ort_id], a = amp[o.ort_id + '_' + datum];
        if (!a) { s.gruen = 0; s.vor = null; continue; } // grau: halten, Zählungen von vorn
        const steigend = s.vor && s.vor.status === 'orange' && a.status === 'orange' && a.auslastung_pct > s.vor.auslastung_pct;
        if (a.status === 'rot') {
          if (s.stufe !== 'gestoppt') { s.stufe = 'gestoppt'; grund[o.ort_id] = '1× rot – Paid gestoppt'; }
          s.zurueck = false; s.gruen = 0;
          if (s.owned !== 'pausiert') { s.owned = 'pausiert'; ownedGrund[o.ort_id] = '1× rot'; }
        } else {
          if (s.owned === 'pausiert') { s.owned = 'aktiv'; ownedGrund[o.ort_id] = a.status === 'orange' ? 'Wieder orange' : 'Wieder grün'; }
          if (a.status === 'orange') {
            s.gruen = 0;
            if (s.stufe !== 'gestoppt' && steigend) { s.stufe = 'gestoppt'; s.zurueck = false; grund[o.ort_id] = '2× orange steigend – Paid gestoppt'; }
            else if (s.stufe === 'voll') { s.stufe = 'reduziert'; grund[o.ort_id] = 'Orange – Paid reduziert'; }
          } else {
            s.gruen++;
            if (s.zurueck) { s.stufe = 'voll'; s.zurueck = false; s.gruen = 0; grund[o.ort_id] = 'Grün – volles Budget zurück'; }
            else if (s.stufe === 'gestoppt' && s.gruen >= 2) { s.stufe = 'reduziert'; s.zurueck = true; s.gruen = 0; grund[o.ort_id] = '2× grün – mit halbem Budget wieder aufgenommen'; }
            else if (s.stufe === 'reduziert' && s.gruen >= 2) { s.stufe = 'voll'; s.gruen = 0; grund[o.ort_id] = '2× grün – hochgefahren auf Saisonstart-Budget'; }
          }
        }
        s.vor = a;
      }
      // 2) Budgetstücke: neu gestoppte Orte geben ab, Rückkehrer holen zurück, gestoppte Halter geben weiter
      for (const o of orte) {
        const s = z[o.ort_id], id = o.ort_id;
        const eigenes = stuecke.find((k) => k.von === id);
        if (s.stufe === 'gestoppt' && basis(id) && !eigenes) {
          const vorher = s.paidAlt ? s.paidAlt.faktor : 1;
          stuecke.push({ von: id, basis: basis(id) * (vorher || 1), faktor: 1, bei: null, betrag: 0 });
        }
        if (eigenes && s.stufe !== 'gestoppt') {
          if (s.zurueck) eigenes.faktor = 0.5;
          else stuecke.splice(stuecke.indexOf(eigenes), 1);
        }
        if (eigenes && s.stufe === 'gestoppt') eigenes.faktor = 1;
        if (s.stufe === 'gestoppt') for (const k of stuecke) if (k.bei === id) k.bei = null;
      }
      // 3) Stücke ohne Halter: entlang der Kette zum ersten Ort, der grün und nicht gestoppt ist
      for (const k of stuecke) {
        if (k.bei) continue;
        k.bei = kette(k.von).find((x) => (amp[x + '_' + datum] || {}).status === 'grün' && z[x].stufe !== 'gestoppt') || null;
      }
      for (const k of stuecke) k.betrag = k.bei ? rund10(k.basis * k.faktor * (Number(by[k.bei].uebernahme_pct) || 75) / 100) : 0;
      // 4) Laufendes Paid pro Ort und Zeilen bei jeder Änderung
      for (const o of orte) {
        const id = o.ort_id, s = z[id];
        const meine = stuecke.filter((k) => k.bei === id);
        const topf = basis(id) + meine.reduce((sum, k) => sum + k.basis * k.faktor * (Number(o.uebernahme_pct) || 75) / 100, 0);
        const betrag = rund10(FAKTOR[s.stufe] * topf);
        const status = s.stufe === 'gestoppt' ? 'gestoppt' : s.stufe === 'reduziert' ? 'reduziert' : 'aktiv';
        const neu = { status, betrag, faktor: FAKTOR[s.stufe], von: meine.map((k) => k.von).sort().join(',') };
        const alt = s.paidAlt;
        if ((basis(id) || meine.length || (alt && alt.betrag)) && (!alt || alt.status !== neu.status || alt.betrag !== neu.betrag || alt.von !== neu.von)) {
          let text = i === 0 ? 'Saisonstart' : grund[id];
          const dazu = meine.filter((k) => !alt || !alt.von.split(',').includes(k.von));
          if (dazu.length) text = (text ? text + '; ' : '') + dazu.map((k) => `übernimmt ${o.uebernahme_pct ?? 75} % von CHF ${fmt(k.basis)} (${name(k.von)})`).join(', ');
          const weg = alt ? alt.von.split(',').filter((v) => v && !meine.some((k) => k.von === v)) : [];
          if (weg.length && !text) text = `Budget von ${weg.map(name).join(', ')} zurückgegeben`;
          const halb = meine.filter((k) => k.faktor === 0.5 && alt && alt.von.split(',').includes(k.von));
          if (halb.length && !text) text = `Gibt die Hälfte an ${halb.map((k) => name(k.von)).join(', ')} zurück`;
          if (status === 'gestoppt') {
            const ziel = stuecke.filter((k) => k.von === id || (alt && alt.von.split(',').includes(k.von))).map((k) => k.bei).filter(Boolean);
            text = (text || 'Paid gestoppt') + (ziel.length ? ` – Budget an ${[...new Set(ziel)].map(name).join(', ')}` : ' – kein grünes Substitut, Budget ruht');
          }
          if (!text) text = 'Budget angepasst';
          zeilen.push({ kampagne_id: id + '-paid', ort: o.name, ort_id: id, art: 'Paid', kanal: 'Meta & Google Ads', datum_ab: datum, status, budget_chf_woche: betrag, hinweis: text, budget_von: neu.von });
        }
        s.paidAlt = neu;
        if (i === 0 || ownedGrund[id]) {
          zeilen.push({ kampagne_id: id + '-owned', ort: o.name, ort_id: id, art: 'Owned', kanal: 'Instagram, Web, Newsletter', datum_ab: datum, status: s.owned, budget_chf_woche: 0, hinweis: i === 0 ? 'Saisonstart' : ownedGrund[id], budget_von: '' });
        }
      }
      tage[datum] = {
        orte: Object.fromEntries(orte.map((o) => [o.ort_id, { stufe: z[o.ort_id].stufe, owned: z[o.ort_id].owned, paid: z[o.ort_id].paidAlt.betrag }])),
        stuecke: stuecke.map((k) => ({ ...k })),
      };
    });
    return { zeilen, tage, kette };
  }

  // Letzter Stand jeder Kampagne an einem Datum
  function standAm(zeilen, datum) {
    const s = {};
    for (const r of zeilen) if (r.datum_ab <= datum && (!s[r.kampagne_id] || s[r.kampagne_id].datum_ab <= r.datum_ab)) s[r.kampagne_id] = r;
    return s;
  }

  // Vergleicht gespeicherte Entscheide mit den Regeln, Tag für Tag bis zum Stand
  function pruefe(gespeichert, erwartet, dates) {
    const abw = [];
    for (const d of dates) {
      const g = standAm(gespeichert, d), e = standAm(erwartet, d);
      for (const id of new Set([...Object.keys(g), ...Object.keys(e)])) {
        const a = g[id], b = e[id];
        const sa = a ? `${a.status}${a.art === 'Paid' ? ' CHF ' + fmt(a.budget_chf_woche) : ''}` : 'keine Kampagne';
        const sb = b ? `${b.status}${b.art === 'Paid' ? ' CHF ' + fmt(b.budget_chf_woche) : ''}` : 'keine Kampagne';
        if (sa !== sb && !abw.some((x) => x.kampagne_id === id && x.gespeichert === sa && x.erwartet === sb)) abw.push({ datum: d, kampagne_id: id, ort_id: (a || b).ort_id, art: (a || b).art, gespeichert: sa, erwartet: sb });
      }
    }
    return abw;
  }

  return { berechneAmpel, rechne, standAm, pruefe };
});
