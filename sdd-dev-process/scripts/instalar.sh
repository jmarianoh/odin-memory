#!/bin/sh
# Instala o actualiza sdd-dev-process (agentes, skills, hooks e instrucciones de Copilot) en un repo de capa.
#
# Uso:
#   sh sdd-dev-process/scripts/instalar.sh <ruta-del-repo> <arquetipo>            instala o actualiza
#   sh sdd-dev-process/scripts/instalar.sh <ruta-del-repo>                        actualiza (arquetipo del manifiesto)
#   sh sdd-dev-process/scripts/instalar.sh --revisar <ruta-del-repo> [arquetipo]  solo informa; sale con 1 si hay pendientes
#   sh sdd-dev-process/scripts/instalar.sh --listar                               muestra los arquetipos
#
# Requisito: el repo ya tiene el bloque de sdd-plataforma tipo capa (Spec Kit, preset, extensiones, ci/).
#   sh sdd-plataforma/scripts/sdd-instalar.sh <ruta-del-repo> capa
# Corre este instalador después de cada actualización de sdd-plataforma: los cuatro agentes
# SDD Planner, Tester, Implementer y Reviewer de sdd-dev-process reemplazan a los de sdd-plataforma.
#
# Qué hace con cada componente:
#   agentes, hooks, skills e instrucciones de sdd-dev-process: se sobrescriben si son distintos
#   odin-memory (memoria entre chats): solo se informa; lo instala cada desarrollador en su máquina
#   knowledge (guías, glosario, arquitectura, arquetipo del repo): se sobrescribe si es distinto
#   .github/copilot-instructions.md: no lo toca (es del repo)
#   knowledge/integraciones y knowledge/operacion: se crean si faltan y se conservan (son del repo)
#   si cambia el arquetipo: quita la skill, las instrucciones y el knowledge del arquetipo anterior
set -eu

DEV="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(cat "$DEV/VERSION")"
CATALOGO="$DEV/arquetipos/catalogo.tsv"

if [ "${1:-}" = "--listar" ]; then
  printf '%-26s %-12s %-5s %-8s %s\n' ARQUETIPO SUBGERENCIA CANAL STACK TEMPLATE
  grep -v '^#' "$CATALOGO" | awk -F'\t' '{ printf "%-26s %-12s %-5s %-8s %s\n", $1, $2, $3, $4, $5 }'
  exit 0
fi

MODO=instalar
if [ "${1:-}" = "--revisar" ]; then MODO=revisar; shift; fi
REPO="${1:?Uso: instalar.sh [--revisar] <ruta-del-repo> [arquetipo]  ·  instalar.sh --listar}"
ARQUETIPO="${2:-}"

cd "$REPO"
NOMBRE="$(basename "$(pwd)")"
[ -d .git ] || { echo "$NOMBRE no es un repo git."; exit 2; }

MANIFIESTO=.github/sdd-dev-process.json
campo_json() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$MANIFIESTO" 2>/dev/null | head -1; }
INSTALADA="$(campo_json sdd_dev_process)"
STACK_ANTERIOR="$(campo_json stack)"
ARQUETIPO_ANTERIOR="$(campo_json arquetipo)"
[ -n "$ARQUETIPO" ] || ARQUETIPO="$(campo_json arquetipo)"
[ -n "$ARQUETIPO" ] || { echo "Falta el arquetipo. Ver: sh $DEV/scripts/instalar.sh --listar"; exit 2; }

FILA="$(grep -v '^#' "$CATALOGO" | awk -F'\t' -v id="$ARQUETIPO" '$1 == id' | head -1)"
[ -n "$FILA" ] || { echo "Arquetipo desconocido: '$ARQUETIPO'. Ver: sh $DEV/scripts/instalar.sh --listar"; exit 2; }
SUBGERENCIA="$(printf '%s' "$FILA" | cut -f2)"
CANAL="$(printf '%s' "$FILA" | cut -f3)"
STACK="$(printf '%s' "$FILA" | cut -f4)"
TEMPLATE="$(printf '%s' "$FILA" | cut -f5)"
if [ "$TEMPLATE" = "por-confirmar" ]; then TEMPLATE="por confirmar"; fi
CONF="$DEV/arquetipos/stacks/$STACK.conf"
[ -f "$CONF" ] || { echo "Falta el perfil del stack: $CONF"; exit 2; }
# shellcheck disable=SC1090
. "$CONF"

PENDIENTES=0
CAMBIOS=0
estado() { printf '  %-11s %s\n' "$1" "$2"; }
pendiente() { estado "$1" "$2"; PENDIENTES=$((PENDIENTES + 1)); }
hecho() { estado "$1" "$2"; CAMBIOS=$((CAMBIOS + 1)); }

