#!/bin/sh
# Agrega una funcionalidad al repo de la célula: funcionalidades/<funcionalidad>/ con jira/, specs/, contracts/,
# e2e/, README.md y el workspace de VS Code de la funcionalidad.
#
# Uso: sh sdd-plataforma/scripts/sdd-funcionalidad.sh <ruta-del-repo-de-la-célula> <funcionalidad>
#   <funcionalidad>: identificador en minúsculas con guiones (p. ej. boton-pago-generico, nominas-mtn).
#   No tiene que coincidir con el nombre de sus repos: los repos (app, BFF, API, MS, propios o compartidos)
#   se declaran en el workspace <funcionalidad>.code-workspace.
#
# Una funcionalidad es nueva cuando llega su primera épica (FUID, FDT o MAU); las épicas siguientes de una
# funcionalidad existente usan la misma carpeta.
# El repo de la célula debe tener instalado sdd-plataforma con tipo "celula" (sdd-instalar.sh <repo> celula).
# No sobrescribe nada: si la funcionalidad ya existe, solo informa.
set -eu

REPO="${1:?Uso: sdd-funcionalidad.sh <ruta-del-repo-de-la-célula> <funcionalidad>}"
F="${2:?Uso: sdd-funcionalidad.sh <ruta-del-repo-de-la-célula> <funcionalidad>}"
PLAT="$(cd "$(dirname "$0")/.." && pwd)"

echo "$F" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$' || { echo "Nombre de funcionalidad inválido: '$F' (minúsculas, números y guiones)"; exit 2; }

cd "$REPO"
campo_json() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" .github/sdd-plataforma.json 2>/dev/null | head -1; }
[ "$(campo_json tipo)" = celula ] || { echo "$(basename "$(pwd)") no es un repo de célula. Instálalo antes: sh $PLAT/scripts/sdd-instalar.sh $(pwd) celula"; exit 2; }
CELULA="$(campo_json celula)"

D="funcionalidades/$F"
if [ -d "$D" ]; then echo "Ya existe $D: no se cambia nada (es una funcionalidad existente)."; exit 0; fi

plantilla() { mkdir -p "$(dirname "$2")"; sed -e "s/__CELULA__/$CELULA/g" -e "s/__FUNCIONALIDAD__/$F/g" "$1" > "$2"; echo "  INSTALAR   $2"; }

echo "== $(basename "$(pwd)") · funcionalidad nueva: $F (célula $CELULA)"
for c in jira specs contracts; do mkdir -p "$D/$c"; : > "$D/$c/.gitkeep"; echo "  INSTALAR   $D/$c/"; done
plantilla "$PLAT/plantillas/funcionalidad/README.md" "$D/README.md"
plantilla "$PLAT/plantillas/funcionalidad/e2e-README.md" "$D/e2e/README.md"
plantilla "$PLAT/plantillas/funcionalidad/funcionalidad.code-workspace" "$D/$F.code-workspace"

SERVS="$(ls -d servicios/*/ 2>/dev/null | sed 's|servicios/||; s|/$||' | paste -sd' ' -)"
echo
echo "== Listo. Siguientes pasos:"
echo "   1. Declara los repos en $D/$F.code-workspace (app, BFF, API y MS) y en la tabla de $D/README.md."
[ -n "$SERVS" ] && echo "      Servicios compartidos de la célula: $SERVS (agrégalos si la funcionalidad los usa)."
echo "   2. En la app y el BFF (y en el API y el MS si son propios): sh $PLAT/scripts/sdd-instalar.sh ../<repo> capa $CELULA/$F"
echo "      Un API o MS compartido se instala sin funcionalidad: sh $PLAT/scripts/sdd-instalar.sh ../<repo> capa $CELULA"
echo "   3. git add $D && git commit -m \"<CLAVE> Funcionalidad $F en la célula $CELULA\""
