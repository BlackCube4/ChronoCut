# -*- coding: utf-8 -*-
"""
Fittet das Zeitmodell des Epilog-Cutters an die Kalibriermessungen.

    python fit_model.py            # Standardmodell, schreibt fitted_params.json
    python fit_model.py theta=20   # eine Konstante festhalten (Sensitivitaet)
    python fit_model.py home=0     # Modellvariante: ohne Anfahrt/Rueckweg
    python fit_model.py target=est # nur die ANZEIGE fitten (alter Stand)

Braucht scipy.

Zielgroesse
-----------
Nachgebildet wird die Zeit, die die Maschine TATSAECHLICH braucht. Wo eine
gestoppte Zeit vorliegt (Spalten meas E / opt_meas E), ist sie das Ziel; sonst
dient die Anzeige des Job Managers als Stellvertreter. Die beiden weichen
voneinander ab: auf den zwei bisher gestoppten Produktionsdateien lief die
Maschine 4,0 % bzw. 4,7 % laenger als angezeigt, bei 48_angle_26 unoptimiert
4,6 % laenger - optimiert dagegen genau richtig, und ein reiner Rasterlauf
(33_rast_ref bei 100 %) ebenfalls genau richtig. Das Muster deutet auf einen
Aufschlag bei leerwegreichen Jobs, nicht auf einen globalen Faktor.

Solange nur vier Laeufe gestoppt sind, aendert das am Fit fast nichts - die
Konstanten haengen weiter an der Anzeige. Erst Block E des Testplans (siehe
docs/CALIBRATION.md Abschnitt 7) macht die gestoppte Zeit zur tragenden
Zielgroesse. "target=est" schaltet zurueck auf reines Anzeige-Fitten.

Was hier anders ist als in der ersten Fassung
---------------------------------------------
Die Geometrie wird NICHT mehr von Hand nachgebaut, sondern aus den echten
Kalibrier-SVGs gelesen (svg_geometry.py). Damit sind auch die Dateien 36-55
auswertbar, deren Geometrie sich kaum sinnvoll abtippen laesst, und
Abschreibfehler in der Geometrie sind ausgeschlossen. Von Hand eingetragen sind
nur noch die abgelesenen ZEITEN (DATA weiter unten).

Modell
------
VEKTOR (pro durchgehender Fahrt der Laenge s, Vektorgeschwindigkeit v):
    trapezfoermig:  t = s/v + v/a          (falls s >= v^2/a)
    dreieckig:      t = 2*sqrt(s/a)        (sonst, Sollgeschw. nie erreicht)
  + p0 je Halt. Wo die Maschine haelt, haengt von der Spalte ab:
      opt  ("Optimieren" an)  - nur an echten Ecken, Knick > theta
      est  ("Optimieren" aus) - an JEDEM Original-Stuetzpunkt, aber NICHT an
                                Stuetzpunkten, die erst beim Zerlegen einer
                                echten Kurve entstehen (50 vs. 51 zeigt das)
  + pv je separatem Vektor, Leerwege mit konstant 250 mm/s
  + Anfahrt vom Ursprung und Rueckweg dorthin (42/43)
  opt sortiert die Konturen zusaetzlich um (36/37 sind dieselbe Geometrie in
  anderer Reihenfolge und ergeben optimiert exakt dieselbe Zeit).

RASTER (pro Scanzeile):
    t = A(v) + span/v_r        mit A(v) = A0 + aramp * v_r
  span = horizontale Spannweite (linkester..rechtester Punkt) DIESER Zeile.
  Zeilen ohne Inhalt entfallen ganz (52/53). Dazu q je mm gescannter Hoehe.
  KEINE Anfahrt und kein Rueckweg (54).

+ globaler Job-Overhead c0.
"""
import json
import math
import os
import statistics
import sys

from scipy.optimize import least_squares

import svg_geometry as SVG

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = os.path.join(HERE, "..", "..", "laser time calibration", "files")

# Leerweg: 250 mm/s konstant (mit Zeitlupenkamera an der Maschine gemessen,
# nicht gefittet).
TRAVEL_SPEED = 250.0

