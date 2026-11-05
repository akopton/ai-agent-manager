import { createTaskInputSchema, taskSchema, updateTaskInputSchema } from '@ai-agent-manager/core';
import { z } from 'zod';

// Request and response contracts shared by the task route handlers, server components, and the
// browser. The request schemas are the domain schemas from `core`; the project comes from the URL.

/** A new task in the project named by the route. Unknown keys (including `status`) are rejected. */
export const createProjectTaskRequestSchema = createTaskInputSchema.omit({ projectId: true });

export type CreateProjectTaskRequest = z.input<typeof createProjectTaskRequestSchema>;

export type CreateProjectTaskData = z.output<typeof createProjectTaskRequestSchema>;

/** Partial edit of a task. Status changes are separate, named actions. */
export const updateProjectTaskRequestSchema = updateTaskInputSchema;

export type UpdateProjectTaskRequest = z.input<typeof updateProjectTaskRequestSchema>;

export const taskResponseSchema = z.object({ task: taskSchema });

export const taskListResponseSchema = z.object({ tasks: z.array(taskSchema) });
