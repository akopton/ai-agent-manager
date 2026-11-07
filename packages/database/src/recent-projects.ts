import { sql } from 'drizzle-orm';
import type { DatabaseConnection } from './client.js';

export type RecentProject = {
  id: string;
  name: string;
  activityAt: number;
  activity: string;
};

/** Read-only activity summary. Visits and execution progress/log events never count. */
export const listRecentProjects = (db: DatabaseConnection['db']): RecentProject[] =>
  db.all<RecentProject>(sql`
    WITH activity AS (
      SELECT id AS project_id, created_at AS at, 'Project added' AS description, 0 AS rank
        FROM projects
      UNION ALL
      SELECT id, updated_at, 'Project settings updated', 1 FROM projects
        WHERE updated_at > created_at
      UNION ALL
      SELECT project_id, updated_at,
        CASE WHEN updated_at = created_at THEN 'Task created' ELSE 'Task updated' END, 2
        FROM tasks
      UNION ALL
      SELECT project_id, updated_at,
        CASE WHEN updated_at = created_at THEN 'Conversation created'
          ELSE 'Conversation updated' END, 3 FROM conversations
      UNION ALL
      SELECT tasks.project_id, task_runs.ended_at, 'Task execution completed', 4
        FROM task_runs JOIN tasks ON tasks.id = task_runs.task_id
        WHERE task_runs.status = 'completed' AND task_runs.ended_at IS NOT NULL
    ), latest AS (
      SELECT project_id, at, description,
        ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY at DESC, rank DESC) AS position
        FROM activity
    )
    SELECT projects.id, projects.name, latest.at AS "activityAt", latest.description AS activity
      FROM projects JOIN latest ON latest.project_id = projects.id AND latest.position = 1
      ORDER BY latest.at DESC, projects.id ASC LIMIT 2
  `);