# ---------------------------------------------------------------- Messdaten
# Abgelesen im Epilog Job Manager, Maschine "Edgar" (60 W).
# (Datei, dpi, Speed-%, est = ohne "Optimieren", opt = mit)
DATA = [
    ("01_overhead_dot", None, 8, 1, 1),
    ("02_overhead_shortline", None, 8, 1, 1),
    ("03_vline_25", None, 8, 26, 26),
    ("04_vline_50", None, 8, 51, 51),
    ("05_vline_100", None, 8, 100, 100),
    ("06_vline_175", None, 8, 174, 174),
    ("07_vline_250", None, 8, 248, 248),
    ("08_zigzag_n4", None, 8, 45, 44),
    ("09_zigzag_n8", None, 8, 48, 48),
    ("10_zigzag_n16", None, 8, 58, 58),
    ("11_zigzag_n32", None, 8, 86, 86),
    ("12_zigzag_n64", None, 8, 151, 151),
    ("13_zigzag_n128", None, 8, 289, 290),
    ("14_circle_d80", None, 8, 169, 145),
    ("15_polygon_12", None, 8, 146, 145),
    ("16_polygon_48", None, 8, 160, 144),
    ("17_dashes_2mm", None, 8, 11, 11),
    ("18_dashes_5mm", None, 8, 17, 17),
    ("19_dashes_10mm", None, 8, 28, 28),
    ("20_rast_50x10", 600, 20, 57, 57),
    ("21_rast_50x20", 600, 20, 113, 113),
    ("22_rast_50x40", 600, 20, 224, 224),
    ("23_rast_50x80", 600, 20, 447, 447),
    ("24_rast_50x160", 600, 20, 893, 893),
    ("25_rast_10x40", 600, 20, 118, 118),
    ("26_rast_25x40", 600, 20, 158, 158),
    ("27_rast_75x40", 600, 20, 291, 291),
    ("28_rast_100x40", 600, 20, 357, 357),
    ("29_rast_150x40", 600, 20, 490, 490),
    ("30_rast_frame", 600, 20, 889, 889),
    ("31_rast_twocol", 600, 20, 534, 534),
    ("32_rast_triangle", 600, 20, 559, 559),
    ("33_rast_ref_80x80", 600, 20, 606, 606),
    ("34_combo_A", 600, "8/20", 126, 126),
    ("35_combo_B", 600, "8/20", 121, 121),
    ("05_vline_100", None, 15, 54, 54),
    ("05_vline_100", None, 30, 28, 28),
    ("05_vline_100", None, 50, 18, 18),
    ("05_vline_100", None, 75, 13, 13),
    ("05_vline_100", None, 100, 11, 11),
    ("11_zigzag_n32", None, 40, 32, 33),
    ("33_rast_ref_80x80", 300, 20, 312, 312),
    ("33_rast_ref_80x80", 1200, 20, 1192, 1192),
    ("33_rast_ref_80x80", 600, 10, 1156, 1156),
    ("33_rast_ref_80x80", 600, 40, 391, 391),
    ("33_rast_ref_80x80", 300, 40, 204, 204),
    ("33_rast_ref_80x80", 1200, 10, 2288, 2288),
    ("33_rast_ref_80x80", 600, 60, 341, 341),
    ("33_rast_ref_80x80", 600, 80, 334, 334),
    ("33_rast_ref_80x80", 600, 100, 300, 300),
    ("22_rast_50x40", 300, 20, 117, 117),
    ("22_rast_50x40", 1200, 20, 436, 436),
    ("36_order_natural", None, 8, 97, 84),
    ("37_order_shuffled", None, 8, 131, 84),
    ("38_order_nntrap", None, 8, 94, 55),
    ("39_travel_grid_p08", None, 8, 122, 123),
    ("40_travel_grid_p25", None, 8, 131, 132),
    ("41_travel_grid_p60", None, 8, 146, 146),
    ("42_home_near", None, 8, 5, 5),
    ("43_home_far", None, 8, 13, 13),
    ("44_vecstart_stack", None, 8, 28, 25),
    ("45_angle_08", None, 8, 153, 139),
    ("46_angle_14", None, 8, 153, 139),
    ("47_angle_20", None, 8, 153, 139),
    ("48_angle_26", None, 8, 153, 138),
    ("49_angle_32", None, 8, 153, 154),
    ("50_bezier_circles", None, 8, 74, 74),
    ("51_poly_circles", None, 8, 94, 74),
    ("52_rast_vgap_05", 600, 20, 379, 379),
    ("53_rast_vgap_60", 600, 20, 379, 379),
    ("54_rast_overscan", 200, 100, 29, 29),
    ("55_rast_speed", 200, 100, 139, 139),
    ("54_rast_overscan", 200, 10, 40, 40),
    ("54_rast_overscan", 200, 20, 26, 26),
    ("54_rast_overscan", 200, 40, 26, 26),
    ("54_rast_overscan", 200, 60, 28, 28),
    ("54_rast_overscan", 200, 80, 31, 31),
    ("55_rast_speed", 200, 10, 1161, 1161),
    ("55_rast_speed", 200, 20, 585, 585),
    ("55_rast_speed", 200, 40, 304, 304),
    ("55_rast_speed", 200, 60, 212, 212),
    ("55_rast_speed", 200, 80, 168, 168),
    ("54_rast_overscan", 600, 100, 72, 72),
    ("55_rast_speed", 600, 100, 407, 407),
    ("56_vecstart_400", None, 8, 55, 50),
    ("57_vecstart_800", None, 8, 110, 100),
    ("61_order_numbers", None, 8, 207, 178),
    ("03_vline_25", None, 100, 5, 5),
    ("04_vline_50", None, 100, 7, 7),
    ("06_vline_175", None, 100, 17, 17),
    ("07_vline_250", None, 100, 23, 23),
    ("08_zigzag_n4", None, 100, 8, 6),
    ("09_zigzag_n8", None, 100, 11, 11),
    ("10_zigzag_n16", None, 100, 17, 17),
    ("11_zigzag_n32", None, 100, 28, 28),
    ("12_zigzag_n64", None, 100, 52, 53),
    ("13_zigzag_n128", None, 100, 101, 101),
    ("14_circle_d80", None, 100, 73, 15),
    ("15_polygon_12", None, 100, 26, 20),
    ("16_polygon_48", None, 100, 57, 15),
    ("17_dashes_2mm", None, 100, 8, 8),
    ("18_dashes_5mm", None, 100, 10, 10),
    ("19_dashes_10mm", None, 100, 12, 12),
]
ROWS = [dict(rid=i + 1, file=f, dpi=d, speed=s, est=e, opt=o)
        for i, (f, d, s, e, o) in enumerate(DATA)]

