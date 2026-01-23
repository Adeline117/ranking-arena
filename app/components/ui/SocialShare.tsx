'use client'

import { useState, useCallback } from 'react'
import { useLanguage } from '../Providers/LanguageProvider'
import { useToast } from './Toast'

// ============================================
// 类型定义
// ============================================

interface ShareData {
  title: string
  text?: string
  url: string
  image?: string
}

type SharePlatform = 'twitter' | 'telegram' | 'wechat' | 'weibo' | 'copy' | 'native'

// ============================================
// 分享链接生成
// ============================================

function getShareUrl(platform: SharePlatform, data: ShareData): string {
  const { title, text, url } = data
  const fullText = text ? `${title}\n${text}` : title

  switch (platform) {
    case 'twitter':
      return `https://twitter.com/intent/tweet?text=${encodeURIComponent(fullText)}&url=${encodeURIComponent(url)}`
    case 'telegram':
      return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(fullText)}`
    case 'weibo':
      return `https://service.weibo.com/share/share.php?title=${encodeURIComponent(fullText)}&url=${encodeURIComponent(url)}`
    default:
      return url
  }
}

// ============================================
// 分享按钮组件
// ============================================

interface ShareButtonProps {
  data: ShareData
  onShare?: (platform: SharePlatform) => void
  className?: string
  showLabel?: boolean
}

