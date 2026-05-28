import { z } from 'zod'

export const clientLogSchema = z.object({
  details: z.unknown().optional(),
  event: z.string().min(1).max(160),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  sessionId: z.string().optional(),
  source: z.string().min(1).max(80).default('desktop-renderer'),
  taskId: z.string().optional(),
  timestamp: z.string().optional(),
  workspace: z.string().optional(),
})

export const taskSchema = z.object({
  prompt: z.string().min(1),
  workspace: z.string().default(process.cwd()),
  employeeId: z.string().min(1),
  enterpriseApiBase: z.string().url().optional(),
  enterpriseAuthToken: z.string().optional(),
  parentTaskId: z.string().optional(),
  sessionId: z.string().optional(),
})

export const approvalSchema = z.object({
  taskId: z.string(),
  decision: z.enum(['allow_once', 'deny']),
  reason: z.string().optional(),
})

export const forkSchema = z.object({
  prompt: z.string().optional(),
})

export const imageGenerationSchema = z.object({
  prompt: z.string().min(1),
  workspace: z.string().default(process.cwd()),
  employeeId: z.string().min(1),
  enterpriseApiBase: z.string().url().optional(),
  enterpriseAuthToken: z.string().optional(),
  model: z.string().optional(),
  size: z.enum(['1024x1024', '1024x1536', '1536x1024']).default('1024x1024'),
})