# Gestoppte Laufzeiten, wo vorhanden: (Datei, dpi, Speed) -> (meas, opt_meas).
# Diese schlagen die Anzeige, sobald target="meas" (Standard).
MEASURED = {
    ("01_overhead_dot", None, 8): (1, 1),
    ("02_overhead_shortline", None, 8): (1, 1),
    ("03_vline_25", None, 8): (26, 26),
    ("04_vline_50", None, 8): (50, 50),
    ("05_vline_100", None, 8): (99, 99),
    ("06_vline_175", None, 8): (172, 172),
    ("07_vline_250", None, 8): (245, 245),
    ("08_zigzag_n4", None, 8): (45, 44),
    ("09_zigzag_n8", None, 8): (49, 49),
    ("10_zigzag_n16", None, 8): (60, 60),
    ("11_zigzag_n32", None, 8): (89, 89),
    ("12_zigzag_n64", None, 8): (157, 157),
    ("13_zigzag_n128", None, 8): (300, 301),
    ("14_circle_d80", None, 8): (176, 143),
    ("15_polygon_12", None, 8): (147, 145),
    ("16_polygon_48", None, 8): (166, 143),
    ("17_dashes_2mm", None, 8): (11, 11),
    ("18_dashes_5mm", None, 8): (18, 18),
    ("19_dashes_10mm", None, 8): (28, 29),
    ("20_rast_50x10", 600, 20): (53, 53),
    ("21_rast_50x20", 600, 20): (104, 104),
    ("22_rast_50x40", 600, 20): (207, 207),
    ("23_rast_50x80", 600, 20): (413, 413),
    ("24_rast_50x160", 600, 20): (824, 824),
    ("25_rast_10x40", 600, 20): (102, 102),
    ("26_rast_25x40", 600, 20): (141, 141),
    ("27_rast_75x40", 600, 20): (273, 273),
    ("28_rast_100x40", 600, 20): (338, 338),
    ("29_rast_150x40", 600, 20): (471, 471),
    ("30_rast_frame", 600, 20): (843, 843),
    ("05_vline_100", None, 100): (11, 11),
    ("33_rast_ref_80x80", 600, 100): (266, 266),
    ("41_travel_grid_p60", None, 8): (151, 152),
    ("48_angle_26", None, 8): (160, 137),
    ("54_rast_overscan", 200, 100): (24, 24),
    ("54_rast_overscan", 200, 10): (34, 34),
    ("54_rast_overscan", 200, 20): (21, 21),
    ("54_rast_overscan", 200, 40): (20, 20),
    ("54_rast_overscan", 200, 60): (22, 22),
    ("54_rast_overscan", 200, 80): (25, 25),
    ("54_rast_overscan", 600, 100): (62, 62),
    ("56_vecstart_400", None, 8): (59, 54),
    ("57_vecstart_800", None, 8): (118, 108),
    ("61_order_numbers", None, 8): (209, 181),
    ("03_vline_25", None, 100): (5, 5),
    ("04_vline_50", None, 100): (7, 7),
    ("06_vline_175", None, 100): (17, 17),
    ("07_vline_250", None, 100): (23, 23),
    ("08_zigzag_n4", None, 100): (9, 6),
    ("09_zigzag_n8", None, 100): (12, 12),
    ("10_zigzag_n16", None, 100): (19, 19),
    ("11_zigzag_n32", None, 100): (30, 30),
    ("12_zigzag_n64", None, 100): (56, 55),
    ("13_zigzag_n128", None, 100): (109, 108),
    ("14_circle_d80", None, 100): (80, 16),
    ("15_polygon_12", None, 100): (28, 21),
    ("16_polygon_48", None, 100): (61, 15),
    ("17_dashes_2mm", None, 100): (9, 9),
    ("18_dashes_5mm", None, 100): (11, 11),
    ("19_dashes_10mm", None, 100): (13, 13),
}

