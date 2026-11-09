"""Re-run store geocoding over already-built parts and re-merge.

Usage: python pipeline/regeocode.py OUT_DIR
Useful after improving geocode.py, without re-downloading prices.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build import CHAIN_NAMES, HERE, merge  # noqa: E402
from geocode import Geocoder  # noqa: E402

out = Path(sys.argv[1])
geocoder = Geocoder(HERE / "geocode_cache.json")
for f in sorted((out / "parts").glob("*.json")):
    part = json.loads(f.read_text(encoding="utf-8"))
    precise = 0
    for s in part["stores"]:
        if s["online"]:
            continue
        loc, ok = geocoder.locate(CHAIN_NAMES[part["chain"]], s["name"], s["address"], s["city"])
        s.pop("approx", None)
        s.pop("lat", None)
        s.pop("lon", None)
        if loc:
            s["lat"], s["lon"] = loc
            if not ok:
                s["approx"] = 1
            precise += ok
    f.write_text(json.dumps(part, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    geocoder.save()
    print(f"[{part['chain']}] {precise}/{len(part['stores'])} precise", flush=True)
merge(out)
