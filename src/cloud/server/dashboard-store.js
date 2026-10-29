import { goTrim } from '../../store/text.js';
import { buildDashboardModel, DashboardView } from './dashboard-model.js';

/**
 * Lecturas del panel sobre `CloudStore`: el modelo en memoria con caché (un solo cálculo a la vez, descartado
 * en cada escritura), vistas por alcance, controles de proyecto y registro de sincronización.
 */

const CHUNK_QUERY = `SELECT chunk_id, project_name, created_by, created_at, payload::text AS payload FROM cloud_chunks
  ORDER BY created_at ASC, chunk_id COLLATE "C" ASC, project_name COLLATE "C" ASC, created_by COLLATE "C" ASC`;
const MUTATION_QUERY = 'SELECT seq, project, entity, entity_key, op, payload::text AS payload, occurred_at FROM cloud_mutations ORDER BY seq ASC';

const rfc3339 = (date) => (date == null ? '' : date.toISOString().replace(/\.\d{3}Z$/, 'Z'));

export const dashboardMethods = {
  /** Descarta el modelo en memoria; la próxima lectura lo recalcula. */
  invalidateDashboard() {
    this._dashboardGeneration = (this._dashboardGeneration ?? 0) + 1;
    this._dashboardModel = null;
  },

  /** El modelo sin recorte de permisos, de la caché o recién calculado. */
  async dashboardModel() {
    if (this._dashboardModel) return this._dashboardModel;
    if (this._dashboardBuild) return this._dashboardBuild.promise;
    const generation = this._dashboardGeneration ?? 0;
    const build = { promise: null };
    build.promise = (async () => {
      try {
        const [chunkRows, mutationRows, controls] = await Promise.all([this.db.query(CHUNK_QUERY), this.db.query(MUTATION_QUERY), this.listProjectSyncControls()]);
        const chunks = chunkRows.map((row) => {
          let parsed;
          try {
            parsed = JSON.parse(row.payload);
          } catch (err) {
            throw new Error(`cloudstore: dashboard decode chunk payload for chunk ${JSON.stringify(goTrim(row.chunk_id))}: ${err.message}`);
          }
          return { chunkId: goTrim(row.chunk_id), project: row.project_name, createdBy: goTrim(row.created_by), createdAt: row.created_at, parsed };
        });
        const mutations = mutationRows.map((row) => ({ seq: Number(row.seq), project: row.project, entity: row.entity, entity_key: row.entity_key, op: row.op, payload: row.payload }));
        const model = buildDashboardModel({ chunks, mutations, controls });
        if (generation === (this._dashboardGeneration ?? 0)) this._dashboardModel = model;
        return model;
      } finally {
        if (this._dashboardBuild === build) this._dashboardBuild = null;
      }
    })();
    this._dashboardBuild = build;
    return build.promise;
  },

  /** Vista con todos los proyectos, o solo con los indicados (nombres canónicos; lista vacía = ninguno). */
  async dashboardView(allowed = null) {
    return new DashboardView(await this.dashboardModel(), allowed === null ? null : new Set(allowed));
  },

  /** Vista de un principal gestionado: lo que sus permisos concedidos alcanzan. */
  async dashboardViewForGrants(grants) {
    return DashboardView.forGrants(await this.dashboardModel(), grants);
  },

  async listProjectSyncControls() {
    const rows = await this.db.query(`
      SELECT p.project, COALESCE(c.sync_enabled, TRUE) AS sync_enabled, c.paused_reason, c.updated_by, c.updated_at
      FROM (SELECT DISTINCT project_name AS project FROM cloud_chunks UNION SELECT project FROM cloud_project_controls) p
      LEFT JOIN cloud_project_controls c ON c.project = p.project
      ORDER BY p.project`);
    return rows.map((r) => ({ project: r.project, syncEnabled: r.sync_enabled, pausedReason: r.paused_reason ?? null, updatedBy: r.updated_by ?? null, updatedAt: rfc3339(r.updated_at) }));
  },

  async getProjectSyncControl(project) {
    const name = goTrim(project ?? '');
    if (name === '') return null;
    const rows = await this.db.query('SELECT project, sync_enabled, paused_reason, updated_by, updated_at FROM cloud_project_controls WHERE project = $1', [name]);
    if (rows.length === 0) return null;
    const r = rows[0];
    return { project: r.project, syncEnabled: r.sync_enabled, pausedReason: r.paused_reason ?? null, updatedBy: r.updated_by ?? null, updatedAt: rfc3339(r.updated_at) };
  },

  /** Registro de rechazos de sincronización, lo más reciente primero. @returns {Promise<{ rows: object[], total: number }>} */
  async listAuditEntriesPaginated(filter, limit, offset) {
    const conditions = [];
    const args = [];
    const add = (sql, value) => {
      args.push(value);
      conditions.push(sql.replace('?', `$${args.length}`));
    };
    if (goTrim(filter.contributor ?? '') !== '') add('contributor = ?', goTrim(filter.contributor));
    if (goTrim(filter.project ?? '') !== '') add('project = ?', goTrim(filter.project));
    if (goTrim(filter.outcome ?? '') !== '') add('outcome = ?', goTrim(filter.outcome));
    if (filter.occurredAtFrom) add('occurred_at >= ?', filter.occurredAtFrom);
    if (filter.occurredAtTo) add('occurred_at <= ?', filter.occurredAtTo);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [{ n }] = await this.db.query(`SELECT COUNT(*)::int AS n FROM cloud_sync_audit_log ${where}`, args);
    const rows = await this.db.query(
      `SELECT id, occurred_at, contributor, project, action, outcome, entry_count, COALESCE(reason_code, '') AS reason_code, metadata
       FROM cloud_sync_audit_log ${where} ORDER BY occurred_at DESC, id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, limit, offset],
    );
    return {
      total: n,
      rows: rows.map((r) => ({
        ID: Number(r.id), OccurredAt: rfc3339(r.occurred_at), Contributor: r.contributor, Project: r.project, Action: r.action, Outcome: r.outcome,
        EntryCount: r.entry_count, ReasonCode: r.reason_code, Metadata: r.metadata ?? null,
      })),
    };
  },

  /** ¿Responde la base? (Pulso corto, sin lanzar.) */
  async ping() {
    try {
      await Promise.race([this.db.query('SELECT 1'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500).unref())]);
      return true;
    } catch {
      return false;
    }
  },
};
