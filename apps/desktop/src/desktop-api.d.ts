export type DesktopLogTail = {
  error?: string
  exists: boolean
  path: string
  size?: number
  text: string
  truncated?: boolean
  updatedAt?: string
}

export type DesktopDiagnosticsSnapshot = {
  appPath: string
  isPackaged: boolean
  logs: {
    electronMain: DesktopLogTail
    rendererClient: DesktopLogTail
    runtimeMain: DesktopLogTail
    runtimeNdjson: DesktopLogTail
    startup: DesktopLogTail
  }
  paths: {
    appData: string
    temp: string
    userData: string
  }
  platform: string
  runtime: {
    alive: boolean
    managed: boolean
    pid?: number
    port?: number
    status: 'starting' | 'running' | 'stopping' | 'stopped'
    url?: string
  }
  versions: {
    app: string
    chrome?: string
    electron?: string
    node?: string
    v8?: string
  }
}

declare global {
  interface Window {
    moyuanDesktop?: {
      collectDiagnostics?: () => Promise<DesktopDiagnosticsSnapshot>
    }
  }
}

export {}
