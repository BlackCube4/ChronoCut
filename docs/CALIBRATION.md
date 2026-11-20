# Zeitmodell-Kalibrierung - Epilog Fusion "Edgar" (60 W)

Auswertung von 61 Kalibrierdateien / 87 Läufen (`messprotokoll.xlsx`).
Stand: September 2026 (dritte Messreihe).

## Zwei Schichten, weil es zwei Größen gibt

**Zielgröße ist die Zeit, die die Maschine TATSÄCHLICH braucht.** Die ist aber
nicht dasselbe wie die Zahl, die der Job Manager anzeigt, und die beiden sind
unterschiedlich gut belegt:

| | Datenlage | Modell trifft |
|---|---|---|
| **Anzeige** des Job Managers | 87 Läufe, beide Spalten | **Ø 0,60 %**, Median 0,33 %, max 4,1 % (n = 164) |
| **Gestoppte Laufzeit** | 25 Läufe | **Ø 1,1 %**, max 3,3 % |

Deshalb rechnet das Modell in zwei Schritten: `CALIBRATION` bildet die Anzeige
nach (dafür reichen die Daten für eine dichte Kalibrierung), `REALITY` korrigiert
von dort auf die echte Laufzeit. Die App zeigt die echte Laufzeit
(`stats.totalTime`); die Zahl der Maschine bleibt als `stats.displayTime`
erhalten.

In der App lässt sich zwischen beiden umschalten: **Debug-Menü → „Maschinen-
Schätzung"**. Aus ist die tatsächliche Laufzeit (Standard), an die Zahl, die am
Gerät steht. Umgeschaltet wird an genau einer Stelle (`publishStats` in
`ThreeViewer.vue`) - alle Anzeigen lesen weiter `stats.totalTime`.

Der einzige Ausreißer im Anzeige-Fit ist `43_home_far` mit 4,1 % - dessen
13-Sekunden-Anzeige löst nur auf ±3,8 % auf. Die zwei gemischten
Validierungsdateien (34/35), die **nicht** mitgefittet wurden, treffen auf
−0,4 % / −0,9 %.

---

## 0. Vierte Messreihe (Oktober 2026) - was übernommen wurde und was nicht

Neu im Protokoll: Vektorreihe 03-19 bei **100 %**, Stoppuhr für die
Zickzack-, Kreis-, Polygon-, Strich- und Rasterreihe, sechs Läufe auf
**George**, `12_zigzag_n64` neu abgelesen (151 statt 180 s, damit kein
Ausreißer mehr). `fit_model.py` enthält jetzt alle 103 Läufe.

**George:** zeigt bei allen sechs Läufen exakt dieselbe Zeit wie Edgar.

**Anzeige-Konstanten: NICHT übernommen.** Ein Neufit über alle Läufe
(a = 4568 mm/s², Eckzuschlag 28,7 ms) holt 100 % von Ø 8,1 % auf Ø 3,7 %,
macht 8 % aber schlechter (0,74 → 1,18 %) und schätzt die
Produktionsdateien deutlich zu kurz (gegen die Anzeige −3 bis −12 % statt
0 bis −7 %; Achtung, siehe Abschnitt 4: dieses Blatt ist noch nicht
verlässlich, die Entscheidung wird mit dem kompakten Satz 80-94 neu
getroffen, Abschnitt 8). Auch ohne den schlimmsten Lauf (15_polygon_12, 100 %,
optimiert: angezeigt 20 s, Modell 26-29 s) bleibt das so. Ursache ist das
Eckenmodell: voller Halt über 28°, sonst nichts. Bei hoher Geschwindigkeit
bremst die Maschine an mittleren Ecken nur ab. Solange das nicht modelliert
ist, verzerrt die 100-%-Reihe die Beschleunigung. → **nächster Schritt:
Eckenmodell mit Teilabbremsung (z. B. junction deviation), dann neu fitten.**

**Realitätsschicht: neu gefittet** (`docs/calib/fit_reality.mjs`, 116
gestoppte Werte), jetzt gegen die ABGELESENE Anzeige statt gegen die
Modell-Anzeige, und mit einem fünften Term **je Eckhalt (8,5 ms)**. Eilgang
bleibt 215 mm/s.

