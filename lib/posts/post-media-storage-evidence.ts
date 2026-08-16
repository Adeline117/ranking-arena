export type PostMediaStorageEvidence = Readonly<{
  objectName: string
  mimeType: string
  sizeBytes: number
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate the exact FileObject returned by storage-js list(). The route has
 * already fixed the bucket and directory; this binds the remaining basename,
 * durable object id, byte length, and MIME type before the registry may move
 * from reserved to uploaded.
 */
export function hasExactPostMediaStorageEvidence(
  listing: unknown,
  evidence: PostMediaStorageEvidence
): boolean {
  if (
    !Array.isArray(listing) ||
    !Number.isSafeInteger(evidence.sizeBytes) ||
    evidence.sizeBytes <= 0
  ) {
    return false
  }

  const basename = evidence.objectName.slice(evidence.objectName.lastIndexOf('/') + 1)
  const exactEntries = listing.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.name === basename
  )
  if (exactEntries.length !== 1) return false

  const entry = exactEntries[0]
  if (typeof entry.id !== 'string' || entry.id.trim() === '') return false
  if (!isRecord(entry.metadata)) return false

  const metadata = entry.metadata
  if (metadata.size !== evidence.sizeBytes || metadata.mimetype !== evidence.mimeType) return false

  // Storage currently returns contentLength as well. Treat it as additional
  // evidence when present, but retain compatibility with older managed API
  // responses where this redundant field was omitted.
  if (
    Object.prototype.hasOwnProperty.call(metadata, 'contentLength') &&
    metadata.contentLength !== evidence.sizeBytes
  ) {
    return false
  }

  return true
}
