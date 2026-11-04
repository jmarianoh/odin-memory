#!/bin/sh
# Siguiente número de spec libre en el repo de la célula.
# Uso (en la raíz de celula-<célula>): sh ci/siguiente-spec.sh      → imprime NNN
#
# La numeración es única en toda la célula, no por funcionalidad: así las ramas feature/NNN-*,
# los tags @spec-NNN y las carpetas de spec no chocan entre funcionalidades del mismo repo, ni en los
# API y MS compartidos, que reciben historias de varias funcionalidades.
# Considera las specs de todas las funcionalidades (funcionalidades/*/specs/NNN-*) y las ramas feature/NNN-*
# locales y remotas. Corre `git pull` antes; si dos devs toman el mismo número a la vez, el
# control [numeracion] de ci/sdd-checks.sh lo detecta en el MR.
set -eu

git fetch -q --prune 2>/dev/null || true

MAX=0
for N in $( {
  ls -d funcionalidades/*/specs/[0-9][0-9][0-9]-* 2>/dev/null | sed -n 's|.*/specs/\([0-9][0-9][0-9]\)-.*|\1|p'
  git for-each-ref --format='%(refname:short)' refs/heads refs/remotes 2>/dev/null \
    | sed -n 's|^\([^/]*/\)\{0,1\}feature/\([0-9][0-9][0-9]\)-.*|\2|p'
} ); do
  N=$(echo "$N" | sed 's/^0*//'); [ -n "$N" ] || N=0
  [ "$N" -gt "$MAX" ] && MAX=$N
done
printf '%03d\n' $((MAX + 1))
