/**
 * Image magic-byte sniffing for upload validation.
 *
 * SECURITY (audit P1-SEC-2): client-supplied `file.type` and file extension
 * are trivially spoofable. Sniffing magic bytes lets us:
 *   1. Reject non-image uploads even when the client claims image/jpeg
 *   2. Compute the canonical extension from byte content (not from filename)
 *   3. Override storage Content-Type with the sniffed value to prevent
 *      attacker-controlled MIME confusion (HTML/SVG hosted on our origin)
 *
 * Why not the `file-type` package: this implementation is intentionally
 * dependency-free and Edge-runtime safe. Add the npm package later if we
 * start accepting more exotic formats (HEIC, AVIF beyond `ftypavif`, etc.).
 */

export type SniffedImageKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'avif' | 'unknown'

export interface SniffResult {
  kind: SniffedImageKind
  mime: string
  extension: string
}

const UNKNOWN: SniffResult = { kind: 'unknown', mime: 'application/octet-stream', extension: 'bin' }

/**
 * Inspect the first ~32 bytes of a file buffer and return the detected
 * image kind. Returns 'unknown' for any unrecognized signature.
 */
export function sniffImage(bytes: Uint8Array): SniffResult {
  if (bytes.length < 12) return UNKNOWN

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'jpeg', mime: 'image/jpeg', extension: 'jpg' }
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { kind: 'png', mime: 'image/png', extension: 'png' }
  }

  // GIF: "GIF87a" or "GIF89a"
  if (
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return { kind: 'gif', mime: 'image/gif', extension: 'gif' }
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { kind: 'webp', mime: 'image/webp', extension: 'webp' }
  }

  // AVIF: ISOBMFF box "ftyp" with brand "avif"
  // Layout: [u32 box_size][b'f't'y'p'][b'a'v'i'f'...]
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 &&
    bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && bytes[11] === 0x66
  ) {
    return { kind: 'avif', mime: 'image/avif', extension: 'avif' }
  }

  return UNKNOWN
}

/**
 * Convenience: read enough of a Web File to sniff its image kind.
 * Returns null if the file fails to sniff as one of the allowed kinds.
 */
export async function sniffImageFile(
  file: File,
  allowed: ReadonlyArray<SniffedImageKind>,
): Promise<SniffResult | null> {
  // Only need the first 32 bytes; reading more is wasted I/O.
  const head = file.slice(0, 32)
  const buf = new Uint8Array(await head.arrayBuffer())
  const result = sniffImage(buf)
  if (result.kind === 'unknown' || !allowed.includes(result.kind)) return null
  return result
}
