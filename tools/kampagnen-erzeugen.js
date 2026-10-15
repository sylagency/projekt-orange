// Erzeugt data/kampagnen.json aus den Regeln (js/regeln.js), bis zum letzten gemessenen Spitzentag.
// Aufruf im Projektordner: node tools/kampagnen-erzeugen.js
const fs = require('fs');
const path = require('path');
const Regeln = require('../js/regeln.js');
const daten = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const orte = daten('orte.json');
const ampel = Regeln.berechneAmpel(daten('auslastung.json'), orte);
const dates = [...new Set(ampel.map((a) => a.datum))].sort();
const stand = dates.filter((d) => !ampel.some((a) => a.datum === d && a.prognose)).pop();
const { zeilen } = Regeln.rechne(orte, ampel, dates);
const gespeichert = zeilen.filter((r) => r.datum_ab <= stand);
fs.writeFileSync(path.join(__dirname, '..', 'data', 'kampagnen.json'), JSON.stringify(gespeichert));
for (const r of gespeichert) console.log(r.datum_ab, r.ort_id.padEnd(10), r.art.padEnd(5), r.status.padEnd(9), String(r.budget_chf_woche).padStart(5), '|', r.hinweis);
console.log(`\n${gespeichert.length} Zeilen bis ${stand}; Simulation danach: ${zeilen.length - gespeichert.length} Zeilen`);
for (const r of zeilen.filter((r) => r.datum_ab > stand)) console.log('  SIM', r.datum_ab, r.ort_id, r.art, r.status, r.budget_chf_woche, '|', r.hinweis);
