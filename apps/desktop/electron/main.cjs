const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron')
const { autoUpdater } = require('electron-updater')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')

const devUrl = process.env.MOYUAN_DESKTOP_URL || 'http://127.0.0.1:5170'
const enterpriseApiBase = process.env.MOYUAN_ENTERPRISE_API_BASE || 'http://codex.tminos.com:18080/admin-api'
const runtimeHost = '127.0.0.1'
const defaultRuntimePort = Number(process.env.CODEX_RUNTIME_PORT || 4101)
const runtimeToken = crypto.randomBytes(32).toString('hex')
let runtimeProcess = null
let runtimeLog = null
const startupLogPath = path.join(app.getPath('temp'), 'moyuan-desktop-startup.log')
let updateCheckStarted = false

app.setName('墨渊')
app.setPath('userData', path.join(app.getPath('appData'), 'Moyuan Desktop'))

function mainLogPath() {
  return path.join(app.getPath('userData'), 'logs', 'electron-main.ndjson')
}

function runtimeLogPath() {
  return path.join(app.getPath('userData'), 'logs', 'codex-runtime.log')
}

function runtimeNdjsonPath() {
  return path.join(app.getPath('userData'), 'runtime', 'logs', 'runtime.ndjson')
}

function rendererLogPath() {
  return path.join(app.getPath('userData'), 'runtime', 'logs', 'desktop-client.ndjson')
}

function redactDiagnosticsText(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer ***')
    .replace(/(Authorization\s*[:=]\s*)[^\s,;]+/gi, '$1***')
    .replace(/([?&](?:token|runtimeToken|enterpriseAuthToken|authToken|apiKey|key)=)[^&\s]+/gi, '$1***')
    .replace(/("?(?:token|runtimeToken|enterpriseAuthToken|authToken|apiKey|api_key|authorization)"?\s*[:=]\s*")([^"]+)(")/gi, '$1***$3')
}

function tailText(filePath, maxBytes = 48 * 1024) {
  try {
    if (!fs.existsSync(filePath)) return { exists: false, path: filePath, text: '' }
    const stat = fs.statSync(filePath)
    const length = Math.min(stat.size, maxBytes)
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(filePath, 'r')
    try {
      fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length))
    } finally {
      fs.closeSync(fd)
    }
    return {
      exists: true,
      path: filePath,
      size: stat.size,
      truncated: stat.size > maxBytes,
      text: redactDiagnosticsText(buffer.toString('utf8')),
      updatedAt: stat.mtime.toISOString(),
    }
  } catch (error) {
    return {
      error: error?.message || String(error),
      exists: false,
      path: filePath,
      text: '',
    }
  }
}

function collectDiagnosticsSnapshot() {
  return {
    appPath: app.getAppPath(),
    isPackaged: isPackagedApp(),
    paths: {
      appData: app.getPath('appData'),
      temp: app.getPath('temp'),
      userData: app.getPath('userData'),
    },
    platform: process.platform,
    runtime: {
      alive: Boolean(runtimeProcess && !runtimeProcess.killed),
      pid: runtimeProcess?.pid,
    },
    logs: {
      electronMain: tailText(mainLogPath()),
      rendererClient: tailText(rendererLogPath()),
      runtimeMain: tailText(runtimeLogPath()),
      runtimeNdjson: tailText(runtimeNdjsonPath()),
      startup: tailText(startupLogPath),
    },
    versions: {
      app: app.getVersion(),
      chrome: process.versions.chrome,
      electron: process.versions.electron,
      node: process.versions.node,
      v8: process.versions.v8,
    },
  }
}