COMBOS = {"34_combo_A", "35_combo_B"}   # gemischt, NICHT mitgefittet (Validierung)
# 12_zigzag_n64 war hier jahrelang (181 s angezeigt, Modell 150 s). Im Oktober
# neu abgelesen: 151 s - die alte Zahl war verlesen, kein Ausreisser mehr.
OUTLIERS = set()
ROUNDING = {1, 2}                       # Anzeige "1 s": Rundung dominiert

# Stuetzstellen der Raster-Geschwindigkeitstabelle (die gemessenen Speed-%).
RSPD = [10, 20, 40, 60, 80, 100]

# Standard = der ausgelieferte Stand. theta ist bewusst FESTGEHALTEN: der Fit ist
# ueber 27-31 Grad exakt gleich gut (freigelassen landet er bei 29,8), 28 liegt
# mittig im Plateau. "theta=none" gibt ihn frei.
CFG = dict(home=2, order="nn", theta=28, target="meas", av=None)
for _a in sys.argv[1:]:
    _k, _, _v = _a.partition("=")
    CFG[_k] = None if _v == "none" else (int(_v) if _v.lstrip("-").isdigit() else _v)


# ---------------------------------------------------------------- Geometrie
_geom, _rows, _order = {}, {}, {}


def geom(name):
    if name not in _geom:
        _geom[name] = SVG.parse_svg(os.path.join(FILES, name + ".svg"))
    return _geom[name]


def scanrows(name, dpi):
    if (name, dpi) not in _rows:
        _rows[name, dpi] = SVG.scan_rows(geom(name)["raster"], dpi)
    return _rows[name, dpi]


# ---------------------------------------------------------------- Kinematik
def seg_time(s, v, a):
    if s <= 0:
        return 0.0
    return s / v + v / a if s >= v * v / a else 2.0 * math.sqrt(s / a)


