#!/bin/bash
# Fetch chains that block non-Israeli servers (run on a Mac in Israel) and
# upload the built data to the GitHub release "il-data". The cloud build
# downloads it and merges it with the other chains.
#
# Usage: scripts/il_upload.sh [CHAIN ...]   (default: hazihinam)
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CHAINS=("${@:-hazihinam}")
REPO="chen890/Shopil"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== $(date '+%F %T') il_upload: ${CHAINS[*]}"
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r pipeline/requirements.txt
fi

# Build only these chains into a fresh output folder
RAW_DIR="$WORK/raw" .venv/bin/python pipeline/run_all.py "$WORK/out" "${CHAINS[@]}"

ok=0
for chain in "${CHAINS[@]}"; do
  part="$WORK/out/parts/$chain.json"
  if [ ! -s "$part" ]; then echo "[$chain] no data built, skipping upload"; continue; fi
  (cd "$WORK/out" && tar -czf "$WORK/$chain.tar.gz" "parts/$chain.json" s/"$chain"-*.json)
  gh release view il-data -R "$REPO" >/dev/null 2>&1 || \
    gh release create il-data -R "$REPO" --title "Israel-only chain data" \
      --notes "Uploaded from a Mac in Israel by scripts/il_upload.sh. Used by the cloud build." --latest=false
  gh release upload il-data "$WORK/$chain.tar.gz" -R "$REPO" --clobber
  echo "[$chain] uploaded $(du -h "$WORK/$chain.tar.gz" | cut -f1)"
  ok=1
done
[ "$ok" = 1 ] || exit 1
