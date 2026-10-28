/** Errores propios de la capa MCP al resolver el proyecto de una llamada. */
export class McpProjectError extends Error {
  /**
   * @param {'unknown_project'|'invalid_project_choice'|'missing_recovery_token'|'invalid_recovery_token'|'invalid_explicit_project'|'project_name_collision'|'unknown_session'|'session_project_mismatch'} kind
   * @param {string} message
   * @param {object} [fields]
   */
  constructor(kind, message, fields = {}) {
    super(message);
    this.name = 'McpProjectError';
    this.kind = kind;
    Object.assign(this, fields);
  }
}

export const unknownProject = (name, availableProjects) =>
  new McpProjectError('unknown_project', `unknown project: ${name}`, { projectName: name, availableProjects });

export const invalidProjectChoice = (name, availableProjects) =>
  new McpProjectError('invalid_project_choice', `invalid project choice: ${name}`, { projectName: name, availableProjects });

export const missingRecoveryToken = (name, availableProjects) =>
  new McpProjectError('missing_recovery_token', `missing ambiguous project recovery token for project choice: ${name}`, { projectName: name, availableProjects });

export const invalidRecoveryToken = (name, availableProjects) =>
  new McpProjectError('invalid_recovery_token', `invalid ambiguous project recovery token for project choice: ${name}`, { projectName: name, availableProjects });

export const invalidExplicitProject = (name, reason) =>
  new McpProjectError('invalid_explicit_project', reason ? `invalid project: ${name} (${reason})` : `invalid project: ${name}`, { projectName: name, reason });

export const projectNameCollision = (name, normalized, collidingProjects) =>
  new McpProjectError('project_name_collision', `project ${JSON.stringify(name)} collides after normalization to ${JSON.stringify(normalized)}`, { projectName: name, normalized, collidingProjects });

export const unknownSession = (sessionId) => new McpProjectError('unknown_session', `unknown session: ${sessionId}`, { sessionId });

export const sessionProjectMismatch = (sessionId, sessionProject, explicitProject) =>
  new McpProjectError('session_project_mismatch', `session ${JSON.stringify(sessionId)} belongs to project ${JSON.stringify(sessionProject)}, not ${JSON.stringify(explicitProject)}`, { sessionId, sessionProject, explicitProject });
