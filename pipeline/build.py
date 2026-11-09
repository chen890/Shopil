"""Turn raw price-transparency XML files into compact JSON for the static site.

Usage: python pipeline/build.py RAW_DIR OUT_DIR [CHAIN ...]

Output (OUT_DIR):
  meta.json                 build time + per-chain info
  stores.json               every store with coordinates
  catalog.json              barcode -> [name, manufacturer, size text, weighted, store count]
  s/<chain>-<store>.json    {"p": {barcode: price}, "d": {barcode: [[qty, total, club, desc]]}, "t": [desc...]}
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from lxml import etree

sys.path.insert(0, str(Path(__file__).parent))
from geocode import Geocoder  # noqa: E402

HERE = Path(__file__).parent
LOCALITIES = json.loads((HERE / "localities.json").read_text(encoding="utf-8"))

CHAIN_NAMES = {
    "shufersal": "שופרסל",
    "ramilevy": "רמי לוי",
    "yohananof": "יוחננוף",
    "osherad": "אושר עד",
    "tivtaam": "טיב טעם",
    "carrefour": "קרפור / יינות ביתן",
    "hazihinam": "חצי חינם",
}

# Only real barcodes are comparable across chains (internal codes are chain specific).
BARCODE_RE = re.compile(r"^\d{8,14}$")
DATE_IN_NAME = re.compile(r"-(\d{8})(\d{4,6})?(?:\D|$)|-(\d{8})-(\d{4,6})")
ONLINE_WORDS = ("אונליין", "משלוח", "online", "אינטרנט", "דיגיטל", "וירטואלי")


def local(tag) -> str:
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].lower()


def text(el, name: str) -> str:
    for child in el:
        if local(child.tag) == name:
            return (child.text or "").strip()
    return ""


def num(value: str):
    try:
        return float(value.replace(",", ""))
    except (ValueError, AttributeError):
        return None


def file_stamp(path: Path) -> str:
    """Sortable timestamp from the file name (falls back to mtime)."""
    digits = re.findall(r"(20\d{6})-?(\d{4,6})?", path.name)
    if digits:
        d, t = digits[-1]
        return d + (t or "").ljust(6, "0")
    return datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y%m%d%H%M%S")


def kind_of(path: Path) -> str | None:
    n = path.name.lower()
    if n.startswith("pricefull"):
        return "price"
    if n.startswith("promofull"):
        return "promo"
    if n.startswith("stores"):
        return "stores"
    return None


def iter_elements(path: Path, names: set[str]):
    try:
        for _, el in etree.iterparse(
            str(path), events=("end",), recover=True, huge_tree=True
        ):
            if local(el.tag) in names:
                yield el
                el.clear()
    except etree.XMLSyntaxError as exc:
        print(f"  ! parse error {path.name}: {exc}", file=sys.stderr)


def root_store_id(path: Path) -> str | None:
    for _, el in etree.iterparse(str(path), events=("end",), recover=True):
        if local(el.tag) == "storeid":
            return str(int(el.text)) if (el.text or "").strip().isdigit() else None
    return None


# ---------------------------------------------------------------- stores
def parse_stores(chain: str, files: list[Path]) -> dict[str, dict]:
    stores: dict[str, dict] = {}
    for path in sorted(files, key=file_stamp):  # newer files override older
        for el in iter_elements(path, {"store"}):
            sid = text(el, "storeid")
            if not sid.isdigit():
                continue
            name = text(el, "storename")
            address = text(el, "address")
            city_raw = text(el, "city")
            city = LOCALITIES.get(str(int(city_raw)), "") if city_raw.isdigit() else city_raw
            stype = text(el, "storetype")
            online = stype == "2" or any(w in (name + address).lower() for w in ONLINE_WORDS)
            stores[str(int(sid))] = {
                "id": f"{chain}-{int(sid)}",
                "chain": chain,
                "name": name,
                "address": "" if address.lower() in ("unknown", "none") else address,
                "city": city,
                "online": online,
            }
    return stores


# ---------------------------------------------------------------- prices
def parse_prices(path: Path, catalog: dict) -> dict[str, float]:
    prices: dict[str, float] = {}
    for el in iter_elements(path, {"item", "product"}):
        code = text(el, "itemcode").lstrip("0")
        if not BARCODE_RE.match(code.zfill(8)) or len(code) < 7:
            continue
        price = num(text(el, "itemprice"))
        if not price or price <= 0 or price > 5000:
            continue
        prices[code] = round(price, 2)
        if code not in catalog:
            qty = num(text(el, "quantity")) or 0
            unit = text(el, "unitqty")
            size = ""
            if qty and unit and unit not in ("לא ידוע", "יחידה"):
                size = f"{qty:g} {unit}"
            catalog[code] = [
                re.sub(r"\s+", " ", text(el, "itemname")),
                re.sub(r"\s+", " ", text(el, "manufacturername") or text(el, "manufacturename")),
                size,
                1 if text(el, "bisweighted") == "1" else 0,
            ]
    return prices


# ---------------------------------------------------------------- promos
def club_of(raw: str) -> int | None:
    """0 = everyone, 1 = chain club, 2 = chain credit card, None = skip."""
    m = re.match(r"\s*(\d+)", raw or "0")
    club = int(m.group(1)) if m else 0
    return club if club in (0, 1, 2) else None


def parse_dt(value: str):
    value = (value or "").strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def parse_promos(path: Path, prices: dict[str, float], now: datetime):
    """Return {barcode: [[minQty, totalPriceForMinQty, club, descIndex]]}, descs."""
    deals: dict[str, list] = defaultdict(list)
    descs: list[str] = []
    desc_idx: dict[str, int] = {}
    for promo in iter_elements(path, {"promotion", "sale"}):
        start = parse_dt(text(promo, "promotionstartdatetime") or text(promo, "promotionstartdate"))
        end = parse_dt(text(promo, "promotionenddatetime") or text(promo, "promotionenddate"))
        if (start and start > now) or (end and end < now):
            continue
        if text(promo, "additionaliscoupon") == "1":
            continue  # needs a coupon
        if text(promo, "isgiftitem") == "1" and text(promo, "promotiondescription").find("מתנה") >= 0:
            continue
        club = club_of(text(promo, "clubid"))
        if club is None:
            continue
        min_amount = None
        for el in promo.iter():
            if local(el.tag) == "minpurchaseamount":
                min_amount = num(el.text or "")
        if min_amount and min_amount > 0:
            continue  # depends on whole-basket total
        desc = re.sub(r"\s+", " ", text(promo, "promotiondescription"))[:80]

        promo_qty = num(text(promo, "minqty"))
        promo_price = num(text(promo, "discountedprice"))
        promo_rate = num(text(promo, "discountrate"))
        for item in promo.iter():
            if local(item.tag) not in ("promotionitem", "item") and not (
                local(item.tag) == "sale" and item is promo
            ):
                continue
            code = text(item, "itemcode").lstrip("0")
            regular = prices.get(code)
            if not regular:
                continue
            qty = num(text(item, "minqty")) or promo_qty or 1
            price = num(text(item, "discountedprice"))
            rate = num(text(item, "discountrate"))
            if price is None:
                price = promo_price
            if rate is None:
                rate = promo_rate
            qty = max(1, round(qty)) if qty < 50 else None
            if qty is None:
                continue
            total = None
            if price is not None and price > 0:
                # Chains disagree whether DiscountedPrice is per unit or for all
                # MinQty units. Pick the reading that is a real discount.
                as_total, as_unit = price, price * qty
                if qty > 1 and as_total < regular * qty and as_total > regular * (qty - 1) * 0.5:
                    total = as_total
                elif as_unit < regular * qty:
                    total = as_unit
            elif rate and 0 < rate < 100:
                total = regular * qty * (1 - rate / 100)
            if total is None or total <= 0 or total >= regular * qty - 0.005:
                continue
            if total < regular * qty * 0.15:
                continue  # implausible (gift / bad data)
            if desc not in desc_idx:
                desc_idx[desc] = len(descs)
                descs.append(desc)
            deals[code].append([qty, round(total, 2), club, desc_idx[desc]])
    # keep the best deal per (qty, club)
    out = {}
    for code, lst in deals.items():
        best = {}
        for d in lst:
            key = (d[0], d[2])
            if key not in best or d[1] < best[key][1]:
                best[key] = d
        out[code] = sorted(best.values())
    return out, descs


# ---------------------------------------------------------------- main
def latest_per_store(files: list[Path]) -> dict[str, Path]:
    chosen: dict[str, tuple[str, Path]] = {}
    for path in files:
        sid = root_store_id(path)
        if sid is None:
            continue
        stamp = file_stamp(path)
        if sid not in chosen or stamp > chosen[sid][0]:
            chosen[sid] = (stamp, path)
    return {sid: p for sid, (_, p) in chosen.items()}


def build_chain(chain: str, raw: Path, out: Path, geocoder: Geocoder) -> dict | None:
    """Parse one chain's raw files into out/s/*.json and out/parts/<chain>.json."""
    now = datetime.now()
    folder = raw / chain
    if not folder.is_dir():
        print(f"[{chain}] no data", flush=True)
        return None
    (out / "s").mkdir(parents=True, exist_ok=True)
    (out / "parts").mkdir(parents=True, exist_ok=True)
    by_kind = defaultdict(list)
    for p in folder.rglob("*"):
        if p.is_file() and kind_of(p):
            by_kind[kind_of(p)].append(p)
    stores = parse_stores(chain, by_kind["stores"])
    price_files = latest_per_store(by_kind["price"])
    promo_files = latest_per_store(by_kind["promo"])
    if not price_files:
        print(f"[{chain}] no price files", flush=True)
        return None
    t0 = time.time()
    catalog: dict[str, list] = {}
    popularity: Counter = Counter()
    written = []
    n_items = n_deals = 0
    for sid, pfile in price_files.items():
        prices = parse_prices(pfile, catalog)
        if not prices:
            continue
        deals, descs = ({}, [])
        if sid in promo_files:
            deals, descs = parse_promos(promo_files[sid], prices, now)
        store = stores.get(sid) or {
            "id": f"{chain}-{sid}", "chain": chain, "name": f"סניף {sid}",
            "address": "", "city": "", "online": False,
        }
        store["items"] = len(prices)
        n_items += len(prices)
        for code in prices:
            popularity[code] += 1
        n_deals += len(deals)
        payload = {"p": prices}
        if deals:
            payload["d"] = deals
            payload["t"] = descs
        (out / "s" / f"{store['id']}.json").write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        written.append(store)
    for s in written:
        if not s["online"]:
            loc = geocoder.locate(CHAIN_NAMES[chain], s["name"], s["address"], s["city"])
            if loc:
                s["lat"], s["lon"] = loc
    geocoder.save()
    # drop store files of this chain that no longer exist
    ids = {s["id"] for s in written}
    for f in (out / "s").glob(f"{chain}-*.json"):
        if f.stem not in ids:
            f.unlink()
    part = {
        "chain": chain,
        "name": CHAIN_NAMES[chain],
        "updated": now.strftime("%Y-%m-%d %H:%M"),
        "stores": written,
        "catalog": {c: info + [popularity[c]] for c, info in catalog.items()},
    }
    (out / "parts" / f"{chain}.json").write_text(
        json.dumps(part, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"[{chain}] {len(written)} stores, {n_items} prices, {n_deals} deals, "
          f"{time.time()-t0:.0f}s", flush=True)
    return part


def merge(out: Path) -> None:
    """Combine out/parts/*.json into stores.json, catalog.json and meta.json."""
    catalog: dict[str, list] = {}
    stores: list[dict] = []
    meta = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "chains": {}}
    for f in sorted((out / "parts").glob("*.json")):
        part = json.loads(f.read_text(encoding="utf-8"))
        stores.extend(part["stores"])
        for code, info in part["catalog"].items():
            # prefer the longest (most descriptive) name
            if code not in catalog:
                catalog[code] = info
            else:
                pop = catalog[code][4] + info[4]
                if len(info[0]) > len(catalog[code][0]):
                    catalog[code] = info
                catalog[code][4] = pop
        meta["chains"][part["chain"]] = {
            "name": part["name"], "updated": part["updated"], "stores": len(part["stores"]),
        }
    dump = lambda name, obj: (out / name).write_text(  # noqa: E731
        json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    dump("catalog.json", catalog)
    dump("stores.json", stores)
    dump("meta.json", meta)
    located = sum(1 for s in stores if "lat" in s)
    print(f"merged: {len(stores)} stores ({located} located), {len(catalog)} products")


def main() -> None:
    raw, out = Path(sys.argv[1]), Path(sys.argv[2])
    chains = sys.argv[3:] or list(CHAIN_NAMES)
    geocoder = Geocoder(HERE / "geocode_cache.json")
    for chain in chains:
        if chain != "--merge-only":
            build_chain(chain, raw, out, geocoder)
    merge(out)


if __name__ == "__main__":
    main()
