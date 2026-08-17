'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useToast } from '@/app/components/ui/Toast'
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
  onSave: (key: string, value: string, enabled: boolean) => Promise<boolean>
}

type DraftState = {
  value: string
  enabled: boolean
}

function isSameDraft(left: DraftState, right: DraftState) {
  return left.value === right.value && left.enabled === right.enabled
}

function ConfigItem({
  label,
  description,
  configKey,
  placeholder,
  value: initialValue,
  enabled: initialEnabled,
  saving,
  savingLabel,
  saveLabel,
  onSave,
}: ConfigItemProps) {
  const incomingDraft = useMemo(
    () => ({ value: initialValue, enabled: initialEnabled }),
    [initialValue, initialEnabled]
  )
  const [draft, setDraft] = useState<DraftState>(incomingDraft)
  const [committed, setCommitted] = useState<DraftState>(incomingDraft)
  const pendingSaveRef = useRef<DraftState | null>(null)
  const draftRef = useRef(draft)
  const committedRef = useRef(committed)

  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  useEffect(() => {
    committedRef.current = committed
  }, [committed])

  useEffect(() => {
    const previousCommitted = committedRef.current
    const currentDraft = draftRef.current
    const pendingSave = pendingSaveRef.current

    setCommitted(incomingDraft)
    committedRef.current = incomingDraft

    if (pendingSave && isSameDraft(incomingDraft, pendingSave)) {
      pendingSaveRef.current = null
      if (isSameDraft(currentDraft, pendingSave)) {
        draftRef.current = incomingDraft
        setDraft(incomingDraft)
      }
      return
    }

    if (
      !pendingSave &&
      isSameDraft(currentDraft, previousCommitted) &&
      !isSameDraft(currentDraft, incomingDraft)
    ) {
      draftRef.current = incomingDraft
      setDraft(incomingDraft)
    }
  }, [incomingDraft])

  const isDirty = !isSameDraft(draft, committed)

  const handleChange = (newValue: string) => {
    setDraft((current) => ({ ...current, value: newValue }))
  }

  const handleToggle = () => {
    setDraft((current) => ({ ...current, enabled: !current.enabled }))
  }

  const handleSave = async () => {
    const submission = draftRef.current
    pendingSaveRef.current = submission
    const saved = await onSave(configKey, submission.value, submission.enabled)
    if (!saved && pendingSaveRef.current && isSameDraft(pendingSaveRef.current, submission)) {
      pendingSaveRef.current = null
    }
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
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: tokens.spacing[3],
        }}
      >
        <Box>
          <Text size="md" weight="bold">
            {label}
          </Text>
          <Text size="sm" color="tertiary">
            {description}
          </Text>
        </Box>
        <Box
          onClick={handleToggle}
          style={{
            width: 48,
            height: 24,
            borderRadius: tokens.radius.lg,
            background: draft.enabled ? tokens.colors.accent.success : tokens.colors.bg.tertiary,
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
              left: draft.enabled ? 26 : 2,
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
          value={draft.value}
          onChange={(e) => handleChange(e.target.value)}
          disabled={!draft.enabled}
          style={{
            flex: 1,
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: draft.enabled ? tokens.colors.bg.primary : tokens.colors.bg.tertiary,
            color: draft.enabled ? tokens.colors.text.primary : tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
            opacity: draft.enabled ? 1 : 0.6,
          }}
        />
        <Button variant="primary" size="sm" onClick={handleSave} disabled={!isDirty || saving}>
          {saving ? savingLabel : saveLabel}
        </Button>
      </Box>
    </Box>
  )
}

export default function AlertConfigTab({ accessToken }: AlertConfigTabProps) {
  const { showToast } = useToast()
  const { config, error, loading, saving, loadConfig, updateConfig } = useAlertConfig(
    accessToken,
    showToast
  )
  const { t } = useLanguage()

  useEffect(() => {
    if (accessToken) {
      loadConfig()
    }
  }, [accessToken, loadConfig])

  const handleSave = async (key: string, value: string, enabled: boolean) => {
    return updateConfig(key, value || null, enabled)
  }

  return (
    <Card title={t('adminAlertConfiguration')}>
      <Box style={{ marginBottom: tokens.spacing[4] }}>
        <Text size="sm" color="secondary">
          {t('adminAlertConfigDesc')}
        </Text>
      </Box>

      {error && (
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text size="sm" style={{ color: tokens.colors.accent.error }}>
            {error}
          </Text>
        </Box>
      )}

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
