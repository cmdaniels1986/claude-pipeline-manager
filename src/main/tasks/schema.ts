import { z } from 'zod'

export const taskStatusSchema = z.enum(['todo', 'doing', 'done'])

export const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: taskStatusSchema,
  note: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
})

export const goalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  note: z.string().optional(),
  tasks: z.array(taskSchema),
  createdAt: z.string(),
  updatedAt: z.string()
})

export const taskEventSchema = z.object({
  ts: z.string(),
  termId: z.string().nullable(),
  tool: z.string(),
  summary: z.string()
})

export const tasksStateSchema = z.object({
  version: z.literal(1),
  projectRoot: z.string(),
  updatedAt: z.string(),
  goals: z.array(goalSchema),
  events: z.array(taskEventSchema)
})

/** A task from an MCP call: a bare title string, or an object with an optional note. */
export const taskInputSchema = z.union([
  z.string().min(1),
  z.object({ title: z.string().min(1), note: z.string().optional() })
])

export type TaskInput = z.infer<typeof taskInputSchema>

/** Normalizes either input form to a {title, note?} object. */
export function normalizeTaskInput(input: TaskInput): { title: string; note?: string } {
  return typeof input === 'string' ? { title: input } : input
}
