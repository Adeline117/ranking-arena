'use client'

import { useState, useEffect, useCallback } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getCsrfHeaders } from '@/lib/api/client'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'

interface CopyTradeSettings {
  maxPositionSize: number
  leverageLimit: number
  stopLossPercent: number
  takeProfitPercent: number
  proportionalSize: number
  maxDailyLoss: number
  maxOpenPositions: number
  allowedPairs: string[]
  blockedPairs: string[]
}

interface CopyTradeConfigData {
  id?: string
  trader_id: string
  exchange: string
  settings: CopyTradeSettings
  active: boolean
  created_at?: string
  updated_at?: string
}

interface CopyTradeConfigProps {
  traderId: string
  traderName?: string
  onClose?: () => void
}

const DEFAULT_SETTINGS: CopyTradeSettings = {
  maxPositionSize: 1000,
  leverageLimit: 10,
  stopLossPercent: 5,
  takeProfitPercent: 10,
  proportionalSize: 50,
  maxDailyLoss: 500,
  maxOpenPositions: 5,
  allowedPairs: [],
  blockedPairs: [],
}

const EXCHANGES = ['binance', 'okx', 'bybit', 'hyperliquid'] as const
const PROPORTIONAL_OPTIONS = [10, 25, 50, 75, 100] as const
const COMMON_PAIRS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT', 'ARB/USDT', 'OP/USDT']

/**
 * 跟单配置组件
 *
 * 注意: 当前仅为配置界面，实际交易执行功能将在后续版本中实现。
 * 保存的配置会存储到数据库，待执行引擎上线后自动生效。
 */