**Achtung `fill_protocol_com.py`:** schreibt neben den CC-Spalten den
Testplan der dritten Reihe an feste Zeilen und überschreibt damit die
Oktober-Blöcke (George, 100 %). Nicht laufen lassen, bevor es auf
Zeilensuche umgestellt ist.

## 1. Konstanten (eingebaut in `frontend/src/calibration.js`)

### Vektor (Schnitt + Vektorgravur)
| Größe | Wert |
|---|---|
| Geschwindigkeit | `2,550 mm/s je Speed-%` → **255 mm/s bei 100 %** |
| Beschleunigung | **2754 mm/s²** |
| Eckenzuschlag | **21,9 ms** je echter Ecke |
| Ecken-Schwelle | Knick **> 28°** |
| Startaufwand je separatem Vektor | **36,9 ms** |
| Leerweg (Anzeige) | **250 mm/s** konstant, Anfahrt **und** Rückweg zählen |
| Pfadreihenfolge bei „Optimieren" | **greedy nearest-neighbour** |

### Raster (Gravur)
Zeit je Scanzeile = `Zeilen-Overhead + span / v_raster`, dazu **320,7 ms je mm
gescannter Höhe**. Zeilen ohne Inhalt entfallen ganz.

| Speed-% | v_raster | mm/s je % | Zeilen-Overhead |
|---|---|---|---|
| 10 % | 178,5 mm/s | 17,85 | 150,3 ms |
| 20 % | 357,4 mm/s | 17,87 | 82,9 ms |
| 40 % | 727,9 mm/s | 18,20 | 83,0 ms |
| 60 % | 1089,3 mm/s | 18,15 | 94,4 ms |
| 80 % | 1461,5 mm/s | 18,27 | 109,4 ms |
| 100 % | 1806,2 mm/s | 18,06 | 102,4 ms |

### Global
Job-Overhead **0,649 s**. **Leistung (Power) hat keinen Einfluss auf die Zeit.**

### Anzeige → Realität
| Domäne | Korrektur |
|---|---|
| Raster | **−12,67 ms je Scanzeile**, **−123,3 ms je mm gescannter Höhe** |
| Vektor | **+9,39 ms je Kontur**, **+0,645 ms je mm Leerweg** |

Der Leerweg-Term entspricht einem echten Eilgang von **215 mm/s** statt der
250 mm/s, mit denen die Anzeige rechnet.

---

## 2. Was die dritte Messreihe geändert hat

### a) Die Rastergeschwindigkeit ist linear - und war vorher an zwei Stufen falsch

Das Paar `54_rast_overscan` / `55_rast_speed` (zwei Balken gleicher Höhe, 1 mm
bzw. 1000 mm breit) ist jetzt bei **allen sechs** Stufen gefahren. Aus der
Differenz folgt die Geschwindigkeit direkt:

```
v = 200 Zeilen × 999 mm / (t55 − t54)
```

ohne jeden Overhead-Term - der hebt sich heraus. Ergebnis: 17,85 bis 18,27 mm/s
je Prozent, also praktisch linear. Die alte Tabelle lag bei 10 % um −13 %, bei
40 % um +7 % und bei **80 % um −21 %** daneben (1150 statt 1461).

Damit ist auch die offene Frage aus der zweiten Reihe beantwortet: die
abgelesenen 334 s bei 80 % waren **richtig**, die Aufteilung im Modell war
falsch. Meine damalige Vermutung, das könnte ein verlesenes 5:14 sein, war es
nicht.

### b) Der Zeilen-Overhead ist U-förmig

`54_rast_overscan` (1 mm Spannweite) misst ihn fast pur: 40 / 26 / 26 / 28 / 31 /
29 s über die sechs Stufen. Hoch bei langsam, Minimum bei 20-40 %, zu hohen
Geschwindigkeiten hin wieder steigend.

Das ist weder ein fester Zeitanteil noch eine Beschleunigungsrampe. Ein fester
Overscan-**Weg** plus Rampe (`A0 + 2d/v + v/a`) kommt der Form nahe - physikalisch
die naheliegende Erklärung - trifft die Rasterdaten aber nur auf Ø 2,2 % mit
8,7 % Maximalfehler. Die gemessene Tabelle bleibt näher an dem, was die Maschine
tut, und steht deshalb so im Code.

