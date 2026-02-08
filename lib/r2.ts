/**
 * Cloudflare R2 Storage Client (stub)
 *
 * R2 support is planned but @aws-sdk/client-s3 is not yet installed.
 * This stub allows the build to pass. Install the SDK and restore
 * the real implementation when R2 credentials are ready.
 */

export function isR2Configured(): boolean {
  return false
}

export async function uploadFile(
  _key: string,
  _body: Buffer | Uint8Array | string,
  _contentType?: string
): Promise<{ url: string }> {
  throw new Error('R2 storage is not configured. Install @aws-sdk/client-s3 first.')
}

export function libraryPdfKey(itemId: string, filename?: string): string {
  const name = filename || 'content.pdf'
  return `library/${itemId}/${name}`
}

export function getPublicUrl(key: string): string {
  return `https://cdn.arenafi.org/${key}`
}

export async function deleteFile(_key: string): Promise<void> {
  throw new Error('R2 storage is not configured.')
}

export async function fileExists(_key: string): Promise<boolean> {
  return false
}

export async function listFiles(_prefix: string): Promise<string[]> {
  return []
}
