import { type PollChoice } from '@/lib/types'

export const ARENA_PURPLE = '#8b6fa8'

// 默认显示的回复数量
export const REPLIES_PREVIEW_COUNT = 2

/**
 * 将文本中的URL转换为可点击链接
 */
export function renderContentWithLinks(text: string) {
  if (!text) return null
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  const parts = text.split(urlRegex)
  
  return parts.map((part, index) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0 // Reset regex state
      return (
        <a
          key={index}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            color: ARENA_PURPLE,
            textDecoration: 'underline',
            wordBreak: 'break-all',
          }}
        >
          {part}
        </a>
      )
    }
    return part
  })
}

/**
 * 获取投票标签
 */
export function pollLabel(
  choice: PollChoice | 'tie',
  t: (key: string) => string
): string {
  if (choice === 'bull') return t('bullish')
  if (choice === 'bear') return t('bearish')
  return t('wait')
}

/**
 * 获取投票颜色
 */
export function pollColor(choice: PollChoice | 'tie'): string {
  if (choice === 'bull') return '#7CFFB2'
  if (choice === 'bear') return '#FF7C7C'
  return '#A9A9A9'
}

/**
 * 检测文本是否是中文
 */
export function isChineseText(text: string): boolean {
  if (!text) return false
  const chineseRegex = /[\u4e00-\u9fa5]/g
  const chineseMatches = text.match(chineseRegex)
  const chineseRatio = chineseMatches ? chineseMatches.length / text.length : 0
  return chineseRatio > 0.1 // 超过10%是中文字符
}

