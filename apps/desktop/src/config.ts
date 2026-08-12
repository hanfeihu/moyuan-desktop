import {
  defaultCodexModelCatalog,
  defaultCodexModelId,
  defaultCodexReasoningEffort,
  isReasoningEffort,
  normalizeModelCatalog,
  type ModelCatalogEntry,
  type ReasoningEffort,
} from '@eaw/shared'

const launchParams = new URLSearchParams(window.location.search)

export const runtimeUrl = launchParams.get('runtimeUrl') ?? import.meta.env.VITE_CODEX_RUNTIME_URL ?? 'http://127.0.0.1:4101'
export const runtimeToken = launchParams.get('runtimeToken') ?? import.meta.env.VITE_CODEX_RUNTIME_TOKEN ?? ''
export const enterpriseApiBase = launchParams.get('enterpriseApiBase') ?? import.meta.env.VITE_ENTERPRISE_API_BASE ?? 'http://codex.tminos.com:18080/admin-api'
export const desktopPlatform = launchParams.get('platform') ?? 'web'
export const desktopAppVersion = launchParams.get('appVersion') ?? import.meta.env.VITE_APP_VERSION ?? 'dev'
export const defaultWorkspace = launchParams.get('defaultWorkspace') ?? import.meta.env.VITE_DEFAULT_WORKSPACE ?? ''
export const localEmployeeId = import.meta.env.VITE_EMPLOYEE_ID ?? 'u-1001'
export const authTokenStorageKey = 'moyuan.auth.token'
export const executionSettingsStorageKey = 'moyuan.execution.settings'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type ExecutionSettings = {
  model: string
  reasoningEffort: ReasoningEffort
  sandboxMode: SandboxMode
}

export const defaultExecutionSettings: ExecutionSettings = {
  model: defaultCodexModelId,
  reasoningEffort: defaultCodexReasoningEffort,
  sandboxMode: 'danger-full-access',
}

export function readExecutionSettings(
  models: ModelCatalogEntry[] = defaultCodexModelCatalog,
  defaultModel = defaultCodexModelId,
): ExecutionSettings {
  const catalog = normalizeModelCatalog(models, defaultModel).filter((model) => model.enabled)
  const catalogDefault = catalog.find((model) => model.id === defaultModel) ?? catalog[0]
  try {
    const parsed = JSON.parse(window.localStorage.getItem(executionSettingsStorageKey) ?? '{}') as Partial<ExecutionSettings>
    const persistedModel = catalog.find((model) => model.id === parsed.model)
    const selectedModel = persistedModel ?? catalogDefault
    const requestedEffort = persistedModel && isReasoningEffort(parsed.reasoningEffort)
      ? parsed.reasoningEffort
      : selectedModel.defaultReasoningEffort
    return {
      model: selectedModel.id,
      reasoningEffort: selectedModel.supportedReasoningEfforts.includes(requestedEffort)
        ? requestedEffort
        : selectedModel.defaultReasoningEffort,
      sandboxMode: parsed.sandboxMode === 'read-only' || parsed.sandboxMode === 'workspace-write' || parsed.sandboxMode === 'danger-full-access'
        ? parsed.sandboxMode
        : defaultExecutionSettings.sandboxMode,
    }
  } catch {
    return {
      model: catalogDefault.id,
      reasoningEffort: catalogDefault.defaultReasoningEffort,
      sandboxMode: defaultExecutionSettings.sandboxMode,
    }
  }
}

export function writeExecutionSettings(settings: ExecutionSettings) {
  window.localStorage.setItem(executionSettingsStorageKey, JSON.stringify(settings))
}
