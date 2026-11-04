#!/bin/sh
# Controles SDD de la gerencia, versión local (sin GitLab CI).
# Uso: sh ci/sdd-checks.sh "<título del MR>" [rama] [base]
#   rama: por defecto la rama actual
#   base: por defecto Desarrollo-CI
# Variables:
#   SIN_CAMBIO_COMPORTAMIENTO=1  equivale a la etiqueta del MR (omite el aviso de regla de oro)
# Sale con código 1 si algún control bloqueante falla. La regla de oro solo avisa.

TITULO="$1"
RAMA="${2:-$(git rev-parse --abbrev-ref HEAD)}"
BASE="${3:-Desarrollo-CI}"
FALLOS=0
AVISOS=0

ok()    { printf '  \033[32mOK\033[0m     %s\n' "$1"; }
falla() { printf '  \033[31mFALLA\033[0m  %s\n' "$1"; FALLOS=$((FALLOS + 1)); }
aviso() { printf '  \033[33mAVISO\033[0m  %s\n' "$1"; AVISOS=$((AVISOS + 1)); }
omite() { printf '  --     %s\n' "$1"; }

PATRON_TEST='(\.spec\.[cm]?[jt]sx?$|\.e2e-spec\.[cm]?[jt]sx?$|\.test\.[cm]?[jt]sx?$|_test\.dart$|\.jmx$|(^|/)(test|tests|__tests__|integration_test|perf|e2e)/)'

# Tipo de repo: capa (app, BFF, API, MS; propio de una funcionalidad o compartido) o celula
# (celula-<célula>, con funcionalidades/<funcionalidad>/specs, contracts y e2e, y servicios/<repo>/contracts)
campo_json() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" .github/sdd-plataforma.json 2>/dev/null | head -1; }
TIPO_REPO="$(campo_json tipo)"
if [ "$TIPO_REPO" != capa ] && [ "$TIPO_REPO" != celula ]; then
  if [ -d funcionalidades ]; then TIPO_REPO=celula; else TIPO_REPO=capa; fi
fi
CELULA="$(campo_json celula)"
FUNC="$(campo_json funcionalidad)"
COMPARTIDO=false
grep -q '"compartido": *true' .github/sdd-plataforma.json 2>/dev/null && COMPARTIDO=true
if [ "$TIPO_REPO" = capa ] && [ "$COMPARTIDO" = true ]; then DONDE=" · compartido"; else DONDE="${FUNC:+ · funcionalidad $FUNC}"; fi

echo "Controles SDD · repo: $(basename "$(pwd)") ($TIPO_REPO${CELULA:+ · célula $CELULA}$DONDE) · rama: $RAMA · base: $BASE"

if ! git rev-parse --verify -q "$BASE" >/dev/null; then
  echo "No existe la rama base $BASE"; exit 2
fi
CAMBIOS=$(git diff --name-only "$BASE"...HEAD)

