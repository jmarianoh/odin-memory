#!/bin/sh
# Instala o actualiza el bloque SDD de la gerencia en un repo (el "bloque Spec Kit común" de los templates).
#
# Uso:
#   sh sdd-plataforma/scripts/sdd-instalar.sh <ruta-del-repo> capa <célula>/<funcionalidad>  repo de capa propio de una funcionalidad (app, BFF y, si no se comparten, API y MS)
#   sh sdd-plataforma/scripts/sdd-instalar.sh <ruta-del-repo> capa <célula>                  repo de capa compartido entre funcionalidades (API o MS, p. ej. botonpago-ms)
#   sh sdd-plataforma/scripts/sdd-instalar.sh <ruta-del-repo> celula [<célula>]              repo de la célula (celula-<célula>)
#   sh sdd-plataforma/scripts/sdd-instalar.sh --revisar <ruta-del-repo> [...]                solo informa, no cambia nada
#
# Tipo, célula y funcionalidad se pueden omitir si el repo ya tiene .github/sdd-plataforma.json.
#   capa   : Spec Kit + integración copilot + preset sdd-gerencia + extensiones git, bug, fdt, sdd
#            + 4 agentes + hook tests-intactos + controles locales + plantillas de MR + instrucciones.
#            <célula>/<funcionalidad> dice dónde están la spec de la historia, los contratos y los E2E:
#            ../celula-<célula>/funcionalidades/<funcionalidad>/. Un repo compartido (solo <célula>) atiende
#            historias de varias funcionalidades: la funcionalidad de cada historia sale de su spec, y sus
#            contratos están en ../celula-<célula>/servicios/<repo>/contracts/.
#   celula : un repo por célula con las specs, contratos y E2E de todas sus funcionalidades
#            (funcionalidades/<funcionalidad>/) y los contratos de sus servicios compartidos (servicios/<repo>/).
#            Spec Kit + preset + extensiones git, sdd + agentes Planner, Tester y Reviewer + hook + controles
#            + Playwright (un proyecto api y uno ui por funcionalidad) + instrucciones. <célula> por defecto sale
#            del nombre del repo (celula-<célula>). Las funcionalidades se agregan con scripts/sdd-funcionalidad.sh
#            y los servicios compartidos con scripts/sdd-servicio.sh.
#
# Qué hace con cada componente:
#   preset y extensiones propias (sdd-gerencia, fdt, sdd): se reinstalan si cambió la versión o el contenido
#   agentes, hook, ci/, plantillas de MR, *.instructions.md, playwright.config.ts: se sobrescriben si son distintos
#   copilot-instructions.md, constitution ratificada, specs/mapa.txt, package.json, .gitignore, README.md:
#   se conservan (los adapta cada repo)
#
# --revisar sale con código 1 si hay algo pendiente, para usarlo en CI o en un recorrido por todos los repos.
# En el piloto el preset y las extensiones se instalan desde carpeta local (--dev). En producción se
# instalan desde el catálogo corporativo (SPECKIT_CATALOG_URL) con versión fijada.
set -eu

MODO=instalar
if [ "${1:-}" = "--revisar" ]; then MODO=revisar; shift; fi
REPO="${1:?Uso: sdd-instalar.sh [--revisar] <ruta-del-repo> [capa <célula>[/<funcionalidad>] | celula [<célula>]]}"
TIPO="${2:-}"
DESTINO="${3:-}"
PLAT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(cat "$PLAT/VERSION")"

cd "$REPO"
NOMBRE="$(basename "$(pwd)")"
[ -d .git ] || { echo "$NOMBRE no es un repo git. Corre 'git init -b master' primero."; exit 2; }

campo_json() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" .github/sdd-plataforma.json 2>/dev/null | head -1; }
INSTALADA="$(campo_json sdd_plataforma)"
[ -n "$TIPO" ] || TIPO="$(campo_json tipo)"
case "$TIPO" in
  capa|celula) ;;
  specs|e2e)
    echo "El tipo '$TIPO' ya no existe: las specs, los contratos y los E2E viven en el repo de la célula"
    echo "(celula-<célula>, tipo celula), en funcionalidades/<funcionalidad>/ y servicios/<repo>/."; exit 2 ;;
  *) echo "Falta o es inválido el tipo: '$TIPO' (capa|celula)"; exit 2 ;;
esac

