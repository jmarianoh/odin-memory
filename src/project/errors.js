/** Errores del paquete de detección de proyecto. Todos llevan un `code` estable. */

class ProjectError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Mensaje base del archivo de configuración inválido. */
export const INVALID_CONFIG_MESSAGE = 'invalid .odin-memory/config.json';
/** Mensaje base del vínculo de identidad del repositorio. */
export const REPOSITORY_BINDING_MESSAGE = 'repository identity binding unavailable';

/** El directorio contiene varios repositorios git hijos y no hay forma de elegir. */
export class AmbiguousProjectError extends ProjectError {
  constructor() {
    super('ambiguous_project', 'ambiguous project: multiple git repos found in cwd');
  }
}

/** `.odin-memory/config.json` ilegible o con un `project_name` inválido. */
export class InvalidConfigError extends ProjectError {
  /** @param {string} [detail] */
  constructor(detail) {
    super('invalid_config', detail ? `${INVALID_CONFIG_MESSAGE}: ${detail}` : INVALID_CONFIG_MESSAGE);
  }
}

/** Sin un proyecto explícito no se puede elegir uno (p. ej. el repositorio de HOME). */
export class ExplicitProjectRequiredError extends ProjectError {
  constructor() {
    super('explicit_project_required', 'explicit project required: use --project, ODIN_PROJECT, or .odin-memory/config.json project_name');
  }
}

/** No se pudo leer o crear el vínculo de identidad del repositorio. */
export class RepositoryBindingError extends ProjectError {
  /**
   * @param {string} [detail]
   * @param {ErrorOptions} [options]
   */
  constructor(detail, options) {
    super('repository_binding', detail ? `${REPOSITORY_BINDING_MESSAGE}: ${detail}` : REPOSITORY_BINDING_MESSAGE, options);
  }
}

/** No se pudo consultar el historial de proyectos del directorio. */
export class ProjectHistoryUnavailableError extends ProjectError {
  /** @param {string} [detail] */
  constructor(detail) {
    super('project_history_unavailable', detail ? `project history unavailable: ${detail}` : 'project history unavailable');
  }
}

/** Git elegiría un proyecto distinto del que tiene historial en este directorio. */
export class ProjectTransitionError extends ProjectError {
  /**
   * @param {string} candidate
   * @param {string[]} historicalProjects
   */
  constructor(candidate, historicalProjects) {
    super(
      'project_transition',
      `Git would select project ${JSON.stringify(candidate)}, but this directory has history under ${historicalProjects.join(', ')}; choose explicitly or run odin init <project> to set future scope (existing memories are not moved)`,
    );
    this.candidate = candidate;
    this.historicalProjects = historicalProjects;
  }
}

/** El proyecto indicado no existe en el almacén. */
export class UnknownProjectError extends ProjectError {
  /** @param {string} name */
  constructor(name) {
    super('unknown_project', `unknown project: ${name}`);
    this.projectName = name;
  }
}