# 1. rama-feature: el pipeline solo corre en feature/*
echo "[rama-feature]"
case "$RAMA" in
  feature/*) ok "la rama empieza con feature/" ;;
  *) falla "la rama '$RAMA' no empieza con feature/ (el pipeline no correría)" ;;
esac

# 2. clave-jira: el título del MR empieza con la clave
echo "[clave-jira]"
if [ -z "$TITULO" ]; then
  falla "falta el título del MR (primer argumento)"
elif echo "$TITULO" | grep -qE '^[A-Z][A-Z0-9]+-[0-9]+ '; then
  ok "título: $TITULO"
  if echo "$TITULO" | grep -qiE '(close[sd]?|fix(e[sd])?|resolve[sd]?) [A-Z][A-Z0-9]+-[0-9]+'; then
    falla "el título usa una palabra de cierre (Closes/Fixes/Resolves): no se usa en MR de capa"
  fi
else
  falla "el título del MR debe empezar con la clave de la historia en Jira, por ejemplo 'WCAP-104 Autorizar pago · BFF'"
fi

NUM=$(echo "$RAMA" | sed -n 's|^feature/\([0-9][0-9][0-9]\)-.*|\1|p')
case "$RAMA" in feature/[0-9][0-9][0-9]-*|feature/fdt-*|feature/mau-*) DE_HISTORIA=1 ;; *) DE_HISTORIA=0 ;; esac

# Repo de la célula: funcionalidades y servicios compartidos que toca el cambio
if [ "$TIPO_REPO" = celula ]; then
  FUNCS=$(echo "$CAMBIOS" | sed -n 's|^funcionalidades/\([^/]*\)/.*|\1|p' | sort -u)
  N_FUNCS=$(echo "$FUNCS" | grep -c . || true)
  SERVS=$(echo "$CAMBIOS" | sed -n 's|^servicios/\([^/]*\)/.*|\1|p' | sort -u)

  # 2b. numeracion: el número de spec es único en toda la célula
  echo "[numeracion]"
  REPETIDOS=$(ls -d funcionalidades/*/specs/[0-9][0-9][0-9]-* 2>/dev/null | sed -n 's|.*/specs/\([0-9][0-9][0-9]\)-.*|\1|p' | sort | uniq -d)
  if [ -n "$REPETIDOS" ]; then
    for r in $REPETIDOS; do
      falla "la spec $r está repetida en: $(ls -d funcionalidades/*/specs/"$r"-* | paste -sd' ' -). La numeración es única en la célula (sh ci/siguiente-spec.sh)"
    done
  else
    ok "$(ls -d funcionalidades/*/specs/[0-9][0-9][0-9]-* 2>/dev/null | grep -c . || true) spec(s) en $(ls -d funcionalidades/*/ 2>/dev/null | grep -c . || true) funcionalidad(es), sin números repetidos"
  fi

  # 2c. funcionalidad: una rama de historia toca una sola funcionalidad; los contratos de un servicio
  #     compartido (servicios/<repo>/) los cambia su dueño en su propio MR
  echo "[funcionalidad]"
  if [ "$N_FUNCS" -le 1 ]; then
    if [ -n "$FUNCS" ]; then ok "el cambio toca solo funcionalidades/$FUNCS"
    elif [ -n "$SERVS" ]; then ok "el cambio toca solo servicios/: $(echo $SERVS) (contratos de servicios compartidos)"
    else ok "el cambio no toca funcionalidades/ ni servicios/ (cambio de la célula: ci, Playwright, estándar)"; fi
  elif [ "$DE_HISTORIA" = 1 ]; then
    falla "una historia es de una sola funcionalidad y esta rama toca: $(echo $FUNCS)"
  else
    aviso "el cambio toca varias funcionalidades: $(echo $FUNCS). Confirma que es un cambio de la célula y no de una historia"
  fi
  if [ -n "$SERVS" ] && [ -n "$FUNCS" ]; then
    aviso "la rama cambia el contrato compartido servicios/$(echo $SERVS) junto con funcionalidades/$(echo $FUNCS): el contrato de un servicio compartido lo cambia su dueño, en su propio MR, y afecta a todas las funcionalidades que lo usan"
  fi
fi

# 3. validar-specs: en feature/NNN-* exigir los artefactos de la spec
echo "[validar-specs]"
if [ -z "$NUM" ]; then
  omite "no es rama de FUID (feature/NNN-*)"
