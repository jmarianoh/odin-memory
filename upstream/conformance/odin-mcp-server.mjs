// Arranque de odin como servidor MCP por stdio para las pruebas diferenciales.
// (El comando `odin mcp` se implementa en la fase de CLI; esto es el equivalente mínimo.)
import { silenceSqliteWarning } from '../../src/runtime/warnings.js';

silenceSqliteWarning();
const { Store } = await import('../../src/store/index.js');
const { createServer, runMcp } = await import('../../src/mcp/index.js');
const { resolveTools } = await import('../../src/mcp/profiles.js');

const store = Store.open({ dataDir: process.env.ODIN_DATA_DIR, log: () => {} });
const server = createServer(store, { defaultProject: process.env.ODIN_PROJECT ?? '' }, resolveTools(process.env.ODIN_TOOLS ?? 'all'));
await runMcp(server);
store.close();