Folge für den Viewer: der gezeichnete Overscan ist **ganz entfallen**. Er war aus
dem Overhead hergeleitet, unter der Annahme, dass der Overhead ein Auslaufweg
*ist* - und genau die ist widerlegt.

### c) Die Auflösung bremst das Raster nicht

Dasselbe Paar bei 600 statt 200 dpi ergibt 1789 mm/s gegen 1816 mm/s. Eine
Punktfrequenz-Grenze, die hohe dpi ausbremst, gibt es also nicht.

### d) Die Pfadreihenfolge ist bewiesen, nicht mehr erschlossen

`61_order_numbers` (25 lesbare Zahlen über das ganze Blatt, in Dateireihenfolge
nummeriert) wurde gefilmt. Beobachtete Reihenfolge:

```
11 04 09 03 16 24 12 18 22 23 20 02 01 08 25 07 21 05 10 17 19 15 14 13 06
```

Das ist **Zeichen für Zeichen die Vorhersage von greedy nearest-neighbour**, alle
25 Positionen. 2-opt weicht ab Position 3 ab. `DEFAULT_PATH_ORDER = 'nn'` ist
damit direkt belegt statt aus Zeitbudgets geschlossen.

### e) Anzeige und Realität weichen systematisch ab

25 gestoppte Läufe, und die Abweichung hat in beiden Domänen eine klare Form:

* **Raster läuft schneller als angezeigt** (Verhältnis 0,77 bis 0,92). Zwei Terme
  - je Scanzeile und je mm Gravurhöhe - reproduzieren alle neun Rastermessungen
  auf **0,7 s** genau, über 200 bis 1890 Zeilen und 25 bis 80 mm Höhe. Das ist
  besser als die ±0,5 s, mit denen jede der beiden abgelesenen Zahlen behaftet
  ist.
* **Vektor läuft langsamer als angezeigt** (1,02 im Mittel), und zwar proportional
  zum **Leerweg**, nicht zur Konturenzahl: `56`/`57` (400/800 Konturen, kaum
  Leerweg) gegen `41`/`61` (viel Leerweg) trennen die beiden Terme sauber.

---

## 3. Aus der ersten Messreihe, unverändert gültig

**`span` ist die Spannweite PRO SCANZEILE, nicht die Breite der Bounding-Box.**
Dateien 30–32 trennen das sauber: `30_rast_frame` (100×100 mit 90×90-Loch)
kostet die vollen 100 mm je Zeile, `32_rast_triangle` nur die mittlere
Zeilenbreite von 50 mm.

**Raster und Vektor haben verschiedene Geschwindigkeitsskalen.** Vektor 100 %
≈ 255 mm/s, Raster 100 % = 1820 mm/s - Faktor 7. Raster-% gegen die
Vektor-`maxSpeed` zu rechnen ist grob falsch.

**Leerwege laufen konstant mit 250 mm/s** und skalieren nicht mit der
Speed-Einstellung (Kameramessung, nicht gefittet).

---

## 4. Gegenprobe auf echten Produktionsdateien

Echte Produktionsdateien sind Arbeiten anderer Leute und liegen nicht im Repo;
ihre Einzelwerte stehen deshalb auch nicht hier. Sie fließen in keinen Fit ein
und dienen nur als grober Plausibilitätscheck.

---

## 5. Offene Punkte

**1. Einer Produktionsdatei fehlt eine Minute.** Die einzige reale Datei, die deutlich
danebenliegt - und zwar in beiden Schichten gleich (−6,9 % gegen die Anzeige,
−8,9 % gegen die gestoppte Zeit). Es ist also kein Fehler der Realitätskorrektur,
sondern der Anzeige-Nachbildung auf genau dieser Datei. 826 Konturen, viel
Leerweg. Jede weitere reale Datei mit **gesichertem Preset** hilft hier; vier
Dateien sind eine dünne Stichprobe.

**2. Die Beschleunigung hängt an zwei Läufen.** Bei 8 % Speed - mit dem fast die
gesamte Vektorreihe gefahren wurde - kostet die Rampe 7,4 ms je Fahrt, und jede
Strecke über 0,08 mm erreicht die Sollgeschwindigkeit. Der Beschleunigungsanteil
liegt dort unter 3 %, meist unter 1 %. Ein Scan über festgehaltene `a`-Werte
zeigt: das Minimum bei 2754 wird praktisch nur von `11_zigzag_n32` bei 40 % und
`05_vline_100` bei 100 % getragen.

