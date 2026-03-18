'use client'

import { localizedLabel } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface FlashNews {
  id: string
  title: string
  title_zh?: string
  title_en?: string
  content?: string
  content_zh?: string
  content_en?: string
  source: string
  source_url?: string
  category: 'crypto' | 'macro' | 'defi' | 'regulation' | 'market' | 'btc_eth' | 'altcoin' | 'exchange'
  importance: 'breaking' | 'important' | 'normal'
  tags: string[]
  published_at: string
  created_at: string
}

interface CategoryOption {
  key: string
  label: string
  label_en: string
}

interface NewsCardProps {
  item: FlashNews
  language: string
  categories: CategoryOption[]
  categoryDisplayMap: Record<string, string>
  categoryColors: Record<string, string>
  importanceConfig: Record<string, { color: string; label: string; label_en: string }>
  getNewsTitle: (item: FlashNews) => string
  getNewsContent: (item: FlashNews) => string | null
  translatedContent: Record<string, string>
  formatPublishedTime: (timestamp: string) => string
}

export default function NewsCard({
  item,
  language,
  categories,
  categoryDisplayMap,
  categoryColors,
  importanceConfig,
  getNewsTitle,
  getNewsContent,
  translatedContent,
  formatPublishedTime,
}: NewsCardProps) {
  const { t } = useLanguage()
  const impConfig = importanceConfig[item.importance]
  const catColor = categoryColors[item.category] || tokens.colors.text.secondary
  const content = getNewsContent(item)

  return (
    <Box
      style={{
        display: 'flex',
        marginBottom: tokens.spacing[4],
        borderLeft: `2px solid ${tokens.colors.border.primary}`,
        paddingLeft: tokens.spacing[3],
        position: 'relative',
      }}
    >
      <Box
        className={item.importance === 'breaking' ? 'flash-dot-breaking' : undefined}
        style={{
          position: 'absolute', left: '-7px', top: tokens.spacing[3],
          width: '12px', height: '12px', borderRadius: '50%',
          background: impConfig.color, border: `2.5px solid ${tokens.colors.bg.primary}`,
          boxShadow: `0 0 8px ${impConfig.color}60`,
          transition: `box-shadow ${tokens.transition.base}`,
        }}
      />

      <Box style={{ flex: 1 }}>
        <Card variant="glass" hoverable={false} style={{
          padding: tokens.spacing[4],
          borderRadius: tokens.radius.lg,
          position: 'relative', overflow: 'hidden',
          cursor: 'default',
        }}>
          {item.importance !== 'normal' && (
            <Box style={{
              position: 'absolute', top: 0, left: 0,
              background: impConfig.color, color: 'var(--color-on-accent)',
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              fontSize: '12px', fontWeight: '600',
              borderRadius: `0 0 ${tokens.radius.sm} 0`,
            }}>
              {localizedLabel(impConfig.label, impConfig.label_en, language)}
            </Box>
          )}

          <Box style={{ paddingTop: item.importance !== 'normal' ? tokens.spacing[4] : '0' }}>
            <Box style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: tokens.spacing[2],
            }}>
              <Text style={{ color: tokens.colors.text.tertiary, fontSize: '14px', fontWeight: '500' }}>
                {formatPublishedTime(item.published_at)}
              </Text>
              <Box style={{
                background: catColor, color: 'var(--color-on-accent)',
                padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                borderRadius: tokens.radius.sm, fontSize: '12px', fontWeight: '600',
              }}>
                {categories.find(c => c.key === (categoryDisplayMap[item.category] || item.category))?.[language === 'zh' ? 'label' : 'label_en']}
              </Box>
            </Box>

            <Text style={{
              fontSize: '16px', fontWeight: '600', lineHeight: '1.5',
              marginBottom: tokens.spacing[2], color: tokens.colors.text.primary,
            }}>
              {getNewsTitle(item)}
            </Text>

            {content && (
              <Text style={{
                color: translatedContent[item.id] ? 'var(--color-translated)' : tokens.colors.text.secondary,
                lineHeight: '1.5', marginBottom: tokens.spacing[2], fontSize: '14px',
              }}>
                {content}
                {translatedContent[item.id] && (
                  <span style={{
                    fontSize: 10, fontWeight: 500, marginLeft: 6,
                    padding: '1px 6px', borderRadius: tokens.radius.sm,
                    background: 'var(--color-translated-08)',
                    color: 'var(--color-translated)',
                    verticalAlign: 'middle',
                  }}>
                    {t('autoTranslated')}
                  </span>
                )}
              </Text>
            )}

            <Box style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              flexWrap: 'wrap', gap: tokens.spacing[2],
            }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                <Text style={{ color: tokens.colors.text.tertiary, fontSize: '12px', fontWeight: '500' }}>
                  {t('newsSource')}
                </Text>
                {item.source_url ? (
                  <a
                    href={item.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: tokens.colors.accent.primary, textDecoration: 'none',
                      fontSize: '12px', fontWeight: '500',
                    }}
                  >
                    {item.source}
                  </a>
                ) : (
                  <Text style={{ color: tokens.colors.text.secondary, fontSize: '12px', fontWeight: '500' }}>
                    {item.source}
                  </Text>
                )}
              </Box>

              {item.tags && item.tags.length > 0 && (
                <Box style={{ display: 'flex', gap: tokens.spacing[1], flexWrap: 'wrap' }}>
                  {item.tags.slice(0, 3).map((tag, tagIndex) => (
                    <Box key={tagIndex} style={{
                      background: tokens.colors.bg.tertiary, color: tokens.colors.text.tertiary,
                      padding: `2px ${tokens.spacing[1]}`, borderRadius: tokens.radius.sm,
                      fontSize: '10px', fontWeight: '500',
                    }}>
                      #{tag}
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          </Box>
        </Card>
      </Box>
    </Box>
  )
}
