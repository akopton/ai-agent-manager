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
