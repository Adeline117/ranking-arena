/**
 * 发送报警通知
 * 支持 Slack、飞书 Webhook 和邮件
 */

import { createClient } from '@supabase/supabase-js'

interface AlertPayload {
  title: string
  message: string
  level: 'info' | 'warning' | 'critical'
  details?: Record<string, any>
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  
  if (!url || !key) {
    return null
  }
  
  return createClient(url, key, { auth: { persistSession: false } })
}

async function getAlertConfig() {
  const supabase = getSupabaseAdmin()
  if (!supabase) return null
  
  const { data } = await supabase
    .from('alert_config')
    .select('key, value, enabled')
  
  if (!data) return null
  
  const config: Record<string, { value: string | null; enabled: boolean }> = {}
  for (const item of data) {
    config[item.key] = { value: item.value, enabled: item.enabled }
  }
  
  return config
}

async function sendSlackAlert(webhookUrl: string, payload: AlertPayload) {
  const colorMap = {
    info: '#36a64f',
    warning: '#ffcc00',
    critical: '#ff0000',
  }
  
  const slackPayload = {
    attachments: [{
      color: colorMap[payload.level],
      title: payload.title,
      text: payload.message,
      fields: payload.details ? Object.entries(payload.details).map(([key, value]) => ({
        title: key,
        value: String(value),
        short: true,
      })) : [],
      ts: Math.floor(Date.now() / 1000),
    }],
  }
  
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload),
    })
    
    if (!response.ok) {
      console.error('[Alert] Slack webhook failed:', response.status)
      return false
    }
    return true
  } catch (error) {
    console.error('[Alert] Slack webhook error:', error)
    return false
  }
}

async function sendFeishuAlert(webhookUrl: string, payload: AlertPayload) {
  const colorMap = {
    info: 'green',
    warning: 'yellow',
    critical: 'red',
  }
  
  const feishuPayload = {
    msg_type: 'interactive',
    card: {
      header: {
        title: {
          tag: 'plain_text',
          content: payload.title,
        },
        template: colorMap[payload.level],
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'plain_text',
            content: payload.message,
          },
        },
        ...(payload.details ? [{
          tag: 'div',
          fields: Object.entries(payload.details).map(([key, value]) => ({
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**${key}:** ${value}`,
            },
          })),
        }] : []),
      ],
    },
  }
  
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feishuPayload),
    })
    
    if (!response.ok) {
      console.error('[Alert] Feishu webhook failed:', response.status)
      return false
    }
    return true
  } catch (error) {
    console.error('[Alert] Feishu webhook error:', error)
    return false
  }
}

export async function sendAlert(payload: AlertPayload): Promise<{ sent: boolean; channels: string[] }> {
  const config = await getAlertConfig()
  if (!config) {
    console.log('[Alert] No config found, skipping alerts')
    return { sent: false, channels: [] }
  }
  
  const sentChannels: string[] = []
  
  // Send to Slack
  if (config.slack_webhook_url?.enabled && config.slack_webhook_url?.value) {
    const success = await sendSlackAlert(config.slack_webhook_url.value, payload)
    if (success) sentChannels.push('slack')
  }
  
  // Send to Feishu
  if (config.feishu_webhook_url?.enabled && config.feishu_webhook_url?.value) {
    const success = await sendFeishuAlert(config.feishu_webhook_url.value, payload)
    if (success) sentChannels.push('feishu')
  }
  
  // TODO: Add email support via Resend/SendGrid if needed
  // if (config.alert_email?.enabled && config.alert_email?.value) {
  //   await sendEmailAlert(config.alert_email.value, payload)
  // }
  
  return {
    sent: sentChannels.length > 0,
    channels: sentChannels,
  }
}

export async function sendScraperAlert(
  criticalPlatforms: string[],
  stalePlatforms: string[],
  platformNames: Record<string, string>
) {
  if (criticalPlatforms.length === 0 && stalePlatforms.length === 0) {
    return { sent: false, channels: [] }
  }
  
  const isCritical = criticalPlatforms.length > 0
  const level = isCritical ? 'critical' : 'warning'
  
  const criticalList = criticalPlatforms.map(p => platformNames[p] || p).join(', ')
  const staleList = stalePlatforms.map(p => platformNames[p] || p).join(', ')
  
  let message = ''
  if (criticalPlatforms.length > 0) {
    message += `严重过期 (>24h): ${criticalList}\n`
  }
  if (stalePlatforms.length > 0) {
    message += `数据陈旧 (>12h): ${staleList}`
  }
  
  return sendAlert({
    title: isCritical ? '爬虫数据严重过期告警' : '爬虫数据陈旧告警',
    message: message.trim(),
    level,
    details: {
      '严重过期平台数': criticalPlatforms.length,
      '陈旧平台数': stalePlatforms.length,
      '检查时间': new Date().toLocaleString('zh-CN'),
    },
  })
}
