#!/bin/sh
# Agrega un servicio compartido (API o MS que usan varias funcionalidades) al repo de la célula:
# servicios/<repo>/ con contracts/ y README.md.
#
# Uso: sh sdd-plataforma/scripts/sdd-servicio.sh <ruta-del-repo-de-la-célula> <repo>
#   <repo>: nombre del repo de capa compartido, tal cual (p. ej. botonpago-api, botonpago-ms).
#
# Los contratos del servicio se versionan con tags servicios/<repo>/contracts-vX.Y.Z y los cambia su dueño
# en su propio MR. El servicio no tiene specs ni E2E propios: cada historia tiene su spec en la funcionalidad
# que la pidió. No sobrescribe nada: si el servicio ya existe, solo informa.
set -eu

REPO="${1:?Uso: sdd-servicio.sh <ruta-del-repo-de-la-célula> <repo>}"
S="${2:?Uso: sdd-servicio.sh <ruta-del-repo-de-la-célula> <repo>}"
PLAT="$(cd "$(dirname "$0")/.." && pwd)"

echo "$S" | grep -qE '^[a-z0-9]+([-_.][a-z0-9]+)*$' || { echo "Nombre de repo inválido: '$S' (minúsculas, números, guiones, puntos o _)"; exit 2; }

cd "$REPO"
campo_json() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" .github/sdd-plataforma.json 2>/dev/null | head -1; }
[ "$(campo_json tipo)" = celula ] || { echo "$(basename "$(pwd)") no es un repo de célula. Instálalo antes: sh $PLAT/scripts/sdd-instalar.sh $(pwd) celula"; exit 2; }
CELULA="$(campo_json celula)"

D="servicios/$S"
if [ -d "$D" ]; then echo "Ya existe $D: no se cambia nada."; exit 0; fi

echo "== $(basename "$(pwd)") · servicio compartido nuevo: $S (célula $CELULA)"
mkdir -p "$D/contracts"; : > "$D/contracts/.gitkeep"; echo "  INSTALAR   $D/contracts/"
sed -e "s/__CELULA__/$CELULA/g" -e "s/__SERVICIO__/$S/g" "$PLAT/plantillas/servicio/README.md" > "$D/README.md"; echo "  INSTALAR   $D/README.md"

echo
echo "== Listo. Siguientes pasos:"
echo "   1. Agrega $S al workspace de cada funcionalidad que lo usa (funcionalidades/<f>/<f>.code-workspace), con \"(compartido)\" en el name."
echo "   2. En el repo del servicio: sh $PLAT/scripts/sdd-instalar.sh ../$S capa $CELULA"
echo "   3. git add $D && git commit -m \"<CLAVE> Servicio compartido $S en la célula $CELULA\""
