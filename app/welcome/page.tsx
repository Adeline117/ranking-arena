'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../components/base'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type Step = 'welcome' | 'interests' | 'complete'

const interests = [
  { id: 'btc', label: 'BTC 交易', labelEn: 'BTC Trading', icon: '₿' },
  { id: 'eth', label: 'ETH 交易', labelEn: 'ETH Trading', icon: 'Ξ' },
  { id: 'altcoin', label: '山寨币', labelEn: 'Altcoins', icon: '◈' },
  { id: 'futures', label: '合约/期货', labelEn: 'Futures', icon: '⟡' },
  { id: 'spot', label: '现货交易', labelEn: 'Spot', icon: '◉' },
  { id: 'defi', label: 'DeFi', labelEn: 'DeFi', icon: '⬡' },
  { id: 'nft', label: 'NFT', labelEn: 'NFT', icon: '◇' },
  { id: 'analysis', label: '技术分析', labelEn: 'Analysis', icon: '' },
]

// CSS keyframe animations
const injectStyles = () => {
  if (typeof window === 'undefined') return
  if (document.getElementById('welcome-page-styles')) return
  
  const style = document.createElement('style')
  style.id = 'welcome-page-styles'
  style.textContent = `
    @keyframes welcomeGradient {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }
    
    @keyframes stepEnter {
      from { 
        opacity: 0; 
        transform: translateX(40px);
      }
      to { 
        opacity: 1; 
        transform: translateX(0);
      }
    }
    
    @keyframes stepExit {
      from { 
        opacity: 1; 
        transform: translateX(0);
      }
      to { 
        opacity: 0; 
        transform: translateX(-40px);
      }
    }
    
    @keyframes cardFloat {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-8px); }
    }
    
    @keyframes featureItem {
      from { 
        opacity: 0; 
        transform: translateY(20px);
      }
      to { 
        opacity: 1; 
        transform: translateY(0);
      }
    }
    
    @keyframes progressPulse {
      0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(139, 111, 168, 0.4); }
      50% { transform: scale(1.1); box-shadow: 0 0 0 8px rgba(139, 111, 168, 0); }
    }
    
    @keyframes interestHover {
      from { transform: scale(1); }
      to { transform: scale(1.02); }
    }
    
    @keyframes celebrationBurst {
      0% { transform: scale(0); opacity: 0; }
      50% { transform: scale(1.2); opacity: 1; }
      100% { transform: scale(1); opacity: 1; }
    }
    
    @keyframes checkDraw {
      from { stroke-dashoffset: 50; }
      to { stroke-dashoffset: 0; }
    }
    
    @keyframes confetti {
      0% { transform: translateY(0) rotate(0deg); opacity: 1; }
      100% { transform: translateY(100px) rotate(720deg); opacity: 0; }
    }
    
    @keyframes floatParticle {
      0%, 100% { transform: translateY(0px) rotate(0deg); opacity: 0.3; }
      50% { transform: translateY(-15px) rotate(180deg); opacity: 0.5; }
    }
    
    .welcome-page-bg {
      position: fixed;
      inset: 0;
      background: linear-gradient(135deg, #0a0a0f 0%, #13111a 50%, #0f0d14 100%);
      z-index: 0;
    }
    
    .welcome-page-bg::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(ellipse at center, rgba(139, 111, 168, 0.06) 0%, transparent 50%);
      animation: welcomeGradient 25s ease infinite;
    }
    
    .welcome-card {
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }
    
    .step-content {
      animation: stepEnter 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    
    .step-content.exiting {
      animation: stepExit 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    
    .feature-item {
      animation: featureItem 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
      opacity: 0;
    }
    
    .progress-dot.active {
      animation: progressPulse 2s ease infinite;
    }
    
    .interest-card {
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .interest-card:hover {
      transform: translateY(-2px);
    }
    
    .interest-card.selected {
      animation: interestHover 0.2s ease forwards;
    }
    
    .celebration-icon {
      animation: celebrationBurst 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    }
    
    .check-animation {
      stroke-dasharray: 50;
      stroke-dashoffset: 50;
      animation: checkDraw 0.5s ease 0.3s forwards;
    }
    
    .confetti-particle {
      position: absolute;
      animation: confetti 1.5s ease forwards;
    }
    
    .floating-particle {
      position: absolute;
      border-radius: 50%;
      background: linear-gradient(135deg, rgba(139, 111, 168, 0.3), rgba(139, 111, 168, 0.1));
      animation: floatParticle 6s ease-in-out infinite;
    }
    
    .welcome-button {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .welcome-button:not(:disabled):hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 30px rgba(139, 111, 168, 0.4);
    }
    
    .welcome-button:not(:disabled):active {
      transform: translateY(0) scale(0.98);
    }
    
    .welcome-input {
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    
    .welcome-input:focus {
      border-color: #8b6fa8 !important;
      box-shadow: 0 0 0 4px rgba(139, 111, 168, 0.1);
      background: rgba(139, 111, 168, 0.05) !important;
    }
  `
  document.head.appendChild(style)
}