→ **Bestehende Dateien bei hohem Speed fahren**, keine neue Datei nötig. Am
meisten sagt `13_zigzag_n128` bei 50 / 75 / 100 % (30 s Spreizung zwischen
a = 2000 und a = 4000), dann `49_angle_32` bei 50/100 % (16 s) und
`11_zigzag_n32` bei 75/100 % (8,5 s). `07_vline_250` bei 100 % ist die
Gegenkontrolle mit nur 1,3 s Spreizung.

→ Besonderheit: ab 46 % Speed ist in `13_zigzag_n128` **jede** Fahrt dreieckig,
dort gilt `t = 2·√(s/a)` und die Speed-Einstellung fällt heraus. Zeigt die
Maschine bei 50, 75 und 100 % dieselbe Zeit, ist `a` direkt ablesbar und hängt an
keiner anderen Konstanten. Rechenskripte: `docs/calib/accel_sensitivity.py` und
`accel_proposal.py`.

**3. Noch nicht gemessen** aus dem Testplan der dritten Reihe: `58_order_big`
(Reihenfolge bei 300 Konturen - durch `61_order_numbers` allerdings weitgehend
erledigt), `59_zigzag_n48` / `60_zigzag_n80` (Nachbarn des Ausreißers
`12_zigzag_n64`), `34_combo_A` bei Raster 100 %.

**4. George (120 W) hat weiterhin null Daten.** Die Spalten `est G` / `meas G`
sind leer geblieben. Erwartung: kinematisch identisch zu Edgar.

**6. Bilder und „explodierte“ Linien (Dateien 62–73, November 2026).**
Erzeugt mit `docs/calib/make_edge_tests.py`. Jeweils die Job-Manager-Anzeige
notieren; Vorhersage des Modells in Klammern.

| Datei | Einstellung | klärt |
|---|---|---|
| 62 `img_vector_ref` (99 s) | Raster 20 %, 600 dpi | Referenz: schwarze Vektorfläche 40 × 20 mm |
| 63 `img_gray`, 64 `img_color` (je 99 s) | dito | kostet ein Bild (grau / farbig) dasselbe wie die Fläche? |
| 65 `img_white_margin`, 66 `img_alpha_margin` (je 99 s) | dito | zählt weißer / transparenter Rand im Bild mit? |
| 67 `img_lightgray` (99 s), 68 `img_nearwhite` (0,6 s) | dito | ab welcher Helligkeit fährt der Kopf die Zeilen nicht mehr ab? (Modell: Schwelle 97 %) |
| 69 `img_triangle` (145 s) | dito | Spannweite je Zeile auch bei Bildern? |
| 70 `circle_exploded` (144 / 169 s) | Schnitt 8 %, **mit und ohne** Optimieren | Geometrie wie 14, aber Einzellinien: verbindet die Maschine sich berührende Objekte? Modell: ja, also exakt wie 14. |
| 71 `circle_fine_poly` (14 / 51 s), 72 `circle_fine_exploded` (14 / 51 s), 73 `circle_bezier` (14 / 14 s) | dito | Archicad-Feinheit (0,2 mm) als Pfad, als Einzellinien, als Bézier |

**5. `12_zigzag_n64` bleibt ein Ausreißer.** Angezeigt 181 s, Modell 150 s.
Reproduzierbar, aus dem Fit ausgeschlossen. Punkt 3 würde klären, ob es ein
schmaler Einzelfall ist oder ein ganzes Band von Segmentlängen.

---

## 6. Was im Code geändert wurde

