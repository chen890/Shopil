"""CI entry point: fetch + build each chain in turn, then merge.

Usage: python pipeline/run_all.py OUT_DIR [CHAIN ...]

Raw files are deleted after each chain to keep disk usage low.
If a chain fails and PREVIOUS_URL is set (the live site), the chain's
previous data is restored from there so one broken source doesn't
blank out the app.
"""
import asyncio
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build import CHAIN_NAMES, HERE, build_chain, merge  # noqa: E402
from fetch import CHAINS, fetch_chain  # noqa: E402
from geocode import Geocoder  # noqa: E402

SCRAPER_OF = {v: k for k, v in CHAINS.items()}


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Shopil-CI"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def restore_previous(chain: str, out: Path) -> bool:
    base = os.environ.get("PREVIOUS_URL", "").rstrip("/")
    if not base:
        return False
    try:
        part = json.loads(get(f"{base}/data/parts/{chain}.json"))
    except Exception as exc:  # noqa: BLE001
        print(f"[{chain}] no previous data: {exc}", flush=True)
        return False
    (out / "parts").mkdir(parents=True, exist_ok=True)
    (out / "s").mkdir(parents=True, exist_ok=True)
    ok = []
    for store in part["stores"]:
        try:
            (out / "s" / f"{store['id']}.json").write_bytes(get(f"{base}/data/s/{store['id']}.json"))
            ok.append(store)
        except Exception:  # noqa: BLE001
            pass
    part["stores"] = ok
    (out / "parts" / f"{chain}.json").write_text(json.dumps(part, ensure_ascii=False), encoding="utf-8")
    print(f"[{chain}] restored previous data ({len(ok)} stores, {part.get('updated')})", flush=True)
    return bool(ok)


def main() -> None:
    out = Path(sys.argv[1])
    chains = sys.argv[2:] or list(CHAIN_NAMES)
    raw = Path(os.environ.get("RAW_DIR", "raw"))
    geocoder = Geocoder(HERE / "geocode_cache.json")
    failed = []
    for chain in chains:
        shutil.rmtree(raw / chain, ignore_errors=True)
        asyncio.run(fetch_chain(SCRAPER_OF[chain], str(raw)))
        part = build_chain(chain, raw, out, geocoder)
        shutil.rmtree(raw / chain, ignore_errors=True)
        if part is None or len(part["stores"]) == 0:
            failed.append(chain)
            restore_previous(chain, out)
    merge(out)
    if failed:
        print("chains that failed this run:", ", ".join(failed))
    if len(failed) == len(chains):
        sys.exit(1)


if __name__ == "__main__":
    main()
