import { createInterface } from 'node:readline';

/** Versiones del protocolo MCP que el servidor sabe hablar, de la más reciente a la más antigua. */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * Servidor MCP mínimo sobre JSON-RPC 2.0 con mensajes delimitados por salto de
 * línea (transporte stdio). Implementa `initialize`, `ping`, `tools/list` y
 * `tools/call`; ignora las notificaciones.
 */
export class McpServer {
  /**
   * @param {object} options
   * @param {string} options.name nombre del servidor
   * @param {string} options.version versión del servidor
   * @param {string} [options.instructions] guía para el agente
   * @param {{ definition: object, handler: (args: object) => object|Promise<object> }[]} options.tools
   */
  constructor({ name, version, instructions = '', tools }) {
    this.name = name;
    this.version = version;
    this.instructions = instructions;
    /** @type {Map<string, { definition: object, handler: Function }>} */
    this.tools = new Map(tools.map((t) => [t.definition.name, t]));
  }

  /** Definiciones registradas, ordenadas por nombre. */
  listTools() {
    return [...this.tools.values()].map((t) => t.definition).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Procesa un mensaje ya decodificado.
   * @param {any} message
   * @returns {Promise<object|null>} la respuesta, o `null` si era una notificación
   */
  async handle(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id, INVALID_REQUEST, 'Invalid Request');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined;
    if (isNotification) return null; // notifications/initialized, notifications/cancelled…
    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
          const result = {
            protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: this.name, version: this.version },
          };
          if (this.instructions) result.instructions = this.instructions;
          return { jsonrpc: '2.0', id, result };
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: this.listTools() } };
        case 'tools/call': {
          const tool = typeof params?.name === 'string' ? this.tools.get(params.name) : undefined;
          if (!tool) return rpcError(id, INVALID_PARAMS, `tool '${params?.name}' not found`);
          const args = params.arguments ?? {};
          if (args === null || typeof args !== 'object' || Array.isArray(args)) return rpcError(id, INVALID_PARAMS, 'arguments must be an object');
          try {
            return { jsonrpc: '2.0', id, result: await tool.handler(args) };
          } catch (err) {
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Internal error: ${err.message}` }], isError: true } };
          }
        }
        default:
          return rpcError(id, METHOD_NOT_FOUND, `method '${method}' not found`);
      }
    } catch (err) {
      return rpcError(id, INTERNAL_ERROR, err.message);
    }
  }

  /**
   * Atiende un flujo de entrada línea a línea hasta que se cierra. Las respuestas
   * se escriben en orden. Al terminar la entrada espera a que acaben las
   * peticiones en curso (con un máximo de `graceMs`) antes de resolver.
   * @param {object} streams
   * @param {NodeJS.ReadableStream} streams.input
   * @param {NodeJS.WritableStream} streams.output
   * @param {number} [streams.graceMs] espera máxima por peticiones en curso (5000 por defecto)
   * @returns {Promise<void>}
   */
  serve({ input, output, graceMs = 5000 }) {
    const lines = createInterface({ input, crlfDelay: Infinity });
    let chain = Promise.resolve();
    const write = (response) => output.write(`${JSON.stringify(response)}\n`);
    lines.on('line', (line) => {
      if (line.trim() === '') return;
      chain = chain.then(async () => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          write(rpcError(null, PARSE_ERROR, 'Parse error'));
          return;
        }
        const response = await this.handle(message);
        if (response) write(response);
      });
    });
    return new Promise((resolveDone) => {
      lines.on('close', () => {
        const timer = setTimeout(resolveDone, graceMs);
        chain.finally(() => {
          clearTimeout(timer);
          resolveDone();
        });
      });
    });
  }
}