# Archivo administrado: se sobrescribe si es distinto.
archivo() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then estado "al día" "$2"; return 0; fi
  if [ -f "$2" ]; then etiqueta="DESFASADO"; accion="ACTUALIZAR"; else etiqueta="FALTA"; accion="INSTALAR"; fi
  if [ "$MODO" = revisar ]; then pendiente "$etiqueta" "$2"; return 0; fi
  mkdir -p "$(dirname "$2")"; cp "$1" "$2"; hecho "$accion" "$2"
}

# Carpeta administrada (una skill): se reemplaza entera si es distinta.
carpeta() {
  if [ -d "$2" ] && diff -rq "$1" "$2" >/dev/null 2>&1; then estado "al día" "$2/"; return 0; fi
  if [ -d "$2" ]; then etiqueta="DESFASADO"; accion="ACTUALIZAR"; else etiqueta="FALTA"; accion="INSTALAR"; fi
  if [ "$MODO" = revisar ]; then pendiente "$etiqueta" "$2/"; return 0; fi
  rm -rf "$2"; mkdir -p "$(dirname "$2")"; cp -R "$1" "$2"; hecho "$accion" "$2/"
}

# Archivo propio del repo: se crea desde la plantilla solo si falta.
archivo_propio() {
  if [ -e "$2" ]; then estado "propio" "$2 (se conserva)"; return 0; fi
  if [ "$MODO" = revisar ]; then pendiente "FALTA" "$2"; return 0; fi
  mkdir -p "$(dirname "$2")"; cp "$1" "$2"; hecho "INSTALAR" "$2"
}

quitar() {
  [ -e "$1" ] || return 0
  if [ "$MODO" = revisar ]; then pendiente "SOBRA" "$1 (del arquetipo anterior)"; return 0; fi
  rm -rf "$1"; hecho "QUITAR" "$1 (del arquetipo anterior)"
}

echo "== $NOMBRE · arquetipo $ARQUETIPO ($SUBGERENCIA/$CANAL/$STACK) · instalada: ${INSTALADA:-ninguna} · sdd-dev-process: $VERSION · modo: $MODO"

