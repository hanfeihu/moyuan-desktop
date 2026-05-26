const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const devUrl = process.env.MOYUAN_DESKTOP_URL || 'http://127.0.0.1:5171'

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: '墨渊 Desktop',
    backgroundColor: '#0b0f14',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.env.NODE_ENV === 'production') {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  } else {
    win.loadURL(devUrl)
  }
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
