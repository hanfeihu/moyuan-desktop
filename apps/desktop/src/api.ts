import { enterpriseApiBase, runtimeToken, runtimeUrl } from './config'

export function enterpriseEndpoint(pathname: string) {
  return `${enterpriseApiBase.replace(/\/$/, '')}/${pathname.replace(/^\//, '')}`
}

export function enterpriseFetch(pathname: string, token = '', init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (init.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(enterpriseEndpoint(pathname), { ...init, headers })
}

export function runtimeEndpoint(pathname: string) {
  const url = new URL(pathname, runtimeUrl)
  if (runtimeToken) url.searchParams.set('token', runtimeToken)
  return url.toString()
}

export function runtimeFetch(pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (runtimeToken) headers.set('x-moyuan-runtime-token', runtimeToken)
  return fetch(runtimeEndpoint(pathname), { ...init, headers })
}
