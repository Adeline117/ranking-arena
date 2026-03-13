'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { Box, Text } from '../base'
import CryptoIcon from '@/app/components/common/CryptoIcon'

interface MarketDetailDrawerProps {
  selectedMarket: string
  onClose: () => void
}

export default function MarketDetailDrawer({ selectedMarket, onClose }: MarketDetailDrawerProps) {
  const { t } = useLanguage()

  return (
    <>
      {/* Backdrop */}
      <Box
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--color-overlay-dark)',
          zIndex: tokens.zIndex.overlay,
          opacity: 1,
          transition: 'opacity 0.3s ease',
        }}
        onClick={onClose}
      />
      {/* Drawer */}
      <Box
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          bottom: 0,
          width: 'min(420px, 90vw)',
          background: `linear-gradient(135deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary} 100%)`,
          borderLeft: `1px solid ${tokens.colors.border.primary}`,
          padding: tokens.spacing[6],
          zIndex: tokens.zIndex.modal,
          overflowY: 'auto',
          boxShadow: '-8px 0 32px var(--color-overlay-medium)',
          transform: 'translateX(0)',
          transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[6] }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
            <CryptoIcon symbol={selectedMarket} size={48} />
            <Text size="xl" weight="black" style={{ color: tokens.colors.text.primary }}>
              {selectedMarket}
            </Text>
          </Box>
          <button aria-label="Close"
            onClick={onClose}
            style={{
              background: tokens.colors.bg.tertiary,
              border: `1px solid ${tokens.colors.border.primary}`,
              color: tokens.colors.text.secondary,
              cursor: 'pointer',
              fontSize: tokens.typography.fontSize.xl,
              width: 44,
              height: 44,
              borderRadius: tokens.radius.full,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: `all ${tokens.transition.base}`,
            }}
          >
            ×
          </button>
        </Box>
        <Text size="sm" color="secondary">
          {t('loadingDetails')}
        </Text>
      </Box>
    </>
  )
}