| Datei | Änderung |
|---|---|
| `frontend/src/calibration.js` | Alle Konstanten neu; `rasterLineOverhead` ist jetzt eine **Funktion** der Rastergeschwindigkeit (`rasterLineBase` + `rasterLineRamp`); `RASTER_SPEED_TABLE` bis 100 % gemessen, Deckelung entfällt; `returnToHome` neu |
| `toolpath.js` | Eckenschwelle 20° → 28°, Eckenzuschlag 21,6 ms, Vektor-Startaufwand 69 → 35 ms |
| `toolpath.js` | **Rückweg zum Ursprung** wieder eingebaut (nach den Vektorphasen, ohne Startaufwand) |
| `toolpath.js` | Raster: **kein Leerweg** mehr in ein Band hinein oder zwischen zwei Bändern |
| `toolpath.js` | Raster: fester Anteil des Zeilen-Overheads + Y-Vorschub als **Zeit** über `moveExtraTime` (nutzt `m.rows`/`m.pitch`), nur noch der geschwindigkeitsabhängige Anteil als gezeichneter Overscan |
| `toolpath.js` | `DEFAULT_PATH_ORDER` `'2opt'` → `'nn'` |
| `edgar.xml`, `george.xml`, `Converter.py` | `maxSpeed` 252 → 255, `accel` 2370 → 2715 |

**Nachtrag November 2026 - „Optimieren aus“ in der App.** Die Regel aus dem Fit
(`moves_and_stops(every_vertex=True)`: ohne „Optimieren“ hält die Maschine an
jedem Stützpunkt einer GERADEN Linie, an Bézierkurven nicht) stand bisher nur in
`fit_model.py`. Die App rechnete auch bei Pfadreihenfolge „Aus“ wie mit
„Optimieren“. Jetzt: `forcedStopsFor()` in `toolpath.js`, aktiv bei `'file'`.
`verify_js.mjs` prüft beide Spalten: mit Optimieren Ø 0,73 % (n = 55), ohne
Ø 0,77 % (n = 34), z. B. `14_circle_d80` 169,1 s gegen 169 s gemessen (vorher
~145 s). Anlass: Archicad-Exporte („Arbeitsmodell P*“) bestehen aus tausenden
0,2-mm-Einzellinien; ohne Optimieren ergibt das P6 = 13 min statt 2 min. Das
Werkzeug „Kurven verbinden“ ersetzt solche Ketten durch Bézierkurven.

Verifikation des Produktivcodes gegen 55 Kalibrierfälle: **Ø 0,61 %, max 4,1 %**
(`43_home_far`, dessen 13-s-Anzeige nur auf ±0,5 s ≈ ±3,8 % auflöst).
`npm run build` läuft durch.

---

## 7. Rohdaten & Skripte

| Datei | Zweck |
|---|---|
| `docs/calib/fit_model.py` | Der Fit. Messwerte als `DATA` eingebettet, Geometrie aus den echten SVGs. `python fit_model.py` gibt Parameter + Residuentabelle aus und schreibt `fitted_params.json`. Braucht `scipy`. |
| `docs/calib/svg_geometry.py` | SVG-Parser + Scanline-Zerlegung für den Rasterteil |
| `docs/calib/svg_to_data.mjs` | Kalibrier-SVG → die Extraktionsobjekte, die `buildToolpath()` erwartet |
| `docs/calib/verify_js.mjs` | Prüft den **Produktivcode** gegen 55 Kalibrierfälle |
| `docs/calib/make_tests.py` | Erzeugt die neuen Kalibrierdateien 56-60 |
| `docs/calib/make_number_test.mjs` | Erzeugt `61_order_numbers.svg` und sucht das Layout, das die Reihenfolge-Strategien am besten trennt |
| `docs/calib/predict_all.mjs` | Rechnet jede Protokollzeile durch → `predictions.json` |
| `docs/calib/fill_protocol.py` | Schreibt `est CC`/`opt_est CC` und den Testplan in die xlsx (legt vorher eine Sicherung an) |
| `docs/calib/fill_protocol_com.py` | Dasselbe über Excel selbst (COM) - verlustfrei, siehe Kasten unten |
| `docs/calib/extract_protocol.py` | Zieht `DATA` + `MEASURED` aus der xlsx als Python-Literale - Abtippen ist die einzige Fehlerquelle, die sich nicht nachrechnen lässt |
| `docs/calib/accel_sensitivity.py` | Anteil der Beschleunigung an der Fahrzeit, je Datei und Speed |
| `docs/calib/accel_proposal.py` | Rangliste, welche Läufe die Beschleunigung festnageln würden |
| `docs/calib/register.mjs` | Loader-Hook, damit Node die endungslosen Imports des Frontends auflöst |

```bash
python docs/calib/fit_model.py
cd frontend && node --import ../docs/calib/register.mjs ../docs/calib/verify_js.mjs
```

