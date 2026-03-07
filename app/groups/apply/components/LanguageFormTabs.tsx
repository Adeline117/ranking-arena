'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { inputStyle, labelStyle, tabStyle } from '../styles'

interface LanguageFormTabsProps {
  activeTab: 'zh' | 'en'
  setActiveTab: (tab: 'zh' | 'en') => void
  showMultiLang: boolean
  setShowMultiLang: (show: boolean) => void
  nameZh: string
  setNameZh: (v: string) => void
  nameEn: string
  setNameEn: (v: string) => void
  descriptionZh: string
  setDescriptionZh: (v: string) => void
  descriptionEn: string
  setDescriptionEn: (v: string) => void
  fieldErrors: Record<string, string>
  setFieldErrors: (errors: Record<string, string>) => void
  validateField: (fieldName: string, value: string) => void
}

export function LanguageFormTabs({
  activeTab,
  setActiveTab,
  showMultiLang,
  setShowMultiLang,
  nameZh,
  setNameZh,
  nameEn,
  setNameEn,
  descriptionZh,
  setDescriptionZh,
  descriptionEn,
  setDescriptionEn,
  fieldErrors,
  setFieldErrors,
  validateField,
}: LanguageFormTabsProps) {
  const { t } = useLanguage()

  const clearNameError = () => {
    if (fieldErrors.name) {
      const newErrors = { ...fieldErrors }
      delete newErrors['name']
      setFieldErrors(newErrors)
    }
  }

  return (
    <Box>
      {/* Language tabs */}
      <Box style={{ display: 'flex', borderBottom: ('1px solid ' + tokens.colors.border.primary) }}>
        <button
          type="button"
          style={tabStyle(activeTab === 'zh')}
          onClick={() => setActiveTab('zh')}
        >
          {t('chinese')}
        </button>
        {showMultiLang && (
          <button
            type="button"
            style={tabStyle(activeTab === 'en')}
            onClick={() => setActiveTab('en')}
          >
            English
          </button>
        )}
        {!showMultiLang && (
          <button
            type="button"
            style={{
              ...tabStyle(false),
              color: tokens.colors.accent?.primary || tokens.colors.accent.brand,
              border: 'none',
            }}
            onClick={() => {
              setShowMultiLang(true)
              setActiveTab('en')
            }}
          >
            + {t('addLanguageBtn')}
          </button>
        )}
      </Box>

      {/* Chinese form */}
      <Box
        style={{
          display: activeTab === 'zh' ? 'flex' : 'none',
          flexDirection: 'column',
          gap: tokens.spacing[4],
          padding: tokens.spacing[4],
          background: tokens.colors.bg.secondary,
          borderRadius: ('0 0 ' + tokens.radius.lg + ' ' + tokens.radius.lg),
          border: ('1px solid ' + tokens.colors.border.primary),
          borderTop: 'none',
        }}
      >
        <Box>
          <label style={labelStyle}>
            {t('groupNameRequired')}
          </label>
          <input
            type="text"
            value={nameZh}
            onChange={(e) => {
              setNameZh(e.target.value)
              clearNameError()
            }}
            onBlur={() => validateField('nameZh', nameZh)}
            placeholder={t('groupNameZhPlaceholder')}
            style={{
              ...inputStyle,
              borderColor: fieldErrors.name ? tokens.colors.accent.error : tokens.colors.border.primary
            }}
            aria-invalid={!!fieldErrors.name}
            maxLength={50}
            autoFocus
          />
          {fieldErrors.name && (
            <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
              {fieldErrors.name}
            </Text>
          )}
        </Box>

        <Box>
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label style={labelStyle}>
              {t('groupDescription')}
            </label>
          </Box>
          <textarea
            value={descriptionZh}
            onChange={(e) => setDescriptionZh(e.target.value)}
            placeholder={t('groupDescZhPlaceholder')}
            style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
            maxLength={500}
          />
          <Text size="xs" style={{
            textAlign: 'right',
            marginTop: tokens.spacing[1],
            color: descriptionZh.length > 450 ? tokens.colors.accent.warning : tokens.colors.text.tertiary,
          }}>
            {descriptionZh.length}/500
          </Text>
        </Box>
      </Box>

      {/* English form */}
      {showMultiLang && (
        <Box
          style={{
            display: activeTab === 'en' ? 'flex' : 'none',
            flexDirection: 'column',
            gap: tokens.spacing[4],
            padding: tokens.spacing[4],
            background: tokens.colors.bg.secondary,
            borderRadius: ('0 0 ' + tokens.radius.lg + ' ' + tokens.radius.lg),
            border: ('1px solid ' + tokens.colors.border.primary),
            borderTop: 'none',
          }}
        >
          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text size="sm" color="tertiary">English Version</Text>
            <Button
              type="button"
              variant="text"
              size="sm"
              onClick={() => {
                setShowMultiLang(false)
                setActiveTab('zh')
                setNameEn('')
                setDescriptionEn('')
              }}
              style={{ padding: 0, color: tokens.colors.text.tertiary }}
            >
              {t('removeEnglish')}
            </Button>
          </Box>

          <Box>
            <label style={labelStyle}>
              Group Name
            </label>
            <input
              type="text"
              value={nameEn}
              onChange={(e) => {
                setNameEn(e.target.value)
                clearNameError()
              }}
              onBlur={() => validateField('nameEn', nameEn)}
              placeholder="e.g., BTC Trading Discussion"
              style={{
                ...inputStyle,
                borderColor: fieldErrors.name ? tokens.colors.accent.error : tokens.colors.border.primary
              }}
              aria-invalid={!!fieldErrors.name}
              maxLength={50}
            />
            {fieldErrors.name && (
              <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
                {fieldErrors.name}
              </Text>
            )}
          </Box>

          <Box>
            <label style={labelStyle}>
              Group Description
            </label>
            <textarea
              value={descriptionEn}
              onChange={(e) => setDescriptionEn(e.target.value)}
              placeholder="Describe your group..."
              style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
              maxLength={500}
            />
            <Text size="xs" style={{
              textAlign: 'right',
              marginTop: tokens.spacing[1],
              color: descriptionEn.length > 450 ? tokens.colors.accent.warning : tokens.colors.text.tertiary,
            }}>
              {descriptionEn.length}/500
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
