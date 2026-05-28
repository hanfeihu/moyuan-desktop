export type AuthMode = 'login' | 'register'
export type AuthState = 'checking' | 'anonymous' | 'signed-in'
export type AuthMessageTone = 'error' | 'info' | 'success'

export type AuthValues = {
  code: string
  email: string
  name: string
}
