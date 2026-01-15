import React from 'react'
import { type PollChoice } from '@/lib/types'

export const ARENA_PURPLE = '#8b6fa8'

// 默认显示的回复数量
export const REPLIES_PREVIEW_COUNT = 2

/**
 * 解析视频链接，返回嵌入信息
 */
interface VideoEmbed {
  type: 'youtube' | 'bilibili'
  embedUrl: string
  originalUrl: string
}

function parseVideoUrl(url: string): VideoEmbed | null {
  // YouTube 链接
  // 格式: https://www.youtube.com/watch?v=VIDEO_ID 或 https://youtu.be/VIDEO_ID
  const youtubeMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/)
  if (youtubeMatch) {
    return {
      type: 'youtube',
      embedUrl: `https://www.youtube.com/embed/${youtubeMatch[1]}`,
      originalUrl: url,
    }
  }

  // Bilibili 链接
  // 格式: https://www.bilibili.com/video/BV1xxxxx 或 https://b23.tv/xxx
  const bilibiliMatch = url.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)|bilibili\.com\/video\/av(\d+)|b23\.tv\/([a-zA-Z0-9]+)/)
  if (bilibiliMatch) {
    const bvid = bilibiliMatch[1]
    const aid = bilibiliMatch[2]
    const shortId = bilibiliMatch[3]
    
    if (bvid) {
      return {
        type: 'bilibili',
        embedUrl: `//player.bilibili.com/player.html?bvid=${bvid}&autoplay=0`,
        originalUrl: url,
      }
    } else if (aid) {
      return {
        type: 'bilibili',
        embedUrl: `//player.bilibili.com/player.html?aid=${aid}&autoplay=0`,
        originalUrl: url,
      }
    } else if (shortId) {
      // b23.tv 短链接需要单独处理，这里先返回原链接
      return null
    }
  }

  return null
}

/**
 * 渲染视频嵌入组件
 */
function VideoPlayer({ video }: { video: VideoEmbed }) {
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        paddingBottom: '56.25%', // 16:9 比例
        marginTop: 8,
        marginBottom: 8,
        borderRadius: 8,
        overflow: 'hidden',
        background: '#000',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <iframe
        src={video.embedUrl}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          border: 'none',
        }}
        allowFullScreen
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        title={video.type === 'youtube' ? 'YouTube 视频' : 'Bilibili 视频'}
      />
    </div>
  )
}

/**
 * 将文本中的URL转换为可点击链接，识别视频链接并嵌入播放器
 */
export function renderContentWithLinks(text: string) {
  if (!text) return null
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  const parts = text.split(urlRegex)
  
  return parts.map((part, index) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0 // Reset regex state
      
      // 检查是否是视频链接
      const videoEmbed = parseVideoUrl(part)
      if (videoEmbed) {
        return <VideoPlayer key={index} video={videoEmbed} />
      }
      
      // 普通链接
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