export default function CopyTradeConfig({ traderId, traderName, onClose }: CopyTradeConfigProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { user } = useAuthSession()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [config, setConfig] = useState<CopyTradeConfigData>({
    trader_id: traderId,
    exchange: 'binance',
    settings: { ...DEFAULT_SETTINGS },
    active: false,
  })
  const [pairInput, setPairInput] = useState('')
  const [pairMode, setPairMode] = useState<'allowed' | 'blocked'>('blocked')

  useEffect(() => {
    if (!user) { setLoading(false); return }
    const loadConfig = async () => {
      try {
        const res = await fetch(`/api/copy-trade/config?traderId=${traderId}`)
        const data = await res.json()
        if (data.configs?.length > 0) {
          setConfig(data.configs[0])
        }
      } catch {
        // 使用默认值
      } finally {
        setLoading(false)
      }
    }
    loadConfig()
  }, [traderId, user])

  const updateSettings = useCallback(<K extends keyof CopyTradeSettings>(key: K, value: CopyTradeSettings[K]) => {
    setConfig(prev => ({
      ...prev,
      settings: { ...prev.settings, [key]: value },
    }))
  }, [])

  const addPair = useCallback((pair: string) => {
    const normalized = pair.toUpperCase().trim()
    if (!normalized) return
    const key = pairMode === 'allowed' ? 'allowedPairs' : 'blockedPairs'
    setConfig(prev => {
      const list = prev.settings[key]
      if (list.includes(normalized)) return prev
      return { ...prev, settings: { ...prev.settings, [key]: [...list, normalized] } }
    })
    setPairInput('')
  }, [pairMode])

  const removePair = useCallback((pair: string, mode: 'allowed' | 'blocked') => {
    const key = mode === 'allowed' ? 'allowedPairs' : 'blockedPairs'
    setConfig(prev => ({
      ...prev,
      settings: { ...prev.settings, [key]: prev.settings[key].filter(p => p !== pair) },
    }))
  }, [])

  const handleSave = async () => {
    if (!user) {
      showToast(t('copyTrade_loginRequired'), 'error')
      return
    }
    setSaving(true)
    try {
      const headers = await getCsrfHeaders()
      const res = await fetch('/api/copy-trade/config', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: config.id,
          traderId: config.trader_id,
          exchange: config.exchange,
          settings: config.settings,
          active: config.active,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || t('copyTrade_saveFailed'))
      setConfig(data.config)
      showToast(t('copyTrade_saveSuccess'), 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('copyTrade_saveFailed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!config.id) return
    setSaving(true)
    try {
      const headers = await getCsrfHeaders()
      const res = await fetch(`/api/copy-trade/config?id=${config.id}`, {
        method: 'DELETE',
        headers,
      })
      if (!res.ok) throw new Error()
      showToast(t('copyTrade_deleteSuccess'), 'success')
      onClose?.()
    } catch {
      showToast(t('copyTrade_deleteFailed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Box style={{ padding: 24, textAlign: 'center' }}>
        <Text>{t('loading')}</Text>
      </Box>
    )
  }

  const c = tokens.colors

  return (
    <Box style={{
      padding: 24, maxWidth: 560, margin: '0 auto', width: '100%',
      background: c.bg.primary, borderRadius: 12,
      border: `1px solid ${c.border.primary}`,
    }}>
      {/* 标题 */}
      <Box style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontSize: 18, fontWeight: 700 }}>
          {t('copyTrade_title')}{traderName ? ` - ${traderName}` : ''}
        </Text>
        {onClose && (
          <button aria-label="Close" onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 20, color: c.text.secondary, padding: 4,
          }}>
            x
          </button>
        )}
      </Box>

      {/* 仅配置提示 */}
      <Box style={{
        padding: '10px 14px', marginBottom: 20,
        background: c.bg.secondary, borderRadius: 8,
        border: `1px solid ${c.accent.warning}`,
      }}>
        <Text style={{ fontSize: 13, color: c.text.secondary }}>
          {t('copyTrade_configOnlyNotice')}
        </Text>
      </Box>

      {/* 交易所选择 */}
      <FieldGroup label={t('copyTrade_exchange')}>
        <Box style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {EXCHANGES.map(ex => (
            <ChipButton
              key={ex}
              selected={config.exchange === ex}
              onClick={() => setConfig(prev => ({ ...prev, exchange: ex }))}
            >
              {ex}
            </ChipButton>
          ))}
        </Box>
      </FieldGroup>

      {/* 比例跟单 */}
      <FieldGroup label={t('copyTrade_proportionalSize')}>
        <Box style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {PROPORTIONAL_OPTIONS.map(pct => (
            <ChipButton
              key={pct}
              selected={config.settings.proportionalSize === pct}
              onClick={() => updateSettings('proportionalSize', pct)}
            >
              {pct}%
            </ChipButton>
          ))}
        </Box>
        <Text style={{ fontSize: 12, color: c.text.secondary, marginTop: 4 }}>
          {t('copyTrade_proportionalSizeHint')}
        </Text>
      </FieldGroup>

      {/* 仓位与杠杆 */}
      <Box style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <NumberField
          label={t('copyTrade_maxPositionSize')}
          value={config.settings.maxPositionSize}
          onChange={v => updateSettings('maxPositionSize', v)}
          suffix="USDT"
          min={0}
        />
        <NumberField
          label={t('copyTrade_leverageLimit')}
          value={config.settings.leverageLimit}
          onChange={v => updateSettings('leverageLimit', v)}
          suffix="x"
          min={1}
          max={125}
        />
      </Box>

      {/* 止盈止损 */}
      <Box style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <NumberField
          label={t('copyTrade_stopLoss')}
          value={config.settings.stopLossPercent}
          onChange={v => updateSettings('stopLossPercent', v)}
          suffix="%"
          min={0}
          max={100}
        />
        <NumberField
          label={t('copyTrade_takeProfit')}
          value={config.settings.takeProfitPercent}
          onChange={v => updateSettings('takeProfitPercent', v)}
          suffix="%"
          min={0}
          max={1000}
        />
      </Box>

      {/* 风控设置 */}
      <Box style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <NumberField
          label={t('copyTrade_maxDailyLoss')}
          value={config.settings.maxDailyLoss}
          onChange={v => updateSettings('maxDailyLoss', v)}
          suffix="USDT"
          min={0}
        />
        <NumberField
          label={t('copyTrade_maxOpenPositions')}
          value={config.settings.maxOpenPositions}
          onChange={v => updateSettings('maxOpenPositions', v)}
          suffix=""
          min={0}
          max={50}
        />
      </Box>

      {/* 交易对筛选 */}
      <FieldGroup label={t('copyTrade_pairFilter')}>
        <Box style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button
            onClick={() => setPairMode('blocked')}
            style={{
              padding: '4px 12px', borderRadius: 4, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${pairMode === 'blocked' ? c.accent.error : c.border.primary}`,
              background: pairMode === 'blocked' ? c.accent.error : 'transparent',
              color: pairMode === 'blocked' ? '#fff' : c.text.primary,
            }}
          >
            {t('copyTrade_blockedPairs')}
          </button>
          <button
            onClick={() => setPairMode('allowed')}
            style={{
              padding: '4px 12px', borderRadius: 4, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${pairMode === 'allowed' ? c.accent.success : c.border.primary}`,
              background: pairMode === 'allowed' ? c.accent.success : 'transparent',
              color: pairMode === 'allowed' ? '#fff' : c.text.primary,
            }}
          >
            {t('copyTrade_allowedPairs')}
          </button>
        </Box>

        <Box style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
          {COMMON_PAIRS.map(pair => (
            <button
              key={pair}
              onClick={() => addPair(pair)}
              style={{
                padding: '2px 8px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${c.border.primary}`,
                background: 'transparent', color: c.text.secondary,
              }}
            >
              +{pair}
            </button>
          ))}
        </Box>

        <Box style={{ display: 'flex', gap: 8 }}>
          <input
            value={pairInput}
            onChange={e => setPairInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addPair(pairInput)}
            placeholder={t('copyTrade_pairInputPlaceholder')}
            style={{
              flex: 1, padding: '6px 10px', borderRadius: 6, fontSize: 14,
              border: `1px solid ${c.border.primary}`,
              background: c.bg.secondary, color: c.text.primary, outline: 'none',
            }}
          />
          <button
            onClick={() => addPair(pairInput)}
            style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 14, cursor: 'pointer',
              border: `1px solid ${c.accent.primary}`,
              background: c.accent.primary, color: '#fff',
            }}
          >
            {t('copyTrade_add')}
          </button>
        </Box>

        {config.settings.blockedPairs.length > 0 && (
          <Box style={{ marginTop: 8 }}>
            <Text style={{ fontSize: 12, color: c.text.secondary, marginBottom: 4 }}>
              {t('copyTrade_blockedPairs')}:
            </Text>
            <Box style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {config.settings.blockedPairs.map(pair => (
                <PairTag key={pair} pair={pair} onRemove={() => removePair(pair, 'blocked')} variant="blocked" />
              ))}
            </Box>
          </Box>
        )}
        {config.settings.allowedPairs.length > 0 && (
          <Box style={{ marginTop: 8 }}>
            <Text style={{ fontSize: 12, color: c.text.secondary, marginBottom: 4 }}>
              {t('copyTrade_allowedPairs')}:
            </Text>
            <Box style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {config.settings.allowedPairs.map(pair => (
                <PairTag key={pair} pair={pair} onRemove={() => removePair(pair, 'allowed')} variant="allowed" />
              ))}
            </Box>
          </Box>
        )}
      </FieldGroup>

      {/* 启用开关 */}
      <Box style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 0', marginBottom: 16, borderTop: `1px solid ${c.border.primary}`,
      }}>
        <Text style={{ fontWeight: 600 }}>{t('copyTrade_enableAutoFollow')}</Text>
        <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', gap: 8 }}>
          <input
            type="checkbox"
            checked={config.active}
            onChange={e => setConfig(prev => ({ ...prev, active: e.target.checked }))}
            style={{ width: 18, height: 18, cursor: 'pointer' }}
          />
          <Text style={{ fontSize: 14, color: config.active ? c.accent.success : c.text.secondary }}>
            {config.active ? t('copyTrade_enabled') : t('copyTrade_disabled')}
          </Text>
        </label>
      </Box>

      {/* 操作按钮 */}
      <Box style={{ display: 'flex', gap: 12 }}>
        <Button
          onClick={handleSave}
          disabled={saving}
          style={{
            flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 15, fontWeight: 600,
            background: c.accent.primary, color: '#fff', border: 'none', cursor: 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? t('loading') : t('copyTrade_save')}
        </Button>
        {config.id && (
          <button
            onClick={handleDelete}
            disabled={saving}
            style={{
              padding: '10px 20px', borderRadius: 8, fontSize: 15, cursor: 'pointer',
              background: 'transparent', color: c.accent.error,
              border: `1px solid ${c.accent.error}`,
              opacity: saving ? 0.6 : 1,
            }}
          >
            {t('copyTrade_delete')}
          </button>
        )}
      </Box>
    </Box>
  )
}

