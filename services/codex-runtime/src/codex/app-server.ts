import { createServer } from 'node:net'

type WebSocketInstance = {
  close: () => void
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onopen: (() => void) | null
  send: (data: string) => void
}

type WebSocketConstructor = new (url: string) => WebSocketInstance

type PendingRequest = {
  reject: (error: Error) => void
  resolve: (value: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export function findOpenPort(start = 49200) {
  return new Promise<number>((resolve, reject) => {
    let port = start + Math.floor(Math.random() * 200)

    const tryPort = () => {
      if (port > start + 500) {
        reject(new Error('没有可用的本地 app-server 端口'))
        return
      }

      const server = createServer()
      server.once('error', () => {
        port += 1
        tryPort()
      })
      server.once('listening', () => {
        server.close(() => resolve(port))
      })
      server.listen(port, '127.0.0.1')
    }

    tryPort()
  })
}

export async function connectAppServer(url: string, onNotification: (message: Record<string, unknown>) => void) {
  const WebSocketCtor = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket
  if (!WebSocketCtor) throw new Error('当前 Node 运行时不支持 WebSocket')

  let requestId = 1
  const pending = new Map<number, PendingRequest>()
  const openSocket = () =>
    new Promise<WebSocketInstance>((resolve, reject) => {
      const ws = new WebSocketCtor(url)
      let settled = false
      const settle = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback()
      }
      const timer = setTimeout(() => {
        try {
          ws.close()
        } catch {
          // Ignore close errors while retrying startup.
        }
        settle(() => reject(new Error('Codex app-server 连接超时')))
      }, 1200)

      ws.onopen = () => settle(() => resolve(ws))
      ws.onerror = () => settle(() => reject(new Error('Codex app-server 连接失败')))
      ws.onclose = () => settle(() => reject(new Error('Codex app-server 已断开')))
    })

  let socket: WebSocketInstance | undefined
  let lastConnectError: unknown
  const connectDeadline = Date.now() + 10000
  while (!socket && Date.now() < connectDeadline) {
    try {
      socket = await openSocket()
    } catch (error) {
      lastConnectError = error
      await sleep(160)
    }
  }

  if (!socket) {
    throw lastConnectError instanceof Error ? lastConnectError : new Error('Codex app-server 连接失败')
  }

  socket.onmessage = (event) => {
    const raw = typeof event.data === 'string' ? event.data : String(event.data)
    const message = JSON.parse(raw) as Record<string, unknown>
    const id = typeof message.id === 'number' ? message.id : undefined

    if (id !== undefined) {
      const waiter = pending.get(id)
      if (!waiter) return
      pending.delete(id)
      clearTimeout(waiter.timer)
      const error = message.error as { message?: string } | undefined
      if (error) {
        waiter.reject(new Error(error.message ?? 'Codex app-server 请求失败'))
      } else {
        waiter.resolve(message.result)
      }
      return
    }

    onNotification(message)
  }

  socket.onclose = () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Codex app-server 已断开'))
    }
    pending.clear()
  }

  return {
    close() {
      socket.close()
    },
    request(method: string, params: unknown, timeoutMs = 45000) {
      const id = requestId
      requestId += 1
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Codex app-server ${method} 请求超时`))
        }, timeoutMs)
        timer.unref()
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
  }
}

export function appServerThreadId(result: unknown) {
  const thread = result && typeof result === 'object' ? (result as { thread?: unknown }).thread : undefined
  if (!thread || typeof thread !== 'object') return undefined
  const id = (thread as { id?: unknown; threadId?: unknown }).id ?? (thread as { id?: unknown; threadId?: unknown }).threadId
  return typeof id === 'string' ? id : undefined
}

export function appServerTurnId(result: unknown) {
  const turn = result && typeof result === 'object' ? (result as { turn?: unknown }).turn : undefined
  if (!turn || typeof turn !== 'object') return undefined
  const id = (turn as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

export function appServerSandboxPolicy(workspace: string) {
  return {
    type: 'workspaceWrite',
    writableRoots: [workspace],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
