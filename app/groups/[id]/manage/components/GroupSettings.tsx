'use client'

import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
// Language context available via parent
import Card from '@/app/components/ui/Card'
import { Box, Text, Button } from '@/app/components/base'

type Rule = { zh: string; en: string }

type Group = {
  id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  rules_json?: Rule[] | null
  role_names?: { admin: { zh: string; en: string }; member: { zh: string; en: string } } | null
  is_premium_only?: boolean | null
}

interface GroupSettingsProps {
  group: Group | null
  editMode: boolean
  setEditMode: (v: boolean) => void
  editName: string; setEditName: (v: string) => void
  editNameEn: string; setEditNameEn: (v: string) => void
  editDescription: string; setEditDescription: (v: string) => void
  editDescriptionEn: string; setEditDescriptionEn: (v: string) => void
  editRules: Rule[]; setEditRules: (v: Rule[]) => void
  newRuleZh: string; setNewRuleZh: (v: string) => void
  newRuleEn: string; setNewRuleEn: (v: string) => void
  editAvatarUrl: string; setEditAvatarUrl: (v: string) => void
  editRoleNames: { admin: { zh: string; en: string }; member: { zh: string; en: string } }
  setEditRoleNames: (v: { admin: { zh: string; en: string }; member: { zh: string; en: string } }) => void
  isPremiumOnly: boolean; setIsPremiumOnly: (v: boolean) => void
  isPro: boolean
  langTab: 'zh' | 'en'; setLangTab: (v: 'zh' | 'en') => void
  showMultiLang: boolean; setShowMultiLang: (v: boolean) => void
  submitting: boolean
  onSubmitEdit: () => void
  onCancelEdit: () => void
  inputStyle: React.CSSProperties
  labelStyle: React.CSSProperties
  langTabStyle: (active: boolean) => React.CSSProperties
  t: (key: string) => string
}

