import { useEffect, useRef, useState } from 'react'
import type { AccountUser } from '@eaw/shared'
import { enterpriseFetch } from '../../api'
import { authTokenStorageKey } from '../../config'
import { errorLogDetails, logClientEvent } from '../../logger'
import type { AuthMessageTone, AuthMode, AuthState, AuthValues } from './types'

const AUTH_RESTORE_TIMEOUT_MS = 10000
const AUTH_REFRESH_TIMEOUT_MS = 8000

export async function loadSignedInUser(token: string, options: { timeoutMs?: number } = {}) {
  const response = await enterpriseFetch('/me', token, { timeoutMs: options.timeoutMs })
  const payload = (await response.json()) as { data?: { user: AccountUser }; error?: string }
  if (!response.ok || !payload.data?.user) throw new Error(payload.error ?? '登录状态已失效')
  return payload.data.user
}

export function useAuth() {
  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [authToken, setAuthToken] = useState(() => window.localStorage.getItem(authTokenStorageKey) ?? '')
  const [authUser, setAuthUser] = useState<AccountUser | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [authMessageTone, setAuthMessageTone] = useState<AuthMessageTone>('info')
  const refreshUserPromiseRef = useRef<Promise<AccountUser | null> | null>(null)

  useEffect(() => {
    if (!authToken) {
      logClientEvent('auth.restore.skip_no_token', undefined, 'debug')
      setAuthState('anonymous')
      return
    }

    logClientEvent('auth.restore.start')
    loadSignedInUser(authToken, { timeoutMs: AUTH_RESTORE_TIMEOUT_MS })
      .then((user) => {
        logClientEvent('auth.restore.success', { userId: user.id, status: user.status })
        setAuthUser(user)
        setAuthState('signed-in')
      })
      .catch((error) => {
        logClientEvent('auth.restore.failed', errorLogDetails(error), 'warn')
        window.localStorage.removeItem(authTokenStorageKey)
        setAuthToken('')
        setAuthUser(null)
        setAuthState('anonymous')
      })
  }, [authToken])

  useEffect(() => {
    if (authState !== 'signed-in' || !authToken) return

    const timer = window.setInterval(() => {
      void refreshUser()
    }, 15000)
    return () => window.clearInterval(timer)
  }, [authState, authToken])

  async function refreshUser() {
    if (!authToken) return null
    if (refreshUserPromiseRef.current) return refreshUserPromiseRef.current

    const refreshPromise = loadSignedInUser(authToken, { timeoutMs: AUTH_REFRESH_TIMEOUT_MS })
      .then((user) => {
        logClientEvent('auth.refresh.success', { tokenUsed: user.tokenUsed, userId: user.id }, 'debug')
        setAuthUser(user)
        return user
      })
      .catch((error) => {
        logClientEvent('auth.refresh.failed', errorLogDetails(error), 'warn')
        return null
      })
      .finally(() => {
        refreshUserPromiseRef.current = null
      })

    refreshUserPromiseRef.current = refreshPromise
    return refreshPromise
  }

  async function requestAuthCode(email: string) {
    if (!email) return false
    logClientEvent('auth.code.request', { email })
    setAuthBusy(true)
    setAuthMessage('')
    setAuthMessageTone('info')
    try {
      const response = await enterpriseFetch('/auth/send-code', '', {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
      const payload = (await response.json()) as { data?: { sent: boolean }; error?: string }
      if (!response.ok || !payload.data?.sent) throw new Error(payload.error ?? '验证码发送失败')
      logClientEvent('auth.code.sent', { email })
      setAuthMessage('验证码已发送，请查看邮箱。')
      setAuthMessageTone('success')
      return true
    } catch (error) {
      logClientEvent('auth.code.failed', errorLogDetails(error, { email }), 'warn')
      setAuthMessage(error instanceof Error ? error.message : '验证码发送失败')
      setAuthMessageTone('error')
      return false
    } finally {
      setAuthBusy(false)
    }
  }

  async function submitAuth(values: AuthValues) {
    logClientEvent('auth.submit.start', { email: values.email.trim(), mode: authMode })
    setAuthBusy(true)
    setAuthMessage('')
    setAuthMessageTone('info')
    try {
      const response = await enterpriseFetch(`/auth/${authMode}`, '', {
        method: 'POST',
        body: JSON.stringify({
          code: values.code.trim(),
          email: values.email.trim(),
          name: values.name.trim(),
        }),
      })
      const payload = (await response.json()) as { data?: { token: string; user: AccountUser }; error?: string }
      if (!response.ok || !payload.data) throw new Error(payload.error ?? '登录失败')
      window.localStorage.setItem(authTokenStorageKey, payload.data.token)
      logClientEvent('auth.submit.success', { mode: authMode, userId: payload.data.user.id })
      setAuthToken(payload.data.token)
      setAuthUser(payload.data.user)
      setAuthState('signed-in')
      setAuthMessage('')
    } catch (error) {
      logClientEvent('auth.submit.failed', errorLogDetails(error, { mode: authMode }), 'warn')
      setAuthMessage(error instanceof Error ? error.message : '登录失败')
      setAuthMessageTone('error')
    } finally {
      setAuthBusy(false)
    }
  }

  function logout() {
    window.localStorage.removeItem(authTokenStorageKey)
    setAuthToken('')
    setAuthUser(null)
    setAuthState('anonymous')
  }

  return {
    authBusy,
    authMessage,
    authMessageTone,
    authMode,
    authState,
    authToken,
    authUser,
    logout,
    requestAuthCode,
    refreshUser,
    setAuthMode,
    setAuthUser,
    submitAuth,
  }
}
