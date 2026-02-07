export interface Sticker {
  id: string
  name_en: string
  name_zh: string
  path: string
}

export const STICKERS: Sticker[] = [
  { id: 'surprised', name_en: 'Surprised', name_zh: '惊讶', path: '/stickers/surprised.png' },
  { id: 'wagmi', name_en: 'WAGMI', name_zh: 'WAGMI', path: '/stickers/wagmi.png' },
  { id: 'pray', name_en: 'Pray', name_zh: '祈祷', path: '/stickers/pray.png' },
  { id: 'party', name_en: 'Party', name_zh: '庆祝', path: '/stickers/party.png' },
  { id: 'bullish', name_en: 'Bullish', name_zh: '看涨', path: '/stickers/bullish.png' },
  { id: 'bearish', name_en: 'Bearish', name_zh: '看跌', path: '/stickers/bearish.png' },
  { id: 'mooning', name_en: 'Mooning', name_zh: '登月', path: '/stickers/mooning.png' },
  { id: 'happy', name_en: 'Happy', name_zh: '开心', path: '/stickers/happy.png' },
  { id: 'daze', name_en: 'Daze', name_zh: '发呆', path: '/stickers/daze.png' },
  { id: 'hodl', name_en: 'HODL', name_zh: 'HODL', path: '/stickers/hodl.png' },
  { id: 'diamond_hands', name_en: 'Diamond Hands', name_zh: '钻石手', path: '/stickers/diamond_hands.png' },
  { id: 'fomo', name_en: 'FOMO', name_zh: 'FOMO', path: '/stickers/fomo.png' },
  { id: 'gm', name_en: 'GM', name_zh: '早安', path: '/stickers/gm.png' },
  { id: 'gn', name_en: 'GN', name_zh: '晚安', path: '/stickers/gn.png' },
  { id: 'lfg', name_en: 'LFG', name_zh: '冲冲冲', path: '/stickers/lfg.png' },
  { id: 'thinking', name_en: 'Thinking', name_zh: '思考', path: '/stickers/thinking.png' },
  { id: 'angry', name_en: 'Angry', name_zh: '生气', path: '/stickers/angry.png' },
  { id: 'shocked', name_en: 'Shocked', name_zh: '震惊', path: '/stickers/shocked.png' },
  { id: 'rich', name_en: 'Rich', name_zh: '发财', path: '/stickers/rich.png' },
  { id: 'confused', name_en: 'Confused', name_zh: '懵圈', path: '/stickers/confused.png' },
  { id: 'crying', name_en: 'Crying', name_zh: '哭泣', path: '/stickers/crying.png' },
]

const stickerMap = new Map(STICKERS.map(s => [s.id, s]))

export function getStickerById(id: string): Sticker | undefined {
  return stickerMap.get(id)
}

/** Check if text is purely a sticker (no other content) */
export function isPureSticker(text: string): boolean {
  return /^\[sticker:[a-z_]+\]$/.test(text.trim())
}

/** Extract sticker ID from [sticker:xxx] format */
export function extractStickerId(text: string): string | null {
  const match = text.trim().match(/^\[sticker:([a-z_]+)\]$/)
  return match ? match[1] : null
}

/** Pattern to match sticker tokens in mixed content */
export const STICKER_PATTERN = /\[sticker:([a-z_]+)\]/g
