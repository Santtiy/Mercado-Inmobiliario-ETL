#!/usr/bin/env bash
# Copia el dashboard web a dist/ para que Vercel lo publique.
set -euo pipefail

echo "Directorio de build: $(pwd)"
ls -la

SRC=""
for d in ETL-Inmobiliario/dashboard-web dashboard-web; do
  if [ -f "$d/index.html" ]; then SRC="$d"; break; fi
done
if [ -z "$SRC" ]; then
  f=$(find . -path ./dist -prune -o -path ./node_modules -prune -o \
        -path '*dashboard-web/index.html' -print | head -n 1)
  [ -n "$f" ] && SRC=$(dirname "$f")
fi
if [ -z "$SRC" ]; then
  echo "ERROR: no se encontró dashboard-web/index.html"
  find . -maxdepth 3 -not -path './.git*' | head -n 100
  exit 1
fi

echo "Copiando web desde: $SRC"
rm -rf dist
mkdir -p dist
cp "$SRC"/index.html "$SRC"/style.css "$SRC"/script.js "$SRC"/datos.json dist/
ls -la dist
