"""Hämtar Stockholms stads parkeringsföreskrifter (LTF-Tolken) för gatorna
kring Årsta torg och sparar dem som GeoJSON i data/city/.

Körs automatiskt av GitHub Actions (se .github/workflows/fetch-city-data.yml),
men går också att köra för hand: python scripts/fetch_city_data.py

Ingen API-nyckel behövs längre (Trafikkontoret slutade kräva det 2026-10-07).
"""

import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://openparking.stockholm.se/LTF-Tolken/v1"

# Gator inom (eller som korsar) området. Gator som sträcker sig längre bort,
# som Årstavägen, hämtas i sin helhet och beskärs mot områdesgränsen senare.
STREETS = [
    "Ottsjövägen",
    "Bränningevägen",
    "Årstavägen",
    "Siljansvägen",
    "Åmänningevägen",
    "Skedviksvägen",
    "Hjälmarsvägen",
    "Rämensvägen",
    "Långhalsvägen",
    "Borensvägen",
    "Tämnarvägen",
    "Bråviksvägen",
]

# Föreskriftstyper som spelar roll för en vanlig bil.
REGULATIONS = [
    "ptillaten",        # var och när det är tillåtet att parkera
    "servicedagar",     # städ-/servicetider då det är förbjudet
    "prorelsehindrad",  # platser endast för rörelsehindrade
    "pmotorcykel",      # platser endast för MC
    "plastbil",         # platser endast för lastbil
    "pbuss",            # platser endast för buss
]

OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "city"


def fetch_json(url, attempts=3):
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "parkering-arsta"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # nätverksfel, tidsgräns, trasig JSON
            last_error = e
            print(f"  försök {attempt} misslyckades: {e}", file=sys.stderr)
            time.sleep(5 * attempt)
    raise RuntimeError(f"Kunde inte hämta {url}: {last_error}")


def fetch_regulation(reg):
    features = {}
    for street in STREETS:
        url = (f"{BASE}/{reg}/street/{urllib.parse.quote(street)}"
               f"?outputFormat=json")
        print(f"{reg}: {street}")
        data = fetch_json(url)
        if "features" not in data:
            raise RuntimeError(f"Oväntat svar för {reg}/{street}: {str(data)[:200]}")
        for f in data["features"]:
            # Samma föreskrift kan dyka upp under flera gatunamn; dedupe på id.
            key = f.get("id") or json.dumps(f, sort_keys=True)
            features[key] = f
    ordered = [features[k] for k in sorted(features, key=str)]
    return {"type": "FeatureCollection", "features": ordered}


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # Hämta allt först, så att ett fel halvvägs inte lämnar halva filer.
    results = {reg: fetch_regulation(reg) for reg in REGULATIONS}

    changed = []
    for reg, fc in results.items():
        path = OUT_DIR / f"{reg}.geojson"
        new_text = json.dumps(fc, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
        old_text = path.read_text(encoding="utf-8") if path.exists() else None
        if new_text != old_text:
            path.write_text(new_text, encoding="utf-8")
            changed.append(reg)
        print(f"{reg}: {len(fc['features'])} föreskrifter"
              f"{' (ändrad)' if reg in changed else ''}")

    if changed:
        meta = {
            "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "changed": changed,
            "streets": STREETS,
            "counts": {reg: len(fc["features"]) for reg, fc in results.items()},
        }
        (OUT_DIR / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        print("Inga ändringar sedan förra hämtningen.")


if __name__ == "__main__":
    main()
