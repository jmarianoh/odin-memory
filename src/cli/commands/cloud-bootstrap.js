import { goTrim } from '../../store/text.js';
import { CliExit, fatal, println } from '../runtime.js';

const USAGE = [
  'usage: odin cloud bootstrap admin --username <name> [--email <email>] [--grant-project <project>]... [--issue-token [name]]',
  '       odin cloud bootstrap recover-token [--name <name>] [--revoke-existing]',
  'admin creates the first managed admin for a self-hosted cloud deployment',
  'recover-token issues one token for the eligible stranded managed admin',
  '--revoke-existing replaces exactly one unused active bootstrap token',
];
const AUDIT_ACTION = 'bootstrap.cli';

function usageFailure(cli, message) {
  for (const line of USAGE) println(cli, line);
  cli.err(`error: ${message}\n`);
  throw new CliExit(1);
}

/** Banderas de `cloud bootstrap admin`. @throws {Error} */
export function parseBootstrapAdminArgs(args) {
  const out = { username: '', email: '', grantProjects: [], issueToken: false, issueTokenName: '' };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--username':
        if (i + 1 >= args.length) throw new Error('--username requires a value');
        out.username = goTrim(args[++i]);
        break;
      case '--email':
        if (i + 1 >= args.length) throw new Error('--email requires a value');
        out.email = goTrim(args[++i]);
        break;
      case '--grant-project': {
        if (i + 1 >= args.length) throw new Error('--grant-project requires a value');
        const project = goTrim(args[++i]);
        if (project === '') throw new Error('--grant-project requires a non-empty value');
        out.grantProjects.push(project);
        break;
      }
      case '--issue-token':
        out.issueToken = true;
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) out.issueTokenName = goTrim(args[++i]);
        break;
      default:
        throw new Error(`unknown flag: ${args[i]}`);
    }
  }
  if (out.username === '') throw new Error('--username is required');
  return out;
}

/** Auditoría del arranque; el resultado `success`, `denied` o `error` queda en el diario de autenticación. */
const auditEvent = (targetPrincipalId, outcome, reasonCode, metadata) => ({
  actorSource: 'bootstrap_cli', targetPrincipalId, action: AUDIT_ACTION, outcome, reasonCode, metadata,
});

/** Banderas de `cloud bootstrap recover-token`. @throws {Error} */
export function parseRecoverTokenArgs(args) {
  const out = { name: '', revokeExisting: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) throw new Error('--name requires a value');
      out.name = goTrim(args[++i]);
      if (out.name === '') throw new Error('--name requires a non-empty value');
    } else if (args[i] === '--revoke-existing') {
      out.revokeExisting = true;
    } else {
      throw new Error(`unknown flag: ${args[i]}`);
    }
  }
  return out;
}

async function recoverToken(cli) {
  let args;
  try {
    args = parseRecoverTokenArgs(cli.args.slice(3));
  } catch (err) {
    return usageFailure(cli, err.message);
  }
  const { cloudServeConfigFromEnv } = await import('../../cloud/server/config.js');
  const { CloudStore, Database, ManagedTokenHasher, generateManagedToken } = await import('../../cloud/server/index.js');
  const config = cloudServeConfigFromEnv(cli.env);
  if (config.tokenPepper === '') {
    cli.err('error: recover-token requires ODIN_CLOUD_TOKEN_PEPPER to be configured (a dedicated cloud token pepper, distinct from ODIN_JWT_SECRET)\n');
    throw new CliExit(1);
  }
  let hasher;
  try {
    hasher = new ManagedTokenHasher(config.tokenPepper);
  } catch (err) {
    return fatal(cli, new Error(`cloud bootstrap recover-token: ${err.message}`));
  }
  const store = new CloudStore(Database.connect(config.dsn));
  try {
    await store.migrate();
    const managed = generateManagedToken('live');
    try {
      await store.recoverStrandedAdminTokenWithAudit(
        { tokenPrefix: managed.prefix, tokenHash: hasher.hash(managed.raw), name: args.name || 'cli-bootstrap-recovery', revokeExisting: args.revokeExisting },
        { metadata: { recovered: true, token_prefix: managed.prefix } },
      );
    } catch (err) {
      return fatal(cli, new Error(`cloud bootstrap recover-token: ${err.message}`));
    }
    println(cli, 'Managed admin token recovered — SHOWN ONCE, copy and store it now, it cannot be retrieved again:');
    println(cli, managed.raw);
  } finally {
    await store.close().catch(() => {});
  }
  return undefined;
}

/**
 * `odin cloud bootstrap admin`: crea la primera persona administradora del servidor, con permisos y token
 * opcionales. El token se muestra una sola vez.
 * @param {import('../runtime.js').Cli} cli
 */
