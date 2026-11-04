#!/bin/sh
# Corre el E2E de una funcionalidad de la célula con Playwright.
# Uso (en la raíz de celula-<célula>):
#   sh ci/e2e.sh <funcionalidad> ["<tags>"]   p. ej. sh ci/e2e.sh boton-pago-generico "@spec-004|@WCAP-301"
#   sh ci/e2e.sh --todos ["<tags>"]           todas las funcionalidades: corrida nocturna o, con tags, el cambio
#                                             de un API o MS compartido (sus specs pueden ser de varias funcionalidades)
# Sin tags corre toda la suite (regresión antes del pase). La numeración de specs es única en la célula,
# así que un tag @spec-NNN nunca selecciona tests de otra funcionalidad.
# URLs: BFF_URL_<FUNCIONALIDAD> y APP_URL_<FUNCIONALIDAD> (mayúsculas, guiones como _), o BFF_URL y APP_URL
# cuando se corre una sola funcionalidad. Ver playwright.config.ts.
set -eu

F="${1:?Uso: sh ci/e2e.sh <funcionalidad> [\"<tags>\"] | --todos [\"<tags>\"]}"
TAGS="${2:-}"

if [ "$F" = --todos ]; then
  set --
else
  [ -d "funcionalidades/$F/e2e" ] || { echo "No existe funcionalidades/$F/e2e en $(basename "$(pwd)")"; exit 2; }
  set -- --project="$F-api" --project="$F-ui"
fi
[ -n "$TAGS" ] && set -- "$@" --grep "$TAGS"

exec npx playwright test "$@"
