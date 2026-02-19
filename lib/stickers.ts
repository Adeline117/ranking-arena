export interface Sticker {
  id: string
  name_en: string
  name_zh: string
  label_en: string
  label_zh: string
  path: string
}

export const STICKERS: Sticker[] = [
  { id: 'surprised', name_en: 'Surprised', name_zh: '惊讶', label_en: 'Surprised', label_zh: '惊讶', path: '/stickers/surprised.webp' },
  { id: 'begging', name_en: 'Begging', name_zh: '求求了', label_en: 'Please', label_zh: '求求了', path: '/stickers/begging.webp' },
  { id: 'pray', name_en: 'Pray', name_zh: '祈祷', label_en: 'Pray', label_zh: '祈祷', path: '/stickers/pray.webp' },
  { id: 'party', name_en: 'Party', name_zh: '庆祝', label_en: 'Party', label_zh: '庆祝', path: '/stickers/party.webp' },
  { id: 'bullish', name_en: 'Bullish', name_zh: '看涨', label_en: 'Bullish', label_zh: '看涨', path: '/stickers/bullish.webp' },
  { id: 'bearish', name_en: 'Bearish', name_zh: '看跌', label_en: 'Bearish', label_zh: '看跌', path: '/stickers/bearish.webp' },
  { id: 'mooning', name_en: 'Mooning', name_zh: '登月', label_en: 'To the Moon', label_zh: '登月', path: '/stickers/mooning.webp' },
  { id: 'happy', name_en: 'Happy', name_zh: '开心', label_en: 'Happy', label_zh: '开心', path: '/stickers/happy.webp' },
  { id: 'daze', name_en: 'Daze', name_zh: '发呆', label_en: 'Daze', label_zh: '发呆', path: '/stickers/daze.webp' },
  { id: 'hodl', name_en: 'HODL', name_zh: 'HODL', label_en: 'Hold On for Dear Life', label_zh: '坚定持有', path: '/stickers/hodl.webp' },
  { id: 'diamond_hands', name_en: 'Diamond Hands', name_zh: '钻石手', label_en: 'Diamond Hands', label_zh: '钻石手', path: '/stickers/diamond_hands.webp' },
  { id: 'fomo', name_en: 'FOMO', name_zh: 'FOMO', label_en: 'Fear of Missing Out', label_zh: '怕错过', path: '/stickers/fomo.webp' },
  { id: 'gm', name_en: 'GM', name_zh: '早安', label_en: 'Good Morning', label_zh: '早安', path: '/stickers/gm.webp' },
  { id: 'gn', name_en: 'GN', name_zh: '晚安', label_en: 'Good Night', label_zh: '晚安', path: '/stickers/gn.webp' },
  { id: 'lfg', name_en: 'LFG', name_zh: '冲冲冲', label_en: 'Let\'s Go', label_zh: '冲冲冲', path: '/stickers/lfg.webp' },
  { id: 'thinking', name_en: 'Thinking', name_zh: '思考', label_en: 'Thinking', label_zh: '思考', path: '/stickers/thinking.webp' },
  { id: 'wagmi', name_en: 'WAGMI', name_zh: 'WAGMI', label_en: 'We\'re All Gonna Make It', label_zh: '我们都会成功', path: '/stickers/wagmi.webp' },
  { id: 'shocked', name_en: 'Shocked', name_zh: '震惊', label_en: 'Shocked', label_zh: '震惊', path: '/stickers/shocked.webp' },
  { id: 'rich', name_en: 'Rich', name_zh: '发财', label_en: 'Getting Rich', label_zh: '发财', path: '/stickers/rich.webp' },
  { id: 'confused', name_en: 'Confused', name_zh: '懵圈', label_en: 'Confused', label_zh: '懵圈', path: '/stickers/confused.webp' },
  { id: 'crying', name_en: 'Crying', name_zh: '哭泣', label_en: 'Crying', label_zh: '哭泣', path: '/stickers/crying.webp' },
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