CELULA="$(campo_json celula)"; FUNC="$(campo_json funcionalidad)"
if [ "$TIPO" = capa ]; then
  if [ -n "$DESTINO" ]; then
    CELULA="${DESTINO%%/*}"
    case "$DESTINO" in */*) FUNC="${DESTINO#*/}" ;; *) FUNC="" ;; esac
  fi
  if [ -z "$CELULA" ]; then
    echo "Falta la célula del repo de capa: sdd-instalar.sh $REPO capa <célula>/<funcionalidad> (propio, p. ej. hades/boton-pago-generico)"
    echo "o sdd-instalar.sh $REPO capa <célula> (API o MS compartido entre funcionalidades, p. ej. hades)"; exit 2
  fi
  if [ -n "$FUNC" ]; then COMPARTIDO=false; else COMPARTIDO=true; fi
else
  [ -n "$DESTINO" ] && CELULA="$DESTINO"
  [ -n "$CELULA" ] || CELULA="$(echo "$NOMBRE" | sed -n 's/^celula-//p')"
  [ -n "$CELULA" ] || { echo "Falta la célula: sdd-instalar.sh $REPO celula <célula> (o nombra el repo celula-<célula>)"; exit 2; }
  FUNC=""; COMPARTIDO=""
fi
for v in "$CELULA" "$FUNC"; do
  [ -z "$v" ] || echo "$v" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$' || { echo "Nombre inválido: '$v' (minúsculas, números y guiones)"; exit 2; }
done

PENDIENTES=0
CAMBIOS=0
estado() { printf '  %-11s %s\n' "$1" "$2"; }
pendiente() { estado "$1" "$2"; PENDIENTES=$((PENDIENTES + 1)); }
hecho() { estado "$1" "$2"; CAMBIOS=$((CAMBIOS + 1)); }

version_de() { sed -n 's/^  version: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p' "$1" 2>/dev/null | head -1; }

# Preset o extensión propia de sdd-plataforma. $1=preset|extension  $2=id  $3=carpeta fuente
componente() {
  tipo_c="$1"; id="$2"; fuente="$3"
  if [ "$tipo_c" = preset ]; then dest=".specify/presets/$id"; manif=preset.yml; else dest=".specify/extensions/$id"; manif=extension.yml; fi
  nueva="$(version_de "$fuente/$manif")"
  if [ ! -d "$dest" ]; then
    accion="instalar"; etiqueta="FALTA"; detalle="$tipo_c $id → $nueva"
  else
    actual="$(version_de "$dest/$manif")"
    if [ "$actual" != "$nueva" ]; then
      accion="actualizar"; etiqueta="DESFASADO"; detalle="$tipo_c $id $actual → $nueva"
    elif ! diff -rq -x .composed -x .specify-dev "$fuente" "$dest" >/dev/null 2>&1; then
      accion="actualizar"; etiqueta="MODIFICADO"; detalle="$tipo_c $id $actual: el contenido cambió sin subir la versión en sdd-plataforma"
    else
      estado "al día" "$tipo_c $id $actual"; return 0
    fi
  fi
  if [ "$MODO" = revisar ]; then pendiente "$etiqueta" "$detalle"; return 0; fi
  if [ "$accion" = actualizar ]; then
    if [ "$tipo_c" = preset ]; then specify preset remove "$id" >/dev/null
    else
      specify extension remove "$id" --force >/dev/null
      rm -rf ".specify/extensions/.backup/$id"; rmdir .specify/extensions/.backup 2>/dev/null || true
    fi
  fi
  if [ "$tipo_c" = preset ]; then specify preset add --dev "$fuente" >/dev/null
  else specify extension add --dev "$fuente" >/dev/null; fi
  hecho "$(echo "$accion" | tr '[:lower:]' '[:upper:]')" "$detalle"
}

# Extensión que trae Spec Kit (git, bug): solo se exige que esté instalada.
extension_core() {
  if [ -d ".specify/extensions/$1" ]; then
    estado "al día" "extension $1 $(version_de ".specify/extensions/$1/extension.yml") (de Spec Kit)"
  elif [ "$MODO" = revisar ]; then pendiente "FALTA" "extension $1 (de Spec Kit)"
  else specify extension add "$1" >/dev/null; hecho "INSTALAR" "extension $1 (de Spec Kit)"
  fi
}

# Archivo administrado por sdd-plataforma: se sobrescribe si es distinto.
archivo() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then estado "al día" "$2"; return 0; fi
  if [ -f "$2" ]; then etiqueta="DESFASADO"; accion="ACTUALIZAR"; else etiqueta="FALTA"; accion="INSTALAR"; fi
  if [ "$MODO" = revisar ]; then pendiente "$etiqueta" "$2"; return 0; fi
  mkdir -p "$(dirname "$2")"; cp "$1" "$2"; hecho "$accion" "$2"
}

