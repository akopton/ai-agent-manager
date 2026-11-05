import { asc, eq, or, sql } from 'drizzle-orm';
import type { DatabaseConnection } from './client.js';
import { projects } from './schema.js';

export type ProjectRecord = typeof projects.$inferSelect;

export type NewProjectRecord = typeof projects.$inferInsert;

type Database = DatabaseConnection['db'];

/** Thrown when a project with the same path or common Git directory is already stored. */
export class ProjectConflictError extends Error {
  override name = 'ProjectConflictError';
}

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY');

export const insertProject = (db: Database, record: NewProjectRecord): ProjectRecord => {
  try {
    return db.insert(projects).values(record).returning().get();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ProjectConflictError('The repository is already registered as a project.', {
        cause: error,
      });
    }
    throw error;
  }
};

/** Lists projects by name (case-insensitive), then by registration time. */
export const listProjects = (db: Database): ProjectRecord[] =>
  db
    .select()
    .from(projects)
    .orderBy(asc(sql`${projects.name} COLLATE NOCASE`), asc(projects.createdAt), asc(projects.id))
    .all();

export const findProjectById = (db: Database, id: string): ProjectRecord | undefined =>
  db.select().from(projects).where(eq(projects.id, id)).get();

/** Finds a project registered for the same working tree path or the same common Git directory. */
export const findProjectByRepository = (
  db: Database,
  { localPath, gitCommonDir }: Pick<ProjectRecord, 'localPath' | 'gitCommonDir'>,
): ProjectRecord | undefined =>
  db
    .select()
    .from(projects)
    .where(or(eq(projects.localPath, localPath), eq(projects.gitCommonDir, gitCommonDir)))
    .get();

/** Settings that may change after registration. The repository identity is never updated. */
export type ProjectSettingsUpdate = Partial<
  Pick<ProjectRecord, 'name' | 'priority' | 'instructions' | 'defaultBaseBranch' | 'remoteName'>
>;

/**
 * Updates a project's settings and `updatedAt`. Returns the stored record, or `undefined` when no
 * project has this ID.
 */
export const updateProject = (
  db: Database,
  id: string,
  changes: ProjectSettingsUpdate,
  updatedAt: number,
): ProjectRecord | undefined =>
  db
    .update(projects)
    .set({
      name: changes.name,
      priority: changes.priority,
      instructions: changes.instructions,
      defaultBaseBranch: changes.defaultBaseBranch,
      remoteName: changes.remoteName,
      updatedAt,
    })
    .where(eq(projects.id, id))
    .returning()
    .get();

export type ProjectDependent = { table: string; column: string; count: number };

/**
 * Thrown when other records still reference the project. Disconnecting never cascades: the owner
 * must decide about tasks, runs and retained worktrees first.
 */
export class ProjectHasDependentsError extends Error {
  override name = 'ProjectHasDependentsError';

  constructor(readonly dependents: ProjectDependent[]) {
    super('Other records still reference this project.');
  }
}

/**
 * Counts rows in every table that declares a foreign key to `projects`. The check reads the live
 * schema, so tables added later (tasks, workspaces, conversations) are covered without changes
 * here, and a reference is never removed by an `ON DELETE CASCADE` rule.
 */
const findProjectDependents = (db: Database, id: string): ProjectDependent[] => {
  const references = db.all<{ tableName: string; columnName: string }>(sql`
    SELECT m.name AS tableName, f."from" AS columnName
    FROM sqlite_master AS m, pragma_foreign_key_list(m.name) AS f
    WHERE m.type = 'table' AND f."table" = 'projects'
    ORDER BY m.name, f."from"
  `);
  return references
    .map(({ tableName, columnName }) => {
      const row = db.get<{ count: number }>(
        sql`SELECT count(*) AS count FROM ${sql.identifier(tableName)} WHERE ${sql.identifier(columnName)} = ${id}`,
      );
      return { table: tableName, column: columnName, count: row?.count ?? 0 };
    })
    .filter(({ count }) => count > 0);
};

/**
 * Removes the project record only, in one transaction. Throws `ProjectHasDependentsError` (and
 * deletes nothing) if any record references it. Returns the removed record, or `undefined` when no
 * project has this ID. Nothing outside the database is touched.
 */
export const deleteProject = (db: Database, id: string): ProjectRecord | undefined =>
  db.transaction((tx) => {
    const existing = tx.select().from(projects).where(eq(projects.id, id)).get();
    if (existing === undefined) {
      return undefined;
    }
    const dependents = findProjectDependents(tx, id);
    if (dependents.length > 0) {
      throw new ProjectHasDependentsError(dependents);
    }
    return tx.delete(projects).where(eq(projects.id, id)).returning().get();
  });