export function ShareButton({
  data,
  onShare,
  className = '',
  showLabel = true
}: ShareButtonProps) {
  const [showDropdown, setShowDropdown] = useState(false)
  const [copied, setCopied] = useState(false)
  const { t } = useLanguage()
  const { showToast } = useToast()

  const handleShare = useCallback(async (platform: SharePlatform) => {
    onShare?.(platform)

    if (platform === 'native' && navigator.share) {
      try {
        await navigator.share({
          title: data.title,
          text: data.text,
          url: data.url,
        })
      } catch (_err) {
        // 用户取消或不支持
      }
      setShowDropdown(false)
      return
    }

    if (platform === 'copy') {
      try {
        await navigator.clipboard.writeText(data.url)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } catch (_err) {
        // 复制失败
      }
      setShowDropdown(false)
      return
    }

    if (platform === 'wechat') {
      // 微信需要二维码，这里可以打开一个模态框显示二维码
      showToast('请截图发送给好友或扫描二维码分享', 'info')
      setShowDropdown(false)
      return
    }

    // 打开分享链接
    const shareUrl = getShareUrl(platform, data)
    window.open(shareUrl, '_blank', 'width=600,height=400')
    setShowDropdown(false)
  }, [data, onShare, showToast])

  // 检查是否支持原生分享
  const supportsNativeShare = typeof navigator !== 'undefined' && !!navigator.share

  return (
    <div className={`relative ${className}`}>
      <button
        onClick={() => supportsNativeShare ? handleShare('native') : setShowDropdown(!showDropdown)}
        className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors"
      >
        <ShareIcon />
        {showLabel && <span>{t('share') || '分享'}</span>}
      </button>

      {/* 下拉菜单 */}
      {showDropdown && (
        <>
          <div 
            className="fixed inset-0 z-40" 
            onClick={() => setShowDropdown(false)} 
          />
          <div className="absolute right-0 top-full mt-2 w-48 bg-[var(--color-bg-secondary)] border border-[var(--color-border-primary)] rounded-xl shadow-xl overflow-hidden z-50">
            <div className="p-2">
              <ShareOption
                icon={<TwitterIcon />}
                label="Twitter / X"
                onClick={() => handleShare('twitter')}
              />
              <ShareOption
                icon={<TelegramIcon />}
                label="Telegram"
                onClick={() => handleShare('telegram')}
              />
              <ShareOption
                icon={<WeiboIcon />}
                label="微博"
                onClick={() => handleShare('weibo')}
              />
              <ShareOption
                icon={<WechatIcon />}
                label="微信"
                onClick={() => handleShare('wechat')}
              />
              <div className="my-1 border-t border-[var(--color-border-primary)]" />
              <ShareOption
                icon={<CopyIcon />}
                label={copied ? '已复制!' : '复制链接'}
                onClick={() => handleShare('copy')}
                highlight={copied}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ============================================
// 邀请好友组件
// ============================================

interface InviteFriendsProps {
  referralCode?: string
  onInvite?: () => void
}

export function InviteFriends({ referralCode, onInvite }: InviteFriendsProps) {
  const [copied, setCopied] = useState(false)
  const { t: _t } = useLanguage()

  const inviteUrl = referralCode
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}/welcome?ref=${referralCode}`
    : typeof window !== 'undefined' ? window.location.origin : ''

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      onInvite?.()
    } catch (_err) {
      // 复制失败
    }
  }

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Arena - 发现顶级交易员',
          text: '我发现了一个很棒的交易员排行榜平台，快来看看！',
          url: inviteUrl,
        })
        onInvite?.()
      } catch (_err) {
        // 用户取消
      }
    }
  }

  return (
    <div className="bg-gradient-to-r from-[var(--color-accent-primary)]/20 to-purple-500/20 rounded-xl p-4 border border-[var(--color-accent-primary)]/30">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-[var(--color-accent-primary)]/30 flex items-center justify-center text-xl">
          🎁
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-bold text-[var(--color-text-primary)] mb-1">
            邀请好友，获得奖励
          </h3>
          <p className="text-xs text-[var(--color-text-secondary)] mb-3">
            每邀请一位好友注册，双方都可获得 7 天 Pro 会员体验
          </p>
          
          {/* 邀请链接 */}
          <div className="flex items-center gap-2 bg-[var(--color-bg-secondary)] rounded-lg p-2">
            <input
              type="text"
              value={inviteUrl}
              readOnly
              className="flex-1 bg-transparent text-xs text-[var(--color-text-secondary)] truncate focus:outline-none"
            />
            <button
              onClick={handleCopy}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                copied 
                  ? 'bg-[var(--color-success)] text-white' 
                  : 'bg-[var(--color-accent-primary)] text-white hover:bg-[var(--color-accent-primary)]/90'
              }`}
            >
              {copied ? '已复制' : '复制'}
            </button>
          </div>

          {/* 分享按钮 */}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={() => window.open(getShareUrl('twitter', {
                title: '我发现了一个很棒的交易员排行榜平台 @RankingArena',
                url: inviteUrl,
              }), '_blank')}
              className="flex-1 flex items-center justify-center gap-2 py-2 bg-[#1DA1F2] text-white rounded-lg text-xs font-medium hover:bg-[#1DA1F2]/90 transition-colors"
            >
              <TwitterIcon />
              Twitter
            </button>
            <button
              onClick={() => window.open(getShareUrl('telegram', {
                title: '发现顶级交易员',
                url: inviteUrl,
              }), '_blank')}
              className="flex-1 flex items-center justify-center gap-2 py-2 bg-[#0088cc] text-white rounded-lg text-xs font-medium hover:bg-[#0088cc]/90 transition-colors"
            >
              <TelegramIcon />
              Telegram
            </button>
            {typeof navigator !== 'undefined' && typeof navigator.share !== 'undefined' && (
              <button
                onClick={handleShare}
                className="px-4 py-2 bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--color-bg-hover)] transition-colors"
              >
                更多
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================
// 子组件
// ============================================

function ShareOption({ 
  icon, 
  label, 
  onClick,
  highlight = false
}: { 
  icon: React.ReactNode
  label: string
  onClick: () => void
  highlight?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
        highlight 
          ? 'bg-[var(--color-success)]/20 text-[var(--color-success)]' 
          : 'hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'
      }`}
    >
      <span className="w-5 h-5">{icon}</span>
      <span className="text-sm">{label}</span>
    </button>
  )
}

// ============================================
// 图标
// ============================================

function ShareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  )
}

function TwitterIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

function TelegramIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  )
}

function WeiboIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M10.098 20.323c-3.977.391-7.414-1.406-7.672-4.02-.259-2.609 2.759-5.047 6.74-5.441 3.979-.394 7.413 1.404 7.671 4.018.259 2.6-2.759 5.049-6.739 5.443zM9.05 17.219c-.384.616-1.208.884-1.829.602-.612-.279-.793-.991-.406-1.593.379-.595 1.176-.861 1.793-.601.622.263.82.972.442 1.592zm1.27-1.627c-.141.237-.449.353-.689.253-.236-.09-.313-.361-.177-.586.138-.227.436-.346.672-.24.239.09.315.36.194.573zm.176-2.719c-1.893-.493-4.033.45-4.857 2.118-.836 1.704-.026 3.591 1.886 4.21 1.983.64 4.318-.341 5.132-2.179.8-1.793-.201-3.642-2.161-4.149zm7.563-1.224c-.346-.105-.579-.18-.4-.649.388-1.032.428-1.922.008-2.557-.786-1.185-2.936-1.123-5.411-.032 0 0-.776.34-.578-.275.381-1.222.324-2.246-.269-2.838-1.344-1.341-4.914.047-7.978 3.103C1.634 11.196 0 13.717 0 15.897c0 4.166 5.344 6.704 10.574 6.704 6.862 0 11.426-3.986 11.426-7.146 0-1.909-1.61-2.994-2.911-3.406zm.442-4.009a3.01 3.01 0 0 1 2.308 3.142c-.066.593-.566 1.037-1.164.969a1.089 1.089 0 0 1-.969-1.161 1.047 1.047 0 0 0-.761-1.069 1.054 1.054 0 0 0-1.223.461 1.084 1.084 0 0 1-1.489.407 1.087 1.087 0 0 1-.411-1.49 3.034 3.034 0 0 1 3.709-1.259zm1.745-3.462a5.49 5.49 0 0 1 4.198 5.722c-.063.567-.565 1.004-1.164.967a1.088 1.088 0 0 1-.968-1.162 3.335 3.335 0 0 0-2.436-3.336 3.347 3.347 0 0 0-4.083 1.58 1.089 1.089 0 0 1-1.49.408c-.539-.302-.73-.973-.412-1.49a5.512 5.512 0 0 1 6.355-2.689z" />
    </svg>
  )
}

function WechatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.045c.134 0 .24-.111.24-.246 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89l-.407-.032zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

export default ShareButton