Nach jeder Änderung an `calibration.js` die Protokollspalten nachziehen
(**messprotokoll.xlsx muss dafür in Excel geschlossen sein**):

```bash
cd frontend && node --import ../docs/calib/register.mjs ../docs/calib/predict_all.mjs && cd .. && python docs/calib/fill_protocol_com.py
```

**Warum die COM-Variante:** `fill_protocol.py` (openpyxl) schreibt die Mappe neu
und verliert dabei Excel-eigene Teile - `calcChain`, `sharedStrings`, die
Revisionsdaten. Die Zellinhalte bleiben vollständig, aber Excel meldet beim
Öffnen „[Repariert]". `fill_protocol_com.py` lässt Excel selbst speichern; der
Teilebestand der Datei bleibt dann bitgenau erhalten.

Eine Falle noch, die schon einmal zugeschlagen hat: openpyxl speichert **jeden
String, der mit `=` beginnt, als FORMEL**. Abschnittsüberschriften im Protokoll
beginnen deshalb mit `---`, nicht mit `===` - sonst landen ungültige Formeln in
der Mappe und Excel repariert beim nächsten Öffnen.

Die Geometrie wird **nicht mehr von Hand nachgebaut**, sondern aus den echten
Kalibrier-SVGs gelesen. Erst dadurch waren die Dateien 36–55 überhaupt
auswertbar; von Hand eingetragen sind nur noch die abgelesenen Zeiten.

Modellvarianten lassen sich direkt vergleichen, z. B.:

```bash
python docs/calib/fit_model.py home=0       # ohne Anfahrt/Rueckweg
python docs/calib/fit_model.py theta=20     # alte Eckenschwelle
python docs/calib/fit_model.py order=2opt   # andere Pfadreihenfolge
```

---

## 8. Kompakter Messsatz 80-93 (November 2026)

Ziel: mit **14 Dateien und rund 40 min Laserzeit** jede Stellschraube des
Modells neu bestimmen, statt 73 Dateien vorwiegend bei 8 % zu fahren. Gebaut
von `docs/calib/make_kompakt.py`, Plan und Vorhersage von
`docs/calib/plan_kompakt.mjs`, Tabelle `laser time calibration/messplan_kompakt.xlsx`
(`make_messplan.py`: Kopie von messprotokoll.xlsx ohne alte Werte, gelb = cutten,
blau = nur ablesen; fertige Zeilen unten an das Blatt „Messprotokoll“ anhängen).

**Wie gemessen wird:** Beide Zahlen kommen vom Cutter selbst, es gibt keine
externe Stoppuhr. Beim Senden zeigt er die Schätzung (est), nach dem Cut die
tatsächlich gebrauchte Zeit (meas). Die gemessene Zeit ist reproduzierbar
(Wiederholungen bringen nichts), hat aber nur ganze Sekunden, also ±0,5 s.
Deshalb dauert jeder Lauf im Plan mindestens ~30 s (Fehler ≤ 1,7 %).

**Bekannt, nicht gemessen:** Die Maschine arbeitet Farbe für Farbe ab, immer
Grün (Raster) → Rot (Vektorgravur) → Blau (Schnitt). So rechnet auch
`toolpath.js`.

Prinzip: jede Datei enthält **eine** Größe dominant, und jede Vektordatei
läuft bei **15 / 40 / 100 %**. Damit trennen sich die Anteile, die mit 1/v
skalieren (Schnittweg), die konstant sind (Startaufwand, Halte, Eilgang) und
die mit v wachsen (Rampen, Teilabbremsung). Anzeige ablesen kostet nur das
Senden; gecuttet wird nur, was gelb ist.

