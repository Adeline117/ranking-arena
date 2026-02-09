'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useAlertConfig } from '../hooks/useAlertConfig'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface AlertConfigTabProps {
  accessToken: string | null
}

interface ConfigItemProps {
  label: string
  description: string
  configKey: string
  placeholder: string
  value: string
  enabled: boolean
  saving: boolean
  savingLabel: string
  saveLabel: string
  onSave: (key: string, value: string, enabled: boolean) => void
}

function ConfigItem({ label, description, configKey, placeholder, value: initialValue, enabled: initialEnabled, saving, savingLabel, saveLabel, onSave }: ConfigItemProps) {
  const [value, setValue] = useState(initialValue)
  const [enabled, setEnabled] = useState(initialEnabled)
  const [isDirty, setIsDirty] = useState(false)

  useEffect(() => {
    setValue(initialValue)
    setEnabled(initialEnabled)
    setIsDirty(false)
  }, [initialValue, initialEnabled])

  const handleChange = (newValue: string) => {
    setValue(newValue)
    setIsDirty(true)
  }

  const handleToggle = () => {
    setEnabled(!enabled)
    setIsDirty(true)
  }

  const handleSave = () => {
    onSave(configKey, value, enabled)
    setIsDirty(false)
  }

  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[3] }}>
        <Box>
          <Text size="md" weight="bold">{label}</Text>
          <Text size="sm" color="tertiary">{description}</Text>
        </Box>
        <Box
          onClick={handleToggle}
          style={{
            width: 48,
            height: 24,
            borderRadius: tokens.radius.lg,
            background: enabled ? tokens.colors.accent.success : tokens.colors.bg.tertiary,
            cursor: 'pointer',
            position: 'relative',
            transition: 'background 0.2s',
          }}
        >
          <Box
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: tokens.colors.white,
              position: 'absolute',
              top: 2,
              left: enabled ? 26 : 2,
              transition: 'left 0.2s',
              boxShadow: '0 1px 3px var(--color-overlay-medium)',
            }}
          />
        </Box>
      </Box>

      <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
        <input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          disabled={!enabled}
          style={{
            flex: 1,
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: enabled ? tokens.colors.bg.primary : tokens.colors.bg.tertiary,
            color: enabled ? tokens.colors.text.primary : tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
            opacity: enabled ? 1 : 0.6,
          }}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={!isDirty || saving}
        >
          {saving ? savingLabel : saveLabel}
        </Button>
      </Box>
    </Box>
  )
}

export default function AlertConfigTab({ accessToken }: AlertConfigTabProps) {
  const { config, loading, saving, loadConfig, updateConfig } = useAlertConfig(accessToken)
  const { t } = useLanguage()

  useEffect(() => {
    if (accessToken) {
      loadConfig()
    }
  }, [accessToken, loadConfig])

  const handleSave = async (key: string, value: string, enabled: boolean) => {
    await updateConfig(key, value || null, enabled)
  }

  return (
    <Card title={t('adminAlertConfiguration')}>
      <Box style={{ marginBottom: tokens.spacing[4] }}>
        <Text size="sm" color="secondary">
          {t('adminAlertConfigDesc')}
        </Text>
      </Box>

      {loading ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">{t('loading')}</Text>
        </Box>
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          <ConfigItem
            label={t('adminSlackWebhook')}
            description={t('adminSlackDesc')}
            configKey="slack_webhook_url"
            placeholder="https://hooks.slack.com/services/..."
            value={config.slack_webhook_url?.value || ''}
            enabled={config.slack_webhook_url?.enabled || false}
            saving={saving}
            savingLabel={t('adminSaving')}
            saveLabel={t('adminSaveBtn')}
            onSave={handleSave}
          />

          <ConfigItem
            label={t('adminFeishuWebhook')}
            description={t('adminFeishuDesc')}
            configKey="feishu_webhook_url"
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            value={config.feishu_webhook_url?.value || ''}
            enabled={config.feishu_webhook_url?.enabled || false}
            saving={saving}
            savingLabel={t('adminSaving')}
            saveLabel={t('adminSaveBtn')}
            onSave={handleSave}
          />

          <ConfigItem
            label={t('adminAlertEmail')}
            description={t('adminAlertEmailDesc')}
            configKey="alert_email"
            placeholder="admin@example.com"
            value={config.alert_email?.value || ''}
            enabled={config.alert_email?.enabled || false}
            saving={saving}
            savingLabel={t('adminSaving')}
            saveLabel={t('adminSaveBtn')}
            onSave={handleSave}
          />
        </Box>
      )}

      {/* Help Text */}
      <Box
        style={{
          marginTop: tokens.spacing[6],
          padding: tokens.spacing[4],
          background: tokens.colors.bg.tertiary,
          borderRadius: tokens.radius.lg,
        }}
      >
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('adminAlertTriggerTitle')}
        </Text>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
          <Text size="xs" color="secondary">
            - {t('adminStaleAlertDesc')}
          </Text>
          <Text size="xs" color="secondary">
            - {t('adminCriticalAlertDesc')}
          </Text>
          <Text size="xs" color="secondary">
            - {t('adminAlertCronNote')}
          </Text>
        </Box>
      </Box>
    </Card>
  )
}