export default function WelcomePage() {
  const router = useRouter()
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  
  const [step, setStep] = useState<Step>('welcome')
  const [_prevStep, setPrevStep] = useState<Step | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [_email, setEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [mounted, setMounted] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  
  // Profile setup
  const [handle, setHandle] = useState('')
  const [selectedInterests, setSelectedInterests] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [showConfetti, setShowConfetti] = useState(false)

  useEffect(() => {
    injectStyles()
    setMounted(true)
  }, [])

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      
      if (!user) {
        router.push('/login')
        return
      }

      setUserId(user.id)
      setEmail(user.email || null)

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('handle, onboarding_completed')
        .eq('id', user.id)
        .maybeSingle()

      if (profile?.onboarding_completed) {
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

  const goToStep = (newStep: Step) => {
    setTransitioning(true)
    setPrevStep(step)
    setTimeout(() => {
      setStep(newStep)
      setTransitioning(false)
    }, 300)
  }

  const toggleInterest = (id: string) => {
    setSelectedInterests(prev => 
      prev.includes(id) 
        ? prev.filter(i => i !== id)
        : [...prev, id]
    )
  }

  const handleComplete = async () => {
    if (!userId) {
      showToast(t('userNotLoggedIn'), 'error')
      return
    }

    setSaving(true)
    try {
      const { error } = await supabase
        .from('user_profiles')
        .update({
          interests: selectedInterests,
          onboarding_completed: true,
        })
        .eq('id', userId)

      if (error) {
        console.error('Error saving interests:', error)
        const errorMsg = error.message || t('saveFailed')
        showToast(errorMsg, 'error')
        setSaving(false)
        return
      }

      setShowConfetti(true)
      goToStep('complete')
    } catch (error: unknown) {
      console.error('Error completing onboarding:', error)
      const errorMsg = error instanceof Error ? error.message : t('networkError')
      showToast(errorMsg, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleSkipInterests = async () => {
    if (!userId) {
      showToast(t('userNotLoggedIn'), 'error')
      return
    }

    setSaving(true)
    try {
      const { error } = await supabase
        .from('user_profiles')
        .update({ onboarding_completed: true })
        .eq('id', userId)

      if (error) {
        console.error('Error skipping:', error)
        const errorMsg = error.message || t('saveFailed')
        showToast(errorMsg, 'error')
        setSaving(false)
        return
      }

      setShowConfetti(true)
      goToStep('complete')
    } catch (error: unknown) {
      console.error('Error skipping:', error)
      const errorMsg = error instanceof Error ? error.message : t('networkError')
      showToast(errorMsg, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleGoHome = () => {
    router.push('/')
  }

  const handleGoProfile = () => {
    router.push(`/u/${handle}`)
  }

  const getStepIndex = (s: Step) => {
    const steps = ['welcome', 'interests', 'complete']
    return steps.indexOf(s)
  }

  if (loading || !mounted) {
    return (
      <Box style={{ 
        minHeight: '100vh', 
        background: '#0a0a0f', 
        color: tokens.colors.text.primary,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <div style={{
          width: 40,
          height: 40,
          border: '3px solid rgba(139, 111, 168, 0.2)',
          borderTopColor: '#8b6fa8',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </Box>
    )
  }

  // Confetti particles
  const ConfettiParticles = () => (
    <>
      {showConfetti && [...Array(12)].map((_, i) => (
        <div
          key={i}
          className="confetti-particle"
          style={{
            left: `${30 + Math.random() * 40}%`,
            top: '30%',
            width: 8,
            height: 8,
            borderRadius: Math.random() > 0.5 ? '50%' : '2px',
            background: ['#8b6fa8', '#c9b8db', '#6b4f88', '#ff7c7c', '#2fe57d'][Math.floor(Math.random() * 5)],
            animationDelay: `${i * 0.1}s`,
          }}
        />
      ))}
    </>
  )

  return (
    <Box style={{ 
      minHeight: '100vh', 
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Animated background */}
      <div className="welcome-page-bg" />
      
      {/* Floating particles */}
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="floating-particle"
          style={{
            width: 6 + i * 3,
            height: 6 + i * 3,
            left: `${15 + i * 18}%`,
            top: `${25 + (i % 3) * 20}%`,
            animationDelay: `${i * 0.7}s`,
            animationDuration: `${5 + i}s`,
          }}
        />
      ))}
      
      <Box 
        className="welcome-card"
        style={{ 
          maxWidth: 540, 
          width: '100%',
          background: 'rgba(15, 15, 20, 0.85)',
          border: '1px solid rgba(139, 111, 168, 0.15)',
          borderRadius: 28,
          padding: '48px 44px',
          position: 'relative',
          zIndex: 1,
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 100px rgba(139, 111, 168, 0.06)',
        }}
      >
        {/* Confetti */}
        <ConfettiParticles />
        
        {/* Progress indicator */}
        <Box style={{ 
          display: 'flex', 
          justifyContent: 'center', 
          gap: 12, 
          marginBottom: 40,
        }}>
          {['welcome', 'interests', 'complete'].map((s, i) => {
            const isActive = s === step
            const isPast = getStepIndex(step) > i
            
            return (
              <Box
                key={s}
                className={`progress-dot ${isActive ? 'active' : ''}`}
                style={{
                  width: isActive ? 28 : 10,
                  height: 10,
                  borderRadius: 5,
                  background: isPast || isActive
                    ? 'linear-gradient(135deg, #8b6fa8 0%, #6b4f88 100%)'
                    : 'rgba(255, 255, 255, 0.1)',
                  transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
                }}
              />
            )
          })}
        </Box>

        {/* Step content */}
        <div 
          key={step}
          className={`step-content ${transitioning ? 'exiting' : ''}`}
        >
          {/* Welcome step */}
          {step === 'welcome' && (
            <Box style={{ textAlign: 'center' }}>
              <Text 
                size="3xl" 
                weight="black" 
                style={{ 
                  marginBottom: 8,
                  background: 'linear-gradient(135deg, #f2f2f2 0%, #c9b8db 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                {t('welcomeJoin')}
              </Text>
              <Text 
                size="2xl" 
                weight="black" 
                style={{ 
                  marginBottom: 28,
                  background: 'linear-gradient(135deg, #8b6fa8 0%, #c9b8db 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                Arena
              </Text>
              <Text color="secondary" style={{ marginBottom: 36, lineHeight: 1.7, color: '#8a8a8a' }}>
                {t('welcomeDesc')}
              </Text>
              
              <Box style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                gap: 18,
                marginBottom: 44,
                textAlign: 'left',
              }}>
                {[
                  { num: 1, title: t('stepViewRanking'), desc: t('stepViewRankingDesc') },
                  { num: 2, title: t('stepFollowTraders'), desc: t('stepFollowTradersDesc') },
                  { num: 3, title: t('stepJoinCommunity'), desc: t('stepJoinCommunityDesc') },
                ].map((item, idx) => (
                  <Box 
                    key={item.num}
                    className="feature-item"
                    style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: 16,
                      animationDelay: `${0.2 + idx * 0.15}s`,
                      padding: '14px 16px',
                      borderRadius: 14,
                      background: 'rgba(139, 111, 168, 0.05)',
                      border: '1px solid rgba(139, 111, 168, 0.1)',
                    }}
                  >
                    <Box style={{ 
                      width: 44, 
                      height: 44, 
                      borderRadius: 12,
                      background: 'linear-gradient(135deg, rgba(139, 111, 168, 0.2) 0%, rgba(139, 111, 168, 0.1) 100%)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 15,
                      fontWeight: 800,
                      color: '#c9b8db',
                      flexShrink: 0,
                    }}>
                      {item.num}
                    </Box>
                    <Box>
                      <Text weight="bold" style={{ marginBottom: 2, color: '#eaeaea' }}>{item.title}</Text>
                      <Text size="sm" style={{ color: '#7a7a7a' }}>{item.desc}</Text>
                    </Box>
                  </Box>
                ))}
              </Box>

              <button
                className="welcome-button"
                onClick={() => goToStep('interests')}
                style={{ 
                  width: '100%',
                  padding: '16px 24px',
                  borderRadius: 14,
                  border: 'none',
                  background: 'linear-gradient(135deg, #8b6fa8 0%, #6b4f88 100%)',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 16,
                  cursor: 'pointer',
                }}
              >
                {t('startSetup')}
              </button>
            </Box>
          )}

          {/* Interests step */}
          {step === 'interests' && (
            <Box>
              <Text 
                size="2xl" 
                weight="black" 
                style={{ 
                  marginBottom: 8, 
                  textAlign: 'center',
                  background: 'linear-gradient(135deg, #f2f2f2 0%, #c9b8db 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                {t('selectInterests')}
              </Text>
              <Text color="secondary" style={{ marginBottom: 32, textAlign: 'center', color: '#7a7a7a' }}>
                {t('selectInterestsDesc')}
              </Text>

              <Box style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 14,
                marginBottom: 36,
              }}>
                {interests.map((interest, idx) => {
                  const isSelected = selectedInterests.includes(interest.id)
                  return (
                    <Box
                      key={interest.id}
                      onClick={() => toggleInterest(interest.id)}
                      className={`interest-card ${isSelected ? 'selected' : ''}`}
                      style={{
                        padding: '16px 18px',
                        borderRadius: 14,
                        border: isSelected 
                          ? '1px solid rgba(139, 111, 168, 0.5)' 
                          : '1px solid rgba(255, 255, 255, 0.1)',
                        background: isSelected
                          ? 'linear-gradient(135deg, rgba(139, 111, 168, 0.2) 0%, rgba(139, 111, 168, 0.1) 100%)'
                          : 'rgba(0, 0, 0, 0.2)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        animationDelay: `${idx * 0.05}s`,
                      }}
                    >
                      <span style={{ 
                        fontSize: 18, 
                        opacity: isSelected ? 1 : 0.6,
                        transition: 'opacity 0.2s ease',
                      }}>
                        {interest.icon}
                      </span>
                      <Text 
                        size="sm" 
                        weight={isSelected ? "bold" : "medium"}
                        style={{ color: isSelected ? '#c9b8db' : '#9a9a9a' }}
                      >
                        {language === 'en' ? interest.labelEn : interest.label}
                      </Text>
                    </Box>
                  )
                })}
              </Box>

              <Box style={{ display: 'flex', gap: 14 }}>
                <button
                  className="welcome-button"
                  onClick={handleSkipInterests}
                  disabled={saving}
                  style={{ 
                    flex: 1,
                    padding: '14px 20px',
                    borderRadius: 12,
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    background: 'transparent',
                    color: '#b0b0b0',
                    fontWeight: 600,
                    fontSize: 15,
                    cursor: saving ? 'not-allowed' : 'pointer',
                  }}
                >
                  {t('skip')}
                </button>
                <button
                  className="welcome-button"
                  onClick={handleComplete}
                  disabled={saving}
                  style={{ 
                    flex: 2,
                    padding: '14px 20px',
                    borderRadius: 12,
                    border: 'none',
                    background: saving 
                      ? 'rgba(139, 111, 168, 0.2)' 
                      : 'linear-gradient(135deg, #8b6fa8 0%, #6b4f88 100%)',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: 15,
                    cursor: saving ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  {saving && (
                    <div style={{
                      width: 16,
                      height: 16,
                      border: '2px solid rgba(255,255,255,0.3)',
                      borderTopColor: '#fff',
                      borderRadius: '50%',
                      animation: 'spin 1s linear infinite',
                    }} />
                  )}
                  {saving ? t('saving') : t('complete')}
                </button>
              </Box>
            </Box>
          )}

          {/* Complete step */}
          {step === 'complete' && (
            <Box style={{ textAlign: 'center' }}>
              <Box 
                className="celebration-icon"
                style={{ 
                  width: 80, 
                  height: 80,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, rgba(139, 111, 168, 0.3) 0%, rgba(139, 111, 168, 0.1) 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 28px',
                  boxShadow: '0 0 40px rgba(139, 111, 168, 0.3)',
                }}
              >
                <svg 
                  width="40" 
                  height="40" 
                  viewBox="0 0 24 24" 
                  fill="none" 
                  stroke="#c9b8db" 
                  strokeWidth="2.5" 
                  strokeLinecap="round" 
                  strokeLinejoin="round"
                >
                  <polyline className="check-animation" points="20 6 9 17 4 12"></polyline>
                </svg>
              </Box>
              <Text 
                size="2xl" 
                weight="black" 
                style={{ 
                  marginBottom: 12,
                  background: 'linear-gradient(135deg, #f2f2f2 0%, #c9b8db 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                {t('setupComplete')}
              </Text>
              <Text color="secondary" style={{ marginBottom: 36, color: '#7a7a7a' }}>
                {t('welcomeToArena')}
              </Text>

              <Box style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <button
                  className="welcome-button"
                  onClick={handleGoHome}
                  style={{ 
                    width: '100%',
                    padding: '16px 24px',
                    borderRadius: 14,
                    border: 'none',
                    background: 'linear-gradient(135deg, #8b6fa8 0%, #6b4f88 100%)',
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: 16,
                    cursor: 'pointer',
                  }}
                >
                  {t('exploreRanking')}
                </button>
                <button
                  className="welcome-button"
                  onClick={handleGoProfile}
                  style={{ 
                    width: '100%',
                    padding: '14px 20px',
                    borderRadius: 12,
                    border: '1px solid rgba(139, 111, 168, 0.3)',
                    background: 'transparent',
                    color: '#b0b0b0',
                    fontWeight: 600,
                    fontSize: 15,
                    cursor: 'pointer',
                  }}
                >
                  {t('viewMyProfile')}
                </button>
              </Box>
            </Box>
          )}
        </div>
        
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </Box>
    </Box>
  )
}
