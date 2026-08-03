/**
 * Bounded video-container sniffing for uploads. Client MIME types and file
 * extensions are untrusted; only canonical container evidence is returned.
 */

export type SniffedVideoKind = 'mp4' | 'quicktime' | 'webm' | 'matroska' | 'avi'

export type SniffedVideo = Readonly<{
  kind: SniffedVideoKind
  mime: string
  extension: string
}>

const HEADER_LIMIT = 4_096
const MP4_MAJOR_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'iso7',
  'iso8',
  'iso9',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'M4V ',
  'M4VH',
  'M4VP',
  'MSNV',
  'F4V ',
])

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return (
    offset >= 0 &&
    offset + expected.length <= bytes.length &&
    expected.every((value, index) => bytes[offset + index] === value)
  )
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = ''
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index])
  }
  return value
}

function uint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  )
}

function uint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  )
}

type Vint = { length: number; value: number }

function readBoundedVint(bytes: Uint8Array, offset: number, maximum: number): Vint | null {
  const first = bytes[offset]
  if (first === undefined || first === 0) return null

  let marker = 0x80
  let length = 1
  while ((first & marker) === 0 && length < 8) {
    marker >>= 1
    length += 1
  }
  if (marker === 0 || offset + length > bytes.length) return null

  let value = first & (marker - 1)
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[offset + index]
    if (!Number.isSafeInteger(value) || value > maximum) return null
  }

  const unknownLengthValue = 2 ** (7 * length) - 1
  if (value === unknownLengthValue || value > maximum) return null
  return { length, value }
}

function sniffIsoBaseMedia(bytes: Uint8Array, fileSize: number): SniffedVideo | null {
  if (!hasBytes(bytes, 4, [0x66, 0x74, 0x79, 0x70]) || bytes.length < 16) return null

  const boxSize = uint32BigEndian(bytes, 0)
  if (
    boxSize < 16 ||
    boxSize > HEADER_LIMIT ||
    boxSize > bytes.length ||
    boxSize > fileSize ||
    boxSize % 4 !== 0
  ) {
    return null
  }

  const majorBrand = ascii(bytes, 8, 4)
  if (majorBrand === 'qt  ') {
    return { kind: 'quicktime', mime: 'video/quicktime', extension: 'mov' }
  }
  if (!MP4_MAJOR_BRANDS.has(majorBrand)) return null
  return { kind: 'mp4', mime: 'video/mp4', extension: 'mp4' }
}

function sniffEbml(bytes: Uint8Array, fileSize: number): SniffedVideo | null {
  if (!hasBytes(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) return null

  const headerSize = readBoundedVint(bytes, 4, HEADER_LIMIT)
  if (!headerSize) return null
  const headerStart = 4 + headerSize.length
  const headerEnd = headerStart + headerSize.value
  if (headerEnd > bytes.length || headerEnd > fileSize) return null

  let cursor = headerStart
  while (cursor < headerEnd) {
    const idFirst = bytes[cursor]
    if (idFirst === undefined || idFirst === 0) return null
    let idMarker = 0x80
    let idLength = 1
    while ((idFirst & idMarker) === 0 && idLength < 4) {
      idMarker >>= 1
      idLength += 1
    }
    if ((idFirst & idMarker) === 0 || cursor + idLength > headerEnd) return null

    const size = readBoundedVint(bytes, cursor + idLength, HEADER_LIMIT)
    if (!size) return null
    const payloadStart = cursor + idLength + size.length
    const payloadEnd = payloadStart + size.value
    if (payloadEnd > headerEnd) return null

    if (idLength === 2 && bytes[cursor] === 0x42 && bytes[cursor + 1] === 0x82) {
      const documentType = ascii(bytes, payloadStart, size.value)
      if (documentType === 'webm') {
        return { kind: 'webm', mime: 'video/webm', extension: 'webm' }
      }
      if (documentType === 'matroska') {
        return { kind: 'matroska', mime: 'video/x-matroska', extension: 'mkv' }
      }
      return null
    }

    cursor = payloadEnd
  }
  return null
}

function sniffAvi(bytes: Uint8Array, fileSize: number): SniffedVideo | null {
  if (
    !hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) ||
    !hasBytes(bytes, 8, [0x41, 0x56, 0x49, 0x20])
  ) {
    return null
  }

  const riffPayloadSize = uint32LittleEndian(bytes, 4)
  if (riffPayloadSize < 4 || riffPayloadSize + 8 > fileSize) return null
  return { kind: 'avi', mime: 'video/x-msvideo', extension: 'avi' }
}

export function sniffVideo(bytes: Uint8Array, fileSize: number): SniffedVideo | null {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || bytes.length === 0) return null
  return (
    sniffIsoBaseMedia(bytes, fileSize) ?? sniffEbml(bytes, fileSize) ?? sniffAvi(bytes, fileSize)
  )
}

export async function sniffVideoFile(file: File): Promise<SniffedVideo | null> {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return null
  const header = new Uint8Array(await file.slice(0, HEADER_LIMIT).arrayBuffer())
  return sniffVideo(header, file.size)
}