| Datei | dominante Größe | Gegenstück |
|---|---|---|
| 80_k_gerade (7,5 m Serpentine) | Höchstgeschwindigkeit, Linearität Speed-% | – |
| 81_k_striche (400 × 2 mm) | Startaufwand je Vektor, kurze Rampen | 80 |
| 82_k_leerweg (42 Punkte, Zufallsreihenfolge) | Eilgang, Reihenfolge („Optimieren“), Eilgang unabhängig vom Speed? | – |
| 83-86_k_winkel_020/045/090/150 (je 6,4 m) | Ecke als Funktion von Winkel und Geschwindigkeit | untereinander |
| 87_k_kreise_klein (150 × r 2 mm) | enge Krümmung | 88 |
| 88_k_kreise_gross (14 Kreise, 7,5 m) | weite Krümmung; Kurven ohne „Optimieren“ (14_circle_d80 @100 %: 73 s statt 15 s!) | 80 |
| 89_k_explodiert | neuer Vektor ohne Leerweg statt Ecke (Archicad) | 85 (identische Geometrie) |
| 90_k_raster_block (80 × 25 mm) | Zeilen-Overhead, v Raster, Y-Vorschub, dpi | – |
| 91_k_raster_inseln | Spannweite oder Tinte? | 90 (gleiche Zeilen, 20 % Tinte) |
| 92_k_raster_bild | Bild = Fläche? weißer Rand? Grau? | 90 |
| 93_k_kombi | Wechsel Grün → Rot → Blau | Summe der Teile |

Was das heutige Modell erwartet (Auszug aus `plan_kompakt.mjs`) und wo es
voraussichtlich danebenliegt:

* **83-86:** Das Modell sagt für 45°, 90° und 150° bei jeder Geschwindigkeit
  dieselbe Zeit (voller Halt). Wenn die Maschine an flachen Ecken nur
  abbremst, fällt 45° bei 100 % deutlich kürzer aus. Daraus wird das neue
  Eckenmodell gefittet.
* **88 ohne „Optimieren“:** Modell = mit „Optimieren“ (Bezier ist von den
  Zwangshalten ausgenommen). Die 100-%-Daten von 14_circle_d80 sagen etwas
  ganz anderes.
* **91:** Modell = 90 (Spannweite zählt). Ist 91 kürzer, überspringt der Kopf
  Lücken.
* **82 bei 15/40/100 %:** Modell = gleich (Eilgang hängt nicht vom Speed ab).

Danach: Eckenmodell mit Teilabbremsung in `fit_model.py` und `toolpath.js`,
Anzeige-Schicht neu fitten, mit diesem Satz als Kern und 01-73 als
Gegenprobe.

---

## 9. Neukalibrierung mit dem kompakten Satz (19.11.2026)

Gefittet mit `docs/calib/fit_all.mjs` - **auf dem Produktivcode**: `buildToolpath()`
liefert je Lauf die Geometrie (Reihenfolge, Halte, Länge jeder Fahrt, Leerwege,
Scanzeilen), die Zeit ist danach eine geschlossene Formel in den Konstanten,
identisch mit `toolpath.js` (Selbsttest: Abweichung < 1e-9 s). Daten: Reihen 1-4
(`fit_model.py` DATA/MEASURED), kompakter Satz 80-93 und die zwei Zeilen der Produktionsdateien A/B
(`python extract_kompakt.py` → `data/kompakt.json`; Dateien in `data/`).
`fit_model.py` und `fit_reality.mjs` sind damit abgelöst.

Prüfen: `cd frontend && node --import ../docs/calib/register.mjs ../docs/calib/verify_all.mjs [kompakt|alt|real]`

### Ergebnis (Produktivcode gegen Cutter)

| | n | Ø | max |
|---|---|---|---|
| Anzeige, Reihen 1-4 | 202 | 0,74 s | 5,1 s |
| Anzeige, kompakter Satz | 76 | 0,73 s | 2,3 s |
| Anzeige, Produktionsdateien (3 von 4) | 3 | 6 s (1,2 %) | 9 s |
| gemessen, Reihen 1-4 | 116 | 0,63 s | 2,8 s |
| gemessen, kompakter Satz | 31 | 1,5 s | 3,7 s |

Vorher (alte Konstanten): Anzeige kompakt Ø 2,8 s / max 17 s, Produktionsdateien bis 234 s daneben.

### Was neu im Modell ist

1. **Beschleunigung der Anzeige wächst mit der Geschwindigkeit**: a = 1758 + 5,42·v
   (8 %: 1868, 100 %: 3132 mm/s²). Belegt durch 81 und 84-86: dreieckige Fahrten
   (Sollgeschwindigkeit nie erreicht) sind bei 100 % schneller als bei 40 %.
