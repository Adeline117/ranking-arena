'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/Base'
import { useToast } from '@/app/components/UI/Toast'

type Step = 'welcome' | 'profile' | 'interests' | 'complete'

const interests = [
  { id: 'btc', label: 'BTC 交易', emoji: '₿' },
  { id: 'eth', label: 'ETH 交易', emoji: 'Ξ' },
  { id: 'altcoin', label: '山寨币', emoji: '🪙' },
  { id: 'futures', label: '合约/期货', emoji: '📈' },
  { id: 'spot', label: '现货交易', emoji: '💰' },
  { id: 'defi', label: 'DeFi', emoji: '🔗' },
  { id: 'nft', label: 'NFT', emoji: '🖼' },
  { id: 'analysis', label: '技术分析', emoji: '📊' },
]

export default function WelcomePage() {
  const router = useRouter()
  const { showToast } = useToast()
  
  const [step, setStep] = useState<Step>('welcome')
  const [userId, setUserId] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  
  // Profile setup
  const [handle, setHandle] = useState('')
  const [bio, setBio] = useState('')
  const [selectedInterests, setSelectedInterests] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      
      if (!user) {
        router.push('/login')
        return
      }

      setUserId(user.id)
      setEmail(user.email || null)

      // 检查是否已完成引导
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('handle, onboarding_completed')
        .eq('id', user.id)
        .maybeSingle()

      if (profile?.onboarding_completed) {
        // 已完成引导，跳转到首页
        router.push('/')
        return
      }

      if (profile?.handle) {
        setHandle(profile.handle)
      } else if (user.email) {
        setHandle(user.email.split('@')[0])
      }

      setLoading(false)
    }

    checkAuth()
  }, [router])

  const toggleInterest = (id: string) => {
    setSelectedInterests(prev => 
      prev.includes(id) 
        ? prev.filter(i => i !== id)
        : [...prev, id]
    )
  }

  const handleSaveProfile = async () => {
    if (!handle.trim()) {
      showToast('请输入用户名', 'warning')
      return
    }

    if (handle.length < 3) {
      showToast('用户名至少3个字符', 'warning')
      return
    }

    setSaving(true)
    try {
      const { error } = await supabase
        .from('user_profiles')
        .upsert({
          id: userId,
          handle: handle.trim(),
          bio: bio.trim() || null,
        }, { onConflict: 'id' })

      if (error) {
        showToast(error.message, 'error')
        return
      }

      setStep('interests')
    } catch (error: any) {
      showToast(error?.message || '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleComplete = async () => {
    setSaving(true)
    try {
      // 保存兴趣偏好和标记完成引导
      const { error } = await supabase
        .from('user_profiles')
        .update({
          interests: selectedInterests,
          onboarding_completed: true,
        })
        .eq('id', userId)

      if (error) {
        console.error('Error saving interests:', error)
      }

      setStep('complete')
    } catch (error) {
      console.error('Error completing onboarding:', error)
      setStep('complete')
    } finally {
      setSaving(false)
    }
  }

  const handleSkipInterests = async () => {
    setSaving(true)
    try {
      await supabase
        .from('user_profiles')
        .update({ onboarding_completed: true })
        .eq('id', userId)
    } catch (error) {
      console.error('Error skipping:', error)
    } finally {
      setSaving(false)
      setStep('complete')
    }
  }

  const handleGoHome = () => {
    router.push('/')
  }

  const handleGoProfile = () => {
    router.push(`/u/${handle}`)
  }

  if (loading) {
    return (
      <Box style={{ 
        minHeight: '100vh', 
        background: tokens.colors.bg.primary, 
        color: tokens.colors.text.primary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Text size="lg">加载中...</Text>
      </Box>
    )
  }

  return (
    <Box style={{ 
      minHeight: '100vh', 
      background: '#060606', 
      color: '#f2f2f2',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
    }}>
      <Box style={{ 
        maxWidth: 520, 
        width: '100%',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid #1f1f1f',
        borderRadius: 20,
        padding: 40,
      }}>
        {/* 步骤指示器 */}
        <Box style={{ 
          display: 'flex', 
          justifyContent: 'center', 
          gap: 8, 
          marginBottom: 32,
        }}>
          {['welcome', 'profile', 'interests', 'complete'].map((s, i) => (
            <Box
              key={s}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: step === s || 
                  (step === 'profile' && i < 1) ||
                  (step === 'interests' && i < 2) ||
                  (step === 'complete' && i < 3)
                  ? '#8b6fa8'
                  : '#2a2a2a',
                transition: 'background 0.3s ease',
              }}
            />
          ))}
        </Box>

        {/* 欢迎步骤 */}
        {step === 'welcome' && (
          <Box style={{ textAlign: 'center' }}>
            <Text size="3xl" weight="black" style={{ marginBottom: 12 }}>
              🎉 欢迎加入
            </Text>
            <Text size="2xl" weight="black" style={{ marginBottom: 24, color: '#8b6fa8' }}>
              Ranking Arena
            </Text>
            <Text color="secondary" style={{ marginBottom: 32, lineHeight: 1.6 }}>
              这里汇聚了各大交易所的顶级交易员，你可以：
            </Text>
            
            <Box style={{ 
              display: 'flex', 
              flexDirection: 'column', 
              gap: 16,
              marginBottom: 40,
              textAlign: 'left',
            }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Box style={{ 
                  width: 40, 
                  height: 40, 
                  borderRadius: 10,
                  background: 'rgba(139,111,168,0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 20,
                }}>
                  📊
                </Box>
                <Box>
                  <Text weight="bold">查看交易员排名</Text>
                  <Text size="sm" color="secondary">聚合 5 大交易所实时 ROI 数据</Text>
                </Box>
              </Box>
              
              <Box style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Box style={{ 
                  width: 40, 
                  height: 40, 
                  borderRadius: 10,
                  background: 'rgba(139,111,168,0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 20,
                }}>
                  ⭐
                </Box>
                <Box>
                  <Text weight="bold">关注优秀交易员</Text>
                  <Text size="sm" color="secondary">追踪他们的动态和策略分享</Text>
                </Box>
              </Box>
              
              <Box style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Box style={{ 
                  width: 40, 
                  height: 40, 
                  borderRadius: 10,
                  background: 'rgba(139,111,168,0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 20,
                }}>
                  💬
                </Box>
                <Box>
                  <Text weight="bold">参与社区讨论</Text>
                  <Text size="sm" color="secondary">与其他交易者交流心得</Text>
                </Box>
              </Box>
            </Box>

            <Button
              variant="primary"
              size="lg"
              onClick={() => setStep('profile')}
              style={{ width: '100%' }}
            >
              开始设置
            </Button>
          </Box>
        )}

        {/* 设置资料步骤 */}
        {step === 'profile' && (
          <Box>
            <Text size="2xl" weight="black" style={{ marginBottom: 8, textAlign: 'center' }}>
              设置你的资料
            </Text>
            <Text color="secondary" style={{ marginBottom: 32, textAlign: 'center' }}>
              让其他用户更容易找到你
            </Text>

            <Box style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <Box>
                <Text size="sm" weight="bold" style={{ marginBottom: 8, display: 'block' }}>
                  用户名 *
                </Text>
                <input
                  type="text"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  placeholder="输入用户名（至少3个字符）"
                  style={{
                    width: '100%',
                    padding: '12px 16px',
                    borderRadius: 12,
                    border: '1px solid #1f1f1f',
                    background: '#0b0b0b',
                    color: '#eaeaea',
                    fontSize: 14,
                    outline: 'none',
                  }}
                />
              </Box>

              <Box>
                <Text size="sm" weight="bold" style={{ marginBottom: 8, display: 'block' }}>
                  个人简介（可选）
                </Text>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="介绍一下你自己，比如交易风格、经验等..."
                  rows={4}
                  style={{
                    width: '100%',
                    padding: '12px 16px',
                    borderRadius: 12,
                    border: '1px solid #1f1f1f',
                    background: '#0b0b0b',
                    color: '#eaeaea',
                    fontSize: 14,
                    outline: 'none',
                    resize: 'none',
                    lineHeight: 1.5,
                  }}
                />
              </Box>
            </Box>

            <Box style={{ display: 'flex', gap: 12, marginTop: 32 }}>
              <Button
                variant="ghost"
                onClick={() => setStep('welcome')}
                style={{ flex: 1 }}
              >
                返回
              </Button>
              <Button
                variant="primary"
                onClick={handleSaveProfile}
                disabled={saving || !handle.trim() || handle.length < 3}
                style={{ flex: 2 }}
              >
                {saving ? '保存中...' : '下一步'}
              </Button>
            </Box>
          </Box>
        )}

        {/* 选择兴趣步骤 */}
        {step === 'interests' && (
          <Box>
            <Text size="2xl" weight="black" style={{ marginBottom: 8, textAlign: 'center' }}>
              选择你的兴趣
            </Text>
            <Text color="secondary" style={{ marginBottom: 32, textAlign: 'center' }}>
              帮助我们为你推荐更相关的内容
            </Text>

            <Box style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 12,
              marginBottom: 32,
            }}>
              {interests.map((interest) => (
                <Box
                  key={interest.id}
                  onClick={() => toggleInterest(interest.id)}
                  style={{
                    padding: '14px 16px',
                    borderRadius: 12,
                    border: selectedInterests.includes(interest.id) 
                      ? '1px solid #8b6fa8' 
                      : '1px solid #1f1f1f',
                    background: selectedInterests.includes(interest.id)
                      ? 'rgba(139,111,168,0.15)'
                      : 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    transition: 'all 0.2s ease',
                  }}
                >
                  <span style={{ fontSize: 20 }}>{interest.emoji}</span>
                  <Text size="sm" weight="bold">{interest.label}</Text>
                </Box>
              ))}
            </Box>

            <Box style={{ display: 'flex', gap: 12 }}>
              <Button
                variant="ghost"
                onClick={handleSkipInterests}
                disabled={saving}
                style={{ flex: 1 }}
              >
                跳过
              </Button>
              <Button
                variant="primary"
                onClick={handleComplete}
                disabled={saving}
                style={{ flex: 2 }}
              >
                {saving ? '保存中...' : '完成'}
              </Button>
            </Box>
          </Box>
        )}

        {/* 完成步骤 */}
        {step === 'complete' && (
          <Box style={{ textAlign: 'center' }}>
            <Box style={{ 
              fontSize: 64, 
              marginBottom: 24,
            }}>
              🎊
            </Box>
            <Text size="2xl" weight="black" style={{ marginBottom: 12 }}>
              设置完成！
            </Text>
            <Text color="secondary" style={{ marginBottom: 32 }}>
              欢迎来到 Ranking Arena，开始你的探索之旅吧！
            </Text>

            <Box style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Button
                variant="primary"
                size="lg"
                onClick={handleGoHome}
                style={{ width: '100%' }}
              >
                探索交易员排名
              </Button>
              <Button
                variant="ghost"
                onClick={handleGoProfile}
                style={{ width: '100%' }}
              >
                查看我的主页
              </Button>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  )
}

