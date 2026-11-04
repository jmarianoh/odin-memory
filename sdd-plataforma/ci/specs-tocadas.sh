#!/bin/sh
# Arma el filtro de tags de Playwright con las specs que toca un cambio, según specs/mapa.txt.
# Uso: sh ci/specs-tocadas.sh [base]     (por defecto compara HEAD~1..HEAD)
# Formato de specs/mapa.txt: "<ruta> <NNN-nombre>" por línea; "#" para comentarios.
# Si cambia el runtime o las dependencias (package.json, lockfile, Dockerfile, .nvmrc),
# devuelve todas las specs del mapa: un cambio técnico exige regresión completa.
if [ -n "$1" ]; then
  CAMBIOS=$(git diff --name-only "$1"...HEAD)
else
  CAMBIOS=$(git diff --name-only HEAD~1 HEAD 2>/dev/null)
fi
[ -f specs/mapa.txt ] || exit 0

if echo "$CAMBIOS" | grep -qE '^(package\.json|package-lock\.json|Dockerfile|\.nvmrc|\.node-version)$'; then
  grep -vE '^\s*(#|$)' specs/mapa.txt | awk '{print $2}' | sed 's/-.*//' | sed 's/^/@spec-/' | sort -u | paste -sd'|' -
  exit 0
fi

while read -r ruta spec; do
  case "$ruta" in ''|\#*) continue ;; esac
  echo "$CAMBIOS" | grep -q "^$ruta" && echo "@spec-${spec%%-*}"
done < specs/mapa.txt | sort -u | paste -sd'|' -
