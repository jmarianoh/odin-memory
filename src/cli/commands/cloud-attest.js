import { resolveCloudRuntimeConfig, validateServerUrl } from '../../cloud/config.js';
import { MutationTransport } from '../../cloud/remote.js';
import { confirmPromptSourceAttestation, previewPromptSource } from '../../store/prompt-source.js';
import { goTrim } from '../../store/text.js';
import { fatal, println } from '../runtime.js';

const USAGE = 'usage: odin cloud attest-prompt-source --sync-id <exact-sync-id> --owner-project <asserted-owner>';

/** Dirección del servidor validada y sin credenciales. @throws {Error} */
function attestationEndpoint(raw) {
  let endpoint;
  try {
    endpoint = validateServerUrl(raw);
  } catch {
    throw new Error('invalid cloud server URL');
  }
  const parsed = new URL(endpoint);
  if (parsed.username !== '' || parsed.password !== '') throw new Error('cloud server URL credentials are not allowed');
  return endpoint;
}

/**
 * Muestra el origen observado, pide confirmación humana, atesta ante la nube y guarda la confirmación local.
 * @param {import('../runtime.js').Cli} cli
 */
async function attest(cli, store, syncId, owner, endpoint, transport) {
  const preview = previewPromptSource(store, syncId);
  if (preview === null) throw new Error('no unambiguous complete prompt source preview for exact sync ID');
  cli.out(`Observed source: session=${JSON.stringify(preview.sessionId)} source_inbox=${JSON.stringify(preview.sourceInboxId)} sync_id=${JSON.stringify(preview.syncId)} prompt_project=${JSON.stringify(preview.project)} kind=${JSON.stringify(preview.kind)}\nHuman-asserted owner: ${JSON.stringify(owner)}\n`);
  cli.out('Send this exact tuple for remote attestation? Type yes or no: ');
  const answer = goTrim(cli.readLine() ?? '');
  if (answer !== 'yes') {
    if (answer === 'no') throw new Error('attestation declined; no remote call made');
    throw new Error('invalid confirmation; type yes or no; no remote call made');
  }
  let id;
  try {
    id = await transport.attestPromptSource(preview.sessionId, preview.sourceInboxId, preview.syncId, owner, preview.project);
  } catch (err) {
    throw new Error(`remote attestation failed: ${err.message}`);
  }
  if (!(id > 0)) throw new Error('remote attestation returned no positive ID; local confirmation not saved');
  try {
    confirmPromptSourceAttestation(store, endpoint, preview, owner, id);
  } catch (err) {
    throw new Error(`remote attestation succeeded (ID ${id}), but local confirmation failed: ${err.message}; do not assume local authorization`);
  }
  cli.out(`Remote attestation ID ${id} confirmed locally for sync ID ${JSON.stringify(syncId)}\n`);
}

/** `odin cloud attest-prompt-source --sync-id <id> --owner-project <p>`. */
export async function cmdCloudAttestPromptSource(cli, config) {
  const args = cli.args.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h' || args[0] === 'help')) {
    println(cli, USAGE);
    return;
  }
  if (args.length !== 4 || args[0] !== '--sync-id' || args[2] !== '--owner-project' || goTrim(args[1]) === '' || goTrim(args[3]) === '') {
    cli.err(`${USAGE}\n`);
    return fatal(cli, new Error('one exact sync ID and an asserted owner project are required'));
  }
  let runtime;
  try {
    runtime = resolveCloudRuntimeConfig(config.dataDir, cli.env);
  } catch {
    return fatal(cli, new Error('cloud runtime configuration unavailable'));
  }
  if (goTrim(runtime.server_url) === '') return fatal(cli, new Error('cloud server URL is required'));
  let endpoint;
  try {
    endpoint = attestationEndpoint(runtime.server_url);
  } catch (err) {
    return fatal(cli, err);
  }
  if (goTrim(runtime.token) === '') return fatal(cli, new Error('human bearer token required for remote dual-grant enforcement'));
  let transport;
  try {
    transport = new MutationTransport(endpoint, goTrim(runtime.token), cli.fetch ? { fetch: cli.fetch } : {});
  } catch {
    return fatal(cli, new Error('cloud transport configuration rejected'));
  }
  let store;
  try {
    store = cli.openStore(config);
  } catch (err) {
    return fatal(cli, new Error(`local store unavailable: ${err.message}`));
  }
  try {
    await attest(cli, store, args[1], args[3], endpoint, transport);
  } catch (err) {
    return fatal(cli, err);
  } finally {
    store.close();
  }
  return undefined;
}
