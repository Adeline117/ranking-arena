/**
 * Cloudflare R2 Storage Client
 *
 * R2 is S3-compatible, so we use the AWS SDK.
 * Configured via R2_* environment variables.
 */
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || ''
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || ''
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || ''
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'ranking-arena-library'
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '' // e.g. https://cdn.arenafi.org

export function isR2Configured(): boolean {
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY)
}

// ---------------------------------------------------------------------------
// Client (lazy singleton)
// ---------------------------------------------------------------------------

let _client: S3Client | null = null

function getClient(): S3Client {
  if (!isR2Configured()) {
    throw new Error(
      'R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.'
    )
  }
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  }
  return _client
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the public URL for a given R2 key */
export function getPublicUrl(key: string): string {
  if (R2_PUBLIC_URL) {
    return `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`
  }
  // Fallback: R2 dev URL (not publicly accessible without custom domain)
  return `https://${R2_BUCKET_NAME}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`
}

/** Generate a storage key for a library item's PDF */
export function libraryPdfKey(itemId: string, filename?: string): string {
  const safe = (filename || 'document.pdf')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100)
  return `library/${itemId}/${safe}`
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function uploadFile(
  key: string,
  body: Buffer | Uint8Array | ReadableStream,
  contentType: string = 'application/pdf'
): Promise<{ key: string; url: string }> {
  const client = getClient()
  await client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: body as any,
      ContentType: contentType,
    })
  )
  return { key, url: getPublicUrl(key) }
}

export async function deleteFile(key: string): Promise<void> {
  const client = getClient()
  await client.send(
    new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    })
  )
}

export async function fileExists(key: string): Promise<boolean> {
  try {
    const client = getClient()
    await client.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    )
    return true
  } catch {
    return false
  }
}

export async function getFile(key: string): Promise<ReadableStream | null> {
  try {
    const client = getClient()
    const res = await client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    )
    return (res.Body as any) ?? null
  } catch {
    return null
  }
}

export async function listFiles(prefix: string, maxKeys = 1000) {
  const client = getClient()
  const res = await client.send(
    new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME,
      Prefix: prefix,
      MaxKeys: maxKeys,
    })
  )
  return res.Contents || []
}
