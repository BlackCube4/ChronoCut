# Randfälle für die Werkzeuge

Zum Hochladen in ChronoCut, nicht zum Lasern. Erzeugt mit
`python docs/calib/make_edge_tests.py` (neu erzeugen überschreibt die Dateien).

| Datei | Was drin ist | Erwartet |
|---|---|---|
| `edge_wasserzeichen.pdf` | Inhalt bei (60, 60) mm, Archicad-Marker „GSEducationalVersion“ (weiß, 4 pt), Stempelbild „ARCHICAD BILDUNGSVERSION“, Plotstempel „PRODUCED BY AN AUTODESK STUDENT VERSION“ | „Wasserzeichen entfernen“ findet 55 Teile (Marker, ganze Stempelzeile, Bild). Danach liegt der Inhalt bei (5, 5) mm. |
| `edge_wasserzeichen_falscher_alarm.pdf` | Normaler Text „Testversion 2 - bitte gravieren“ | Wird fälschlich als Wasserzeichen erkannt. Dafür ist die Vorschau beim ersten Klick da. |
| `edge_weiss.pdf` | Quadrate: weiß/weiß, weiße Füllung + blauer Rand, grüne Füllung + weißer Rand, #F5F5F5, #EEEEEE, nur weißer Rand, weiße Linie | „Weiß entfernen“: Weiß und #F5F5F5 weg, blauer Rand und grüne Füllung bleiben, #EEEEEE bleibt. |
| `edge_farben.pdf` | Rot, fast Rot, Blau, fast Blau, Orange, Magenta, Schwarz; Grün, fast Grün, Grau 50 % | „Farben korrigieren“: 3 Änderungen (fast Rot, fast Blau, fast Grün). Orange und Magenta bleiben „Sonstiges“. Schwarz und Grau gelten als Rastergravur. |
| `edge_dopplungen.pdf` | 2× identisch, teilweise überlappend, umgekehrte Richtung, Rot auf Blau, parallel 0,05 mm, parallel 0,3 mm, ein Pfad hin und zurück, Bézierkreis doppelt | „Dopplungen entfernen“ räumt alles außer der 0,3-mm-Parallele ab. |
| `edge_winzig.pdf` | Linien mit 0 / 0,001 / 0,004 / 0,006 / 0,01 / 0,1 mm Länge | „Winzige Segmente entfernen“ findet die ersten drei (unter 0,005 mm). Keine davon zählt als Kleinteil. |
| `edge_explodiert.pdf` | Kreis, Welle und Quadrat aus 0,2-mm-Einzelstücken; Kreis halb blau, halb rot; Lücken 0,005 und 0,05 mm; derselbe Kreis als ein Pfad | „Kurven verbinden“: 9 Pfade, Quadratecken bleiben spitz, Blau und Rot getrennt, 0,005 mm wird verbunden, 0,05 mm nicht. |
| `edge_bilder.pdf` | Farbfoto (JPEG mit Rauschen), Graustufenverlauf, Logo auf Transparenz, Schwarz mit weißem Rand, komplett weißes Bild, blaue „Schnittlinie“ als Bild, „weißes“ JPEG mit Rauschen | Hinweis „farbige Bilder“. Das weiße Bild und das verrauschte weiße JPEG kosten keine Zeit. Die blaue Linie im Bild wird graviert, nicht geschnitten. |
| `edge_passt_nur_gedreht.pdf` | Rahmen 700 × 1000 mm | Hinweis „passt nur gedreht“ mit Dreh-Knöpfen. |
| `edge_zu_gross.pdf` | Rahmen 1100 × 750 mm | Hinweis „größer als die Platte“. |
| `edge_kleinteile.pdf` | 12 Teile 10 × 6 mm + 1 großes | Beide Hinweise: Entnahmezeit (13 Teile) und „können durchs Gitter fallen“ (12). |
| `edge_text.pdf` | Grüne und schwarze Schrift mit Löchern (O, B, g, 8), rote Konturschrift | Löcher bleiben Löcher. Konturschrift ist Vektorgravur, keine Fläche. |
| `edge_leer.pdf` | Leeres Blatt | Kein Absturz, Zeit „--:--“. |

## Was die Dateien bisher aufgedeckt haben

- **Behoben:** Orange und Gelb zählten als Rot, Cyan als Blau, weil die
  Farbeinteilung den Grünanteil nicht prüfte.
- **Behoben:** SVG-Dateien mit eingebetteten Bildern verloren ihre Bilder.
- **Behoben:** Mini-Linien unter 0,5 mm und Pfade „hin und zurück“ zählten als
  geschlossene Kleinteile.
- **Behoben:** Von einer Wasserzeichen-Zeile wurde nur das Stichwort markiert,
  nicht die ganze Zeile.
