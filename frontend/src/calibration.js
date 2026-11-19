// Gemessene Maschinenkonstanten - Epilog Fusion ("Edgar", 60 W).
//
// Quelle: 61 Kalibrierdateien. Fit-Skripte und Rohdaten: docs/calib/fit_model.py
// (Anzeige) und docs/calib/fit_reality.mjs (Realität), Auswertung:
// docs/CALIBRATION.md.
//
// ZWEI SCHICHTEN, weil es zwei verschiedene Größen gibt:
//
//   1. Die vom Job Manager ANGEZEIGTE Schätzung. CALIBRATION unten trifft sie
//      bei 8 % Vektor auf Ø 0,74 %, beim Raster auf Ø 0,54 %.
//   2. Die Zeit, die die Maschine TATSÄCHLICH braucht. 116 Werte hat der
//      Cutter nach dem Lauf angezeigt (ganze Sekunden), und sie weichen
//      systematisch ab: Raster läuft schneller als angezeigt, Vektor mit viel
//      Leerweg oder vielen Eckhalten langsamer.
//      REALITY unten ist die Korrektur von (1) auf (2).
//
// Die App zeigt (2) - danach richtet sich, wie lange der Job wirklich dauert.
// (1) bleibt über stats.displayTime verfügbar, weil das die Zahl ist, die am
// Gerät steht.
//
// VIERTE MESSREIHE (Oktober 2026), bewusst NICHT in CALIBRATION übernommen:
// die Vektorreihe bei 100 % trifft dieses Modell nur auf Ø 8 % (15_polygon_12
// mit "Optimieren": angezeigt 20 s, Modell 29 s). Ein Neufit über alle Läufe
// holt 100 % auf Ø 3,7 %, macht aber 8 % schlechter (1,2 %). Die Ursache ist
// das Eckenmodell: eine Ecke ist hier entweder ein voller Halt (Knick über
// cornerAngleDeg) oder nichts - bei hoher Geschwindigkeit bremst die Maschine
// an mittleren Ecken aber nur ab. Erst mit einem Modell dafür lässt sich die
// Beschleunigung aus den 100-%-Daten sauber bestimmen. Dafür ist der kompakte
// Messsatz 80-93 gebaut (docs/CALIBRATION.md Abschnitt 8).
//
// Das Blatt "Messprotokoll Real" (Produktionsdateien) ist noch nicht
// verlässlich gemessen und fließt in KEINEN Fit ein; extract_protocol.py liest
// nur das Blatt "Messprotokoll".
//
// George (120 W) ist baugleich: sechs Stichproben (Vektor und Raster) zeigen
// im Job Manager exakt dieselben Zeiten wie Edgar. Gleiche Werte für beide.

export const CALIBRATION = {
  // ── Vektor (Schnitt + Vektorgravur) ────────────────────────────────────────
  vectorMaxSpeed: 255,     // mm/s bei 100 % - Speed-% skaliert linear
  vectorAccel:    2754,    // mm/s²

  // Zuschlag je Ecke, an der die Maschine wirklich auf 0 abbremst. Rein
  // kinematisch (v/a) wäre die Ecke zu billig; dieser Term ist der zusätzliche
  // konstante Aufwand je Stopp.
  cornerPenalty:  0.0219,  // s

  // Knick, ab dem eine Ecke als "echte" Ecke zählt. Direkt gemessen mit der
  // Serie 45-49 (identische Länge und Eckenzahl, nur der Knickwinkel variiert):
  // 8°/14°/20°/26° kosten optimiert alle 139 s, 32° springt auf 154 s.
  cornerAngleDeg: 28,

  // ── Leerfahrten ────────────────────────────────────────────────────────────
  // 250 mm/s ist mit einer Zeitlupenkamera gemessen und ist das, womit die
  // ANZEIGE rechnet. Tatsächlich fährt die Maschine langsamer - siehe
  // REALITY.travelPerMm weiter unten.
  travelSpeed: 250,        // mm/s, konstant

  // Startaufwand je separatem Vektor. 44_vecstart_stack / 56 / 57 (200/400/800
  // getrennte 1-mm-Striche ohne nennenswerten Leerweg) messen ihn isoliert.
  vectorStartPenalty: 0.0369,  // s

  // Rückweg zum Ursprung. Die Anzeige enthält ihn: 42_home_near und 43_home_far
  // sind dasselbe Quadrat, einmal in der Startecke (5 s), einmal in der
  // Gegenecke (13 s) - die 8 s Differenz sind ZWEIMAL ~1080 mm bei 250 mm/s.
  returnToHome: true,

  // ── Raster (Gravur) ────────────────────────────────────────────────────────
  // Zeit je Scanzeile = Zeilen-Overhead + span / v_raster, dazu ein Y-Vorschub
  // je mm gescannter Höhe. span = Spannweite dieser Zeile; Zeilen ohne Inhalt
  // entfallen ganz.
  rasterYFeed: 0.3207,     // s je mm gescannter Höhe
  jobOverhead: 0.649,      // s je Job (Homing/Start)

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
// Gefahren wurde das Paar bei allen sechs Stufen.
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
  [10, 178.5, 0.15031],
  [20, 357.4, 0.08286],
  [40, 727.9, 0.08302],
  [60, 1089.3, 0.09437],
  [80, 1461.5, 0.10939],
  [100, 1806.2, 0.10243],
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
// 116 Werte hat der Cutter nach dem Lauf angezeigt (58 Läufe bei 8-100 %,
// mit und ohne "Optimieren"; 01/02 mit "1 s" ausgenommen). Gefittet mit
// docs/calib/fit_reality.mjs gegen die im Job Manager ABGELESENE Zahl, nicht
// gegen die Modell-Anzeige - so trägt diese Schicht nur den echten
// Unterschied Schätzung -> gemessene Zeit und keine Fehler des Anzeige-Modells.
//
//   RASTER läuft SCHNELLER als angezeigt - die Anzeige veranschlagt je
//   Scanzeile und je mm Gravurhöhe mehr, als die Maschine braucht.
//
//   VEKTOR läuft LANGSAMER als angezeigt: proportional zum Leerweg (0,659 ms je
//   mm = echter Eilgang 215 statt der 250 mm/s der Anzeige, passt zur
//   Kameramessung), je Kontur, und - neu, aus der gemessenen Zickzack-Reihe -
//   je vollem Halt innerhalb einer Kontur.
export const REALITY = {
  rasterPerLine: -0.01236,     // s je Scanzeile
  rasterPerMmHeight: -0.1235,  // s je mm gescannter Höhe
  vectorPerContour: 0.00848,   // s je separatem Vektor
  vectorPerMmTravel: 0.000659, // s je mm Leerweg (= 215 statt 250 mm/s)
  vectorPerStop: 0.00846,      // s je vollem Halt innerhalb einer Kontur
}
