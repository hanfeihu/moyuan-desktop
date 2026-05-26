const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')

const devUrl = process.env.MOYUAN_DESKTOP_URL || 'http://127.0.0.1:5170'
const runtimeHost = '127.0.0.1'
const defaultRuntimePort = Number(process.env.CODEX_RUNTIME_PORT || 4101)
const runtimeToken = crypto.randomBytes(32).toString('hex')
let runtimeProcess = null
let runtimeLog = null
const startupLogPath = path.join(app.getPath('temp'), 'moyuan-desktop-startup.log')

app.setName('Moyuan Desktop')
app.setPath('userData', path.join(app.getPath('appData'), 'Moyuan Desktop'))

function logStartup(message, error) {
  const suffix = error ? ` ${error.stack || error.message || String(error)}` : ''
  fs.appendFileSync(startupLogPath, `[${new Date().toISOString()}] ${message}${suffix}\n`)
}

function isPackagedApp() {
  return app.isPackaged || !process.defaultApp
}

function getAppRoot() {
  return isPackagedApp() ? app.getAppPath() : path.join(__dirname, '../../..')
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
  if (!isPackagedApp()) return { url: process.env.VITE_CODEX_RUNTIME_URL || 'http://127.0.0.1:4101', token: '' }

  const appRoot = getAppRoot()
  const runtimeEntry = path.join(appRoot, 'services/codex-runtime/dist/index.js')
  logStartup(`runtimeEntry ${runtimeEntry}`)
  const port = await findRuntimePort()
  const runtimeUrl = `http://${runtimeHost}:${port}`
  const userData = app.getPath('userData')
  const logDir = path.join(userData, 'logs')

  fs.mkdirSync(logDir, { recursive: true })
  runtimeLog = fs.createWriteStream(path.join(logDir, 'codex-runtime.log'), { flags: 'a' })
  runtimeLog.write(`\n[${new Date().toISOString()}] starting runtime ${runtimeEntry}\n`)

  runtimeProcess = spawn(process.execPath, [runtimeEntry], {
    cwd: appRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CODEX_RUNTIME_HOST: runtimeHost,
      CODEX_RUNTIME_PORT: String(port),
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
  return { url: runtimeUrl, token: runtimeToken }
}

function stopRuntime() {
  if (runtimeProcess && !runtimeProcess.killed) {
    runtimeProcess.kill()
    runtimeProcess = null
  }
  runtimeLog?.end()
  runtimeLog = null
}

async function createWindow() {
  logStartup('createWindow begin')
  const runtime = await startRuntime()
  logStartup(`createWindow runtime url=${runtime.url}`)
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: '墨渊 Desktop',
    backgroundColor: '#f7f7f5',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (isPackagedApp()) {
    win.loadFile(path.join(__dirname, '../dist/index.html'), {
      query: {
        runtimeUrl: runtime.url,
        runtimeToken: runtime.token,
      },
    })
    logStartup('loadFile requested')
  } else {
    win.loadURL(devUrl)
    logStartup(`loadURL requested ${devUrl}`)
  }
}

logStartup(`boot defaultApp=${Boolean(process.defaultApp)} isPackaged=${app.isPackaged}`)

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
