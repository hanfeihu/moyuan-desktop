const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron')
const { autoUpdater } = require('electron-updater')
const { execFile, spawn } = require('node:child_process')
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
let runtimeInfo = null
let runtimeStatus = 'stopped'
let runtimeStartPromise = null
let runtimeStopPromise = null
let mainWindow = null
let windowCreatePromise = null
let applicationShutdownPromise = null
let allowImmediateQuit = false
let isShuttingDown = false
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
  const managedRuntimeAlive = isProcessAlive(runtimeProcess)
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
      alive: runtimeStatus === 'running' && (!isPackagedApp() || managedRuntimeAlive),
      managed: isPackagedApp(),
      pid: managedRuntimeAlive ? runtimeProcess?.pid : undefined,
      port: runtimeInfo?.port,
      status: runtimeStatus,
      url: runtimeInfo?.url,
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

function isProcessAlive(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null)
}

function waitForProcessExit(child, timeoutMs) {
  if (!isProcessAlive(child)) return Promise.resolve(true)

  return new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

function listDescendantPids(rootPid) {
  if (process.platform === 'win32') return Promise.resolve([])

  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid='], { timeout: 2000 }, (error, stdout) => {
      if (error) {
        logStartup(`runtime descendant scan failed rootPid=${rootPid}`, error)
        resolve([])
        return
      }

      const childrenByParent = new Map()
      for (const line of stdout.split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/)
        if (!match) continue
        const pid = Number(match[1])
        const parentPid = Number(match[2])
        const children = childrenByParent.get(parentPid) ?? []
        children.push(pid)
        childrenByParent.set(parentPid, children)
      }

      const descendants = []
      const visit = (parentPid) => {
        for (const pid of childrenByParent.get(parentPid) ?? []) {
          visit(pid)
          descendants.push(pid)
        }
      }
      visit(rootPid)
      resolve(descendants)
    })
  })
}

function signalPosixProcess(pid, signal) {
  try {
    process.kill(-pid, signal)
    return
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // The process already exited.
    }
  }
}

async function forceStopProcessTree(child, knownDescendants = []) {
  const pid = child?.pid
  if (!pid) return

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('error', () => resolve())
      killer.once('exit', () => resolve())
    })
    return
  }

  const currentDescendants = await listDescendantPids(pid)
  const descendants = Array.from(new Set([...knownDescendants, ...currentDescendants]))
  for (const descendantPid of descendants) signalPosixProcess(descendantPid, 'SIGKILL')
  signalPosixProcess(pid, 'SIGKILL')
}

function stopWindowsProcessTree(pid, force = false) {
  return new Promise((resolve) => {
    const args = ['/pid', String(pid), '/T']
    if (force) args.push('/F')
    const killer = spawn('taskkill', args, {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.once('error', () => resolve())
    killer.once('exit', () => resolve())
  })
}

function closeRuntimeLog(logStream = runtimeLog) {
  if (!logStream) return Promise.resolve()
  if (runtimeLog === logStream) runtimeLog = null
  if (logStream.destroyed || logStream.writableEnded) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      logStream.destroy()
      finish()
    }, 1000)
    logStream.end(finish)
  })
}

async function stopManagedRuntimeProcess(child, logStream, reason) {
  if (!child) {
    await closeRuntimeLog(logStream)
    return
  }

  const pid = child.pid
  const descendants = pid ? await listDescendantPids(pid) : []
  if (isProcessAlive(child)) {
    logStartup(`runtime stopping pid=${pid ?? ''} reason=${reason}`)
    if (process.platform === 'win32' && pid) {
      await stopWindowsProcessTree(pid)
    } else {
      try {
        child.kill('SIGTERM')
      } catch (error) {
        logStartup(`runtime SIGTERM failed pid=${pid ?? ''}`, error)
      }
    }
  }

  const exitedGracefully = await waitForProcessExit(child, 5000)
  if (!exitedGracefully) {
    logStartup(`runtime graceful stop timed out pid=${pid ?? ''}; forcing process tree shutdown`)
    await forceStopProcessTree(child, descendants)
    await waitForProcessExit(child, 2500)
  } else if (process.platform !== 'win32') {
    for (const descendantPid of descendants) signalPosixProcess(descendantPid, 'SIGKILL')
  }

  await closeRuntimeLog(logStream)
  logStartup(`runtime stop finished pid=${pid ?? ''} alive=${isProcessAlive(child)}`)
}