else
  if [ "$TIPO_REPO" = celula ]; then
    DIR=""
    [ "$N_FUNCS" = 1 ] && DIR=$(ls -d funcionalidades/"$FUNCS"/specs/"$NUM"-* 2>/dev/null | head -1)
    [ -n "$DIR" ] || DIR=$(ls -d funcionalidades/*/specs/"$NUM"-* 2>/dev/null | head -1)
    NO_ESTA="no existe funcionalidades/<funcionalidad>/specs/$NUM-*"
    REQ="spec.md impacto.md"
  else
    DIR=$(ls -d specs/"$NUM"-* 2>/dev/null | head -1)
    NO_ESTA="no existe specs/$NUM-*"
    REQ="spec.md plan.md tasks.md"
  fi
  if [ -z "$DIR" ]; then
    falla "$NO_ESTA"
  else
    for f in $REQ; do
      if [ -f "$DIR/$f" ]; then ok "$DIR/$f"; else falla "falta $DIR/$f"; fi
    done
    if [ -f "$DIR/spec.md" ] && ! grep -qE '^\*\*Jira\*\*: *[A-Z][A-Z0-9]+-[0-9]+' "$DIR/spec.md"; then
      falla "$DIR/spec.md no tiene la clave de Jira en el encabezado (**Jira**: WCAP-NNN)"
    fi
    if [ -f "$DIR/tasks.md" ] && grep -qE '^- \[[ xX]\] T[0-9]+ ' "$DIR/tasks.md" && \
       grep -E '^- \[[ xX]\] T[0-9]+ ' "$DIR/tasks.md" | grep -vqE '\[(tester|implementer)\]'; then
      falla "$DIR/tasks.md tiene tareas sin rol [tester] o [implementer]"
    fi
    if [ -f "$DIR/tasks.md" ] && ! grep -qiE 'e2e' "$DIR/tasks.md"; then
      falla "$DIR/tasks.md no tiene la tarea E2E final"
    fi
    if [ "$TIPO_REPO" = celula ]; then
      F_SPEC=$(echo "$DIR" | sed 's|^funcionalidades/\([^/]*\)/.*|\1|')
      if [ -n "$FUNCS" ] && [ "$FUNCS" != "$F_SPEC" ]; then
        falla "la spec $NUM es de la funcionalidad $F_SPEC y la rama cambia funcionalidades/$(echo $FUNCS)"
      fi
      E2E=$(ls -d funcionalidades/"$F_SPEC"/e2e/"$NUM"-* 2>/dev/null | head -1)
      if [ -n "$E2E" ]; then ok "tests E2E en $E2E"; else omite "todavía sin tests en funcionalidades/$F_SPEC/e2e/$NUM-* (los escribe el SDD Tester en la última fase de tasks.md)"; fi
    fi
  fi
fi

# 4. veredicto-fdt-mau
echo "[veredicto-fdt-mau]"
case "$RAMA" in
  feature/fdt-*|feature/mau-*)
    if [ "$TIPO_REPO" = celula ]; then
      omite "repo de la célula: el veredicto del FDT o MAU queda en el repo de capa donde se corrigió"
    else
    TIPO=$(echo "$RAMA" | sed 's|^feature/\([a-z]*\)-.*|\1|')
    SLUG=$(echo "$RAMA" | sed -E 's|^feature/[a-z]+-||; s|^[A-Z][A-Z0-9]+-[0-9]+-||')
    if [ "$TIPO" = fdt ]; then ARCH=".specify/fdt/$SLUG/test.md"; PAT='verificado'; else ARCH=".specify/bugs/$SLUG/test.md"; PAT='verified|verificado'; fi
    if [ ! -f "$ARCH" ]; then
      falla "falta $ARCH"
    elif grep -qiE "\*\*(Resultado|Result)\*\*: *($PAT)\b" "$ARCH"; then
      ok "$ARCH con veredicto verificado"
    else
      falla "$ARCH no tiene veredicto verificado"
    fi
    fi
    ;;
  *) omite "no es rama de FDT ni MAU" ;;
esac

# 5. tests-intactos: ningún commit [implementer] toca archivos de test
echo "[tests-intactos]"
VIOLACIONES=""
for c in $(git rev-list "$BASE"..HEAD); do
  ASUNTO=$(git log -1 --format=%s "$c")
  case "$ASUNTO" in
    "[implementer]"*)
      T=$(git diff-tree --no-commit-id --name-only -r "$c" | grep -E "$PATRON_TEST")
      [ -n "$T" ] && VIOLACIONES="$VIOLACIONES
    $(git log -1 --format='%h %s' "$c"): $(echo $T)"
      ;;
  esac
done
N_IMPL=$(git log --format=%s "$BASE"..HEAD | grep -c '^\[implementer\]')
N_TEST=$(git log --format=%s "$BASE"..HEAD | grep -c '^\[tester\]')
if [ -n "$VIOLACIONES" ]; then
  falla "commits [implementer] que modifican tests:$VIOLACIONES"
else
  ok "commits [tester]: $N_TEST · commits [implementer]: $N_IMPL · ninguno [implementer] toca tests"
fi

# 5b. jmeter: en BFF, API y MS, si plan.md dice "JMeter: sí", exigir perf/NNN-*/*.jmx
echo "[jmeter]"
if [ -z "$NUM" ] || [ "$TIPO_REPO" != capa ]; then
  omite "no es rama de FUID en un repo de capa"
else
  PLAN=$(ls -d specs/"$NUM"-*/plan.md 2>/dev/null | head -1)
  if [ -z "$PLAN" ]; then
    omite "no hay plan.md de la spec $NUM"
  elif grep -qiE '^\*\*JMeter\*\*: *s[ií]' "$PLAN"; then
    JMX=$(ls perf/"$NUM"-*/*.jmx 2>/dev/null | head -1)
    if [ -n "$JMX" ]; then ok "$JMX"; else falla "$PLAN dice JMeter: sí y no existe perf/$NUM-*/*.jmx"; fi
  elif grep -qiE '^\*\*JMeter\*\*: *no' "$PLAN"; then
    ok "$PLAN dice JMeter: $(sed -n 's/^\*\*JMeter\*\*: *//p' "$PLAN" | head -1)"
  else
    aviso "$PLAN no tiene la línea **JMeter**: sí | no (obligatoria en BFF, API y MS)"
  fi
fi

# 6. regla-de-oro (solo avisa)
echo "[regla-de-oro]"
if [ "$TIPO_REPO" = celula ]; then
  omite "repo de la célula: la regla de oro se controla en el repo de capa (specs/mapa.txt)"
elif [ "${SIN_CAMBIO_COMPORTAMIENTO:-}" = 1 ]; then
  omite "etiqueta sin-cambio-comportamiento"
elif [ ! -f specs/mapa.txt ]; then
  omite "no hay specs/mapa.txt"
else
  HAY=0
  while read -r ruta spec; do
    case "$ruta" in ''|\#*) continue ;; esac
    if echo "$CAMBIOS" | grep -q "^$ruta"; then
      HAY=1
      DIRS=$(ls -d specs/"${spec%%-*}"-* 2>/dev/null | head -1)
      if [ -n "$DIRS" ] && echo "$CAMBIOS" | grep -q "^$DIRS/spec.md"; then
        ok "$ruta cambió y $DIRS/spec.md también"
      else
        aviso "$ruta (spec $spec) cambió sin tocar su spec.md: ¿cambia comportamiento? Si no, usa la etiqueta sin-cambio-comportamiento"
      fi
    fi
  done < specs/mapa.txt
  [ "$HAY" = 0 ] && ok "ningún archivo mapeado a una spec cambió"
fi

# 7. specs a correr en E2E (en el repo de la célula, con ci/e2e.sh)
echo "[e2e]"
if [ "$TIPO_REPO" = celula ]; then
  if [ -n "$NUM" ] && [ -n "${F_SPEC:-}" ]; then
    ok "E2E a correr: sh ci/e2e.sh $F_SPEC \"@spec-$NUM\""
  elif [ "$N_FUNCS" -ge 1 ]; then
    for f in $FUNCS; do ok "regresión de la funcionalidad: sh ci/e2e.sh $f"; done
  elif [ -n "$SERVS" ]; then
    ok "contrato compartido: corre la regresión de cada funcionalidad que usa $(echo $SERVS) (sh ci/e2e.sh <funcionalidad>, o sh ci/e2e.sh --todos)"
  else
    omite "el cambio no toca funcionalidades/ (si cambió Playwright o ci/: sh ci/e2e.sh --todos)"
  fi
elif [ -f ci/specs-tocadas.sh ]; then
  GREP=$(sh ci/specs-tocadas.sh "$BASE")
  # Repo compartido: la funcionalidad de la historia sale de su spec ("Spec de la historia" apunta a
  # ../celula-<célula>/funcionalidades/<funcionalidad>/specs/NNN-*).
  F_HIST="$FUNC"
  if [ "$COMPARTIDO" = true ] && [ -n "$NUM" ]; then
    F_HIST=$(sed -n 's|.*funcionalidades/\([a-z0-9-]*\)/specs/.*|\1|p' specs/"$NUM"-*/spec.md 2>/dev/null | head -1)
  fi
  if [ -z "$GREP" ]; then
    omite "ninguna spec afectada según specs/mapa.txt"
  elif [ -z "$CELULA" ]; then
    ok "E2E a correr: tags \"$GREP\" (falta la célula en .github/sdd-plataforma.json: sdd-instalar.sh . capa <célula>[/<funcionalidad>])"
  elif [ "$COMPARTIDO" = true ] && { [ -z "$F_HIST" ] || [ "$GREP" != "@spec-$NUM" ]; }; then
    ok "E2E a correr (repo compartido: las specs pueden ser de varias funcionalidades): sh ../celula-$CELULA/ci/e2e.sh --todos \"$GREP\""
  elif [ -n "$F_HIST" ]; then
    ok "E2E a correr: sh ../celula-$CELULA/ci/e2e.sh $F_HIST \"$GREP\""
  else
    ok "E2E a correr: sh ../celula-$CELULA/ci/e2e.sh --todos \"$GREP\""
  fi
else
  omite "no hay ci/specs-tocadas.sh"
fi

echo
if [ "$FALLOS" -gt 0 ]; then
  echo "Resultado: $FALLOS control(es) bloqueante(s) fallaron · $AVISOS aviso(s). El MR no se puede mergear."
  exit 1
fi
echo "Resultado: controles en verde · $AVISOS aviso(s)."
