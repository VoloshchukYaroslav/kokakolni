"""
xlsx -> data/data.json для OEE прототипа (линия L01).

Запуск:  python tools/xlsx_to_json.py путь/к/файлу.xlsx  [data/data.json]
Нужен только openpyxl:  pip install openpyxl

Скрипт ничего не придумывает: берёт листы Vyroba_hodiny, Prestoje, NOK_detail,
Ciselnik_chyb, Kontrola_zmien как есть. Единственное, что добавлено руками, —
блок MAPPING (какой код ошибки показывать на какой станции 3D-модели).
Это допущение, в xlsx станций нет: там только Zariadenie (Kamera, Leak test...).
В конце скрипт сверяет свои суммы со строкой MESIAC листа Kontrola_zmien и
падает, если что-то не сходится.
"""
import json
import sys
from datetime import datetime, date

import openpyxl

# ---- Допущение: код ошибки -> корень станции в line_L01_stations.glb ----
# Простои (ST-xxx) — это КОДЫ ОШИБОК из Ciselnik_chyb, а не номера станций.
# Модель названа по ним для удобства; здесь связь записана явно.
DOWNTIME_TO_STATION = {
    "ST-001": "ST-001",  # Zasobovanie: нет детали -> станция загрузки корпуса
    "ST-016": "ST-016",  # Kamera: камера проверки мотора
    "ST-017": "ST-017",  # Nastroj: остановка последовательности -> автомат винтов мотора
    "ST-038": "ST-038",  # Kamera: модуль подсветки -> камера №2
    "ST-046": "ST-046",  # Leak test: измерительный блок
    "ST-047": "ST-047",  # Leak test: ложемент пропускает воздух
}
# Брак (Q-xxx): где обнаружен. Тоже допущение, в xlsx есть только категория.
NOK_TO_STATION = {
    "Q-020": "Station_02",  # Lisovanie: запрессовка не дошла -> вставка мотора
    "Q-026": "ST-017",      # Skrutkovanie: недотяг винта -> автомат винтов мотора
    "Q-030": "ST-038",      # Kamera: не прошёл визуальный контроль -> камера №2
    "Q-031": "ST-046",      # Leak test: утечка -> leak test
}
REJECT_STATION = "ST-047"   # весь брак визуально уезжает в ящик ST-047


def iso(v):
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%dT%H:%M") if (v.hour or v.minute) else v.strftime("%Y-%m-%d")
    if isinstance(v, date):
        return v.strftime("%Y-%m-%d")
    return v


def rows(ws):
    it = ws.iter_rows(values_only=True)
    head = [h for h in next(it)]
    out = []
    for r in it:
        if r is None or all(v is None for v in r):
            continue
        out.append({h: iso(v) for h, v in zip(head, r) if h is not None})
    return out


def r4(x):
    return None if x is None else round(float(x), 4)