echo "-- requisito: sdd-plataforma (capa)"
TIPO_PLAT="$(sed -n 's/.*"tipo": *"\([^"]*\)".*/\1/p' .github/sdd-plataforma.json 2>/dev/null | head -1)"
if [ -d .specify ] && [ "$TIPO_PLAT" = capa ]; then
  estado "al día" "sdd-plataforma $(sed -n 's/.*"sdd_plataforma": *"\([^"]*\)".*/\1/p' .github/sdd-plataforma.json) (capa)"
elif [ "$MODO" = revisar ]; then
  pendiente "FALTA" "sdd-plataforma tipo capa (sh sdd-plataforma/scripts/sdd-instalar.sh $(pwd) capa)"
else
  echo "  Falta sdd-plataforma tipo capa. Instálalo primero:"
  echo "    sh sdd-plataforma/scripts/sdd-instalar.sh $(pwd) capa"
  exit 2
fi

echo "-- agentes"
for a in sdd-orquestador sdd-planner sdd-tester sdd-implementer sdd-reviewer sdd-seguridad; do
  archivo "$DEV/agents/$a.agent.md" ".github/agents/$a.agent.md"
done

echo "-- hooks"
for h in tests-intactos solo-informe; do archivo "$DEV/hooks/$h.mjs" ".github/hooks/$h.mjs"; done

echo "-- skills de proceso"
for s in sdd-clasificar sdd-tdd sdd-seguridad sdd-memoria; do carpeta "$DEV/skills/proceso/$s" ".github/skills/$s"; done
if [ -n "$SKILL_RENDIMIENTO" ]; then
  carpeta "$DEV/skills/proceso/$SKILL_RENDIMIENTO" ".github/skills/$SKILL_RENDIMIENTO"
else
  quitar ".github/skills/sdd-jmeter"
fi

echo "-- skill de stack ($STACK)"
if [ -n "$STACK_ANTERIOR" ] && [ "$STACK_ANTERIOR" != "$STACK" ]; then
  SKILL_ANTERIOR="$(sed -n 's/^SKILL="\(.*\)"$/\1/p' "$DEV/arquetipos/stacks/$STACK_ANTERIOR.conf" 2>/dev/null)"
  if [ -n "$SKILL_ANTERIOR" ]; then quitar ".github/skills/$SKILL_ANTERIOR"; fi
  for f in "$DEV/instructions/stacks/$STACK_ANTERIOR"/*.instructions.md; do
    if [ -f "$f" ]; then quitar ".github/instructions/$(basename "$f")"; fi
  done
fi
carpeta "$DEV/skills/stack/$SKILL" ".github/skills/$SKILL"

echo "-- instrucciones de Copilot"
archivo "$DEV/instructions/sdd-dev-process.instructions.md" .github/instructions/sdd-dev-process.instructions.md
for f in "$DEV/instructions/stacks/$STACK"/*.instructions.md; do
  archivo "$f" ".github/instructions/$(basename "$f")"
done
GENERADO="$(mktemp)"
trap 'rm -f "$GENERADO"' EXIT
export VERSION ARQUETIPO SUBGERENCIA CANAL STACK TEMPLATE STACK_NOMBRE CAPAS SKILL \
  CMD_INSTALAR CMD_BUILD CMD_LINT CMD_TEST CMD_TEST_FOCO CMD_TEST_INTEGRACION CMD_DEPS ARCHIVOS_TEST MCP JMETER CMD_JMETER
awk '{
  linea = $0
  while (match(linea, /\{\{[A-Z_]+\}\}/)) {
    nombre = substr(linea, RSTART + 2, RLENGTH - 4)
    valor = ENVIRON[nombre]
    linea = substr(linea, 1, RSTART - 1) valor substr(linea, RSTART + RLENGTH)
  }
  print linea
}' "$DEV/instructions/arquetipo.instructions.md.plantilla" > "$GENERADO"
archivo "$GENERADO" .github/instructions/arquetipo.instructions.md

echo "-- knowledge"
K=.github/knowledge
archivo "$DEV/knowledge/README.md" "$K/README.md"
carpeta "$DEV/knowledge/guias" "$K/guias"
archivo "$DEV/knowledge/dominio/glosario.md" "$K/dominio/glosario.md"
for f in overview calidad-codigo; do archivo "$DEV/knowledge/arquitectura/$f.md" "$K/arquitectura/$f.md"; done
if [ -n "$ARQUETIPO_ANTERIOR" ] && [ "$ARQUETIPO_ANTERIOR" != "$ARQUETIPO" ]; then
  quitar "$K/arquitectura/arquetipos/$ARQUETIPO_ANTERIOR.md"
fi
archivo "$DEV/knowledge/arquitectura/arquetipos/$ARQUETIPO.md" "$K/arquitectura/arquetipos/$ARQUETIPO.md"
for d in integraciones operacion; do archivo_propio "$DEV/knowledge/$d/README.md" "$K/$d/README.md"; done

echo "-- memoria (odin-memory, opcional)"
# Es de cada máquina, no del repo: no cuenta como pendiente.
if command -v odin >/dev/null 2>&1; then
  if ODIN_VERSION="$(odin version 2>&1)"; then
    estado "al día" "$(printf '%s' "$ODIN_VERSION" | head -1) (si falta en VS Code: odin setup vscode-copilot)"
  else
    estado "opcional" "odin no responde: $(printf '%s' "$ODIN_VERSION" | head -1)"
  fi
else
  estado "opcional" "odin no instalado: npm install -g odin-memory && odin setup vscode-copilot"
fi

echo "-- manifiesto"
ESPERADO="$(printf '{\n  "sdd_dev_process": "%s",\n  "arquetipo": "%s",\n  "subgerencia": "%s",\n  "canal": "%s",\n  "stack": "%s"\n}' \
  "$VERSION" "$ARQUETIPO" "$SUBGERENCIA" "$CANAL" "$STACK")"
if [ -f "$MANIFIESTO" ] && [ "$(cat "$MANIFIESTO")" = "$ESPERADO" ]; then
  estado "al día" "$MANIFIESTO ($VERSION · $ARQUETIPO)"
elif [ "$MODO" = revisar ]; then
  pendiente "DESFASADO" "$MANIFIESTO (${INSTALADA:-ninguna} → $VERSION · $ARQUETIPO)"
else
  printf '%s\n' "$ESPERADO" > "$MANIFIESTO"
  hecho "ACTUALIZAR" "$MANIFIESTO (${INSTALADA:-ninguna} → $VERSION · $ARQUETIPO)"
fi

echo
if [ "$MODO" = revisar ]; then
  if [ "$PENDIENTES" -gt 0 ]; then
    echo "== $NOMBRE: $PENDIENTES pendiente(s). Para aplicar: sh $DEV/scripts/instalar.sh $(pwd) $ARQUETIPO"
    exit 1
  fi
  echo "== $NOMBRE: al día con sdd-dev-process $VERSION ($ARQUETIPO)"
else
  if [ "$CAMBIOS" -gt 0 ]; then
    if [ -n "$INSTALADA" ]; then VERBO=Actualizar; else VERBO=Instalar; fi
    echo "== $NOMBRE: $CAMBIOS cambio(s) aplicados. Revisa 'git status' y haz commit:"
    echo "   git add .github && git commit -m \"$VERBO sdd-dev-process $VERSION ($ARQUETIPO)\""
  else
    echo "== $NOMBRE: nada que cambiar, ya está en sdd-dev-process $VERSION ($ARQUETIPO)"
  fi
  echo "   En VS Code: activa chat.useAgentSkills y chat.useHooks, y abre el chat con el agente SDD Orquestador."
  echo "   Memoria entre chats (opcional): npm install -g odin-memory && odin setup vscode-copilot, y recarga VS Code."
  if [ "$MCP" != "ninguno" ]; then echo "   MCP del stack (opcional): $MCP."; fi
fi
exit 0
