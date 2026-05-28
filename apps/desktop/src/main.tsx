import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/noto-sans-sc'
import { AppErrorBoundary, installGlobalErrorHandlers, renderFatalError } from './app/errors'
import { DesktopApp } from './app/DesktopApp'
import './styles.css'

installGlobalErrorHandlers()

const rootElement = document.getElementById('root')!
const windowWithRoot = window as typeof window & { __moyuanRoot?: ReactDOM.Root }
const root = windowWithRoot.__moyuanRoot ?? ReactDOM.createRoot(rootElement)
windowWithRoot.__moyuanRoot = root

try {
  root.render(
    <React.StrictMode>
      <AppErrorBoundary>
        <DesktopApp />
      </AppErrorBoundary>
    </React.StrictMode>,
  )
} catch (error) {
  renderFatalError(error)
}