def main(src, dst):
    wb = openpyxl.load_workbook(src, data_only=True, read_only=True)
    V = rows(wb["Vyroba_hodiny"])
    P = rows(wb["Prestoje"])
    N = rows(wb["NOK_detail"])
    C = rows(wb["Ciselnik_chyb"])
    K = rows(wb["Kontrola_zmien"])

    hours = [{
        "id": h["Hodina_ID"], "date": h["Datum"], "hour": h["Hodina_zmeny"],
        "from": h["Cas_od"], "to": h["Cas_do"],
        "am_min": h["AM_min"], "pause_min": h["Pauza_min"], "plan_min": h["Plan_min"],
        "downtime_min": h["Prestoj_min"], "run_min": h["Chod_min"],
        "ideal_cycle_s": h["Ideal_cyklus_s"],
        "produced": h["Vyrobene_ks"], "ok": h["OK_ks"], "nok": h["NOK_ks"],
        "retests": h["Retesty_pocet"], "microstop_s": h["Mikrostop_s"],
        "retest_s": h["Retest_cas_s"], "slowdown_s": h["Spomalenie_s"],
        "A": r4(h["Availability"]), "P": r4(h["Performance"]),
        "Q": r4(h["Quality"]), "OEE": r4(h["OEE"]),
    } for h in V]

    downtimes = [{
        "code": p["Kod_chyby"], "hour_id": p["Hodina_ID"], "date": p["Datum"],
        "from": p["Cas_od"], "to": p["Cas_do"], "min": p["Trvanie_min"],
        "equipment": p["Zariadenie"], "category": p["Kategoria_chyby"],
        "cause_sk": p["Pricina"], "cause_en": p["Popis_EN"],
        "station": DOWNTIME_TO_STATION.get(p["Kod_chyby"]),
    } for p in P]

    nok = [{
        "id": n["NOK_ID"], "hour_id": n["Hodina_ID"], "date": n["Datum"],
        "code": n["Kod_chyby"], "qty": n["NOK_ks"], "category": n["Kategoria_chyby"],
        "cause_sk": n["Pricina"], "cause_en": n["Popis_EN"],
        "station": NOK_TO_STATION.get(n["Kod_chyby"]),
    } for n in N]

    shifts, month = [], None
    for k in K:
        s = {
            "date": k["Datum"], "plan_min": k["Plan_min"], "downtime_min": k["Prestoj_min"],
            "run_min": k["Chod_min"], "produced": k["Vyrobene_ks"], "ok": k["OK_ks"],
            "nok": k["NOK_ks"], "microstop_s": k["Mikrostop_s"], "retest_s": k["Retest_cas_s"],
            "slowdown_s": k["Spomalenie_s"], "A": r4(k["Availability"]),
            "P": r4(k["Performance"]), "Q": r4(k["Quality"]), "OEE": r4(k["OEE"]),
        }
        if k["Datum"] == "MESIAC":
            month = s
        else:
            shifts.append(s)

    codes = [{"code": c["Kod_chyby"], "type": c["Typ"], "category": c["Kategoria"],
              "sk": c["Popis_SK"], "en": c["Popis_EN"]} for c in C]

    # ---- Сверка: если не сходится, json не пишем ----
    def tot(lst, key):
        return sum(x[key] for x in lst)
    checks = {
        "plan_min": (tot(hours, "plan_min"), month["plan_min"]),
        "downtime_min(hours)": (tot(hours, "downtime_min"), month["downtime_min"]),
        "downtime_min(events)": (tot(downtimes, "min"), month["downtime_min"]),
        "produced": (tot(hours, "produced"), month["produced"]),
        "ok": (tot(hours, "ok"), month["ok"]),
        "nok(hours)": (tot(hours, "nok"), month["nok"]),
        "nok(events)": (tot(nok, "qty"), month["nok"]),
        "shifts": (len(shifts), 21),
        "hours": (len(hours), 21 * 8),
    }
    bad = {k: v for k, v in checks.items() if v[0] != v[1]}
    if bad:
        sys.exit("НЕ СХОДИТСЯ: " + json.dumps(bad, ensure_ascii=False))
    unmapped = sorted({d["code"] for d in downtimes if not d["station"]} |
                      {n["code"] for n in nok if not n["station"]})
    if unmapped:
        sys.exit("Коды без станции в MAPPING: " + ", ".join(unmapped))

    out = {
        "meta": {
            "source": src.replace("\\", "/").split("/")[-1],
            "line": "L01", "product": "P01",
            "shift": {"from": "06:00", "to": "14:00", "hours": 8},
            "ideal_cycle_s": 60, "target_oee": 0.85,
            "planned_pauses": [
                {"hour": 1, "min": 10, "what": "AM (autonómna údržba)"},
                {"hour": 5, "min": 30, "what": "prestávka"},
            ],
            "assumptions": {
                "downtime_to_station": DOWNTIME_TO_STATION,
                "nok_to_station": NOK_TO_STATION,
                "reject_station": REJECT_STATION,
                "note": "Stanice v xlsx nie sú. Mapovanie kód -> stanica modelu je predpoklad tímu.",
            },
        },
        "month": month,
        "shifts": shifts,
        "hours": hours,
        "downtimes": downtimes,
        "nok": nok,
        "codes": codes,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("OK:", dst, "| hodiny", len(hours), "| prestoje", len(downtimes),
          "| NOK záznamy", len(nok), "| OEE", month["OEE"])


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "data/data.json")
