// Gemessene Maschinenkonstanten - Epilog Fusion ("Edgar", 60 W).
//
// Quelle: 61 Kalibrierdateien / 87 Läufe. Fit-Skript und Rohdaten:
// docs/calib/fit_model.py, Auswertung: docs/CALIBRATION.md.
//
// ZWEI SCHICHTEN, weil es zwei verschiedene Größen gibt:
//
//   1. Die vom Job Manager ANGEZEIGTE Schätzung. Die ist mit 87 Läufen dicht
//      belegt und wird von CALIBRATION unten auf Ø 0,60 % getroffen.
//   2. Die Zeit, die die Maschine TATSÄCHLICH braucht. 25 Läufe sind mit der
//      Uhr gestoppt, und sie weichen systematisch ab: Raster läuft schneller
//      als angezeigt, Vektor mit viel Leerweg langsamer. REALITY unten ist
//      die Korrektur von (1) auf (2).
//
// Die App zeigt (2) - danach richtet sich, wie lange der Job wirklich dauert.
// (1) bleibt über stats.displayTime verfügbar, weil das die Zahl ist, die am
// Gerät steht.
//
// George (120 W) ist baugleich; die Zeitschätzung ist rein kinematisch und
// hängt nicht an der Laserleistung. Bis Stichproben vorliegen: gleiche Werte.

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
// 25 Läufe sind mit der Uhr gestoppt. Die Abweichung von der Anzeige ist nicht
// zufällig, sondern hat in beiden Domänen eine klare Form:
//
//   RASTER läuft SCHNELLER als angezeigt - die Anzeige veranschlagt je
//   Scanzeile und je mm Gravurhöhe mehr, als die Maschine braucht. Zwei Terme
//   reproduzieren alle neun Rastermessungen auf 0,7 s genau, über 200 bis 1890
//   Zeilen und 25 bis 80 mm Höhe - besser als die ±0,5 s, mit denen die beiden
//   abgelesenen Zahlen selbst behaftet sind.
//
//   VEKTOR läuft LANGSAMER als angezeigt, und zwar proportional zum Leerweg:
//   0,645 ms je mm entspricht einem echten Eilgang von 215 statt der 250 mm/s,
//   mit denen die Anzeige rechnet. Dazu 9,4 ms je Kontur. 56/57 (400/800
//   Konturen, kaum Leerweg) und 41/61 (viel Leerweg) trennen die beiden Terme.
//
// Nicht erfasst bleibt ein Rest von bis zu 3 s auf den langen Einzelkontur-
// Läufen (07_vline_250: angezeigt 248 s, gestoppt 245 s) - 1,2 %, in der
// Größenordnung der Ablesegenauigkeit.
export const REALITY = {
  rasterPerLine: -0.01267,   // s je Scanzeile
  rasterPerMmHeight: -0.1233, // s je mm gescannter Höhe
  vectorPerContour: 0.00939, // s je separatem Vektor
  vectorPerMmTravel: 0.000645, // s je mm Leerweg (= 215 statt 250 mm/s)
}
