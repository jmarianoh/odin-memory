#!/usr/bin/env node
// Hook PreToolUse del agente SDD Seguridad (sdd-dev-process).
// El agente solo puede escribir su informe (seguridad.md). Bloquea cualquier otra edición
// y los comandos de terminal que escriben archivos, instalan dependencias o cambian git.
//
// Acepta los dos formatos de entrada que documenta VS Code:
//   - Copilot:          { toolName, toolArgs }
//   - Local / Claude:   { tool_name, tool_input }
// y responde con los dos formatos de decisión (top-level y hookSpecificOutput).
import { readFileSync } from 'node:fs';

const INFORME = /(^|[/\\])seguridad\.md$/i;
const PARECE_RUTA = /[/\\]|\.[a-z0-9]{1,6}$/i;
const HERRAMIENTA_EDICION = /edit|write|create|replace|insert|patch|apply|rename|move|delete|notebook/i;
const HERRAMIENTA_TERMINAL = /terminal|execute|bash|shell|command|run_in/i;
const COMANDO_PROHIBIDO =
  /(\s>{1,2}\s*[^&\s]|\btee\b|\bsed\s+-i|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bperl\s+-pi|writeFile|\bnpm\s+(i|install|ci|update|audit\s+fix)\b|\b(flutter|dart)\s+pub\s+(get|upgrade|add|remove)\b|\bgit\s+(add|commit|push|checkout|switch|reset|restore|stash|merge|rebase)\b)/;

function leerEntrada() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function textos(valor, acc = []) {
  if (typeof valor === 'string') acc.push(valor);
  else if (Array.isArray(valor)) valor.forEach((v) => textos(v, acc));
  else if (valor && typeof valor === 'object') Object.values(valor).forEach((v) => textos(v, acc));
  return acc;
}

function responder(decision, motivo) {
  const salida =
    decision === 'deny'
      ? {
          permissionDecision: 'deny',
          permissionDecisionReason: motivo,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: motivo,
            additionalContext: motivo,
          },
        }
      : {};
  process.stdout.write(JSON.stringify(salida));
  process.exit(0);
}

const evento = leerEntrada();
const herramienta = String(evento.toolName ?? evento.tool_name ?? '');
let args = evento.toolArgs ?? evento.tool_input ?? {};
if (typeof args === 'string') {
  try { args = JSON.parse(args); } catch { /* se deja como texto */ }
}
const cortos = textos(args).filter((t) => t.length < 2000);

if (HERRAMIENTA_EDICION.test(herramienta)) {
  const rutas = cortos.filter((t) => !/\s/.test(t.trim()) && PARECE_RUTA.test(t.trim()));
  const soloInforme = rutas.length > 0 && rutas.every((t) => INFORME.test(t.trim()));
  if (!soloInforme) {
    responder('deny', 'Regla solo-informe: SDD Seguridad solo puede escribir seguridad.md. Las correcciones las hace el SDD Implementer.');
  }
}
if (HERRAMIENTA_TERMINAL.test(herramienta) && cortos.some((t) => COMANDO_PROHIBIDO.test(t))) {
  responder('deny', 'Regla solo-informe: SDD Seguridad solo corre comandos de lectura (sin escribir archivos, instalar dependencias ni cambiar git).');
}
responder('allow');