function logStartup(message, error) {
  const suffix = error ? ` ${error.stack || error.message || String(error)}` : ''
  const timestamp = new Date().toISOString()
  fs.appendFileSync(startupLogPath, `[${timestamp}] ${message}${suffix}\n`)
  try {
    const filePath = mainLogPath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        details: error ? { message: error.message || String(error), stack: error.stack } : undefined,
        event: message,
        level: error ? 'error' : 'info',
        source: 'electron-main',
        timestamp,
      })}\n`,
    )
  } catch {
    // Startup logging must never block the app from opening.
  }
}

function isPackagedApp() {
  return app.isPackaged || !process.defaultApp
}

function getAppRoot() {
  return isPackagedApp() ? app.getAppPath() : path.join(__dirname, '../../..')
}

function getIconPath() {
  const appRoot = getAppRoot()
  const candidates = [
    path.join(appRoot, 'apps/desktop/build/icon.png'),
    path.join(appRoot, 'build/icon.png'),
    path.join(appRoot, 'build/icon.icns'),
    path.join(process.resourcesPath ?? '', 'icon.png'),
  ]
  return candidates.find((filePath) => filePath && fs.existsSync(filePath))
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const env = {}
  const content = fs.readFileSync(filePath, 'utf8')

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue

    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[match[1]] = value
  }

  return env
}

function loadRuntimeEnv(appRoot, userData) {
  const candidates = [
    path.join(appRoot, '.env'),
    path.join(userData, 'runtime.env'),
    process.env.MOYUAN_RUNTIME_ENV,
  ].filter(Boolean)

  return candidates.reduce((merged, filePath) => ({ ...merged, ...parseEnvFile(filePath) }), {})
}

function appendLaunchParams(rawUrl, params) {
  const url = new URL(rawUrl)
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  })
  return url.toString()
}

function canUsePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, runtimeHost)
  })
}

async function findRuntimePort() {
  for (let port = defaultRuntimePort; port < defaultRuntimePort + 40; port += 1) {
    if (await canUsePort(port)) return port
  }
  throw new Error(`No available local runtime port from ${defaultRuntimePort}`)
}

function waitForRuntime(runtimeUrl, token, timeoutMs = 15000) {
  const startedAt = Date.now()

  return new Promise((resolve) => {
    const probe = () => {
      const request = http.get(
        `${runtimeUrl}/health?token=${encodeURIComponent(token)}`,
        { timeout: 1200 },
        (response) => {
          response.resume()
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve(true)
            return
          }
          retry()
        },
      )
      request.on('timeout', () => {
        request.destroy()
        retry()
      })
      request.on('error', retry)
    }

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        resolve(false)
        return
      }
      setTimeout(probe, 280)
    }

    probe()
  })
}

async function startRuntime() {
  logStartup(`startRuntime packaged=${isPackagedApp()} appPath=${app.getAppPath()}`)
  if (!isPackagedApp()) {
    return {
      url: process.env.VITE_CODEX_RUNTIME_URL || 'http://127.0.0.1:4101',
      token: '',
      defaultWorkspace: process.env.VITE_DEFAULT_WORKSPACE || path.join(app.getPath('documents'), 'Moyuan Workspace'),
    }
  }

  const appRoot = getAppRoot()
  const runtimeEntry = path.join(appRoot, 'services/codex-runtime/dist/index.js')
  logStartup(`runtimeEntry ${runtimeEntry}`)
  const port = await findRuntimePort()
  const runtimeUrl = `http://${runtimeHost}:${port}`
  const userData = app.getPath('userData')
  const defaultWorkspace = path.join(app.getPath('documents'), 'Moyuan Workspace')
  const logDir = path.join(userData, 'logs')
  const runtimeEnv = loadRuntimeEnv(appRoot, userData)

  fs.mkdirSync(logDir, { recursive: true })
  fs.mkdirSync(defaultWorkspace, { recursive: true })
  runtimeLog = fs.createWriteStream(path.join(logDir, 'codex-runtime.log'), { flags: 'a' })
  runtimeLog.write(`\n[${new Date().toISOString()}] starting runtime ${runtimeEntry}\n`)
  runtimeLog.write(`[${new Date().toISOString()}] runtime config keys ${Object.keys(runtimeEnv).join(',') || 'none'}\n`)

  runtimeProcess = spawn(process.execPath, [runtimeEntry], {
    cwd: appRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...runtimeEnv,
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CODEX_RUNTIME_HOST: runtimeHost,
      CODEX_RUNTIME_PORT: String(port),
      MOYUAN_NODE_HOST_PATH: process.execPath,
      MOYUAN_DEFAULT_WORKSPACE: defaultWorkspace,
      MOYUAN_RUNTIME_TOKEN: runtimeToken,
      MOYUAN_RUNTIME_HOME: path.join(userData, 'runtime'),
      MOYUAN_CODEX_HOME: path.join(userData, 'codex-home'),
    },
  })
  logStartup(`runtime spawned pid=${runtimeProcess.pid} url=${runtimeUrl}`)

  runtimeProcess.stdout?.pipe(runtimeLog)
  runtimeProcess.stderr?.pipe(runtimeLog)
  runtimeProcess.once('exit', (code, signal) => {
    runtimeLog?.write(`[${new Date().toISOString()}] runtime exited code=${code ?? ''} signal=${signal ?? ''}\n`)
    runtimeProcess = null
  })

  await waitForRuntime(runtimeUrl, runtimeToken)
  logStartup(`runtime health probe finished ${runtimeUrl}`)
  return { url: runtimeUrl, token: runtimeToken, defaultWorkspace }
}

