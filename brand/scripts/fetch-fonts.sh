#!/usr/bin/env bash
# Fetch the two brand typefaces (SIL Open Font License 1.1) from the npm registry into
# brand/.fonts (ignored by version control). The logo outlines and every rendered asset are
# built from these exact files, so the versions are pinned.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -n "$HERE" ] && [ "$HERE" != "/" ] || { echo "can't locate brand/" >&2; exit 1; }
OUT="$HERE/.fonts"
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm pack --silent @fontsource-variable/fraunces@5.3.0 @fontsource-variable/schibsted-grotesk@5.3.0 @fontsource-variable/jetbrains-mono@5.3.0 >/dev/null
for t in *.tgz; do mkdir -p "${t%.tgz}" && tar xzf "$t" -C "${t%.tgz}"; done
F=fontsource-variable-fraunces-5.3.0/package
S=fontsource-variable-schibsted-grotesk-5.3.0/package
J=fontsource-variable-jetbrains-mono-5.3.0/package
cp "$J/files/jetbrains-mono-latin-wght-normal.woff2" "$OUT/JetBrainsMono-VF.woff2"
cp "$J/LICENSE" "$OUT/JetBrainsMono-OFL.txt"
cp "$F/files/fraunces-latin-full-normal.woff2" "$OUT/Fraunces-VF.woff2"
cp "$F/files/fraunces-latin-full-italic.woff2" "$OUT/Fraunces-Italic-VF.woff2"
cp "$S/files/schibsted-grotesk-latin-wght-normal.woff2" "$OUT/SchibstedGrotesk-VF.woff2"
cp "$F/LICENSE" "$OUT/Fraunces-OFL.txt"
cp "$S/LICENSE" "$OUT/SchibstedGrotesk-OFL.txt"
echo "fonts in $OUT"