def moves_and_stops(pts, curveflags, theta, every_vertex):
    """Zerlegt eine Polylinie in durchgehende Fahrten + Anzahl der Haltepunkte.

    every_vertex=True  -> jeder ORIGINAL-Stuetzpunkt ist ein Halt; Stuetzpunkte
                          aus dem Zerlegen einer echten Kurve nicht (Spalte est)
    every_vertex=False -> Halt nur bei Knick > theta (Spalte opt)"""
    n = len(pts)
    if n < 2:
        return [], 0
    segs = [math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
            for i in range(n - 1)]
    stop = []
    for i in range(1, n - 1):
        ax, ay = pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]
        bx, by = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
        na, nb = math.hypot(ax, ay), math.hypot(bx, by)
        if na < 1e-9 or nb < 1e-9:
            stop.append(False)
            continue
        cosv = max(-1.0, min(1.0, (ax * bx + ay * by) / (na * nb)))
        ang = math.degrees(math.acos(cosv))
        stop.append(True if (every_vertex and not curveflags[i]) else ang > theta)
    moves, cur, corners = [], segs[0], 0
    for i, s in enumerate(segs[1:]):
        if stop[i]:
            moves.append(cur)
            cur = s
            corners += 1
        else:
            cur += s
    moves.append(cur)
    return moves, corners


# ---------------------------------------------------------------- Reihenfolge
def order_nn(subs, start=(0.0, 0.0)):
    """Greedy Nearest-Neighbour ueber die Konturenden, Umkehren erlaubt."""
    rem, cur, out = list(range(len(subs))), start, []
    while rem:
        best, bd, brev = None, 1e18, False
        for i in rem:
            p = subs[i][0]
            for rev in (False, True):
                q = p[-1] if rev else p[0]
                d = (q[0] - cur[0]) ** 2 + (q[1] - cur[1]) ** 2
                if d < bd:
                    bd, best, brev = d, i, rev
        rem.remove(best)
        pts, fl = subs[best]
        if brev:
            pts, fl = pts[::-1], fl[::-1]
        out.append((pts, fl))
        cur = pts[-1]
    return out


def order_2opt(subs, start=(0.0, 0.0), rounds=4):
    """NN + 2-opt auf der Leerweglaenge - dieselbe Strategie wie toolpath.js."""
    tour = order_nn(subs, start)

    def travel(t):
        tot, cur = 0.0, start
        for pts, _ in t:
            tot += math.hypot(pts[0][0] - cur[0], pts[0][1] - cur[1])
            cur = pts[-1]
        return tot

    best, n = travel(tour), len(tour)
    for _ in range(rounds):
        improved = False
        for i in range(n - 1):
            for j in range(i + 1, n):
                cand = (tour[:i]
                        + [(p[::-1], f[::-1]) for p, f in reversed(tour[i:j + 1])]
                        + tour[j + 1:])
                t = travel(cand)
                if t < best - 1e-9:
                    tour, best, improved = cand, t, True
        if not improved:
            break
    return tour


def ordered(name, subs):
    """Die Reihenfolge haengt nur an der Geometrie, nicht an den Parametern -
    einmal rechnen reicht (der Fit ruft das sonst zehntausendfach)."""
    if name not in _order:
        _order[name] = (order_2opt if CFG["order"] == "2opt" else order_nn)(subs)
    return _order[name]


# ---------------------------------------------------------------- Zeitmodell
def vector_time(name, subs, P, optimized):
    v, a = P["kv"] * P["_speed"], P["av"]
    if optimized and CFG["order"] != "file":
        subs = ordered(name, subs)
    t, cur = 0.0, (0.0, 0.0)
    for pts, fl in subs:
        if CFG["home"]:
            t += seg_time(math.hypot(pts[0][0] - cur[0], pts[0][1] - cur[1]),
                          TRAVEL_SPEED, a)
        elif cur != (0.0, 0.0):
            t += seg_time(math.hypot(pts[0][0] - cur[0], pts[0][1] - cur[1]),
                          TRAVEL_SPEED, a)
        t += P["pv"]
        moves, corners = moves_and_stops(pts, fl, P["theta"], not optimized)
        t += sum(seg_time(s, v, a) for s in moves) + P["p0"] * corners
        cur = pts[-1]
    if CFG["home"] == 2:
        t += seg_time(math.hypot(cur[0], cur[1]), TRAVEL_SPEED, a)
    return t


