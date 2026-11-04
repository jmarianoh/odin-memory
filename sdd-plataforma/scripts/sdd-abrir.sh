#!/bin/sh
# Abre el workspace de una historia de Jira con los repos en su rama y la telemetría marcada.
# Uso: sh sdd-plataforma/scripts/sdd-abrir.sh <CLAVE-HISTORIA> [--sin-code]
#
# 1. Busca celula-*/funcionalidades/<funcionalidad>/jira/<CLAVE>.md (Jira simulado del piloto): padre (la épica)
#    y rama. El tipo de pedido (FUID, FDT o MAU) es el de la épica padre: toda épica se divide en historias,
#    y se trabaja siempre una historia. La funcionalidad es la carpeta donde está la historia; el workspace,
#    funcionalidades/<funcionalidad>/<funcionalidad>.code-workspace, declara sus repos (app, BFF y los API y MS,
#    propios o compartidos con otras funcionalidades).
# 2. Para cada repo del workspace: si la rama existe, hace checkout. Si no:
#    - repo de capa: lo deja en Desarrollo-CI (la rama la crea /speckit-specify, /speckit-fdt-assess o /speckit-bug-assess);
#    - repo de la célula: si es FUID y la spec de la historia aún no existe en Desarrollo-CI, lo deja ahí (la rama la
#      crea /speckit-specify); si la spec ya existe (toca escribir los E2E) o es FDT o MAU, crea la rama desde Desarrollo-CI.
# 3. Abre VS Code con OTEL_RESOURCE_ATTRIBUTES="jira.clave=...,jira.padre=...,jira.tipo=...,sdd.funcionalidad=...".
#    Jira no tiene un campo estándar para la funcionalidad (hoy va en el título de la épica), así que sale de la carpeta.
#    Regla: una ventana de VS Code por pedido. Si VS Code ya está abierto, la ventana nueva hereda
#    el entorno del proceso existente: ciérralo antes para que la marca llegue a la telemetría.
set -eu

CLAVE="${1:?Uso: sdd-abrir.sh <CLAVE-HISTORIA> [--sin-code]}"
SIN_CODE="${2:-}"
RAIZ="${SDD_RAIZ:-$(cd "$(dirname "$0")/../.." && pwd)}"

JIRA=$(ls "$RAIZ"/celula-*/funcionalidades/*/jira/"$CLAVE".md 2>/dev/null | head -1 || true)
[ -n "$JIRA" ] || { echo "No encontré $CLAVE en $RAIZ/celula-*/funcionalidades/*/jira/"; exit 2; }
FUNC_DIR="$(cd "$(dirname "$JIRA")/.." && pwd)"
FUNC="$(basename "$FUNC_DIR")"
CELULA_REPO="$(cd "$FUNC_DIR/../.." && pwd)"

campo() { sed -n "s/^\*\*$1\*\*: *//p" "$2" | head -1 | sed 's/`//g; s/ *$//'; }
[ "$(campo 'Tipo en Jira' "$JIRA")" = "Épica" ] && { echo "$CLAVE es una épica: abre una de sus historias (toda épica se divide en historias)"; exit 2; }
PADRE="$(campo 'Padre' "$JIRA")"
RAMA="$(campo 'Rama' "$JIRA")"
[ -n "$PADRE" ] || { echo "$JIRA no tiene **Padre** (la épica de la historia)"; exit 2; }
[ -n "$RAMA" ] || { echo "$JIRA no tiene **Rama**"; exit 2; }
EPICA="$FUNC_DIR/jira/$PADRE.md"
if [ -f "$EPICA" ]; then TIPO="$(campo 'Tipo de pedido' "$EPICA")"; else TIPO="$(campo 'Tipo de pedido' "$JIRA")"; fi
[ -n "$TIPO" ] || { echo "No encontré el **Tipo de pedido** (FUID, FDT o MAU) en la épica $PADRE ($EPICA)"; exit 2; }

WS="$FUNC_DIR/$FUNC.code-workspace"
[ -f "$WS" ] || WS=$(ls "$FUNC_DIR"/*.code-workspace 2>/dev/null | head -1 || true)
[ -n "$WS" ] || { echo "No hay workspace en $FUNC_DIR"; exit 2; }
NUM=$(echo "$RAMA" | sed -n 's|^feature/\([0-9][0-9][0-9]\)-.*|\1|p')
echo "Historia $CLAVE · épica $PADRE ($TIPO) · rama $RAMA"
echo "Célula: $(basename "$CELULA_REPO") · funcionalidad: $FUNC"
echo "Workspace: $WS"

# Rutas de las carpetas del workspace (relativas a la carpeta del workspace)
CARPETAS=$(grep -E '"path"' "$WS" | grep -v '^[[:space:]]*//' | sed -E 's/.*"path": *"([^"]+)".*/\1/')
for rel in $CARPETAS; do
  DIR="$(cd "$(dirname "$WS")" && cd "$rel" 2>/dev/null && pwd || true)"
  if [ -z "$DIR" ] || [ ! -d "$DIR/.git" ]; then echo "  ?  $rel no existe o no es repo git"; continue; fi
  N="$(basename "$DIR")"
  if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
    echo "  !  $N tiene cambios sin commit; se deja en $(git -C "$DIR" rev-parse --abbrev-ref HEAD)"
    continue
  fi
  if git -C "$DIR" rev-parse --verify -q "$RAMA" >/dev/null; then
    git -C "$DIR" switch -q "$RAMA"
    echo "  ✓  $N → $RAMA"
  elif [ "$DIR" = "$CELULA_REPO" ]; then
    if [ "$TIPO" = FUID ] && [ -n "$NUM" ] && \
       ! git -C "$DIR" ls-tree -d --name-only Desarrollo-CI "funcionalidades/$FUNC/specs/" 2>/dev/null | grep -q "/specs/$NUM-"; then
      git -C "$DIR" switch -q Desarrollo-CI
      echo "  ·  $N → Desarrollo-CI (la spec $NUM no existe: la rama $RAMA la crea /speckit-specify)"
    else
      git -C "$DIR" switch -q -c "$RAMA" Desarrollo-CI
      echo "  +  $N → $RAMA (creada desde Desarrollo-CI)"
    fi
  else
    git -C "$DIR" switch -q Desarrollo-CI
    echo "  ·  $N → Desarrollo-CI (la rama $RAMA la crea Spec Kit)"
  fi
done

export OTEL_RESOURCE_ATTRIBUTES="jira.clave=$CLAVE,jira.padre=$PADRE,jira.tipo=$TIPO,sdd.funcionalidad=$FUNC"
echo "OTEL_RESOURCE_ATTRIBUTES=$OTEL_RESOURCE_ATTRIBUTES"

if [ "$SIN_CODE" != "--sin-code" ]; then
  if pgrep -xq "Code Helper" 2>/dev/null || pgrep -fq "Visual Studio Code.app/Contents/MacOS" 2>/dev/null; then
    echo "Aviso: VS Code ya está abierto; la marca OTEL puede no llegar a esta ventana."
  fi
  command -v code >/dev/null || { echo "No está el comando 'code' en el PATH (VS Code → Shell Command: Install 'code')"; exit 2; }
  code --new-window "$WS"
fi