2. **Ecken**: Schwelle 30° statt 28° (15_polygon_12 @100 %). 45°/90°/150° kosten
   exakt gleich - **keine Teilabbremsung**, die Vermutung aus Abschnitt 0 ist widerlegt.
3. **Objekte statt verketteter Konturen** (`reconstructObjects`): die Maschine fährt
   die Pfadobjekte der Datei. Ohne „Optimieren" in Dateireihenfolge, je Objekt ohne
   Leerweg davor 27 ms Halt + 9 ms je Objekt (89: +16 s gegenüber 85). Mit
   „Optimieren": **nächster Anfangspunkt, Objekte werden nie umgedreht**, Durchfahrt
   nur, wo das nächste Objekt genau am Ende des vorigen beginnt. Getestete
   Alternativen auf Produktionsdatei A (Corel) (angezeigt 516 s): alles verketten 398 s, Halt an
   jedem Objekt 591 s, diese Regel 511 s.
4. **Raster**: fester Aufwand 0,74 s je Band; Tabelle mit allen Rasterläufen nachgefittet.
5. **Realität = eigene Kinematik** statt linearer Korrektur (`REALITY`, `realMoveTime`):
   a ≈ 2492 + 0,53·v (fast konstant), Halt 34 ms − 0,062 ms je mm/s, Vektorstart 34 ms,
   Leerweg 258 mm/s, +0,18 mm/s auf die Vektorgeschwindigkeit, Raster −12,7 ms je
   Zeile und −0,117 s je mm Höhe.

### Offen

* **Produktionsdatei B (Corel + ChronoCut-Edit) ohne „Optimieren"**: angezeigt 954 s, Modell 1132 s.
  Datei stammt aus der alten Version (Doppelte-Entfernen hatte Pfadstücke verstreut,
  1500 Leerwege). Keine getestete Regel (Teilpfade nach Nähe, Richtung nach Nähe,
  Eilgang/Beschleunigung frei) erklärt das, ohne alles andere zu verschlechtern.
  Aus dem Fit genommen. → mit der neuen Version neu exportieren und messen.
* **Gemessene Zeit, Rest 3-4 s**: der Mehraufwand je Halt ist nicht linear
  (8 %: ~45 ms, 40 %: ~6 ms, 100 %: 15-31 ms je nach Segmentlänge). Deutet auf
  ruckbegrenzte (S-förmige) Beschleunigung der echten Maschine.
* **92_k_raster_bild** nicht im Fit (Bildtinte braucht den Browser); Anzeige = 90.
* George: weiterhin keine eigenen Werte.

### Nachtrag 20.11.2026

* **Ruck (S-Kurve) für die echte Maschine getestet** (`sCurveTime`, j fest 3000 bis
  1 000 000 mm/s³, Rest jeweils neu gefittet): jeder endliche Ruck ist schlechter als
  keiner (j = 30 000: Ø 2,2 s statt 0,6 s). Verworfen. Korrektur: der Mehraufwand je
  Halt ist ~11 ms bei 8 %, ~6 ms bei 40 %, 8-15 ms bei 100 % (vorher falsch mit 45 ms
  angegeben, Zickzack-Halte verzählt).
* **Getrennte Fits je Spalte** (`SPLIT=1`): Anzeige ohne/mit Optimieren getrennt
  bringt Ø −0,1 s und bei den Produktionsdateien 4-6 s → übernommen als `CALIBRATION.optimized`
  (eigene Beschleunigung, Eckzuschlag, Vektorstart; `OPT=1` im Fit). Gemessene
  Zeit getrennt: kein Gewinn → bleibt ein gemeinsamer Fit.
* Ohne Optimieren ist ein Zuschlag „je Objekt" in der Anzeige mit Vektorstart und
  Objekthalt deckungsgleich (Fit lief auf −33 ms) → nur noch in REALITY.
* Stand: Anzeige Ø 0,73 s (alt) / 0,67 s (kompakt), gemessen Ø 0,63 / 1,49 s,
  Produktionsdateien 1273/516/447 → 1268/514/447 s. Fit-Befehl:
  `OPT=1 CAL="fileObjectPenalty=0" RFREE="kv0,a0,a1,p0,p1,pv,pf,vt,rpl,rph" FREE="kv,a0,a1,p0,pv,pj,rb,yf,c0,vr,ovh" node ... fit_all.mjs write`
