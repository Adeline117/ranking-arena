'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { EXCHANGE_CONFIGS, type ExchangeId } from './exchange-configs'

interface StepGuideProps {
  selectedExchange: ExchangeId
  onChangeExchange: () => void
}

export default function StepGuide({ selectedExchange, onChangeExchange }: StepGuideProps) {
  const { t, language } = useLanguage()
  const config = EXCHANGE_CONFIGS[selectedExchange]
  const steps = config.steps[language as 'zh' | 'en'] || config.steps.zh

  return (
    <Box>
      {/* 交易所标题 */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          marginBottom: tokens.spacing[4],
        }}
      >
        <ExchangeLogo exchange={selectedExchange} size={32} />
        <Text size="xl" weight="bold">{config.name}</Text>
        <Button
          variant="text"
          size="sm"
          onClick={onChangeExchange}
          style={{ marginLeft: 'auto' }}
        >
          {t('changeExchange')}
        </Button>
      </Box>

      {/* 步骤列表 */}
      <Box
        bg="secondary"
        p={5}
        radius="xl"
        border="primary"
        style={{ marginBottom: tokens.spacing[4] }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
          <Text size="lg" weight="bold">
            {t('operationStepsLabel')}
          </Text>
          <Text size="xs" color="tertiary">
            {t('estimatedTime')}
          </Text>
        </Box>

        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {steps.map((step, index) => (
            <Box key={index} style={{ display: 'flex', gap: tokens.spacing[3] }}>
              {/* 步骤数字 */}
              <Box
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: tokens.colors.accent.primary,
                  color: tokens.colors.white,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {index + 1}
              </Box>
              {/* 步骤内容 */}
              <Box style={{ flex: 1 }}>
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[1] }}>
                  {step.title}
                </Text>
                <Text size="xs" color="secondary">
                  {step.desc}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>

        {/* 打开交易所按钮 */}
        <Button
          variant="secondary"
          fullWidth
          onClick={() => window.open(config.apiManagementUrl, '_blank')}
          style={{ marginTop: tokens.spacing[4] }}
        >
          {t('openApiManagement').replace('{exchange}', config.name)}
        </Button>
      </Box>

      {/* 视频教程（预留） */}
      <Box
        style={{
          padding: tokens.spacing[3],
          borderRadius: tokens.radius.lg,
          background: `${tokens.colors.accent.primary}15`,
          border: `1px solid ${tokens.colors.accent.primary}30`,
        }}
      >
        <Text size="sm" color="secondary">
          {t('videoComingSoon')}
        </Text>
      </Box>
    </Box>
  )
}
