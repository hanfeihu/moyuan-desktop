// Pure storage + crypto helpers: S3/MinIO signing & upload, data-URL parsing,
// content-type extension mapping. Depend only on args + process.env, no module state.
import { createHash, createHmac } from 'node:crypto'

export function hmac(key: Buffer | string, data: string) {
  return createHmac('sha256', key).update(data).digest()
}

export function sha256Hex(data: Buffer | string) {
  return createHash('sha256').update(data).digest('hex')
}

export function md5Hex(data: string) {
  return createHash('md5').update(data).digest('hex')
}

export function minioConfig() {
  const endpoint = process.env.MINIO_ENDPOINT?.replace(/\/$/, '')
  const accessKey = process.env.MINIO_ACCESS_KEY ?? process.env.MINIO_ROOT_USER
  const secretKey = process.env.MINIO_SECRET_KEY ?? process.env.MINIO_ROOT_PASSWORD
  const bucket = process.env.MINIO_BUCKET ?? 'worldcup-materials'
  if (!endpoint || !accessKey || !secretKey || !bucket) return undefined
  return {
    accessKey,
    bucket,
    endpoint,
    publicBaseUrl: (process.env.MINIO_PUBLIC_BASE_URL ?? `${endpoint}/${bucket}`).replace(/\/$/, ''),
    region: process.env.MINIO_REGION ?? 'us-east-1',
    secretKey,
  }
}

export async function uploadToMinio(objectKey: string, bytes: Buffer, contentType: string) {
  const config = minioConfig()
  if (!config) return undefined

  const target = new URL(`${config.endpoint}/${config.bucket}/${objectKey}`)
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(bytes)
  const headers = {
    'content-type': contentType,
    host: target.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key as keyof typeof headers]}\n`)
    .join('')
  const canonicalRequest = ['PUT', target.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretKey}`, dateStamp), config.region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const response = await fetch(target, {
    body: bytes as unknown as BodyInit,
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    method: 'PUT',
  })
  if (!response.ok) throw new Error(`MinIO 归档失败：${response.status}`)
  return `${config.publicBaseUrl}/${objectKey}`
}

export function extensionForContentType(contentType: string, fileName?: string) {
  const existing = fileName?.match(/\.([a-z0-9]{1,8})$/i)?.[1]
  if (existing) return existing.toLowerCase()
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg'
  if (contentType.includes('webp')) return 'webp'
  if (contentType.includes('mp4')) return 'mp4'
  if (contentType.includes('quicktime')) return 'mov'
  if (contentType.includes('mpeg')) return 'mp3'
  if (contentType.includes('wav')) return 'wav'
  return 'bin'
}

export function parseDataUrl(dataUrl: string) {
  const matched = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (!matched) throw new Error('素材不是有效的 data URL')
  const contentType = matched[1] || 'application/octet-stream'
  const isBase64 = Boolean(matched[2])
  const payload = matched[3] ?? ''
  const bytes = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload))
  if (!bytes.length) throw new Error('素材内容为空')
  return { bytes, contentType }
}
