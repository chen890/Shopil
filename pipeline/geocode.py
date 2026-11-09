"""Store geocoding with OpenStreetMap Nominatim and a committed cache.

Nominatim policy: max 1 request/second and an identifying User-Agent.
The cache means each store address is looked up only once, ever.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

import requests

UA = "Shopil/1.0 (+https://github.com/chen890/Shopil)"
URL = "https://nominatim.openstreetmap.org/search"
# Rough bounding box of Israel, to reject far-away matches.
LAT_MIN, LAT_MAX, LON_MIN, LON_MAX = 29.4, 33.4, 34.2, 35.95


class Geocoder:
    def __init__(self, cache_path: Path, max_new: int = 3000):
        self.path = cache_path
        self.cache: dict[str, list | None] = (
            json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
        )
        self.budget = max_new
        self.last = 0.0
        self.session = requests.Session()
        self.session.headers["User-Agent"] = UA

    def save(self) -> None:
        self.path.write_text(
            json.dumps(self.cache, ensure_ascii=False, indent=0, sort_keys=True), encoding="utf-8"
        )

    def _query(self, q: str):
        if q in self.cache:
            return self.cache[q]
        if self.budget <= 0:
            return None
        self.budget -= 1
        wait = 1.1 - (time.time() - self.last)
        if wait > 0:
            time.sleep(wait)
        self.last = time.time()
        result = None
        try:
            r = self.session.get(
                URL,
                params={"q": q, "format": "json", "limit": 1, "countrycodes": "il"},
                timeout=20,
            )
            if r.ok and r.json():
                lat, lon = float(r.json()[0]["lat"]), float(r.json()[0]["lon"])
                if LAT_MIN < lat < LAT_MAX and LON_MIN < lon < LON_MAX:
                    result = [round(lat, 5), round(lon, 5)]
        except (requests.RequestException, ValueError):
            return None  # don't cache transient failures
        self.cache[q] = result
        return result

    def locate(self, chain_name: str, store_name: str, address: str, city: str):
        address = re.sub(r",?\s*ישראל\s*$", "", address or "").strip(" ,")
        address = re.sub(r"\s+", " ", address)
        queries = []
        if address and city and city not in address:
            queries.append(f"{address}, {city}")
        elif address:
            queries.append(address)
        if city:
            queries.append(city)
        # Some chains leave the city empty; the store name is often the town.
        clean_name = re.sub(chain_name.split()[0], "", store_name or "").strip(" -")
        if clean_name:
            queries.append(clean_name)
        for q in queries:
            if len(q) < 2:
                continue
            loc = self._query(q)
            if loc:
                return loc
        return None
