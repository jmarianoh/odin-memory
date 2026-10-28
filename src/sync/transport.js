import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/** El chunk que el manifiesto menciona no está en el transporte. */
export class ChunkNotFoundError extends Error {
  constructor() {
    super('sync: chunk not found');
    this.name = 'ChunkNotFoundError';
    this.code = 'chunk_not_found';
  }
}

/**
 * Serializa el manifiesto como el contrato: sangría de dos espacios y `chunks`
 * `null` cuando está vacío.
 * @param {{ version: number, chunks: object[] }} manifest
 */
export function manifestToJson(manifest) {
  return JSON.stringify({ version: manifest.version, chunks: manifest.chunks.length > 0 ? manifest.chunks : null }, null, 2);
}

/**
 * Transporte sobre el sistema de archivos: `manifest.json` y `chunks/<id>.jsonl.gz`.
 * Un transporte expone `readManifest`, `writeManifest`, `writeChunk(id, json, entry)`
 * y `readChunk(id)`; el contenido de un chunk viaja como texto JSON.
 */
export class FileTransport {
  /** @param {string} syncDir directorio de intercambio (`.odin-memory/`) */
  constructor(syncDir) {
    this.syncDir = syncDir;
  }

  readManifest() {
    const path = join(this.syncDir, 'manifest.json');
    let data;
    try {
      data = readFileSync(path, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`read manifest: ${err.message}`, { cause: err });
      try {
        if (!statSync(this.syncDir).isDirectory()) throw new Error(`read manifest: sync path ${JSON.stringify(this.syncDir)} is not a directory`);
      } catch (statErr) {
        if (statErr.code !== 'ENOENT' && statErr.code !== 'ENOTDIR') throw statErr;
      }
      return { version: 1, chunks: [] };
    }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      throw new Error(`parse manifest: ${err.message}`, { cause: err });
    }
    return { version: Number(parsed?.version ?? 0), chunks: Array.isArray(parsed?.chunks) ? parsed.chunks : [] };
  }

  writeManifest(manifest) {
    writeFileSync(join(this.syncDir, 'manifest.json'), manifestToJson(manifest), { mode: 0o644 });
  }

  writeChunk(id, json) {
    const dir = join(this.syncDir, 'chunks');
    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
    } catch (err) {
      throw new Error(`create chunks dir: ${err.message}`, { cause: err });
    }
    writeFileSync(join(dir, `${id}.jsonl.gz`), gzipSync(Buffer.from(json, 'utf8')), { mode: 0o644 });
  }

  readChunk(id) {
    let data;
    try {
      data = readFileSync(join(this.syncDir, 'chunks', `${id}.jsonl.gz`));
    } catch (err) {
      if (err.code === 'ENOENT') throw new ChunkNotFoundError();
      throw err;
    }
    return gunzipSync(data).toString('utf8');
  }
}
