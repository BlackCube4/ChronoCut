// Gemessene Maschinenkonstanten - Epilog Fusion ("Edgar", 60 W).
//
// Quelle: 61 Kalibrierdateien der Reihen 1-4 (01-61) und der kompakte
// Messsatz 80-93 (November 2026), dazu zwei echte Produktionsdateien
// (A und B). Gefittet mit docs/calib/fit_all.mjs auf dem PRODUKTIVCODE
// (toolpath.js liefert die Geometrie, die Zeitformel ist dieselbe),
// Auswertung: docs/CALIBRATION.md Abschnitt 9.
//
// ZWEI SCHICHTEN, weil es zwei verschiedene Größen gibt:
//
//   1. Die vom Job Manager ANGEZEIGTE Schätzung (CALIBRATION). Trifft die
//      Kalibrierläufe auf Ø 0,7 s (n = 278, max 5 s), die echten Dateien
//      auf -1 bis -2 %.
//   2. Die Zeit, die die Maschine TATSÄCHLICH braucht (REALITY), so wie sie
//      der Cutter nach dem Lauf anzeigt (ganze Sekunden). Eigene Kinematik:
//      die echte Maschine beschleunigt fast unabhängig von der Speed-Stufe,
//      hält länger an Ecken und fährt Raster schneller als angezeigt. Trifft
//      die 147 gemessenen Läufe auf Ø 0,8 s (max 3,7 s).
//
// Die App zeigt (2) - danach richtet sich, wie lange der Job wirklich dauert.
// (1) bleibt über stats.displayTime verfügbar, weil das die Zahl ist, die am
// Gerät steht.
//
// Das Blatt "Messprotokoll Real" (Produktionsdateien) ist noch nicht
// verlässlich gemessen und fließt in KEINEN Fit ein.
//
// George (120 W) ist baugleich: sechs Stichproben (Vektor und Raster) zeigen
// im Job Manager exakt dieselben Zeiten wie Edgar. Gleiche Werte für beide.

