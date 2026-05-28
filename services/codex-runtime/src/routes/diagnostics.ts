import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getImageConfig, getModelConfig } from '../config.js'
import type { createRuntimeLogger } from '../observability/logger.js'
import { clientLogSchema } from '../tasks/schemas.js'

type RuntimeLogger = ReturnType<typeof createRuntimeLogger>

export function registerDiagnosticsRoutes({
  app,
  resolveCodexBin,
  runtimeHost,
  runtimeLogger,
  runtimeToken,
}: {
  app: FastifyInstance
  resolveCodexBin: () => string
  runtimeHost: string
  runtimeLogger: RuntimeLogger
  runtimeToken: string
}) {
  app.get('/health', async () => ({
    ok: true,
    service: 'codex-runtime',
    bundledCodex: true,
    codexBin: resolveCodexBin(),
    host: runtimeHost,
    logs: runtimeLogger.paths,
    protected: Boolean(runtimeToken),
    model: getModelConfig(),
    image: getImageConfig(),
  }))

  app.get('/api/logs/info', async () => ({
    data: runtimeLogger.paths,
  }))

  app.get('/api/logs/recent', async (request, reply) => {
    const parsed = z
      .object({
        limit: z.coerce.number().int().positive().max(1000).default(200),
        target: z.enum(['runtime', 'client']).default('runtime'),
      })
      .safeParse(request.query ?? {})

    if (!parsed.success) {
      return reply.status(400).send({ error: '日志查询参数不完整', detail: parsed.error.flatten() })
    }

    return {
      data: await runtimeLogger.recent(parsed.data.target, parsed.data.limit),
      paths: runtimeLogger.paths,
    }
  })

  app.post('/api/logs/client', async (request, reply) => {
    const parsed = clientLogSchema.safeParse(request.body)

    if (!parsed.success) {
      return reply.status(400).send({ error: '日志参数不完整', detail: parsed.error.flatten() })
    }

    await runtimeLogger.append(
      {
        ...parsed.data,
        source: parsed.data.source ?? 'desktop-renderer',
      },
      'client',
    )

    return { ok: true }
  })
}