function waitForRuntime(runtimeUrl, token, timeoutMs = 15000, shouldContinue = () => true) {
  const startedAt = Date.now()

  return new Promise((resolve) => {
    let settled = false
    const finish = (healthy) => {
      if (settled) return
      settled = true
      resolve(healthy)
    }
    const probe = () => {
      if (settled) return
      if (!shouldContinue()) {
        finish(false)
        return
      }
      const request = http.get(
        `${runtimeUrl}/health?token=${encodeURIComponent(token)}`,
        { timeout: 1200 },
        (response) => {
          response.resume()
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            finish(true)
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
      if (settled) return
      if (!shouldContinue()) {
        finish(false)
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        finish(false)
        return
      }
      setTimeout(probe, 280)
    }

    probe()
  })
}

async function startRuntime() {
  if (runtimeInfo && runtimeStatus === 'running' && (!isPackagedApp() || isProcessAlive(runtimeProcess))) {
    return runtimeInfo
  }
  if (runtimeStartPromise) return runtimeStartPromise
  if (runtimeStopPromise) await runtimeStopPromise
  if (isShuttingDown) throw new Error('Application is shutting down')

  runtimeStatus = 'starting'
  runtimeStartPromise = (async () => {
    logStartup(`startRuntime packaged=${isPackagedApp()} appPath=${app.getAppPath()}`)
    if (!isPackagedApp()) {
      const url = process.env.VITE_CODEX_RUNTIME_URL || 'http://127.0.0.1:4101'
      runtimeInfo = {
        url,
        port: Number(new URL(url).port || 4101),
        token: '',
        defaultWorkspace: process.env.VITE_DEFAULT_WORKSPACE || path.join(app.getPath('documents'), 'Moyuan Workspace'),
      }
      runtimeStatus = 'running'
      return runtimeInfo
    }

    const appRoot = getAppRoot()
    const runtimeEntry = path.join(appRoot, 'services/codex-runtime/dist/index.js')
    logStartup(`runtimeEntry ${runtimeEntry}`)
    const port = await findRuntimePort()
    if (isShuttingDown) throw new Error('Application is shutting down')
    const runtimeUrl = `http://${runtimeHost}:${port}`
    const userData = app.getPath('userData')
    const defaultWorkspace = path.join(app.getPath('documents'), 'Moyuan Workspace')
    const logDir = path.join(userData, 'logs')
    const runtimeEnv = loadRuntimeEnv(appRoot, userData)

    fs.mkdirSync(logDir, { recursive: true })
    fs.mkdirSync(defaultWorkspace, { recursive: true })
    const logStream = fs.createWriteStream(path.join(logDir, 'codex-runtime.log'), { flags: 'a' })
    runtimeLog = logStream
    logStream.on('error', (error) => logStartup('runtime log stream failed', error))
    logStream.write(`\n[${new Date().toISOString()}] starting runtime ${runtimeEntry}\n`)
    logStream.write(`[${new Date().toISOString()}] runtime config keys ${Object.keys(runtimeEnv).join(',') || 'none'}\n`)

    let spawnError = null
    const child = spawn(process.execPath, [runtimeEntry], {
      cwd: appRoot,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...runtimeEnv,
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CODEX_RUNTIME_HOST: runtimeHost,
        CODEX_RUNTIME_PORT: String(port),
        MOYUAN_DESKTOP_PID: String(process.pid),
        MOYUAN_NODE_HOST_PATH: process.execPath,
        MOYUAN_DEFAULT_WORKSPACE: defaultWorkspace,
        MOYUAN_RUNTIME_TOKEN: runtimeToken,
        MOYUAN_RUNTIME_HOME: path.join(userData, 'runtime'),
        MOYUAN_CODEX_HOME: path.join(userData, 'codex-home'),
      },
    })
    runtimeProcess = child
    runtimeInfo = { url: runtimeUrl, port, token: runtimeToken, defaultWorkspace }
    logStartup(`runtime spawned pid=${child.pid} url=${runtimeUrl}`)

    child.stdout?.pipe(logStream)
    child.stderr?.pipe(logStream)
    child.once('error', (error) => {
      spawnError = error
      logStartup(`runtime spawn failed entry=${runtimeEntry}`, error)
    })
    child.once('exit', (code, signal) => {
      logStream.write(`[${new Date().toISOString()}] runtime exited code=${code ?? ''} signal=${signal ?? ''}\n`)
      if (runtimeProcess === child) {
        runtimeProcess = null
        runtimeInfo = null
        if (runtimeStatus !== 'stopping') runtimeStatus = 'stopped'
      }
      void closeRuntimeLog(logStream)
    })

    if (isShuttingDown) {
      await stopManagedRuntimeProcess(child, logStream, 'shutdown-during-start')
      throw new Error('Application is shutting down')
    }

    const healthy = await waitForRuntime(runtimeUrl, runtimeToken, 15000, () => !isShuttingDown && !spawnError && isProcessAlive(child))
    if (!healthy || !isProcessAlive(child)) {
      await stopManagedRuntimeProcess(child, logStream, 'health-check-failed')
      throw spawnError ?? new Error(`Local Runtime failed to start at ${runtimeUrl}`)
    }
    if (isShuttingDown) {
      await stopManagedRuntimeProcess(child, logStream, 'shutdown-after-health-check')
      throw new Error('Application is shutting down')
    }
    runtimeStatus = 'running'
    logStartup(`runtime health check passed pid=${child.pid} url=${runtimeUrl}`)
    return runtimeInfo
  })()

  try {
    return await runtimeStartPromise
  } catch (error) {
    if (runtimeStatus !== 'stopping') runtimeStatus = 'stopped'
    runtimeInfo = null
    throw error
  } finally {
    runtimeStartPromise = null
  }
}

function stopRuntime(reason = 'application-quit') {
  if (runtimeStopPromise) return runtimeStopPromise

  runtimeStatus = 'stopping'
  runtimeStopPromise = (async () => {
    if (runtimeStartPromise) await runtimeStartPromise.catch(() => undefined)
    const child = runtimeProcess
    const logStream = runtimeLog
    await stopManagedRuntimeProcess(child, logStream, reason)
    if (runtimeProcess === child) runtimeProcess = null
    runtimeInfo = null
    runtimeStatus = 'stopped'
  })().finally(() => {
    runtimeStopPromise = null
  })
  return runtimeStopPromise
}

function showAppMessageBox(options) {
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, options)
  return dialog.showMessageBox(options)
}

