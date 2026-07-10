/**
 * Grapheme-safe truncation (UI 走查 2026-07-10).
 *
 * `str.slice(0, n)` 按 UTF-16 code unit 截断,切碎 emoji 代理对/ZWJ 组合 →
 * 预览尾部渲染 U+FFFD「�」(Hot 榜 arena_bot 帖 ⚔️ 实锤)。用 Intl.Segmenter
 * 按 grapheme 截断;运行时无 Segmenter(老 Safari)则退化为 code-point 截断
 * (仍防代理对撕裂,只是 ZWJ 组合可能被拆成多个可见 emoji——不产生 �)。
 */

let segmenter: Intl.Segmenter | null | undefined

function getSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter
  try {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  } catch {
    segmenter = null
  }
  return segmenter
}

/** Truncate to at most `max` graphemes, appending `ellipsis` only when cut. */
export function truncateGraphemes(str: string, max: number, ellipsis = '...'): string {
  if (!str) return str
  const seg = getSegmenter()
  if (seg) {
    let count = 0
    let end = 0
    for (const s of seg.segment(str)) {
      count += 1
      if (count > max) return str.slice(0, end) + ellipsis
      end = s.index + s.segment.length
    }
    return str
  }
  // Fallback: code-point slice (never splits surrogate pairs).
  const points = [...str]
  return points.length > max ? points.slice(0, max).join('') + ellipsis : str
}
