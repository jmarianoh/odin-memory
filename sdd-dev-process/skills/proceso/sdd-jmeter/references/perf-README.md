# Planes de rendimiento (JMeter)

Un plan por spec que agrega o cambia endpoints de esta capa. Los escribe el SDD Tester y, antes del pase, los ejecuta el área de performance en el ambiente de QA sobre la versión completa, con la carga y los umbrales que define el arquitecto.

```
perf/
├── README.md
├── NNN-nombre/
│   ├── NNN-nombre.jmx     plan de la spec (parametrizado, sin secretos)
│   └── datos.csv          datos de prueba ficticios
└── resultados/            salida local (.jtl, reportes); no se versiona
```

## Propiedades

| Propiedad | Para qué | Por defecto |
| --- | --- | --- |
| `protocolo` | `http` o `https` | `http` |
| `host` | Host del ambiente | `localhost` |
| `puerto` | Puerto de la capa | `3000` |
| `usuarios` | Usuarios concurrentes | `1` |
| `rampa` | Segundos para llegar a todos los usuarios | `1` |
| `duracion` | Segundos de la prueba | `10` |
| `umbral_ms` | Tiempo máximo por respuesta | `1000` |
| `token` | Token de acceso del ambiente; se pasa al ejecutar, nunca se guarda | vacío |
| `datos` | Archivo CSV de datos | `datos.csv` (junto al plan) |

## Correr

```bash
# Humo (lo corre el dev antes del MR)
jmeter -n -t perf/NNN-nombre/NNN-nombre.jmx -Jhost=localhost -Jpuerto=3000 -Jusuarios=1 -Jduracion=10 -l perf/resultados/NNN.jtl

# Carga (lo corre el área de performance en QA, con la carga y los umbrales del arquitecto)
jmeter -n -t perf/NNN-nombre/NNN-nombre.jmx -Jprotocolo=https -Jhost=<host-qa> -Jpuerto=443 \
  -Jusuarios=<n> -Jrampa=<s> -Jduracion=<s> -Jumbral_ms=<ms> -Jtoken=<token> \
  -l perf/resultados/NNN.jtl -e -o perf/resultados/NNN-reporte
```
