"""Download store / full-price / full-promo files for the supported chains.

Usage: python pipeline/fetch.py OUT_DIR [CHAIN ...]
"""
import asyncio
import sys
import time

from il_supermarket_scarper import FileTypesFilters, ScraperFactory
from il_supermarket_scarper.utils.files.file_output import DiskFileOutput

# Scraper name -> (chain key used by the app)
CHAINS = {
    "SHUFERSAL": "shufersal",
    "RAMI_LEVY": "ramilevy",
    "YOHANANOF": "yohananof",
    "OSHER_AD": "osherad",
    "TIV_TAAM": "tivtaam",
    "YAYNO_BITAN_AND_CARREFOUR": "carrefour",
    "HAZI_HINAM": "hazihinam",
    # Victory (laibcatalog.co.il) currently blocks automated access.
}

FILE_TYPES = [
    FileTypesFilters.STORE_FILE.name,
    FileTypesFilters.PRICE_FULL_FILE.name,
    FileTypesFilters.PROMO_FULL_FILE.name,
]


async def fetch_chain(name: str, out: str) -> None:
    started = time.time()
    scraper = getattr(ScraperFactory, name).value(
        file_output=DiskFileOutput(f"{out}/{CHAINS[name]}")
    )
    count = 0
    try:
        async for result in scraper.scrape(files_types=FILE_TYPES):
            count += 1
            if result.error:
                print(f"[{name}] error {result.file_name}: {result.error}", flush=True)
    except Exception as exc:  # keep other chains going
        print(f"[{name}] FAILED: {exc!r}", flush=True)
    print(f"[{name}] {count} files in {time.time() - started:.0f}s", flush=True)


async def main() -> None:
    out = sys.argv[1]
    names = sys.argv[2:] or list(CHAINS)
    await asyncio.gather(*(fetch_chain(n, out) for n in names))


if __name__ == "__main__":
    asyncio.run(main())
