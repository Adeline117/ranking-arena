'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useAlertConfig } from '../hooks/useAlertConfig'

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
  onSave: (key: string, value: string, enabled: boolean) => void
}

function ConfigItem({ label, description, configKey, placeholder, value: initialValue, enabled: initialEnabled, saving, onSave }: ConfigItemProps) {
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
            borderRadius: 12,
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
              background: '#fff',
              position: 'absolute',
              top: 2,
              left: enabled ? 26 : 2,
              transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
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
          {saving ? '保存中...' : '保存'}
        </Button>
      </Box>
    </Box>
  )
}

export default function AlertConfigTab({ accessToken }: AlertConfigTabProps) {
  const { config, loading, saving, loadConfig, updateConfig } = useAlertConfig(accessToken)

  useEffect(() => {
    if (accessToken) {
      loadConfig()
    }
  }, [accessToken, loadConfig])

  const handleSave = async (key: string, value: string, enabled: boolean) => {
    await updateConfig(key, value || null, enabled)
  }

  return (
    <Card title="报警配置">
      <Box style={{ marginBottom: tokens.spacing[4] }}>
        <Text size="sm" color="secondary">
          配置爬虫数据过期时的报警通知渠道。当数据超过阈值未更新时，系统会自动发送报警通知。
        </Text>
      </Box>

      {loading ? (
        <Box style={{ padding: tokens.spacing[8], textAlign: 'center' }}>
          <Text color="tertiary">加载中...</Text>
        </Box>
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          <ConfigItem
            label="Slack Webhook"
            description="发送报警到 Slack 频道"
            configKey="slack_webhook_url"
            placeholder="https://hooks.slack.com/services/..."
            value={config.slack_webhook_url?.value || ''}
            enabled={config.slack_webhook_url?.enabled || false}
            saving={saving}
            onSave={handleSave}
          />

          <ConfigItem
            label="飞书 Webhook"
            description="发送报警到飞书群"
            configKey="feishu_webhook_url"
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
            value={config.feishu_webhook_url?.value || ''}
            enabled={config.feishu_webhook_url?.enabled || false}
            saving={saving}
            onSave={handleSave}
          />

          <ConfigItem
            label="报警邮箱"
            description="发送报警邮件（需配置邮件服务）"
            configKey="alert_email"
            placeholder="admin@example.com"
            value={config.alert_email?.value || ''}
            enabled={config.alert_email?.enabled || false}
            saving={saving}
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
          报警触发条件
        </Text>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
          <Text size="xs" color="secondary">
            - 陈旧告警: 数据超过 12 小时未更新
          </Text>
          <Text size="xs" color="secondary">
            - 严重告警: 数据超过 24 小时未更新
          </Text>
          <Text size="xs" color="secondary">
            - 报警通过 /api/cron/check-data-freshness 定时任务触发
          </Text>
        </Box>
      </Box>
    </Card>
  )
}
