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
        """Return ((lat, lon) | None, precise) where precise=False means city-level."""
        city = normalize_city(city)
        queries = []  # (query, precise)
        for addr in address_variants(address):
            if city and city not in addr:
                queries.append((f"{addr}, {city}", True))
            else:
                queries.append((addr, bool(re.search(r"\d", addr))))
        if city:
            queries.append((city, False))
        # Some chains leave the city empty; the store name is often the town.
        clean_name = re.sub(re.escape(chain_name.split()[0]), "", store_name or "").strip(" -")
        clean_name = re.sub(r"\(.*?\)", "", clean_name).strip()
        # never geocode a placeholder name ("סניף 273"): it matches a random place
        if clean_name and not re.fullmatch(r"(סניף|branch)?\s*\d+", clean_name):
            queries.append((clean_name, False))
        seen = set()
        for q, precise in queries:
            if len(q) < 2 or q in seen:
                continue
            seen.add(q)
            loc = self._query(q)
            if loc:
                return loc, precise
        return None, False


ABBREVIATIONS = [
    (r"\bשד(?:'|\.)\s*", "שדרות "),
    (r"\bשד\s+(?=[א-ת])", "שדרות "),
    (r"\bרח'?\.\s*", ""),
    (r"\bרחוב\s+", ""),
    (r"\bי-ם\b", "ירושלים"),
    (r"\bככר\b", "כיכר"),
    (r"\bפ\.ת\b", "פתח תקווה"),
    (r"\bת\.א\b", "תל אביב"),
]


def normalize_city(city: str) -> str:
    city = (city or "").strip()
    city = re.sub(r"\s*-\s*יפו$", "", city)  # "תל אביב - יפו" -> "תל אביב"
    return city


def address_variants(address: str) -> list[str]:
    a = re.sub(r",?\s*ישראל\s*$", "", address or "").strip(" ,")
    a = re.sub(r"\(.*?\)", "", a)
    a = re.sub(r"\s+", " ", a).strip(" ,")
    if not a or a.lower() in ("unknown", "none"):
        return []
    out = [a]
    b = a
    for pattern, repl in ABBREVIATIONS:
        b = re.sub(pattern, repl, b)
    b = re.sub(r"\s+", " ", b).strip()
    # "15 דרך ירושלים" -> "דרך ירושלים 15"
    m = re.match(r"^(\d+[א-ת]?)\s+(.+)$", b)
    if m:
        b = f"{m.group(2)} {m.group(1)}"
    # keep only the first comma part when it looks like "street N, mall name"
    first = b.split(",")[0].strip()
    for v in (b, first):
        if v and v not in out:
            out.insert(0, v)
    return out
