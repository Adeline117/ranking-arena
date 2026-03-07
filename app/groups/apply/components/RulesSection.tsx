'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { inputStyle } from '../styles'
import type { Rule } from '../types'

interface RulesSectionProps {
  rules: Rule[]
  newRuleZh: string
  setNewRuleZh: (v: string) => void
  newRuleEn: string
  setNewRuleEn: (v: string) => void
  showMultiLang: boolean
  addRule: () => void
  removeRule: (index: number) => void
  updateRule: (index: number, lang: 'zh' | 'en', value: string) => void
}

export function RulesSection({
  rules,
  newRuleZh,
  setNewRuleZh,
  newRuleEn,
  setNewRuleEn,
  showMultiLang,
  addRule,
  removeRule,
  updateRule,
}: RulesSectionProps) {
  const { t } = useLanguage()

  return (
    <Box>
      <Text weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
        {t('groupRules')}
      </Text>
      <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
        {t('groupRulesDesc')}
      </Text>

      {/* Existing rules */}
      {rules.length > 0 && (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
          {rules.map((rule, index) => (
            <Box
              key={index}
              style={{
                padding: tokens.spacing[3],
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.lg,
                border: ('1px solid ' + tokens.colors.border.primary),
              }}
            >
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
                <Text size="sm" weight="bold" color="secondary">
                  {t('ruleNumber').replace('{n}', String(index + 1))}
                </Text>
                <Button
                  type="button"
                  variant="text"
                  size="sm"
                  onClick={() => removeRule(index)}
                  style={{ padding: 0, color: 'var(--color-accent-error)', fontSize: tokens.typography.fontSize.xs }}
                >
                  {t('delete')}
                </Button>
              </Box>

              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                <Box>
                  <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>{t('chinese')}</Text>
                  <input
                    type="text"
                    value={rule.zh}
                    onChange={(e) => updateRule(index, 'zh', e.target.value)}
                    style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }}
                    placeholder={t('ruleContentZhPlaceholder')}
                  />
                </Box>
                {showMultiLang && (
                  <Box>
                    <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>English</Text>
                    <input
                      type="text"
                      value={rule.en}
                      onChange={(e) => updateRule(index, 'en', e.target.value)}
                      style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }}
                      placeholder={t('ruleContentEnPlaceholder')}
                    />
                  </Box>
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )}

      {/* Add new rule */}
      <Box
        style={{
          padding: tokens.spacing[3],
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.lg,
          border: ('1px dashed ' + tokens.colors.border.primary),
        }}
      >
        <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
          {t('addNewRule')}
        </Text>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          <input
            type="text"
            value={newRuleZh}
            onChange={(e) => setNewRuleZh(e.target.value)}
            style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }}
            placeholder={t('ruleInputZhPlaceholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addRule()
              }
            }}
          />
          {showMultiLang && (
            <input
              type="text"
              value={newRuleEn}
              onChange={(e) => setNewRuleEn(e.target.value)}
              style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }}
              placeholder={t('ruleInputEnPlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addRule()
                }
              }}
            />
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addRule}
            disabled={!newRuleZh.trim() && !newRuleEn.trim()}
            style={{ alignSelf: 'flex-start' }}
          >
            + {t('addRule')}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
