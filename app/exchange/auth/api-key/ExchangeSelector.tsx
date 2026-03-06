'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { EXCHANGE_CONFIGS, type ExchangeId } from './exchange-configs'

interface ExchangeSelectorProps {
  onSelect: (id: ExchangeId) => void
}

export default function ExchangeSelector({ onSelect }: ExchangeSelectorProps) {
  const { t } = useLanguage()

  return (
    <Box
      bg="secondary"
      p={6}
      radius="xl"
      border="primary"
      style={{ marginBottom: tokens.spacing[6] }}
    >
      <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
        {t('selectExchange')}
      </Text>
      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[3] }}>
        {(Object.keys(EXCHANGE_CONFIGS) as ExchangeId[]).map((id) => (
          <Button
            key={id}
            variant="secondary"
            onClick={() => onSelect(id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            }}
          >
            <ExchangeLogo exchange={id} size={24} />
            {EXCHANGE_CONFIGS[id].name}
          </Button>
        ))}
      </Box>
    </Box>
  )
}
