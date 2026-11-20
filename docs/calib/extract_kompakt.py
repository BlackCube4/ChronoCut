# -*- coding: utf-8 -*-
"""Liest den kompakten Messsatz (und die Zeilen darunter) aus der Messtabelle
und schreibt data/kompakt.json - Eingabe fuer fit_all.mjs.

    python extract_kompakt.py [pfad/zur/messplan_kompakt.xlsx]

Ohne Pfad: laser time calibration/messplan_kompakt.xlsx im Repo.

Zeiten, die Excel als Uhrzeit gespeichert hat (mm:ss als hh:mm eingetippt,
z. B. 21:13), werden als Minuten:Sekunden gelesen.
"""
import datetime
import json
import os
import sys

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "laser time calibration", "messplan_kompakt.xlsx")


def sec(v):
    if v is None or v == "":
        return None
    if isinstance(v, datetime.time):
        return v.hour * 60 + v.minute
    return float(v)


ws = openpyxl.load_workbook(SRC, data_only=True)["Messprotokoll"]
rows = []
for r in ws.iter_rows(min_row=3, values_only=True):
    f = r[0]
    if not f or str(f).startswith("---"):
        continue
    rows.append(dict(file=str(f), dpi=None if r[1] in ("-", None) else int(r[1]), speed=str(r[2]),
                     est=sec(r[6]), meas=sec(r[7]), opt=sec(r[8]), opt_meas=sec(r[9]), note=r[5]))
os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
with open(os.path.join(HERE, "data", "kompakt.json"), "w", encoding="utf-8") as fh:
    json.dump(rows, fh, indent=1, ensure_ascii=False)
print(f"{len(rows)} Zeilen -> data/kompakt.json")
