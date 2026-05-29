import { enterpriseApiBase, runtimeToken, runtimeUrl } from './config'

type FetchOptions = RequestInit & {
  timeoutMs?: number
}

export function enterpriseEndpoint(pathname: string) {
  return `${enterpriseApiBase.replace(/\/$/, '')}/${pathname.replace(/^\//, '')}`
}

function fetchWithTimeout(url: string, init: FetchOptions = {}) {
  const { timeoutMs, ...requestInit } = init
  if (!timeoutMs || timeoutMs <= 0) return fetch(url, requestInit)

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  const signal = requestInit.signal
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  return fetch(url, { ...requestInit, signal: controller.signal }).finally(() => window.clearTimeout(timeout))
}

export function enterpriseFetch(pathname: string, token = '', init: FetchOptions = {}) {
  const headers = new Headers(init.headers)
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetchWithTimeout(enterpriseEndpoint(pathname), { ...init, headers })
}

export function runtimeEndpoint(pathname: string) {
  const url = new URL(pathname, runtimeUrl)
  if (runtimeToken) url.searchParams.set('token', runtimeToken)
  return url.toString()
}

export function runtimeFetch(pathname: string, init: FetchOptions = {}) {
  const headers = new Headers(init.headers)
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (runtimeToken) headers.set('x-moyuan-runtime-token', runtimeToken)
  return fetchWithTimeout(runtimeEndpoint(pathname), { ...init, headers })
}
