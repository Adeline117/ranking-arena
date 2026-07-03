import { sniffImage } from '../image-magic-bytes'

// 造带指定 signature 的字节数组（补足到 ≥12 字节）
function withSig(sig: number[]): Uint8Array {
  const arr = new Uint8Array(32)
  sig.forEach((b, i) => (arr[i] = b))
  return arr
}

describe('sniffImage — 各格式魔术字节', () => {
  it('JPEG (FF D8 FF)', () => {
    const r = sniffImage(withSig([0xff, 0xd8, 0xff, 0xe0]))
    expect(r.kind).toBe('jpeg')
    expect(r.mime).toBe('image/jpeg')
    expect(r.extension).toBe('jpg')
  })

  it('PNG (89 50 4E 47 0D 0A 1A 0A)', () => {
    const r = sniffImage(withSig([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(r.kind).toBe('png')
  })

  it('GIF87a 和 GIF89a', () => {
    expect(sniffImage(withSig([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])).kind).toBe('gif')
    expect(sniffImage(withSig([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])).kind).toBe('gif')
  })

  it('WebP (RIFF....WEBP)', () => {
    const r = sniffImage(withSig([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))
    expect(r.kind).toBe('webp')
  })

  it('AVIF (ftyp avif)', () => {
    const r = sniffImage(withSig([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))
    expect(r.kind).toBe('avif')
  })
})

describe('sniffImage — 安全：拒绝伪造/非图片', () => {
  it('<12 字节 → unknown（防截断绕过）', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff])).kind).toBe('unknown')
  })

  it('伪装成图片的 HTML/脚本内容 → unknown', () => {
    // "<html>" 开头的文件即使声称是 image/jpeg，magic byte 不符 → 拒绝
    const html = new TextEncoder().encode('<html><script>evil</script>')
    expect(sniffImage(html).kind).toBe('unknown')
  })

  it('SVG（文本 XML）→ unknown（SVG 可含脚本，不在允许集）', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')
    expect(sniffImage(svg).kind).toBe('unknown')
  })

  it('全零字节 → unknown', () => {
    expect(sniffImage(new Uint8Array(32)).kind).toBe('unknown')
    expect(sniffImage(new Uint8Array(32)).mime).toBe('application/octet-stream')
  })

  it('JPEG 前缀但第 3 字节错 → unknown（signature 必须完整）', () => {
    expect(sniffImage(withSig([0xff, 0xd8, 0x00, 0xe0])).kind).toBe('unknown')
  })
})
