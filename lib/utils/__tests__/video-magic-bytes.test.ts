import { sniffVideo } from '../video-magic-bytes'

function isoFile(brand: string, declaredSize = 24, actualSize = 24): Uint8Array {
  const bytes = new Uint8Array(actualSize)
  bytes.set([
    (declaredSize >>> 24) & 0xff,
    (declaredSize >>> 16) & 0xff,
    (declaredSize >>> 8) & 0xff,
    declaredSize & 0xff,
  ])
  bytes.set(new TextEncoder().encode('ftyp'), 4)
  bytes.set(new TextEncoder().encode(brand), 8)
  if (actualSize >= 20) bytes.set(new TextEncoder().encode('mp42'), 16)
  return bytes
}

function ebmlFile(documentType: string): Uint8Array {
  const documentTypeBytes = new TextEncoder().encode(documentType)
  const element = new Uint8Array(3 + documentTypeBytes.length)
  element.set([0x42, 0x82, 0x80 | documentTypeBytes.length])
  element.set(documentTypeBytes, 3)
  const bytes = new Uint8Array(5 + element.length)
  bytes.set([0x1a, 0x45, 0xdf, 0xa3, 0x80 | element.length])
  bytes.set(element, 5)
  return bytes
}

function riffFile(kind: string, declaredPayloadSize = 16, actualSize = 24): Uint8Array {
  const bytes = new Uint8Array(actualSize)
  bytes.set(new TextEncoder().encode('RIFF'))
  bytes.set(
    [
      declaredPayloadSize & 0xff,
      (declaredPayloadSize >>> 8) & 0xff,
      (declaredPayloadSize >>> 16) & 0xff,
      (declaredPayloadSize >>> 24) & 0xff,
    ],
    4
  )
  bytes.set(new TextEncoder().encode(kind), 8)
  return bytes
}

describe('sniffVideo', () => {
  it.each([
    ['isom', 'mp4', 'video/mp4', 'mp4'],
    ['mp42', 'mp4', 'video/mp4', 'mp4'],
    ['qt  ', 'quicktime', 'video/quicktime', 'mov'],
  ])('recognizes a bounded %s ftyp container', (brand, kind, mime, extension) => {
    expect(sniffVideo(isoFile(brand), 24)).toEqual({ kind, mime, extension })
  })

  it('rejects image-only and unknown ftyp brands', () => {
    expect(sniffVideo(isoFile('avif'), 24)).toBeNull()
    expect(sniffVideo(isoFile('evil'), 24)).toBeNull()
  })

  it('rejects a truncated or impossible ftyp box', () => {
    expect(sniffVideo(isoFile('isom', 24, 16), 16)).toBeNull()
    expect(sniffVideo(isoFile('isom', 28, 28), 24)).toBeNull()
  })

  it.each([
    ['webm', 'webm', 'video/webm', 'webm'],
    ['matroska', 'matroska', 'video/x-matroska', 'mkv'],
  ])('requires the EBML DocType %s', (documentType, kind, mime, extension) => {
    const bytes = ebmlFile(documentType)
    expect(sniffVideo(bytes, bytes.length)).toEqual({ kind, mime, extension })
  })

  it('does not accept a bare EBML prefix or a fake DocType outside the header', () => {
    expect(sniffVideo(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80]), 5)).toBeNull()

    const bytes = new Uint8Array(20)
    bytes.set([0x1a, 0x45, 0xdf, 0xa3, 0x80])
    bytes.set(new TextEncoder().encode('webm'), 12)
    expect(sniffVideo(bytes, bytes.length)).toBeNull()
  })

  it('requires both RIFF and the AVI form type', () => {
    expect(sniffVideo(riffFile('AVI '), 24)).toEqual({
      kind: 'avi',
      mime: 'video/x-msvideo',
      extension: 'avi',
    })
    expect(sniffVideo(riffFile('WAVE'), 24)).toBeNull()
  })

  it('rejects a RIFF payload length beyond the real file', () => {
    expect(sniffVideo(riffFile('AVI ', 100), 24)).toBeNull()
  })

  it('rejects empty, truncated, and text payloads', () => {
    expect(sniffVideo(new Uint8Array(), 0)).toBeNull()
    expect(sniffVideo(new Uint8Array([0x52, 0x49, 0x46, 0x46]), 4)).toBeNull()
    expect(sniffVideo(new TextEncoder().encode('<script>alert(1)</script>'), 25)).toBeNull()
  })
})