def raster_time(spans, P, dpi):
    v, A = P["_vr"], P["_Ar"]
    return sum(A + s / v for s in spans) + P["q"] * len(spans) * 25.4 / dpi


def unpack(p):
    P = dict(kv=p[0], av=(float(CFG["av"]) if CFG["av"] is not None else p[1]),
             p0=p[2], pv=p[3], q=p[4], c0=p[5],
             theta=(p[6] if CFG["theta"] is None else float(CFG["theta"])))
    n = 7 if CFG["theta"] is None else 6
    P["vr"] = dict(zip(RSPD, p[n:n+6]))          # Rastergeschwindigkeit je Stufe
    P["ar"] = dict(zip(RSPD, p[n+6:n+12]))       # Zeilen-Overhead je Stufe
    return P


def predict(row, P, optimized):
    f = row["file"]
    g = geom(f)
    # Bei den Combos steht "8/20": Vektor mit 8 %, Raster mit 20 %.
    vsp = 8 if f in COMBOS else row["speed"]
    rsp = 20 if f in COMBOS else row["speed"]
    t = P["c0"]
    if g["vector"]:
        P["_speed"] = vsp
        t += vector_time(f, g["vector"], P, optimized)
    if g["raster"]:
        P["_vr"] = P["vr"][rsp]
        P["_Ar"] = P["ar"][rsp]
        t += raster_time(scanrows(f, row["dpi"]), P, row["dpi"])
    return t


FIT = [r for r in ROWS
       if r["rid"] not in OUTLIERS and r["rid"] not in ROUNDING
       and r["file"] not in COMBOS]


def target(row, col):
    """Zielwert einer Zeile: gestoppte Zeit wenn vorhanden, sonst die Anzeige."""
    if CFG["target"] == "meas":
        m = MEASURED.get((row["file"], row["dpi"], row["speed"]))
        if m is not None:
            v = m[1] if col == "opt" else m[0]
            if v is not None:
                return v, True
    return row[col], False


def resid(p):
    P = unpack(p)
    out = []
    for r in FIT:
        for col, opt in (("opt", True), ("est", False)):
            y, _ = target(r, col)
            # Relativ gewichtet, aber unterhalb von 5 s dominiert die
            # 1-Sekunden-Anzeige - dort nicht weiter hochskalieren.
            out.append((predict(r, P, opt) - y) / max(5.0, y))
    return out


#     kv      av      p0     pv     q      c0    theta
p0 = [2.55,  2750, 0.0220, 0.036, 0.195, 2.9, 28.0]
lo = [0.5,    200,  0.0,   0.0,   0.0,   0.0, 10.0]
hi = [20,  200000,  1.0,   2.0,  10.0,  30.0, 60.0]
if CFG["theta"] is not None:
    p0, lo, hi = p0[:6], lo[:6], hi[:6]
# Rastergeschwindigkeit je Stufe - Startwerte aus dem Paar 54/55, das sie
# DIREKT misst: v = 200 Zeilen * 999 mm / (t55 - t54).
p0 += [178, 357, 719, 1086, 1458, 1816]
lo += [20] * 6
hi += [6000] * 6
# Zeilen-Overhead je Stufe. Bewusst frei und NICHT als Formel: die gemessene
# Kurve ist U-foermig (hoch bei langsam, Minimum bei 20-40 %, wieder steigend),
# was weder ein fester Zeitanteil noch eine reine Rampe hergibt. Ein fester
# Overscan-WEG plus Rampe kaeme der Form nahe, trifft die Daten aber nur auf
# 2,2 % - die freie Tabelle bleibt naeher an dem, was gemessen wurde.
p0 += [0.155, 0.088, 0.089, 0.100, 0.115, 0.105]
lo += [0.0] * 6
hi += [1.0] * 6