export default function GroupSettings({
  editMode, setEditMode,
  editName, setEditName, editNameEn, setEditNameEn,
  editDescription, setEditDescription, editDescriptionEn, setEditDescriptionEn,
  editRules, setEditRules, newRuleZh, setNewRuleZh, newRuleEn, setNewRuleEn,
  editAvatarUrl, setEditAvatarUrl, editRoleNames, setEditRoleNames,
  isPremiumOnly, setIsPremiumOnly, isPro,
  langTab, setLangTab, showMultiLang, setShowMultiLang,
  submitting, onSubmitEdit, onCancelEdit,
  inputStyle, labelStyle, langTabStyle, t,
}: GroupSettingsProps) {
  const addRule = () => {
    const zh = newRuleZh.trim(); const en = newRuleEn.trim()
    if (!zh && !en) return
    setEditRules([...editRules, { zh, en }]); setNewRuleZh(''); setNewRuleEn('')
  }
  const removeRule = (index: number) => setEditRules(editRules.filter((_, i) => i !== index))
  const updateRule = (index: number, lang: 'zh' | 'en', value: string) => {
    const newRules = [...editRules]; newRules[index] = { ...newRules[index], [lang]: value }; setEditRules(newRules)
  }

  return (
    <Card title={t('groupSettings')}>
      <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>{t('editRequiresApproval')}</Text>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[5] }}>
        {/* Language tabs */}
        <Box>
          <Box style={{ display: 'flex', borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
            <button type="button" style={langTabStyle(langTab === 'zh')} onClick={() => setLangTab('zh')} disabled={!editMode}>{t('chinese')}</button>
            {showMultiLang && <button type="button" style={langTabStyle(langTab === 'en')} onClick={() => setLangTab('en')} disabled={!editMode}>English</button>}
            {!showMultiLang && editMode && (
              <button type="button" style={{ ...langTabStyle(false), color: tokens.colors.accent?.primary || tokens.colors.accent.brand, border: 'none' }} onClick={() => { setShowMultiLang(true); setLangTab('en') }}>+ {t('addLanguage')}</button>
            )}
          </Box>

          {/* Chinese form */}
          <Box style={{ display: langTab === 'zh' ? 'flex' : 'none', flexDirection: 'column', gap: tokens.spacing[4], padding: tokens.spacing[4], background: tokens.colors.bg.secondary, borderRadius: `0 0 ${tokens.radius.lg} ${tokens.radius.lg}`, border: `1px solid ${tokens.colors.border.primary}`, borderTop: 'none' }}>
            <Box><label style={labelStyle}>{t('groupName')} *</label><input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder={t('groupNamePlaceholder')} style={inputStyle} disabled={!editMode} maxLength={50} /></Box>
            <Box><label style={labelStyle}>{t('groupDescription')}</label><textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} placeholder={t('groupDescriptionPlaceholder')} style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }} disabled={!editMode} maxLength={500} /></Box>
          </Box>

          {/* English form */}
          {showMultiLang && (
            <Box style={{ display: langTab === 'en' ? 'flex' : 'none', flexDirection: 'column', gap: tokens.spacing[4], padding: tokens.spacing[4], background: tokens.colors.bg.secondary, borderRadius: `0 0 ${tokens.radius.lg} ${tokens.radius.lg}`, border: `1px solid ${tokens.colors.border.primary}`, borderTop: 'none' }}>
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text size="sm" color="tertiary">{t('englishVersion')}</Text>
                {editMode && <Button type="button" variant="text" size="sm" onClick={() => { setShowMultiLang(false); setLangTab('zh'); setEditNameEn(''); setEditDescriptionEn('') }} style={{ padding: 0, color: tokens.colors.text.tertiary }}>{t('removeEnglish')}</Button>}
              </Box>
              <Box><label style={labelStyle}>{t('groupNameEn')}</label><input type="text" value={editNameEn} onChange={(e) => setEditNameEn(e.target.value)} placeholder={t('groupNameEnPlaceholder')} style={inputStyle} disabled={!editMode} maxLength={50} /></Box>
              <Box><label style={labelStyle}>{t('groupDescriptionEn')}</label><textarea value={editDescriptionEn} onChange={(e) => setEditDescriptionEn(e.target.value)} placeholder={t('groupDescriptionEnPlaceholder')} style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }} disabled={!editMode} maxLength={500} /></Box>
            </Box>
          )}
        </Box>

        {/* Rules */}
        <Box>
          <Text weight="bold" style={{ marginBottom: tokens.spacing[3] }}>{t('groupRules')}</Text>
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>{t('groupRulesDescription')}</Text>
          {editRules.length > 0 && (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
              {editRules.map((rule, index) => (
                <Box key={index} style={{ padding: tokens.spacing[3], background: tokens.colors.bg.secondary, borderRadius: tokens.radius.lg, border: `1px solid ${tokens.colors.border.primary}` }}>
                  <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
                    <Text size="sm" weight="bold" color="secondary">{t('ruleNumber').replace('{n}', String(index + 1))}</Text>
                    {editMode && <Button type="button" variant="text" size="sm" onClick={() => removeRule(index)} style={{ padding: 0, color: 'var(--color-accent-error)', fontSize: tokens.typography.fontSize.xs }}>{t('delete')}</Button>}
                  </Box>
                  {editMode ? (
                    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                      <Box><Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>{t('chinese')}</Text><input type="text" value={rule.zh} onChange={(e) => updateRule(index, 'zh', e.target.value)} style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }} placeholder={t('ruleContentZhPlaceholder')} /></Box>
                      {showMultiLang && <Box><Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>English</Text><input type="text" value={rule.en} onChange={(e) => updateRule(index, 'en', e.target.value)} style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }} placeholder={t('ruleContentEnPlaceholder')} /></Box>}
                    </Box>
                  ) : (<Box><Text size="sm">{rule.zh || rule.en}</Text>{rule.en && rule.zh && <Text size="xs" color="tertiary">{rule.en}</Text>}</Box>)}
                </Box>
              ))}
            </Box>
          )}
          {editMode && (
            <Box style={{ padding: tokens.spacing[3], background: tokens.colors.bg.secondary, borderRadius: tokens.radius.lg, border: `1px dashed ${tokens.colors.border.primary}` }}>
              <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>{t('addNewRule')}</Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                <input type="text" value={newRuleZh} onChange={(e) => setNewRuleZh(e.target.value)} style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }} placeholder={t('enterRuleZh')} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRule() } }} />
                {showMultiLang && <input type="text" value={newRuleEn} onChange={(e) => setNewRuleEn(e.target.value)} style={{ ...inputStyle, padding: tokens.spacing[2], fontSize: tokens.typography.fontSize.sm }} placeholder={t('enterRuleEn')} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRule() } }} />}
                <Button type="button" variant="secondary" size="sm" onClick={addRule} disabled={!newRuleZh.trim() && !newRuleEn.trim()} style={{ alignSelf: 'flex-start' }}>+ {t('addRule')}</Button>
              </Box>
            </Box>
          )}
        </Box>

        {/* Avatar URL */}
        {editMode && (
          <Box>
            <label style={labelStyle}>{t('groupAvatarUrl')}</label>
            <input type="url" value={editAvatarUrl} onChange={(e) => setEditAvatarUrl(e.target.value)} placeholder="https://example.com/avatar.png" style={inputStyle} />
            {editAvatarUrl && <Box style={{ marginTop: tokens.spacing[2] }}><Image src={editAvatarUrl} alt="Preview" width={60} height={60} style={{ width: 60, height: 60, borderRadius: tokens.radius.lg, objectFit: 'cover', border: `1px solid ${tokens.colors.border.primary}` }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} /></Box>}
          </Box>
        )}

        {/* Pro exclusive */}
        {editMode && isPro && (
          <Box style={{ padding: tokens.spacing[4], background: 'var(--color-pro-glow)', borderRadius: tokens.radius.lg, border: '1px solid var(--color-pro-gradient-start)' }}>
            <Box style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[3] }}>
              <Box onClick={() => setIsPremiumOnly(!isPremiumOnly)} style={{ width: 20, height: 20, borderRadius: tokens.radius.sm, border: isPremiumOnly ? '2px solid var(--color-pro-gradient-start)' : '2px solid var(--color-border-secondary)', background: isPremiumOnly ? 'var(--color-pro-gradient-start)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, marginTop: 2, transition: 'all 0.2s' }}>
                {isPremiumOnly && <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--color-on-accent)" strokeWidth="3"><path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </Box>
              <Box style={{ flex: 1 }}>
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: 4 }}>
                  <Text weight="bold" style={{ color: 'var(--color-pro-gradient-start)' }}>{t('proExclusiveGroup')}</Text>
                  <Box style={{ padding: '2px 6px', borderRadius: tokens.radius.full, background: 'var(--color-pro-badge-bg)', fontSize: 10, fontWeight: 700, color: tokens.colors.white }}>Pro</Box>
                </Box>
                <Text size="sm" color="secondary" style={{ lineHeight: 1.5 }}>{t('proExclusiveGroupDesc')}</Text>
              </Box>
            </Box>
          </Box>
        )}

        {/* Role names */}
        {editMode && (
          <Box>
            <Text weight="bold" style={{ marginBottom: tokens.spacing[3] }}>{t('roleNamesSettings')}</Text>
            <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>{t('roleNamesSettingsDesc')}</Text>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
              <Box style={{ display: 'grid', gridTemplateColumns: '100px 1fr 1fr', gap: tokens.spacing[2], alignItems: 'center' }}>
                <Text size="sm" color="secondary">{t('admin')}</Text>
                <input type="text" value={editRoleNames?.admin?.zh || ''} onChange={(e) => setEditRoleNames({ ...editRoleNames, admin: { ...(editRoleNames?.admin || { zh: '', en: '' }), zh: e.target.value } })} placeholder={t('adminRolePlaceholderZh')} style={{ ...inputStyle, padding: tokens.spacing[2] }} maxLength={20} />
                <input type="text" value={editRoleNames?.admin?.en || ''} onChange={(e) => setEditRoleNames({ ...editRoleNames, admin: { ...(editRoleNames?.admin || { zh: '', en: '' }), en: e.target.value } })} placeholder={t('adminRolePlaceholderEn')} style={{ ...inputStyle, padding: tokens.spacing[2] }} maxLength={20} />
              </Box>
              <Box style={{ display: 'grid', gridTemplateColumns: '100px 1fr 1fr', gap: tokens.spacing[2], alignItems: 'center' }}>
                <Text size="sm" color="secondary">{t('groupMember')}</Text>
                <input type="text" value={editRoleNames?.member?.zh || ''} onChange={(e) => setEditRoleNames({ ...editRoleNames, member: { ...(editRoleNames?.member || { zh: '', en: '' }), zh: e.target.value } })} placeholder={t('memberRolePlaceholderZh')} style={{ ...inputStyle, padding: tokens.spacing[2] }} maxLength={20} />
                <input type="text" value={editRoleNames?.member?.en || ''} onChange={(e) => setEditRoleNames({ ...editRoleNames, member: { ...(editRoleNames?.member || { zh: '', en: '' }), en: e.target.value } })} placeholder={t('memberRolePlaceholderEn')} style={{ ...inputStyle, padding: tokens.spacing[2] }} maxLength={20} />
              </Box>
            </Box>
          </Box>
        )}

        {/* Action buttons */}
        <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end', marginTop: tokens.spacing[4] }}>
          {editMode ? (
            <>
              <Button variant="secondary" onClick={onCancelEdit} disabled={submitting}>{t('cancel')}</Button>
              <Button variant="primary" onClick={onSubmitEdit} disabled={submitting}>{submitting ? t('submitting') : t('submitChanges')}</Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => setEditMode(true)}>{t('editGroupInfo')}</Button>
          )}
        </Box>
      </Box>
    </Card>
  )
}
