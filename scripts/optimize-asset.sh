#!/usr/bin/env bash
# Optimize a raw GLB into a game-ready one (Phase 6 pipeline).
# Usage: scripts/optimize-asset.sh <input.glb> <output.glb> [texture-size]
#
# Note: KTX2 (--texture-compress ktx2) needs KTX-Software (toktx) on PATH.
# Without it, we fall back to WebP textures (still a huge win, just not GPU-compressed).
set -euo pipefail

IN="${1:?input GLB path required}"
OUT="${2:?output GLB path required}"
TEX_SIZE="${3:-1024}"

if command -v toktx >/dev/null 2>&1; then
  TEXTURE_COMPRESS="ktx2"
else
  echo "warn: toktx not found — using WebP textures instead of KTX2." >&2
  TEXTURE_COMPRESS="webp"
fi

mkdir -p "$(dirname "$OUT")"

npx --yes @gltf-transform/cli@latest optimize "$IN" "$OUT" \
  --compress draco \
  --texture-compress "$TEXTURE_COMPRESS" \
  --texture-size "$TEX_SIZE"

echo "Optimized: $IN -> $OUT"