# Archivo propio del repo: se crea desde la plantilla solo si falta, con __REPO__, __CELULA__ y __FUNCIONALIDAD__ reemplazados.
# En un repo compartido, __FUNCIONALIDAD__ queda como "<funcionalidad>" (cada historia dice la suya).
archivo_propio() {
  if [ -e "$2" ]; then estado "propio" "$2 (se conserva)"; return 0; fi
  if [ "$MODO" = revisar ]; then pendiente "FALTA" "$2"; return 0; fi
  mkdir -p "$(dirname "$2")"
  sed -e "s/__REPO__/$NOMBRE/g" -e "s/__CELULA__/$CELULA/g" -e "s/__FUNCIONALIDAD__/${FUNC:-<funcionalidad>}/g" "$1" > "$2"
  hecho "INSTALAR" "$2"
}

if [ "$TIPO" != capa ]; then DONDE="célula $CELULA"
elif [ "$COMPARTIDO" = true ]; then DONDE="célula $CELULA · compartido entre funcionalidades"
else DONDE="célula $CELULA · funcionalidad $FUNC"; fi
echo "== $NOMBRE ($TIPO · $DONDE) · instalada: ${INSTALADA:-ninguna} · sdd-plataforma: $VERSION · modo: $MODO"

command -v specify >/dev/null || { echo "Falta specify-cli: uv tool install specify-cli"; exit 2; }

echo "-- Spec Kit"
if [ -d .specify ]; then
  estado "al día" "Spec Kit inicializado (integración $(sed -n 's/.*"integration": *"\([^"]*\)".*/\1/p' .specify/integration.json 2>/dev/null | head -1))"
elif [ "$MODO" = revisar ]; then
  pendiente "FALTA" "specify init"
else
  specify init --here --integration copilot --non-interactive --script sh --force >/dev/null
  hecho "INSTALAR" "specify init (integración copilot)"
fi

if [ -d .specify ] || [ "$MODO" = instalar ]; then
  echo "-- extensiones"
  extension_core git
  if grep -q '^branch_prefix: "feature"' .specify/extensions/git/git-config.yml 2>/dev/null; then
    estado "al día" "ramas feature/NNN-nombre (branch_prefix)"
  elif [ "$MODO" = revisar ]; then
    pendiente "FALTA" "branch_prefix: \"feature\" en .specify/extensions/git/git-config.yml"
  else
    sed -i.bak 's/^branch_prefix: .*/branch_prefix: "feature"/' .specify/extensions/git/git-config.yml
    rm -f .specify/extensions/git/git-config.yml.bak
    hecho "ACTUALIZAR" "branch_prefix: \"feature\""
  fi
  componente extension sdd "$PLAT/extensions/sdd"
  if [ "$TIPO" = capa ]; then
    extension_core bug
    componente extension fdt "$PLAT/extensions/fdt"
  fi

  echo "-- preset"
  componente preset sdd-gerencia "$PLAT/preset/sdd-gerencia"

  echo "-- constitution"
  if grep -q '\[PROJECT_NAME\]' .specify/memory/constitution.md 2>/dev/null; then
    if [ "$MODO" = revisar ]; then
      pendiente "FALTA" ".specify/memory/constitution.md (sigue siendo la plantilla vacía)"
    else
      HOY="$(date +%Y-%m-%d)"
      sed -e "s/\[NOMBRE DEL REPO\]/$NOMBRE/" -e "s/\[FECHA\]/$HOY/g" \
        "$PLAT/preset/sdd-gerencia/templates/constitution-template.md" > .specify/memory/constitution.md
      hecho "INSTALAR" ".specify/memory/constitution.md (base de la gerencia)"
    fi
  else
    estado "propio" ".specify/memory/constitution.md (ratificada; los cambios de la base se llevan a mano)"
  fi
fi

echo "-- agentes"
case "$TIPO" in
  capa)  AGENTES="sdd-planner sdd-tester sdd-implementer sdd-reviewer" ;;
  celula) AGENTES="sdd-planner sdd-tester sdd-reviewer" ;;
esac
for a in $AGENTES; do archivo "$PLAT/agents/$a.agent.md" ".github/agents/$a.agent.md"; done

echo "-- hook"
archivo "$PLAT/hooks/tests-intactos.mjs" .github/hooks/tests-intactos.mjs

echo "-- controles locales"
archivo "$PLAT/ci/sdd-checks.sh" ci/sdd-checks.sh
if [ "$TIPO" = capa ]; then
  archivo "$PLAT/ci/specs-tocadas.sh" ci/specs-tocadas.sh
  if [ -f specs/mapa.txt ]; then
    estado "propio" "specs/mapa.txt (se conserva)"
  elif [ "$MODO" = revisar ]; then
    pendiente "FALTA" "specs/mapa.txt"
  else
    mkdir -p specs
    printf '# Rutas de código → spec. Formato: <ruta> <NNN-nombre>\n# Lo usan ci/specs-tocadas.sh (qué E2E correr) y la regla de oro de ci/sdd-checks.sh.\n' > specs/mapa.txt
    hecho "INSTALAR" "specs/mapa.txt"
  fi
