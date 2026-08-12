import { isReasoningEffort, type ReasoningEffort } from '@eaw/shared'
import type { ModelRuntimeConfig } from './config.js'
import type { RuntimeRunOptions } from './skills/contracts.js'

export function resolveModelSelection(
  config: ModelRuntimeConfig,
  options: RuntimeRunOptions = {},
  fallbackReasoningEffort: ReasoningEffort = 'xhigh',
) {
  const enabledModels = config.models.filter((model) => model.enabled)
  const requestedModel = options.model ?? config.defaultModel
  const selectedModel = enabledModels.find((model) => model.id === requestedModel)
  if (!selectedModel) throw new Error('所选模型已停用或不在企业模型目录中，请重新选择')
  const requestedEffort = options.reasoningEffort ?? (isReasoningEffort(fallbackReasoningEffort) ? fallbackReasoningEffort : 'xhigh')
  if (options.reasoningEffort && !selectedModel.supportedReasoningEfforts.includes(requestedEffort)) {
    throw new Error('所选模型不支持当前推理强度，请重新选择')
  }
  return {
    model: selectedModel.id,
    reasoningEffort: selectedModel.supportedReasoningEfforts.includes(requestedEffort)
      ? requestedEffort
      : selectedModel.defaultReasoningEffort,
  }
}

export function validateModelSelection(config: ModelRuntimeConfig, options: RuntimeRunOptions = {}) {
  const requestedModel = options.model ?? config.defaultModel
  const model = config.models.find((entry) => entry.enabled && entry.id === requestedModel)
  if (!model) return { ok: false as const, error: '所选模型已停用或不在企业模型目录中，请重新选择' }
  if (options.reasoningEffort && !model.supportedReasoningEfforts.includes(options.reasoningEffort)) {
    return { ok: false as const, error: '所选模型不支持当前推理强度，请重新选择' }
  }
  return {
    ok: true as const,
    model: model.id,
    reasoningEffort: options.reasoningEffort ?? model.defaultReasoningEffort,
  }
}