export async function cmdCloudBootstrap(cli) {
  const sub = cli.args[2];
  if (sub === undefined) {
    for (const line of USAGE) println(cli, line);
    cli.err('error: a bootstrap subcommand is required\n');
    throw new CliExit(1);
  }
  if (['--help', '-h', 'help'].includes(sub)) {
    for (const line of USAGE) println(cli, line);
    return undefined;
  }
  if (sub === 'recover-token') return recoverToken(cli);
  if (sub !== 'admin') return usageFailure(cli, `unknown cloud bootstrap subcommand: ${sub}`);
  let args;
  try {
    args = parseBootstrapAdminArgs(cli.args.slice(3));
  } catch (err) {
    return usageFailure(cli, err.message);
  }
  const { cloudServeConfigFromEnv } = await import('../../cloud/server/config.js');
  const { CloudStore, Database, ManagedTokenHasher, generateManagedToken } = await import('../../cloud/server/index.js');
  const config = cloudServeConfigFromEnv(cli.env);
  let hasher = null;
  if (args.issueToken) {
    if (config.tokenPepper === '') {
      cli.err('error: --issue-token requires ODIN_CLOUD_TOKEN_PEPPER to be configured (a dedicated cloud token pepper, distinct from ODIN_JWT_SECRET)\n');
      throw new CliExit(1);
    }
    try {
      hasher = new ManagedTokenHasher(config.tokenPepper);
    } catch (err) {
      return fatal(cli, new Error(`cloud bootstrap admin: ${err.message}`));
    }
  }
  const store = new CloudStore(Database.connect(config.dsn));
  try {
    await store.migrate();
    let user;
    try {
      user = await store.createFirstAdminHumanUser({ username: args.username, email: args.email, displayName: args.username });
    } catch (err) {
      if (err.code === 'admin_already_exists') {
        await store.insertAuthAuditEvent(auditEvent('', 'denied', 'managed_admin_already_exists', { created_admin: false, username: args.username })).catch((e) => cli.err(`warning: failed to record bootstrap denial audit event: ${e.message}\n`));
        cli.err('error: a managed admin already exists; refusing to create a duplicate first admin via CLI bootstrap\n');
        throw new CliExit(1);
      }
      return fatal(cli, new Error(`cloud bootstrap admin: create admin user: ${err.message}`));
    }
    try {
      await store.insertAuthAuditEvent(auditEvent(user.principal_id, 'success', '', { created_admin: true, username: args.username }));
    } catch (err) {
      return fatal(cli, new Error(`cloud bootstrap admin: created admin ${args.username} (principal_id=${user.principal_id}) but failed to record the required bootstrap audit event: ${err.message}`));
    }
    const grants = [];
    for (const project of args.grantProjects) {
      try {
        grants.push(await store.createProjectGrant({ principalId: user.principal_id, project, grantedByPrincipalId: user.principal_id }));
      } catch (err) {
        await store.insertAuthAuditEvent(auditEvent(user.principal_id, 'error', 'grant_project_failed', { created_admin: true, username: args.username, failed_step: 'grant_project', project })).catch(() => {});
        return fatal(cli, new Error(`cloud bootstrap admin: grant project ${JSON.stringify(project)}: ${err.message}`));
      }
    }
    const completion = () => ({ created_admin: true, username: args.username, issued_token: args.issueToken, ...(grants.length > 0 ? { grant_projects: grants.map((g) => g.project) } : {}) });
    let raw = '';
    if (args.issueToken) {
      const managed = generateManagedToken('live');
      try {
        await store.createPrincipalTokenWithAudit(
          { principalId: user.principal_id, tokenPrefix: managed.prefix, tokenHash: hasher.hash(managed.raw), name: args.issueTokenName || 'cli-bootstrap', createdByPrincipalId: user.principal_id },
          auditEvent(user.principal_id, 'success', 'bootstrap_completed', { ...completion(), token_prefix: managed.prefix }),
        );
      } catch (err) {
        await store.insertAuthAuditEvent(auditEvent(user.principal_id, 'error', 'token_create_or_audit_failed', { created_admin: true, username: args.username, failed_step: 'issue_token' })).catch(() => {});
        return fatal(cli, new Error(`cloud bootstrap admin: create token with completion audit: ${err.message}`));
      }
      raw = managed.raw;
    }
    println(cli, `✓ Managed admin created: username=${user.username} principal_id=${user.principal_id}`);
    for (const grant of grants) println(cli, `✓ Project grant created: project=${grant.project}`);
    if (args.issueToken) {
      println(cli);
      println(cli, 'Token issued — SHOWN ONCE, copy and store it now, it cannot be retrieved again:');
      println(cli, raw);
    }
    if (grants.length > 0 && !args.issueToken) {
      try {
        await store.insertAuthAuditEvent(auditEvent(user.principal_id, 'success', 'bootstrap_completed', completion()));
      } catch (err) {
        await store.insertAuthAuditEvent(auditEvent(user.principal_id, 'error', 'completion_audit_failed', { created_admin: true, username: args.username })).catch(() => {});
        return fatal(cli, new Error(`cloud bootstrap admin: created admin ${args.username} (principal_id=${user.principal_id}) and issued optional grants/token but failed to record the completion audit event: ${err.message}`));
      }
    }
  } finally {
    await store.close().catch(() => {});
  }
  return undefined;
}
