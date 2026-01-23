'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

/**
 * 页脚组件
 * 包含风险声明、数据来源说明和基本导航
 */
export default function Footer() {
  const { language } = useLanguage()

  return (
    <Box
      as="footer"
      style={{
        borderTop: `1px solid ${tokens.colors.border.primary}`,
        background: tokens.colors.bg.secondary,
        padding: `${tokens.spacing[8]} ${tokens.spacing[4]}`,
        marginTop: 'auto',
      }}
    >
      <Box
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.spacing[6],
        }}
      >
        {/* 风险声明 - 重要 */}
        <Box
          style={{
            padding: tokens.spacing[4],
            background: `${tokens.colors.accent.warning}10`,
            border: `1px solid ${tokens.colors.accent.warning}30`,
            borderRadius: tokens.radius.lg,
          }}
        >
          <Text
            size="xs"
            weight="bold"
            style={{
              color: tokens.colors.accent.warning,
              marginBottom: tokens.spacing[2],
              display: 'block',
            }}
          >
            {language === 'zh' ? '风险提示' : 'Risk Disclaimer'}
          </Text>
          <Text
            size="xs"
            color="secondary"
            style={{
              lineHeight: 1.7,
            }}
          >
            {language === 'zh' ? (
              <>
                本平台仅提供交易员公开数据的聚合展示，<strong>不构成任何投资建议</strong>。
                跟单交易存在重大风险，可能导致全部本金损失。过往业绩不代表未来表现。
                数据来源于各交易所公开页面，非官方合作，可能存在延迟或误差。
                请您在做出任何投资决策前，充分了解相关风险并咨询专业顾问。
              </>
            ) : (
              <>
                This platform only provides aggregated display of publicly available trader data and <strong>does not constitute any investment advice</strong>.
                Copy trading involves significant risks and may result in total loss of principal. Past performance does not guarantee future results.
                Data is sourced from public pages of exchanges, not official partnerships, and may be delayed or inaccurate.
                Please fully understand the risks and consult professional advisors before making any investment decisions.
              </>
            )}
          </Text>
        </Box>

        {/* 数据来源说明 */}
        <Box
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: tokens.spacing[6],
          }}
        >
          {/* 左侧：数据说明 */}
          <Box style={{ maxWidth: 400 }}>
            <Text size="sm" weight="bold" color="primary" style={{ marginBottom: tokens.spacing[2] }}>
              {language === 'zh' ? '数据说明' : 'Data Information'}
            </Text>
            <Text size="xs" color="tertiary" style={{ lineHeight: 1.7 }}>
              {language === 'zh' ? (
                <>
                  排行榜数据来自 Binance、Bybit、Bitget 等交易所公开页面。
                  热门交易员（Top 100）每 15 分钟更新一次，其他交易员每 4 小时更新。
                  Arena Score 为平台自研评分系统，详见
                  <Link href="/methodology" style={{ color: tokens.colors.accent.primary, marginLeft: 4 }}>
                    评分方法论
                  </Link>
                  。
                </>
              ) : (
                <>
                  Leaderboard data is sourced from public pages of Binance, Bybit, Bitget and other exchanges.
                  Hot traders (Top 100) are updated every 15 minutes, others every 4 hours.
                  Arena Score is our proprietary rating system, see
                  <Link href="/methodology" style={{ color: tokens.colors.accent.primary, marginLeft: 4 }}>
                    Methodology
                  </Link>
                  .
                </>
              )}
            </Text>
          </Box>

          {/* 中间：链接 */}
          <Box style={{ display: 'flex', gap: tokens.spacing[8] }}>
            <Box>
              <Text size="xs" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                {language === 'zh' ? '产品' : 'Product'}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                <FooterLink href="/">{language === 'zh' ? '排行榜' : 'Leaderboard'}</FooterLink>
                <FooterLink href="/pricing">{language === 'zh' ? 'Pro 会员' : 'Pro Membership'}</FooterLink>
                <FooterLink href="/methodology">{language === 'zh' ? '评分方法' : 'Methodology'}</FooterLink>
              </Box>
            </Box>
            <Box>
              <Text size="xs" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                {language === 'zh' ? '支持' : 'Support'}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                <FooterLink href="/help">{language === 'zh' ? '帮助中心' : 'Help Center'}</FooterLink>
                <FooterLink href="/privacy">{language === 'zh' ? '隐私政策' : 'Privacy Policy'}</FooterLink>
                <FooterLink href="/terms">{language === 'zh' ? '服务条款' : 'Terms of Service'}</FooterLink>
              </Box>
            </Box>
          </Box>

          {/* 右侧：版权 */}
          <Box style={{ textAlign: 'right' }}>
            <Text size="xs" color="tertiary">
              © {new Date().getFullYear()} Arena
            </Text>
            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
              {language === 'zh' ? '仅供参考，不构成投资建议' : 'For reference only, not investment advice'}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      style={{
        color: tokens.colors.text.tertiary,
        fontSize: tokens.typography.fontSize.xs,
        textDecoration: 'none',
        transition: `color ${tokens.transition.fast}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = tokens.colors.text.primary
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = tokens.colors.text.tertiary
      }}
    >
      {children}
    </Link>
  )
}