else
  archivo "$PLAT/ci/siguiente-spec.sh" ci/siguiente-spec.sh
  archivo "$PLAT/ci/e2e.sh" ci/e2e.sh

  echo "-- Playwright, funcionalidades y servicios"
  archivo "$PLAT/plantillas/celula/playwright.config.ts" playwright.config.ts
  archivo_propio "$PLAT/plantillas/celula/package.json" package.json
  archivo_propio "$PLAT/plantillas/celula/gitignore" .gitignore
  archivo_propio "$PLAT/plantillas/celula/README.md" README.md
  FUNCS="$(ls -d funcionalidades/*/ 2>/dev/null | sed 's|funcionalidades/||; s|/$||' | paste -sd' ' -)"
  if [ -n "$FUNCS" ]; then estado "propio" "funcionalidades: $FUNCS"
  else estado "--" "sin funcionalidades todavía: sh $PLAT/scripts/sdd-funcionalidad.sh $(pwd) <funcionalidad>"; fi
  SERVS="$(ls -d servicios/*/ 2>/dev/null | sed 's|servicios/||; s|/$||' | paste -sd' ' -)"
  if [ -n "$SERVS" ]; then estado "propio" "servicios compartidos: $SERVS"
  else estado "--" "sin servicios compartidos (si una API o un MS sirve a varias funcionalidades: sh $PLAT/scripts/sdd-servicio.sh $(pwd) <repo>)"; fi
fi

echo "-- plantillas de MR"
for t in FUID FDT MAU; do archivo "$PLAT/mr-templates/$t.md" ".gitlab/merge_request_templates/$t.md"; done

echo "-- instrucciones de Copilot"
archivo_propio "$PLAT/instructions/$TIPO/copilot-instructions.md" .github/copilot-instructions.md
if [ -d "$PLAT/instructions/$TIPO/instructions" ]; then
  for f in "$PLAT/instructions/$TIPO/instructions"/*.instructions.md; do
    archivo "$f" ".github/instructions/$(basename "$f")"
  done
fi

echo "-- versión registrada"
if [ "$TIPO" = capa ]; then
  JSON="$(printf '{\n  "sdd_plataforma": "%s",\n  "tipo": "%s",\n  "celula": "%s",\n  "funcionalidad": "%s",\n  "compartido": %s\n}' "$VERSION" "$TIPO" "$CELULA" "$FUNC" "$COMPARTIDO")"
else
  JSON="$(printf '{\n  "sdd_plataforma": "%s",\n  "tipo": "%s",\n  "celula": "%s"\n}' "$VERSION" "$TIPO" "$CELULA")"
fi
if [ "$(cat .github/sdd-plataforma.json 2>/dev/null)" = "$JSON" ]; then
  estado "al día" ".github/sdd-plataforma.json ($VERSION · $DONDE)"
elif [ "$MODO" = revisar ]; then
  pendiente "DESFASADO" ".github/sdd-plataforma.json (${INSTALADA:-ninguna} → $VERSION · $DONDE)"
else
  mkdir -p .github
  printf '%s\n' "$JSON" > .github/sdd-plataforma.json
  hecho "ACTUALIZAR" ".github/sdd-plataforma.json (${INSTALADA:-ninguna} → $VERSION · $DONDE)"
fi

echo
if [ "$MODO" = revisar ]; then
  if [ "$PENDIENTES" -gt 0 ]; then
    if [ "$TIPO" = capa ]; then ARGS="capa $CELULA${FUNC:+/$FUNC}"; else ARGS="celula $CELULA"; fi
    echo "== $NOMBRE: $PENDIENTES pendiente(s). Para aplicar: sh $PLAT/scripts/sdd-instalar.sh $(pwd) $ARGS"
    exit 1
  fi
  echo "== $NOMBRE: al día con sdd-plataforma $VERSION"
else
  if [ "$CAMBIOS" -gt 0 ]; then
    echo "== $NOMBRE: $CAMBIOS cambio(s) aplicados. Revisa 'git status' y haz commit:"
    if [ -n "$INSTALADA" ]; then VERBO=Actualizar; else VERBO=Instalar; fi
    echo "   git add -A && git commit -m \"$VERBO sdd-plataforma $VERSION\""
  else
    echo "== $NOMBRE: nada que cambiar, ya está en sdd-plataforma $VERSION"
  fi
fi