// ---- 子组件 ----

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  const c = tokens.colors
  return (
    <Box style={{ marginBottom: 16 }}>
      <Text style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: c.text.primary }}>
        {label}
      </Text>
      {children}
    </Box>
  )
}

function ChipButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  const c = tokens.colors
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 16px', borderRadius: 6, fontSize: 14, cursor: 'pointer',
        border: `1px solid ${selected ? c.accent.primary : c.border.primary}`,
        background: selected ? c.accent.primary : 'transparent',
        color: selected ? '#fff' : c.text.primary,
        textTransform: 'capitalize',
      }}
    >
      {children}
    </button>
  )
}

function NumberField({
  label, value, onChange, suffix, min, max,
}: {
  label: string; value: number; onChange: (v: number) => void
  suffix: string; min?: number; max?: number
}) {
  const c = tokens.colors
  return (
    <Box>
      <Text style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, color: c.text.secondary }}>
        {label}
      </Text>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          type="number"
          value={value}
          onChange={e => {
            let v = Number(e.target.value)
            if (min !== undefined && v < min) v = min
            if (max !== undefined && v > max) v = max
            onChange(v)
          }}
          min={min}
          max={max}
          style={{
            flex: 1, padding: '6px 10px', borderRadius: 6, fontSize: 14,
            border: `1px solid ${c.border.primary}`,
            background: c.bg.secondary, color: c.text.primary,
            outline: 'none', width: '100%',
          }}
        />
        {suffix && (
          <Text style={{ fontSize: 13, color: c.text.secondary, whiteSpace: 'nowrap' }}>
            {suffix}
          </Text>
        )}
      </Box>
    </Box>
  )
}

function PairTag({ pair, onRemove, variant }: { pair: string; onRemove: () => void; variant: 'allowed' | 'blocked' }) {
  const c = tokens.colors
  const isBlocked = variant === 'blocked'
  const tagColor = isBlocked ? c.accent.error : c.accent.success
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 4, fontSize: 12,
      background: `color-mix(in srgb, ${tagColor} 15%, transparent)`,
      color: tagColor,
    }}>
      {pair}
      <button
        onClick={onRemove}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: tagColor, fontSize: 14, padding: 0, lineHeight: 1,
        }}
      >
        x
      </button>
    </span>
  )
}
