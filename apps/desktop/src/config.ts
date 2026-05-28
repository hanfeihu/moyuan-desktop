const launchParams = new URLSearchParams(window.location.search)

export const runtimeUrl = launchParams.get('runtimeUrl') ?? import.meta.env.VITE_CODEX_RUNTIME_URL ?? 'http://127.0.0.1:4101'
export const runtimeToken = launchParams.get('runtimeToken') ?? import.meta.env.VITE_CODEX_RUNTIME_TOKEN ?? ''
export const enterpriseApiBase = launchParams.get('enterpriseApiBase') ?? import.meta.env.VITE_ENTERPRISE_API_BASE ?? 'http://codex.tminos.com:18080/admin-api'
export const desktopPlatform = launchParams.get('platform') ?? 'web'
export const defaultWorkspace = import.meta.env.VITE_DEFAULT_WORKSPACE ?? '/Users/a1/Documents/Codex/2026-05-26/codex'
export const localEmployeeId = import.meta.env.VITE_EMPLOYEE_ID ?? 'u-1001'
export const authTokenStorageKey = 'moyuan.auth.token'
