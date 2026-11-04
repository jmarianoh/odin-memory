#!/bin/sh
# Actualiza las skills de terceros desde su repo de origen y registra el commit en vendor/upstream.tsv.
# Deja los cambios sin commit: revisa el diff completo antes de publicar (las skills son instrucciones
# que el agente sigue; un cambio upstream se revisa igual que código).
#
# Uso: sh sdd-dev-process/scripts/actualizar-skills.sh <angular|nestjs|flutter|todas>
#
#   angular → skills/stack/angular-developer/        (angular/skills, carpeta angular-developer)
#   nestjs  → skills/stack/nestjs-best-practices/    (Kadajett/agent-nestjs-skills, skills/nestjs-best-practices)
#   flutter → skills/stack/flutter/references/*.md   (flutter/agent-plugins, skills/<nombre>/SKILL.md)
#             Solo se actualizan las referencias que ya están en el repo; la selección es nuestra.
set -eu

DEV="$(cd "$(dirname "$0")/.." && pwd)"
CUAL="${1:?Uso: actualizar-skills.sh <angular|nestjs|flutter|todas>}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HOY="$(date +%Y-%m-%d)"

clonar() {  # $1=repo de GitHub  $2=carpeta destino temporal
  git clone -q --depth 1 "https://github.com/$1.git" "$TMP/$2"
  git -C "$TMP/$2" rev-parse HEAD
}

registrar() {  # $1=skill  $2=commit
  anterior="$(awk -F'\t' -v s="$1" '$1 == s { print $4 }' "$DEV/vendor/upstream.tsv")"
  awk -F'\t' -v OFS='\t' -v s="$1" -v c="$2" -v f="$HOY" '$1 == s { $4 = c; $5 = f } { print }' \
    "$DEV/vendor/upstream.tsv" > "$TMP/upstream.tsv"
  cp "$TMP/upstream.tsv" "$DEV/vendor/upstream.tsv"
  if [ "$anterior" = "$2" ]; then echo "  $1: sin cambios upstream ($2)"; else echo "  $1: ${anterior:-ninguno} → $2"; fi
}

angular() {
  commit="$(clonar angular/skills angular)"
  rm -rf "$DEV/skills/stack/angular-developer"
  cp -R "$TMP/angular/angular-developer" "$DEV/skills/stack/angular-developer"
  registrar angular-developer "$commit"
}

nestjs() {
  commit="$(clonar Kadajett/agent-nestjs-skills nestjs)"
  rm -rf "$DEV/skills/stack/nestjs-best-practices"
  cp -R "$TMP/nestjs/skills/nestjs-best-practices" "$DEV/skills/stack/nestjs-best-practices"
  registrar nestjs-best-practices "$commit"
}

flutter() {
  commit="$(clonar flutter/agent-plugins flutter)"
  for ref in "$DEV"/skills/stack/flutter/references/*.md; do
    nombre="$(basename "$ref" .md)"
    if [ -f "$TMP/flutter/skills/$nombre/SKILL.md" ]; then
      cp "$TMP/flutter/skills/$nombre/SKILL.md" "$ref"
    else
      echo "  AVISO: $nombre ya no existe en flutter/agent-plugins; revisa si se renombró o se quita"
    fi
  done
  cp "$TMP/flutter/LICENSE" "$DEV/vendor/licencias/flutter-agent-plugins-BSD-3-Clause.txt"
  anterior="$(awk -F'\t' '$1 == "flutter" { print $4 }' "$DEV/vendor/upstream.tsv")"
  if [ -n "$anterior" ] && [ "$anterior" != "$commit" ]; then
    corto_ant="$(printf '%.7s' "$anterior")"; corto="$(printf '%.7s' "$commit")"
    sed -e "s/$anterior/$commit/g" -e "s/$corto_ant/$corto/g" "$DEV/skills/stack/flutter/SKILL.md" > "$TMP/flutter-skill.md"
    cp "$TMP/flutter-skill.md" "$DEV/skills/stack/flutter/SKILL.md"
  fi
  registrar flutter "$commit"
}

echo "== Actualizando skills de terceros ($CUAL)"
case "$CUAL" in
  angular) angular ;;
  nestjs) nestjs ;;
  flutter) flutter ;;
  todas) angular; nestjs; flutter ;;
  *) echo "Opción inválida: $CUAL (angular|nestjs|flutter|todas)"; exit 2 ;;
esac

echo
echo "== Cambios (revisa el diff completo antes del commit):"
git -C "$DEV" status --short -- skills/stack vendor || true
echo "   git -C $DEV diff -- skills/stack vendor"
echo "   Si hay cambios: sube VERSION, agrega una entrada en CHANGELOG.md y haz commit."
