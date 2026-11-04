#!/usr/bin/env node
// Hook PreToolUse del agente SDD Implementer (estándar sdd-plataforma).
// Bloquea cualquier edición de archivos de test: el agente que escribe tests
// (SDD Tester) no es el que escribe el código (SDD Implementer).
//
// Acepta los dos formatos de entrada que documenta VS Code:
//   - Copilot:          { toolName, toolArgs }
//   - Local / Claude:   { tool_name, tool_input }
// y responde con los dos formatos de decisión (top-level y hookSpecificOutput).
import { readFileSync } from 'node:fs';

const PATRON_TEST = /(\.spec\.[cm]?[jt]sx?|\.e2e-spec\.[cm]?[jt]sx?|\.test\.[cm]?[jt]sx?|_test\.dart|\.jmx)\b|(^|[\s"'`/\\])(test|tests|__tests__|integration_test|perf|e2e)[/\\]/i;
const HERRAMIENTA_EDICION = /edit|write|create|replace|insert|patch|apply|rename|move|delete|notebook/i;
const HERRAMIENTA_TERMINAL = /terminal|execute|bash|shell|command|run_in/i;
const COMANDO_ESCRITURA = /(>|>>|\btee\b|\bsed\s+-i|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bperl\s+-pi|writeFile)/;

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

const contenido = textos(args);
// Solo se revisan rutas y comandos, no el contenido completo que se escribe.
const rutasYComandos = contenido.filter((t) => t.length < 2000);
const tocaTests = rutasYComandos.some((t) => PATRON_TEST.test(t));

const MOTIVO =
  'Regla tests-intactos: el SDD Implementer no puede modificar archivos de test. ' +
  'Si un test parece incorrecto, detente y explica por qué; el SDD Tester lo corrige.';

if (tocaTests && HERRAMIENTA_EDICION.test(herramienta)) {
  responder('deny', MOTIVO);
}
if (tocaTests && HERRAMIENTA_TERMINAL.test(herramienta) && rutasYComandos.some((t) => COMANDO_ESCRITURA.test(t))) {
  responder('deny', MOTIVO);
}
responder('allow');
