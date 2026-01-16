'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import type { TraderFeedItem } from '@/lib/data/trader'

interface PinnedPostProps {
  item: TraderFeedItem
}

// 内容渲染函数 - 将 Markdown 图片转换为图片元素，移除图片语法显示纯文本
function renderContent(text: string, maxLength = 150) {
  if (!text) return null
  
  // 移除 Markdown 图片语法，只保留文字内容
  const cleanText = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '').trim()
  
  if (cleanText.length > maxLength) {
    return cleanText.slice(0, maxLength) + '...'
  }
  return cleanText
}

// 提取图片 URL
function extractImages(text: string): string[] {
  if (!text) return []
  
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
  const images: string[] = []
  let match
  
  while ((match = imageRegex.exec(text)) !== null) {
    images.push(match[2])
  }
  
  return images
}

export default function PinnedPost({ item }: PinnedPostProps) {
  const images = item.content ? extractImages(item.content) : []
  const textContent = item.content ? renderContent(item.content) : null
  
  return (
    <Box
      bg="secondary"
      p={4}
      radius="lg"
      border="primary"
      style={{
        borderLeft: `3px solid ${tokens.colors.accent.primary}`,
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
        <Text size="xs" style={{ color: tokens.colors.accent.primary, fontWeight: tokens.typography.fontWeight.black }}>
          📌 置顶
        </Text>
      </Box>
      <Link
        href={item.groupId ? `/groups/${item.groupId}` : `/posts/${item.id}`}
        style={{ textDecoration: 'none' }}
      >
        <Text size="sm" weight="black" style={{ color: tokens.colors.text.primary, marginBottom: tokens.spacing[2], display: 'block' }}>
          {item.title}
        </Text>
        {textContent && (
          <Text size="xs" color="secondary" style={{ lineHeight: 1.5, display: 'block', marginBottom: images.length > 0 ? tokens.spacing[2] : 0 }}>
            {textContent}
          </Text>
        )}
        {/* 渲染图片 */}
        {images.length > 0 && (
          <Box style={{ 
            display: 'flex', 
            gap: tokens.spacing[2], 
            marginTop: tokens.spacing[2],
            flexWrap: 'wrap',
          }}>
            {images.slice(0, 3).map((url, idx) => (
              <Box
                key={idx}
                style={{
                  width: images.length === 1 ? '100%' : images.length === 2 ? 'calc(50% - 4px)' : 'calc(33.33% - 6px)',
                  maxWidth: images.length === 1 ? 300 : 150,
                  aspectRatio: '16/9',
                  borderRadius: tokens.radius.md,
                  overflow: 'hidden',
                  background: tokens.colors.bg.tertiary,
                }}
              >
                <img 
                  src={url} 
                  alt={`图片 ${idx + 1}`}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />
              </Box>
            ))}
            {images.length > 3 && (
              <Text size="xs" color="tertiary">
                +{images.length - 3} 张图片
              </Text>
            )}
          </Box>
        )}
        {item.groupId && item.groupName && (
          <Link
            href={`/groups/${item.groupId}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'block',
              marginTop: tokens.spacing[2],
              fontSize: tokens.typography.fontSize.xs,
              color: '#8b6fa8',
              textDecoration: 'none',
            }}
          >
            {item.groupName}
          </Link>
        )}
      </Link>
    </Box>
  )
}







