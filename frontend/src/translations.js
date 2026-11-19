// Minimal reactive translations for the app. `locale` is a Vue ref, and `t(key)` reads it
// while resolving - so calling t() in a template/computed makes that spot
// re-render automatically when the language changes. The choice is persisted in
// localStorage. Flags are inline SVG (emoji flags render as bare letters on
// Windows, so we ship real little flags instead).

import { ref, computed } from 'vue'

const FLAG_DE = `<svg viewBox="0 0 5 3" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="5" height="3" fill="#000000"/>
  <rect y="1" width="5" height="1" fill="#DD0000"/>
  <rect y="2" width="5" height="1" fill="#FFCE00"/>
</svg>`

// Simplified Union Jack (the outer SVG clips the overflowing diagonals).
const FLAG_GB = `<svg viewBox="0 0 60 30" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
  <rect width="60" height="30" fill="#012169"/>
  <path d="M0,0 L60,30 M60,0 L0,30" stroke="#ffffff" stroke-width="6"/>
  <path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" stroke-width="4"/>
  <path d="M30,0 V30 M0,15 H60" stroke="#ffffff" stroke-width="10"/>
  <path d="M30,0 V30 M0,15 H60" stroke="#C8102E" stroke-width="6"/>
</svg>`

export const LANGS = [
  { code: 'de', label: 'Deutsch', flag: FLAG_DE },
  { code: 'en', label: 'English', flag: FLAG_GB },
]