res = least_squares(resid, p0, bounds=(lo, hi), xtol=1e-14, ftol=1e-14, max_nfev=20000)
P = unpack(res.x)

# ---------------------------------------------------------------- Ausgabe
print("=" * 88)
print("GEFITTETE PARAMETER   " + repr(CFG))
print("=" * 88)
print(f"  Vektor-Geschwindigkeit   v = {P['kv']:.4f} mm/s je Speed-%   "
      f"(100 % = {P['kv']*100:.0f} mm/s)")
print(f"  Vektor-Beschleunigung    a = {P['av']:.0f} mm/s^2")
print(f"  Eckenzuschlag           p0 = {P['p0']*1000:.1f} ms je Ecke")
print(f"  Ecken-Schwelle       theta = {P['theta']:.1f} Grad")
print(f"  Leerfahrt (gemessen)       = {TRAVEL_SPEED:.0f} mm/s konstant"
      f"   (Anfahrt+Rueckweg: {'ja' if CFG['home'] == 2 else 'nein'})")
print(f"  Vektor-Startaufwand     pv = {P['pv']*1000:.1f} ms je separatem Vektor")
print("  Raster, je Speed-Stufe:")
for k in RSPD:
    print(f"      {k:3d} %   v = {P['vr'][k]:7.1f} mm/s   Zeilen-Overhead = "
          f"{P['ar'][k]*1000:6.2f} ms   ({P['vr'][k]/k:.2f} mm/s je %)")
print(f"  Raster Y-Vorschub        q = {P['q']*1000:.1f} ms je mm gescannter Hoehe")
print(f"  Job-Overhead            c0 = {P['c0']:.2f} s")

print()
print("=" * 88)
print("RESIDUEN  (opt = mit 'Optimieren', est = ohne)")
print(f"Ziel: {'gestoppte Zeit wo vorhanden, sonst Anzeige' if CFG['target'] == 'meas' else 'nur Anzeige'}")
print("=" * 88)
hdr = (f"{'id':>3} {'Datei':<22} {'sp':>5} {'dpi':>5} | "
       f"{'opt':>6} {'Modell':>8} {'%':>7} | {'est':>6} {'Modell':>8} {'%':>7}")
print(hdr)
print("-" * len(hdr))
errs = []
for r in ROWS:
    c = []
    meas_used = False
    for col, opt in (("opt", True), ("est", False)):
        y, is_meas = target(r, col)
        meas_used |= is_meas
        pr = predict(r, P, opt)
        pc = 100 * (pr - y) / y
        c += [f"{y:.0f}", f"{pr:.1f}", f"{pc:+.1f}"]
        if r in FIT:
            errs.append(abs(pc))
    flag = ""
    if r["rid"] in OUTLIERS:
        flag = "  <- Ausreisser"
    elif r["file"] in COMBOS:
        flag = "  <- Validierung"
    elif r["rid"] in ROUNDING:
        flag = "  <- Rundung"
    if meas_used:
        flag += "  [gestoppt]"
    print(f"{r['rid']:>3} {r['file']:<22} {r['speed']!s:>5} {r['dpi']!s:>5} | "
          f"{c[0]:>6} {c[1]:>8} {c[2]:>7} | {c[3]:>6} {c[4]:>8} {c[5]:>7}{flag}")
print()
print(f"  n = {len(errs)}   MW {statistics.mean(errs):.2f} %   "
      f"Median {statistics.median(errs):.2f} %   max {max(errs):.2f} %")

out = dict(kv=P["kv"], av=P["av"], p0=P["p0"], pv=P["pv"],
           travel_speed=TRAVEL_SPEED, theta=P["theta"],
           q=P["q"], c0=P["c0"],
           vr={str(k): P["vr"][k] for k in RSPD},
           ar={str(k): P["ar"][k] for k in RSPD},
           cfg=dict(CFG),
           quality=dict(n=len(errs), mean=statistics.mean(errs),
                        median=statistics.median(errs), max=max(errs)))
with open(os.path.join(HERE, "fitted_params.json"), "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=2)
print("\n  -> fitted_params.json geschrieben")