function stopRuntime() {
  if (runtimeProcess && !runtimeProcess.killed) {
    runtimeProcess.kill()
    runtimeProcess = null
  }
  runtimeLog?.end()
  runtimeLog = null
}

function setupAutoUpdater(win) {
  if (!isPackagedApp() || updateCheckStarted) return
  updateCheckStarted = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => logStartup('updater checking-for-update'))
  autoUpdater.on('update-not-available', (info) => logStartup(`updater update-not-available version=${info?.version ?? ''}`))
  autoUpdater.on('download-progress', (progress) => {
    const percent = Number(progress?.percent ?? 0).toFixed(1)
    logStartup(`updater download-progress ${percent}%`)
  })
  autoUpdater.on('error', (error) => logStartup('updater error', error))
  autoUpdater.on('update-available', async (info) => {
    logStartup(`updater update-available version=${info?.version ?? ''}`)
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['下载更新', '稍后再说'],
      defaultId: 0,
      cancelId: 1,
      title: '发现新版本',
      message: `发现墨渊新版本 ${info?.version ?? ''}`,
      detail: '可以先在后台下载，下载完成后会提示重启安装。',
    })
    if (result.response === 0) {
      autoUpdater.downloadUpdate().catch((error) => logStartup('updater download failed', error))
    }
  })
  autoUpdater.on('update-downloaded', async (info) => {
    logStartup(`updater update-downloaded version=${info?.version ?? ''}`)
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['重启安装', '下次启动安装'],
      defaultId: 0,
      cancelId: 1,
      title: '更新已下载',
      message: `墨渊 ${info?.version ?? ''} 已下载完成`,
      detail: '重启后会自动完成安装。',
    })
    if (result.response === 0) {
      autoUpdater.quitAndInstall(false, true)
    }
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => logStartup('updater check failed', error))
  }, 5000)
}

async function createWindow() {
  logStartup('createWindow begin')
  const runtime = await startRuntime()
  logStartup(`createWindow runtime url=${runtime.url}`)
  const iconPath = getIconPath()
  if (iconPath && app.dock) app.dock.setIcon(iconPath)
  const isMac = process.platform === 'darwin'
  if (!isMac) Menu.setApplicationMenu(null)
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: '墨渊',
    backgroundColor: '#f7f7f5',
    autoHideMenuBar: !isMac,
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 18, y: 18 },
        }
      : {}),
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
    },
  })

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    logStartup(`renderer console level=${level} ${sourceId || ''}:${line || 0} ${message}`)
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    logStartup(`renderer failed-load code=${code} description=${description} url=${url}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logStartup(`renderer gone reason=${details.reason} exitCode=${details.exitCode}`)
  })
  win.webContents.on('did-finish-load', () => {
    logStartup(`renderer loaded url=${win.webContents.getURL()}`)
    setupAutoUpdater(win)
  })

  if (isPackagedApp()) {
    win.loadFile(path.join(__dirname, '../dist/index.html'), {
      query: {
        enterpriseApiBase,
        defaultWorkspace: runtime.defaultWorkspace,
        appVersion: app.getVersion(),
        platform: process.platform,
        runtimeUrl: runtime.url,
        runtimeToken: runtime.token,
      },
    })
    logStartup('loadFile requested')
  } else {
    const url = appendLaunchParams(devUrl, {
      enterpriseApiBase,
      defaultWorkspace: runtime.defaultWorkspace,
      appVersion: app.getVersion(),
      platform: process.platform,
      runtimeUrl: runtime.url,
      runtimeToken: runtime.token,
    })
    win.loadURL(url)
    logStartup(`loadURL requested ${url}`)
  }
}

logStartup(`boot defaultApp=${Boolean(process.defaultApp)} isPackaged=${app.isPackaged}`)

ipcMain.handle('moyuan:collect-diagnostics', () => collectDiagnosticsSnapshot())

app.whenReady().then(() => {
  logStartup('app ready')
  return createWindow()
}).catch((error) => {
  logStartup('createWindow failed', error)
})

app.on('before-quit', stopRuntime)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