function beginApplicationShutdown(action = 'quit') {
  if (applicationShutdownPromise) return applicationShutdownPromise

  isShuttingDown = true
  applicationShutdownPromise = (async () => {
    try {
      await stopRuntime(action === 'install-update' ? 'update-install' : 'application-quit')
    } catch (error) {
      logStartup('runtime shutdown failed', error)
    }

    allowImmediateQuit = true
    if (action === 'install-update') {
      logStartup('runtime stopped; starting update install')
      try {
        autoUpdater.quitAndInstall(false, true)
      } catch (error) {
        logStartup('update install restart failed; quitting normally', error)
        app.quit()
      }
      return
    }
    app.quit()
  })()
  return applicationShutdownPromise
}

function setupAutoUpdater() {
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
    const result = await showAppMessageBox({
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
    const result = await showAppMessageBox({
      type: 'info',
      buttons: ['重启安装', '下次启动安装'],
      defaultId: 0,
      cancelId: 1,
      title: '更新已下载',
      message: `墨渊 ${info?.version ?? ''} 已下载完成`,
      detail: '重启后会自动完成安装。',
    })
    if (result.response === 0) {
      void beginApplicationShutdown('install-update')
    }
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => logStartup('updater check failed', error))
  }, 5000)
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  return true
}

async function createWindowInternal() {
  logStartup('createWindow begin')
  const runtime = await startRuntime()
  if (isShuttingDown) return undefined
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
  mainWindow = win
  win.once('closed', () => {
    if (mainWindow === win) mainWindow = null
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
    setupAutoUpdater()
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
  return win
}

function createWindow() {
  if (focusMainWindow()) return Promise.resolve(mainWindow)
  if (windowCreatePromise) return windowCreatePromise
  if (isShuttingDown) return Promise.resolve(undefined)

  windowCreatePromise = createWindowInternal().finally(() => {
    windowCreatePromise = null
  })
  return windowCreatePromise
}

logStartup(`boot defaultApp=${Boolean(process.defaultApp)} isPackaged=${app.isPackaged}`)

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  logStartup('single instance lock denied; quitting secondary process')
  allowImmediateQuit = true
  app.quit()
} else {
  ipcMain.handle('moyuan:collect-diagnostics', () => collectDiagnosticsSnapshot())

  app.on('second-instance', () => {
    logStartup('secondary launch redirected to primary instance')
    if (app.isReady()) {
      if (!focusMainWindow()) void createWindow().catch((error) => logStartup('second-instance createWindow failed', error))
    }
  })

  app.whenReady().then(() => {
    logStartup('app ready')
    return createWindow()
  }).catch((error) => {
    logStartup('createWindow failed', error)
  })

  app.on('before-quit', (event) => {
    if (allowImmediateQuit) return
    event.preventDefault()
    void beginApplicationShutdown('quit')
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (!focusMainWindow()) void createWindow().catch((error) => logStartup('activate createWindow failed', error))
  })
}