const messages = {
  de: {
    // Sidebar
    upload: 'Öffnen',
    uploading: 'Lädt…',
    selectCutter: 'Schneider wählen',
    selectMaterial: 'Material wählen',
    searchMaterial: 'Material suchen…',
    noMatch: 'Kein Treffer',
    selectThickness: 'Stärke wählen',
    option: 'Option',
    options: 'Optionen',
    tipDpi: 'Auflösung der Rastergravur (DPI). Folgt automatisch dem gewählten Material, kann hier für den aktuellen Job überschrieben werden.',
    customMode: 'Custom',
    tipCustomMode: 'Überschreibt die Geschwindigkeiten aus dem Material für Schnitt, Vektor- und Rastergravur mit eigenen Werten (% der Maximalgeschwindigkeit, wie in der Original-Software).',
    editCustomSpeeds: 'Eigene Geschwindigkeiten bearbeiten',
    customSpeedsTitle: 'Eigene Geschwindigkeiten',
    customSpeedsHint: 'Prozent der Maximalgeschwindigkeit, wie in der Original-Software. Startet bei den Werten des gewählten Materials und wird bei jeder neuen Auswahl wieder darauf gesetzt.',
    resetToDefaults: 'Zurücksetzen',
    resetToPreset: 'Zurück auf die Werte von {preset}',
    machineEstimate: 'Maschinen-Schätzung',
    tipMachineEstimate: 'Zeigt statt der tatsächlichen Laufzeit die Zahl, die der Job Manager anzeigt. Die beiden weichen systematisch ab: Raster läuft schneller als angesagt, Vektor mit viel Leerweg langsamer.',
    focusAll: 'Ganzes Werkstück',
    focusLasered: 'Nur schon Gelasertes',
    focusVisible: 'Nur sichtbare Farben',
    done: 'Fertig',
    close: 'Schließen',
    showRulers: 'Lineale anzeigen',
    imagesGray: 'Bilder wie der Laser (Graustufen)',
    optimizePath: 'Optimieren (Job Manager)',
    pathOrderFile: 'Aus',
    pathOrderNn: 'An (Standard)',
    pathOrder2opt: 'An, 2-opt (Vergleich)',
    rasterBlock: 'Raster als Block',
    rasterFilled: 'Gefüllt',
    rasterOutline: 'Nur Umriss',
    showTravel: 'Leerwege anzeigen',
    debug: 'Debug',
    speedGradient: 'Speed-Gradient (Debug)',
    dbgSegments: 'Segmentfarben & Anzahl',
    dbgSpeed: 'Speed-Gradient',
    curveFidelity: 'Kurvenqualität',
    tessNormal: 'Normal',
    tessFine: 'Fein',
    tessUltra: 'Sehr fein',
    fixColors: 'Farben korrigieren',
    removeWhite: 'Weiß entfernen',
    removeDoubles: 'Dopplungen entfernen',
    noDoubles: 'Keine Dopplungen',
    doublesArmedN: 'Entferne {n} Dopplungen',
    doublesDone: 'Dopplungen entfernt',
    colorsArmedN: 'Korrigiere {n} Farben',
    colorsNone: 'Keine Farben zu korrigieren',
    colorsDone: 'Farben korrigiert',
    whiteArmedN: 'Entferne {n} weiße',
    whiteNone: 'Kein Weiß zu entfernen',
    whiteDone: 'Weiß entfernt',
    removeTinySegs: 'Winzige Segmente entfernen',
    tinySegsNone: 'Keine winzigen Segmente',
    tinySegsArmedN: 'Entferne {n} winzige Segmente',
    tinySegsDone: 'Winzige Segmente entfernt',
    autopilot: 'Autopilot',
    autopilotNone: 'Nichts zu optimieren',
    autopilotDone: 'Fertig: {n} von {m} Schritten',
    autopilotDoneSaved: '{n} von {m} Schritten, {t} schneller',
    removeWatermarks: 'Wasserzeichen entfernen',
    watermarksArmedN: 'Entferne Wasserzeichen ({n} Teile)',
    watermarksNone: 'Kein Wasserzeichen gefunden',
    watermarksDone: 'Wasserzeichen entfernt',
    joinCurves: 'Kurven verbinden',
    joinCurvesArmedN: 'Verbinde {n} Segmente',
    joinCurvesNone: 'Nichts zu verbinden',
    joinCurvesDone: '{n} Pfade verbunden',
    joinCurvesDoneSaved: '{n} Pfade, {t} schneller',
    cleanAll: 'Farben & Dopplungen fixen',
    cleaning: 'Bereinige…',
    cleanAllDone: '{n} bereinigt',
    cleanAllNone: 'Nichts zu bereinigen',
    mobileTagline: 'Laser-Job-Vorschau',
    noFileHint: 'Öffne eine PDF- oder SVG-Datei, um die Zeit zu schätzen.',
    uploadError: 'Fehler beim Öffnen der Datei: ',
    svgTextWarning: 'Die SVG-Datei enthält Text, der nicht als Text gelesen werden kann. Bitte Text vorher in Pfade umwandeln oder als PDF exportieren.',
    // Tooltips
    tipRulers: 'Zeigt Lineale (mm) am oberen und linken Rand des Ansichtsfensters an.',
    tipOptimize: 'Entspricht dem Häkchen "Optimieren" im Epilog Job Manager. An: die Maschine sortiert die Pfade (gemessen: Nearest-Neighbour) und fährt flache Knicke durch. Aus: Dateireihenfolge, und an jedem Stützpunkt einer geraden Linie wird angehalten - bei fein zerlegten Kurven (z. B. aus Archicad) sehr langsam. "2-opt" ist nur zum Vergleich.',
    tipRaster: 'Zeichnet Gravur (grün/Graustufen) als einen sich füllenden Block statt der Hin-und-her-Linien. Schneller.',
    tipShowTravel: 'Zeigt die Leerwege (Eilgänge ohne Laser) als gepunktete Linien an.',
    tipDebug: 'Debug: zufällige Segmentfarben + Segmentzähler (oben links).',
    tipSpeedGradient: 'Debug: färbt die Segmente nach Geschwindigkeit (blau = langsam an Ecken, rot = volle Marschgeschwindigkeit) - zum Debuggen der Beschleunigung.',
    tipRemoveDoubles: 'Sucht deckungsgleiche rote/blaue Schnittlinien. 1. Klick hebt sie hervor, 2. Klick entfernt sie.',
    tipFixColors: 'Snappt fast-rote/-blaue Linien und fast-grüne Flächen auf reines Rot/Blau/Grün.',
    tipRemoveWhite: 'Entfernt (fast) weiße Linien/Flächen (oft Wasserzeichen/Artefakte).',
    tipRemoveTinySegs: 'Entfernt Linien/Kurven unter 0,005 mm Länge - Extraktionsrauschen, an dem der Optimierer der Maschine gelegentlich scheitert.',
    tipAutopilot: 'Führt alle Werkzeuge darunter mit einem Klick nacheinander aus, ohne Vorschau: Wasserzeichen entfernen, Weiß entfernen, Farben korrigieren, winzige Segmente entfernen, Dopplungen entfernen, Kurven verbinden. Zum Schluss rückt er die Zeichnung auf 5 mm Abstand zum oberen und linken Rand.',
    tipRemoveWatermarks: 'Entfernt erkannte Wasserzeichen (z. B. Archicad Bildungsversion, Studenten-, Test- und Demoversionen) und richtet die Zeichnung danach oben links mit 5 mm Abstand aus. Erkannt wird nur, was als Text in der Datei steht.',
    tipJoinCurves: 'Verbindet gleichfarbige Linien, deren Enden sich berühren, zu einem Pfad und ersetzt fein zerlegte Kurven durch echte Kurven (max. 0,02 mm Abweichung). Ohne "Optimieren" hält der Laser sonst an jedem Stützpunkt an; mit "Optimieren" fährt er ohnehin flüssig, dann ändert sich die Zeit kaum.',
    resetView: 'Ansicht zurücksetzen',
    hideColor: 'Ausblenden',
    showColor: 'Einblenden',
    // Fit banner
    fitRotate: 'Passt nur gedreht ({dw}×{dh} mm auf {bw}×{bh} mm Bett)',
    rotateLeft: '90° ⟲ links',
    rotateRight: '90° ⟳ rechts',
    tooBig: '⚠ Design ({dw}×{dh} mm) ist größer als die Platte ({bw}×{bh} mm).',
    // Top-right controls
    toLight: 'Zu hellem Modus wechseln',
    toDark: 'Zu dunklem Modus wechseln',
    language: 'Sprache',
    // Overlays
    segments: 'Segmente',
    slow: 'langsam',
    fast: 'schnell',
    // Playback
    speed: 'Tempo',
    customSpeed: 'x',
    apply: 'Übernehmen',
    // Download + breakdown
    download: 'Herunterladen',
    estTime: 'Geschätzte Zeit',
    operation: 'Vorgang',
    distance: 'Strecke',
    time: 'Zeit',
    opVectorEngrave: 'Vektorgravur',
    opRasterEngrave: 'Rastergravur',
    opCut: 'Schnitt',
    opTravel: 'Leerwege',
    opOther: 'Sonstiges',
    total: 'Gesamt',
    smallPartsNote: '⚠ {n} Teile: Entnehmen & Aussortieren kostet zusätzlich ~{time}.',
    tinyPartsNote: '⚠ {n} winzige Teile (< 1,5 × 0,8 cm) können durchs Gitter fallen. Das Bergen kostet Zeit.',
    showParts: 'im Viewer anzeigen',
    hideParts: 'ausblenden',
    colorImagesNote: 'ℹ {n} farbige(s) Bild(er): wird in Graustufen als Rastergravur gelasert, nicht geschnitten.',
  },
  en: {
    // Sidebar
    upload: 'Open',
    uploading: 'Loading…',
    selectCutter: 'Select Cutter',
    selectMaterial: 'Select Material',
    searchMaterial: 'Search material…',
    noMatch: 'No match',
    selectThickness: 'Select Thickness',
    option: 'option',
    options: 'options',
    tipDpi: 'Raster engrave resolution (DPI). Follows the selected material automatically, can be overridden here for the current job.',
    customMode: 'Custom',
    tipCustomMode: 'Overrides the cut, vector-engrave and raster-engrave speeds from the material with your own values (% of max speed, same as the original software).',
    editCustomSpeeds: 'Edit custom speeds',
    customSpeedsTitle: 'Custom speeds',
    customSpeedsHint: 'Percent of max speed, same as the original software. Starts from the selected material’s own values and is reset to them whenever you pick a different one.',
    resetToDefaults: 'Reset',
    resetToPreset: 'Back to the {preset} values',
    machineEstimate: 'Machine estimate',
    tipMachineEstimate: 'Shows the number the Job Manager displays instead of the actual run time. The two differ systematically: raster finishes early, vector with a lot of travel runs late.',
    focusAll: 'Whole workpiece',
    focusLasered: 'Only what is lasered',
    focusVisible: 'Only visible colours',
    done: 'Done',
    close: 'Close',
    showRulers: 'Show rulers',
    imagesGray: 'Images as the laser sees them (grayscale)',
    optimizePath: 'Optimize (Job Manager)',
    pathOrderFile: 'Off',
    pathOrderNn: 'On (default)',
    pathOrder2opt: 'On, 2-opt (compare)',
    rasterBlock: 'Raster as solid block',
    rasterFilled: 'Filled',
    rasterOutline: 'Outline only',
    showTravel: 'Show travel moves',
    debug: 'Debug',
    speedGradient: 'Speed gradient (debug)',
    dbgSegments: 'Segment colours & count',
    dbgSpeed: 'Speed gradient',
    curveFidelity: 'Curve fidelity',
    tessNormal: 'Normal',
    tessFine: 'Fine',
    tessUltra: 'Ultra fine',
    fixColors: 'Fix Colors',
    removeWhite: 'Remove White',
    removeDoubles: 'Remove Doubles',
    noDoubles: 'No doubles',
    doublesArmedN: 'Remove {n} doubles',
    doublesDone: 'Doubles removed',
    colorsArmedN: 'Fix {n} colors',
    colorsNone: 'No colors to fix',
    colorsDone: 'Colors fixed',
    whiteArmedN: 'Remove {n} white',
    whiteNone: 'No white to remove',
    whiteDone: 'White removed',
    removeTinySegs: 'Remove Tiny Segments',
    tinySegsNone: 'No tiny segments',
    tinySegsArmedN: 'Remove {n} tiny segments',
    tinySegsDone: 'Tiny segments removed',
    autopilot: 'Autopilot',
    autopilotNone: 'Nothing to optimise',
    autopilotDone: 'Done: {n} of {m} steps',
    autopilotDoneSaved: '{n} of {m} steps, {t} faster',
    removeWatermarks: 'Remove Watermarks',
    watermarksArmedN: 'Remove watermark ({n} parts)',
    watermarksNone: 'No watermark found',
    watermarksDone: 'Watermark removed',
    joinCurves: 'Join Curves',
    joinCurvesArmedN: 'Join {n} segments',
    joinCurvesNone: 'Nothing to join',
    joinCurvesDone: '{n} paths joined',
    joinCurvesDoneSaved: '{n} paths, {t} faster',
    cleanAll: 'Fix Colors & Doubles',
    cleaning: 'Cleaning…',
    cleanAllDone: '{n} cleaned',
    cleanAllNone: 'Nothing to clean',
    mobileTagline: 'Laser job preview',
    noFileHint: 'Open a PDF or SVG file to estimate the time.',
    uploadError: 'Error opening file: ',
    svgTextWarning: 'The SVG file contains text that cannot be read as text. Please convert text to paths first or export as PDF.',
    // Tooltips
    tipRulers: 'Shows rulers (mm) along the top and left edges of the viewport.',
    tipOptimize: 'Matches the "Optimize" checkbox in the Epilog Job Manager. On: the machine sorts the paths (measured: nearest-neighbour) and drives through gentle bends. Off: file order, and the head stops at every vertex of a straight-line path - very slow for finely split curves (e.g. from Archicad). "2-opt" is for comparison only.',
    tipRaster: 'Draw engraving (green/grayscale) as one solid block that fills up, instead of the back-and-forth scan lines. Faster.',
    tipShowTravel: 'Shows the travel moves (rapid moves without the laser) as dotted lines.',
    tipDebug: 'Debug: random segment colours + show the segment counter (top-left).',
    tipSpeedGradient: 'Debug: colours segments by speed (blue = slow at corners, red = full march speed) - to debug acceleration.',
    tipRemoveDoubles: 'Finds coincident red/blue cut lines. 1st click highlights them, 2nd click removes them.',
    tipFixColors: 'Snaps near-red/-blue lines and near-green fills to pure red/blue/green.',
    tipRemoveWhite: 'Removes (near-)white lines/fills (often watermarks/artefacts).',
    tipRemoveTinySegs: 'Removes lines/curves under 0.005 mm long - extraction noise that occasionally trips up the machine\'s own optimiser.',
    tipAutopilot: 'Runs every tool below one after another with a single click, without preview: remove watermarks, remove white, fix colours, remove tiny segments, remove doubles, join curves. Finally it moves the drawing to 5 mm from the top and left edge.',
    tipRemoveWatermarks: 'Removes detected watermarks (e.g. Archicad educational, student, trial and demo versions) and then moves the drawing back to 5 mm from the top-left corner. Only watermarks stored as text in the file are detected.',
    tipJoinCurves: 'Joins same-colour lines whose ends touch into one path and replaces finely split curves with real curves (max. 0.02 mm deviation). Without "Optimize" the laser otherwise stops at every vertex; with "Optimize" it already runs smoothly, so the time barely changes.',
    resetView: 'Reset view',
    hideColor: 'Hide',
    showColor: 'Show',
    // Fit banner
    fitRotate: 'Only fits rotated ({dw}×{dh} mm on {bw}×{bh} mm bed)',
    rotateLeft: '90° ⟲ left',
    rotateRight: '90° ⟳ right',
    tooBig: '⚠ Design ({dw}×{dh} mm) is larger than the bed ({bw}×{bh} mm).',
    // Top-right controls
    toLight: 'Switch to light mode',
    toDark: 'Switch to dark mode',
    language: 'Language',
    // Overlays
    segments: 'Segments',
    slow: 'slow',
    fast: 'fast',
    // Playback
    speed: 'Speed',
    customSpeed: 'x',
    apply: 'Apply',
    // Download + breakdown
    download: 'Download',
    estTime: 'Estimated time',
    operation: 'Operation',
    distance: 'Distance',
    time: 'Time',
    opVectorEngrave: 'Vector engrave',
    opRasterEngrave: 'Raster engrave',
    opCut: 'Cut',
    opTravel: 'Travel',
    opOther: 'Other',
    total: 'Total',
    smallPartsNote: '⚠ {n} parts: removing & sorting adds ~{time}.',
    tinyPartsNote: '⚠ {n} tiny parts (< 1.5 × 0.8 cm) may fall through the grid. Retrieving them takes time.',
    showParts: 'show in viewer',
    hideParts: 'hide',
    colorImagesNote: 'ℹ {n} colour image(s): engraved in grayscale as a raster, not cut.',
  },
}

const STORAGE_KEY = 'chronocut-lang'
let stored = null
try { stored = localStorage.getItem(STORAGE_KEY) } catch { /* ignore */ }

export const locale = ref(messages[stored] ? stored : 'de')

export function setLocale(code) {
  if (!messages[code]) return
  locale.value = code
  try { localStorage.setItem(STORAGE_KEY, code) } catch { /* ignore */ }
}

// Translate `key`, interpolating {placeholders} from `params`. Reading
// locale.value here is what makes callers reactive to language changes.
export function t(key, params) {
  const dict = messages[locale.value] || messages.de
  let s = dict[key]
  if (s == null) s = messages.en[key] != null ? messages.en[key] : key
  if (params) s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : ''))
  return s
}

export const currentLang = computed(() => LANGS.find((l) => l.code === locale.value) || LANGS[0])