export const CALIBRATION = {
  // ── Vektor (Schnitt + Vektorgravur) ────────────────────────────────────────
  vectorMaxSpeed: 253.6,   // mm/s bei 100 % - Speed-% skaliert linear

  // Beschleunigung, mit der die ANZEIGE rechnet: a = vectorAccel +
  // accelPerSpeed * v. Sie wächst mit der Geschwindigkeit - MESSUNG: 81
  // (400 Striche à 2 mm) und 84-86 (800 Ecken) erreichen die Sollgeschwindigkeit
  // weder bei 40 noch bei 100 %, sind bei 100 % aber 3 bzw. 18 s schneller.
  // Diese Werte gelten für "Optimieren" AUS; mit "Optimieren" rechnet der Job
  // Manager mit eigenen Vektorwerten, siehe `optimized` unten.
  vectorAccel:    1892,    // mm/s² bei Stillstand (= accel in printers/*.xml)
  accelPerSpeed:  5.494,   // mm/s² je mm/s

  // Zuschlag je Ecke, an der die Maschine wirklich auf 0 abbremst. Rein
  // kinematisch (v/a) wäre die Ecke zu billig; dieser Term ist der zusätzliche
  // konstante Aufwand je Stopp.
  cornerPenalty:  0.0179,  // s

  // Knick, ab dem eine Ecke als "echte" Ecke zählt. Serie 45-49 bei 8 %:
  // 26° kostet nichts, 32° einen vollen Halt. 15_polygon_12 (30°) bei 100 %
  // ohne Halt (angezeigt 20 s), 83 (20°) ebenfalls, 84 (45°) mit. 30° trifft
  // alles; mit 28° lag 15_polygon_12 @100 % um 32 % daneben.
  cornerAngleDeg: 30,

  // Ein Objekt, das ohne Leerweg dort anfängt, wo das letzte aufgehört hat,
  // kostet trotzdem einen eigenen Halt. MESSUNG 89_k_explodiert (die 800 Linien
  // von 85 als Einzelobjekte): ohne "Optimieren" +16 s gegenüber 85, mit
  // "Optimieren" exakt gleich (dort fährt der Kopf durch, siehe toolpath.js).
  objectStopPenalty: 0.0383,  // s je Objekt ohne Leerweg davor

  // ── Leerfahrten ────────────────────────────────────────────────────────────
  // 250 mm/s ist mit einer Zeitlupenkamera gemessen und ist das, womit die
  // ANZEIGE rechnet. Tatsächlich fährt die Maschine etwas schneller, siehe
  // REALITY.travelSpeed.
  travelSpeed: 250,        // mm/s

  // Startaufwand je separatem Vektor mit Leerweg davor.
  vectorStartPenalty: 0.0368,  // s

  // Rückweg zum Ursprung. Die Anzeige enthält ihn: 42_home_near und 43_home_far
  // sind dasselbe Quadrat, einmal in der Startecke (5 s), einmal in der
  // Gegenecke (13 s) - die 8 s Differenz sind ZWEIMAL ~1080 mm bei 250 mm/s.
  returnToHome: true,

  // ── Raster (Gravur) ────────────────────────────────────────────────────────
  // Zeit je Scanzeile = Zeilen-Overhead + span / v_raster, dazu ein Y-Vorschub
  // je mm gescannter Höhe und ein fester Aufwand je Band (zusammenhängender
  // Zeilenblock). span = Spannweite dieser Zeile; Zeilen ohne Inhalt entfallen
  // ganz. 91_k_raster_inseln (20 % Tinte auf derselben Fläche) kostet exakt
  // so viel wie 90_k_raster_block: es zählt die Spannweite, nicht die Tinte.
  rasterYFeed: 0.2491,       // s je mm gescannter Höhe
  rasterBandOverhead: 0.695,  // s je Rasterband
  jobOverhead: 0.647,       // s je Job (Homing/Start)

  // ── "Optimieren" AN: eigene Vektorwerte der Anzeige ─────────────────────
  // Getrennt gefittet (fit_all.mjs OPT=1): mit einem gemeinsamen Satz lagen
  // die Produktionsdateien A/B 6-10 s daneben, getrennt 1-5 s, die Kalibrierläufe
  // werden ebenfalls etwas besser. Raster, Leerweg und alles andere ist in
  // beiden Modi gleich.
  optimized: {
    vectorAccel: 1626,           // mm/s² bei Stillstand
    accelPerSpeed: 5.343,        // mm/s² je mm/s
    cornerPenalty: 0.0150,        // s
    vectorStartPenalty: 0.0227,   // s
  },

  // Leistung (Power) hat keinen Einfluss auf die Zeit - messtechnisch bestätigt.
}

// Raster-Geschwindigkeit UND Zeilen-Overhead je Speed-Stufe.
//
// Beides ist direkt gemessen, nicht aus einem Fit herausgelöst: das Paar
// 54_rast_overscan / 55_rast_speed sind zwei Balken gleicher Höhe (25,4 mm,
// 200 dpi) mit 1 mm bzw. 1000 mm Spannweite. Aus der DIFFERENZ folgt
//
//     v = 200 Zeilen × 999 mm / (t55 − t54)
//
// unabhängig von jedem Overhead-Term, und aus t54 allein dann der Overhead.
// Gefahren wurde das Paar bei allen sechs Stufen; die Tabelle ist mit allen
// Rasterläufen gemeinsam nachgefittet (fit_all.mjs).
//
// Die Geschwindigkeit ist linear (17,9-18,3 mm/s je Prozent). Der
// Zeilen-Overhead dagegen ist U-FÖRMIG: hoch bei langsam, Minimum bei 20-40 %,
// zu hohen Geschwindigkeiten hin wieder steigend. Weder ein fester Zeitanteil
// noch eine reine Beschleunigungsrampe gibt das her; ein fester Overscan-Weg
// plus Rampe kommt der Form nahe, trifft die Daten aber nur auf 2,2 %. Deshalb
// steht hier die gemessene Tabelle statt einer Formel.
//
// Die Auflösung bremst das Raster nicht: bei 600 dpi ergibt dasselbe Paar
// 1789 mm/s gegen 1816 mm/s bei 200 dpi.
const RASTER_TABLE = [
  // [Speed-%, v (mm/s), Zeilen-Overhead (s)]
  [10, 179.3, 0.15418],
  [20, 358.4, 0.08526],
  [40, 725.6, 0.08550],
  [60, 1088.4, 0.09469],
  [80, 1464.1, 0.11205],
  [100, 1810.7, 0.10358],
]

