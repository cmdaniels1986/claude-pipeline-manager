import { z } from 'zod'

export const nodeStatusSchema = z.enum(['unknown', 'in_progress', 'validated', 'stale', 'breaking'])
export const nodeTypeSchema = z.enum(['dataset', 'model', 'table', 'source', 'report', 'other'])
export const edgeKindSchema = z.enum(['lineage', 'dependency', 'writes', 'reads'])

export const graphNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: nodeTypeSchema,
  status: nodeStatusSchema,
  statusNote: z.string().optional(),
  meta: z
    .object({
      path: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      placeholder: z.boolean().optional()
    })
    .default({}),
  position: z.object({ x: z.number(), y: z.number() }).nullable().default(null)
})

export const graphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  kind: edgeKindSchema
})

export const graphEventSchema = z.object({
  ts: z.string(),
  termId: z.string().nullable(),
  tool: z.string(),
  summary: z.string()
})

export const graphStateSchema = z.object({
  version: z.literal(1),
  projectRoot: z.string(),
  updatedAt: z.string(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  events: z.array(graphEventSchema)
})

/** Inputs accepted from MCP tools (lenient: fills defaults) */
export const nodeInputSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  type: nodeTypeSchema.optional(),
  status: nodeStatusSchema.optional(),
  statusNote: z.string().optional(),
  path: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional()
})

export const edgeInputSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  kind: edgeKindSchema.optional()
})

export type NodeInput = z.infer<typeof nodeInputSchema>
export type EdgeInput = z.infer<typeof edgeInputSchema>
