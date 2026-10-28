/**
 * Ciclo de vida del servidor MCP por stdio. Atiende hasta que el anfitrión cierra
 * su extremo de la tubería (EOF: se espera a las peticiones en curso, como mucho
 * `graceMs`) o hasta recibir SIGINT/SIGTERM (apagado inmediato y limpio).
 *
 * @param {import('./protocol.js').McpServer} server
 * @param {object} [options]
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @param {number} [options.graceMs] espera máxima tras EOF (5000 por defecto)
 * @param {{ on: Function, off: Function }} [options.processRef] origen de las señales (pruebas)
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<'eof'|'signal'>} qué terminó el servicio
 */
export async function runMcp(server, options = {}) {
  const {
    input = process.stdin, output = process.stdout, graceMs = 5000, processRef = process,
    log = (message) => process.stderr.write(`${message}\n`),
  } = options;
  const controller = new AbortController();
  let reason = 'eof';
  const onSignal = () => {
    reason = 'signal';
    log('[odin] shutting down...');
    controller.abort();
  };
  processRef.on('SIGINT', onSignal);
  processRef.on('SIGTERM', onSignal);
  try {
    await server.serve({ input, output, graceMs, signal: controller.signal });
  } finally {
    processRef.off('SIGINT', onSignal);
    processRef.off('SIGTERM', onSignal);
  }
  return reason;
}
