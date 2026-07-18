'use client'

/**
 * Bot profile header (spec §1.3, REQUIRED for bot profiles): a Bitget/MEXC bot
 * instance is a per-pair bot, not a human trader. This card surfaces the
 * bot-specific facts — strategy, pair, direction, runtime, profit-share %,
 * bot id — and a link to the owner ("交易机器人专家"). Rendered only when
 * traderKind === 'bot'.
 */

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { BotHeader } from '@/lib/data/serving/bot-header'

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: tokens.spacing[1],
        padding: `2px ${tokens.spacing[2]}`,
        borderRadius: tokens.radius.full,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.secondary}`,
        fontSize: tokens.typography.fontSize.xs,
        color: tokens.colors.text.secondary,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  )
}

export interface BotHeaderCardProps {
  bot: BotHeader
  style?: React.CSSProperties
}

export default function BotHeaderCard({ bot, style }: BotHeaderCardProps) {
  const { t } = useLanguage()

  const strategyLabel =
    bot.botStrategy === 'grid'
      ? t('botStrategyGrid')
      : bot.botStrategy === 'martingale'
        ? t('botStrategyMartingale')
        : bot.botStrategy === 'ai'
          ? t('botStrategyAi')
          : null
  const directionLabel =
    bot.direction === 'long'
      ? t('botDirectionLong')
      : bot.direction === 'short'
        ? t('botDirectionShort')
        : bot.direction || null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[2],
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.lg,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.secondary}`,
        ...style,
      }}
    >
      {/* Identity chips */}
      <div
        style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2], alignItems: 'center' }}
      >
        <Text size="sm" weight="semibold" color="primary">
          🤖 {t('botBadge')}
        </Text>
        {strategyLabel && <Chip>{strategyLabel}</Chip>}
        {bot.pair && <Chip>{bot.pair}</Chip>}
        {directionLabel && <Chip>{directionLabel}</Chip>}
      </div>

      {/* Facts row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[4] }}>
        {bot.runtimeDays != null && (
          <Text size="xs" color="tertiary">
            {t('botRuntime')}: <strong>{bot.runtimeDays}d</strong>
          </Text>
        )}
        {bot.profitShareRate != null && (
          <Text size="xs" color="tertiary">
            {t('botProfitShare')}: <strong>{bot.profitShareRate}%</strong>
          </Text>
        )}
        {bot.botId && (
          <Text size="xs" color="tertiary">
            {t('botId')}: <span style={{ fontFamily: 'monospace' }}>{bot.botId}</span>
          </Text>
        )}
      </div>

      {/* Owner link (交易机器人专家) */}
      {bot.ownerNickname && bot.ownerTraderKey && (
        <Text size="xs" color="tertiary">
          {t('botOwner')}:{' '}
          <Link
            href={`/trader/${encodeURIComponent(bot.ownerTraderKey)}${bot.ownerPlatform ? `?platform=${encodeURIComponent(bot.ownerPlatform)}` : ''}`}
            style={{ color: tokens.colors.accent.brand, fontWeight: 600 }}
          >
            {bot.ownerNickname}
          </Link>
        </Text>
      )}
    </div>
  )
}
