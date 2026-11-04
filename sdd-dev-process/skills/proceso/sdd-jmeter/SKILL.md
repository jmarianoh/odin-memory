---
name: sdd-jmeter
description: Crear o actualizar el plan de rendimiento JMeter (.jmx) de una spec en un repo BFF, API o MS, parametrizado y sin secretos, para que el área de performance lo ejecute antes del pase. Usar en la fase de rendimiento de tasks.md, cuando plan.md dice "JMeter: sí", al corregir un defecto de performance o cuando un FDT cambia endpoints o el runtime.
---

# Plan de rendimiento con JMeter

Antes de cada pase a producción, el **área de performance** ejecuta en el **ambiente de QA** los planes JMeter de las capas de backend (BFF, API y MS) de **toda la versión**. La célula entrega el plan; la carga y los umbrales los define el **arquitecto**, y performance certifica.

> **Plantilla provisional.** `references/plantilla.jmx` se reemplaza por el template de la gerencia cuando esté definido (versión de JMeter y headers obligatorios). Hasta entonces, usa esta y respeta los headers que pida el template del arquetipo.

Los planes los escribe el **SDD Tester**: el SDD Implementer no puede editarlos (hook `tests-intactos`).

No aplica a repos de front (Angular) ni de apps (Flutter).

## Cuándo

- `plan.md` tiene la sección "Rendimiento (JMeter)" con `**JMeter**: sí` y la tabla de endpoints, carga y umbral.
- Si la spec no agrega ni cambia endpoints de esta capa: `**JMeter**: no — <motivo>`, y no se crea plan.
- El control `[jmeter]` de `ci/sdd-checks.sh` bloquea el MR si el plan dice "sí" y falta `perf/NNN-*/*.jmx`.

## Dónde

```
perf/
├── README.md                  copia de references/perf-README.md (una vez por repo)
├── NNN-nombre/
│   ├── NNN-nombre.jmx         desde references/plantilla.jmx
│   └── datos.csv              datos ficticios del dominio
└── resultados/                agregar a .gitignore
```

## Cómo armar el plan

Parte de [references/plantilla.jmx](references/plantilla.jmx) (ejemplo: `POST /autorizaciones` de la spec 004) y ajusta:

1. **Nombre del plan** (`TestPlan` → `testname`): `NNN-nombre · <capa>`.
2. **Un Thread Group por escenario de carga** de la tabla de `plan.md`, nombrado `NNN · <escenario>`.
3. **Un HTTP Request por endpoint** (`testname`: `NNN › MÉTODO /ruta`), con la ruta, el método y el cuerpo **exactamente como en el contrato** referenciado en `plan.md`.
4. **Aserciones en cada request**: código de respuesta del contrato (`ResponseAssertion` sobre `response_code`) y umbral de tiempo (`DurationAssertion` con `${__P(umbral_ms,…)}`).
5. **Datos** en `datos.csv` con encabezado y valores ficticios (`PG-PERF-0001`, montos en CLP, RUT de prueba). Nunca datos reales de clientes.
6. **Headers** que exige el template del arquetipo (por ejemplo, el identificador de correlación) en el `HeaderManager`.

## Reglas

- **Todo lo que cambia entre ambientes va como propiedad** `${__P(nombre,valor-por-defecto)}`: `protocolo`, `host`, `puerto`, `usuarios`, `rampa`, `duracion`, `umbral_ms`, `token`, `datos`. Valores por defecto de humo: 1 usuario, 10 segundos, `localhost`.
- **Sin secretos en el archivo:** el token se pasa con `-Jtoken=…` al ejecutar.
- **Sin listeners de interfaz** (View Results Tree, gráficos): se corre en modo no GUI con `-l` y, si hace falta, `-e -o` para el reporte HTML.
- La carga y los umbrales los define el arquitecto y quedan en la sección "Rendimiento (JMeter)" de `plan.md`. Si todavía no están, usa valores de humo y deja la fila marcada "por definir con el arquitecto".
- Un cambio de contrato (ruta, campos, códigos) actualiza también el plan JMeter de la spec.

## Corrida de humo (evidencia para el MR)

```bash
jmeter -n -t perf/NNN-nombre/NNN-nombre.jmx -Jhost=localhost -Jpuerto=<puerto> -Jusuarios=1 -Jduracion=10 -l perf/resultados/NNN.jtl
```

Pega en el MR el resumen de la salida (`summary = … Err: …`). El humo prueba que el plan corre y que las aserciones calzan con el contrato; la carga real la ejecuta performance. Si JMeter no está instalado, dilo: sin corrida no hay evidencia.

## Defecto de performance

Si performance encuentra un problema, abre un defecto en Jira enlazado a la historia. Se clasifica con la skill `sdd-clasificar` (sección "Defecto de certificación"): si el plan estaba mal, lo corrige el SDD Tester; si el código no cumple el umbral, el SDD Implementer optimiza y el plan con su umbral es la prueba que lo demuestra.