const interp = (pct, col) => {
  const t = RASTER_TABLE
  if (pct <= t[0][0]) return (pct / t[0][0]) * t[0][col]        // unter 10 %: proportional
  for (let i = 0; i < t.length - 1; i++) {
    const [x0, , ] = t[i], [x1, , ] = t[i + 1]
    if (pct <= x1) return t[i][col] + ((pct - x0) / (x1 - x0)) * (t[i + 1][col] - t[i][col])
  }
  return t[t.length - 1][col]   // 100 % ist das Maximum der Skala
}

// WICHTIG: Raster und Vektor haben VERSCHIEDENE Geschwindigkeitsskalen - Raster
// ist bei 100 % rund 7× schneller. Raster-% gegen die Vektor-maxSpeed zu rechnen
// ist grob falsch.
export const rasterSpeedForPct = (pct) => interp(pct, 1)
export const rasterLineOverheadForPct = (pct) => interp(pct, 2)

// Umkehrung von rasterSpeedForPct: mm/s -> Speed-%. Gebraucht nur für Presets,
// die ihre Rastergeschwindigkeit in mm/s statt in % angeben.
export function rasterPctForSpeed(v) {
  const t = RASTER_TABLE
  if (!(v > 0)) return 0
  if (v <= t[0][1]) return (v / t[0][1]) * t[0][0]
  for (let i = 0; i < t.length - 1; i++) {
    if (v <= t[i + 1][1]) {
      return t[i][0] + ((v - t[i][1]) / (t[i + 1][1] - t[i][1])) * (t[i + 1][0] - t[i][0])
    }
  }
  return t[t.length - 1][0]
}

// ── Anzeige → Realität ───────────────────────────────────────────────────────
//
// Die echte Maschine fährt dieselben Wege, aber mit ANDERER Kinematik - eine
// zweite Rechnung mit diesen Konstanten (toolpath.js realMoveTime). Gefittet
// an 147 gemessene Läufe (Reihen 1-4 und kompakter Satz, Edgar, beide
// Spalten); der Cutter misst selbst, ganze Sekunden.
//
//   VEKTOR: Beschleunigung fast konstant (~2519 mm/s²), die Anzeige
//     rechnet bei hoher Geschwindigkeit mit viel mehr. Jeder Halt kostet mehr
//     als angezeigt. Ecken bei 100 % (84-86): angezeigt 95-97 s, gemessen
//     107-109 s. Gerade Linien laufen dagegen minimal schneller (+0,18 mm/s).
//   LEERWEG: 258 statt 250 mm/s.
//   RASTER läuft SCHNELLER als angezeigt - je Scanzeile und je mm Gravurhöhe
//     weniger (90-93: angezeigt 98/57/50 s, gemessen 91/49/43 s).
export const REALITY = {
  speedOffset: 0.1782,        // mm/s auf die Vektorgeschwindigkeit
  vectorAccel: 2479,          // mm/s² bei Stillstand
  accelPerSpeed: 0.3987,       // mm/s² je mm/s
  stopPenalty: 0.03393,        // s je Halt ...
  stopPenaltyPerSpeed: -6.5263e-05, // ... + s je mm/s (bei 100 %: 17,4 ms)
  vectorStartPenalty: 0.03198, // s je Vektor mit Leerweg davor
  fileObjectPenalty: 0.01302,  // s je Objekt zusätzlich, nur bei "Optimieren" aus
  travelSpeed: 258.2,         // mm/s
  rasterPerLine: -0.01269,     // s je Scanzeile
  rasterPerMmHeight: -0.1171, // s je mm gescannter Höhe
}
