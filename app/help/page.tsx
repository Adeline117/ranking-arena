'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'
import ContactSupportButton from '@/app/components/UI/ContactSupportButton'

// FAQ 数据
const getFaqData = (language: string) => {
  const isZh = language === 'zh'
  
  return {
    subscription: {
      title: isZh ? '订阅与付款' : 'Subscription & Payment',
      items: [
        {
          q: isZh ? '如何升级到 Pro 会员？' : 'How do I upgrade to Pro membership?',
          a: isZh 
            ? '登录后，点击顶部导航栏的「Pro」按钮或访问定价页面，选择月付或年付计划，完成支付即可立即生效。' 
            : 'After logging in, click the "Pro" button in the top navigation or visit the pricing page, select a monthly or yearly plan, and complete the payment to activate immediately.',
        },
        {
          q: isZh ? '支持哪些支付方式？' : 'What payment methods are supported?',
          a: isZh 
            ? '我们支持 Visa、Mastercard 信用卡/借记卡，以及支付宝和微信支付。' 
            : 'We support Visa and Mastercard credit/debit cards, as well as Alipay and WeChat Pay.',
        },
        {
          q: isZh ? '订阅后可以退款吗？' : 'Can I get a refund after subscribing?',
          a: isZh 
            ? '根据我们的退款政策，7天内如未使用任何 Pro 功能可申请全额退款。请联系客服处理。' 
            : 'According to our refund policy, you can request a full refund within 7 days if you haven\'t used any Pro features. Please contact support.',
        },
        {
          q: isZh ? '如何取消订阅？' : 'How do I cancel my subscription?',
          a: isZh 
            ? '进入「设置」>「账单」页面，点击「管理订阅」即可在 Stripe 客户门户中取消订阅。取消后可继续使用至当前计费周期结束。' 
            : 'Go to "Settings" > "Billing" and click "Manage Subscription" to cancel in the Stripe customer portal. After cancellation, you can continue using until the end of the current billing period.',
        },
        {
          q: isZh ? '年付和月付有什么区别？' : 'What\'s the difference between yearly and monthly plans?',
          a: isZh 
            ? '年付可节省约 17% 的费用，相当于免费使用 2 个月。功能完全相同，仅计费周期不同。' 
            : 'The yearly plan saves about 17%, equivalent to 2 months free. Features are identical, only the billing cycle differs.',
        },
      ],
    },
    features: {
      title: isZh ? 'Pro 功能说明' : 'Pro Features',
      items: [
        {
          q: isZh ? '分类排行有什么作用？' : 'What does Category Ranking do?',
          a: isZh 
            ? '分类排行让你可以按合约、现货、链上三种类型单独查看排行榜，更精准地找到符合你交易风格的交易员。' 
            : 'Category Ranking allows you to view rankings separately by Futures, Spot, and On-chain types, helping you find traders that match your trading style more precisely.',
        },
        {
          q: isZh ? '交易员对比功能如何使用？' : 'How do I use the Trader Comparison feature?',
          a: isZh 
            ? '在首页点击「交易员对比」按钮进入对比页面，搜索并添加最多 5 位交易员，系统会并排展示他们的各项指标。' 
            : 'Click the "Compare Traders" button on the homepage, search and add up to 5 traders, and the system will display their metrics side by side.',
        },
        {
          q: isZh ? '交易员变动提醒是什么？' : 'What are Trader Alerts?',
          a: isZh 
            ? '当你关注的交易员出现大幅排名变动、ROI 波动或其他重要变化时，系统会自动发送站内私信提醒你。' 
            : 'When traders you follow experience significant ranking changes, ROI fluctuations, or other important changes, the system will automatically send you private message alerts.',
        },
        {
          q: isZh ? 'Arena Score 详情显示什么？' : 'What does Arena Score Breakdown show?',
          a: isZh 
            ? '评分详情展示交易员的收益分、回撤分、稳定分三个子分数，以及该交易员在同类型交易员中的分位排名。' 
            : 'Score Breakdown shows a trader\'s Return Score, Drawdown Score, and Stability Score, along with their percentile ranking among traders of the same type.',
        },
        {
          q: isZh ? '高级筛选可以做什么？' : 'What can Advanced Filter do?',
          a: isZh 
            ? '高级筛选支持多条件叠加：交易类型 × 收益区间 × 回撤区间 × 周期 × 交易所，还可保存筛选配置一键复用。' 
            : 'Advanced Filter supports multiple conditions: Trading Type × ROI Range × Drawdown Range × Period × Exchange. You can also save filter configurations for one-click reuse.',
        },
        {
          q: isZh ? 'Pro 群组是什么？' : 'What are Pro Groups?',
          a: isZh 
            ? 'Pro 群组是仅限 Pro 会员参与的专属社群。群组创建者和成员都需要是 Pro 会员才能加入。' 
            : 'Pro Groups are exclusive communities for Pro members only. Both group creators and members need to be Pro members to join.',
        },
        {
          q: isZh ? 'Pro 会员官方群是什么？' : 'What is the Pro Member Official Group?',
          a: isZh 
            ? '成为 Pro 会员后，你会自动加入 Arena 官方会员群（每群上限 500 人）。在群里可以与其他会员交流、反馈问题，官方团队会直接在群里回复。取消订阅后会自动退群。' 
            : 'After becoming a Pro member, you will automatically join the Arena official member group (max 500 members per group). You can chat with other members, give feedback, and get direct responses from the official team. You will be automatically removed when you cancel your subscription.',
        },
      ],
    },
    account: {
      title: isZh ? '账户与安全' : 'Account & Security',
      items: [
        {
          q: isZh ? '如何修改密码？' : 'How do I change my password?',
          a: isZh 
            ? '进入「设置」页面，在「安全」部分输入当前密码和新密码即可修改。' 
            : 'Go to "Settings" and enter your current password and new password in the "Security" section.',
        },
        {
          q: isZh ? '如何绑定交易所账户？' : 'How do I connect my exchange account?',
          a: isZh 
            ? '首页顶部有快速绑定入口，或在设置页面选择交易所并按提示完成 API 绑定。只需只读权限，无需交易权限。' 
            : 'There\'s a quick connect option at the top of the homepage, or go to Settings and follow the prompts to connect your exchange API. Only read-only permission is needed, no trading permission required.',
        },
        {
          q: isZh ? '我的数据安全吗？' : 'Is my data secure?',
          a: isZh 
            ? '是的，我们使用行业标准的加密技术保护你的数据。交易所 API 只需只读权限，无法进行任何交易操作。' 
            : 'Yes, we use industry-standard encryption to protect your data. Exchange APIs only require read-only permission and cannot perform any trading operations.',
        },
        {
          q: isZh ? 'Pro 徽章如何显示/隐藏？' : 'How do I show/hide my Pro badge?',
          a: isZh 
            ? '进入「设置」>「隐私」页面，找到「显示 Pro 徽章」选项进行开关。' 
            : 'Go to "Settings" > "Privacy" and find the "Show Pro Badge" option to toggle it.',
        },
      ],
    },
    contact: {
      title: isZh ? '联系我们' : 'Contact Us',
      items: [
        {
          q: isZh ? '如何联系客服？' : 'How do I contact support?',
          a: isZh 
            ? '你可以点击本页上方的「联系客服」按钮，通过站内私信与我们联系。我们通常会在 24 小时内回复。' 
            : 'You can click the "Contact Support" button above to send us a private message. We typically respond within 24 hours.',
        },
        {
          q: isZh ? '如何反馈产品建议？' : 'How do I submit product feedback?',
          a: isZh 
            ? '我们非常欢迎你的建议！可以在社区发帖或通过站内私信告诉我们。' 
            : 'We welcome your suggestions! You can post in the community or send us a private message.',
        },
      ],
    },
  }
}

// 展开/收起图标
const ChevronIcon = ({ isOpen }: { isOpen: boolean }) => (
  <svg 
    width={20} 
    height={20} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2"
    style={{
      transition: 'transform 0.2s',
      transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
    }}
  >
    <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

// FAQ 项组件
function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <Box
      style={{
        borderBottom: '1px solid var(--color-border-primary)',
      }}
    >
      <Box
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${tokens.spacing[4]} 0`,
          cursor: 'pointer',
          transition: 'color 0.2s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--color-pro-gradient-start)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--color-text-primary)'
        }}
      >
        <Text size="sm" weight="semibold" style={{ flex: 1, paddingRight: tokens.spacing[3] }}>
          {question}
        </Text>
        <Box style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
          <ChevronIcon isOpen={isOpen} />
        </Box>
      </Box>
      
      {isOpen && (
        <Box
          style={{
            paddingBottom: tokens.spacing[4],
            paddingRight: tokens.spacing[6],
            animation: 'fadeIn 0.2s ease-out',
          }}
        >
          <Text size="sm" color="secondary" style={{ lineHeight: 1.7 }}>
            {answer}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// FAQ 分类组件
function FaqSection({ title, items }: { title: string; items: Array<{ q: string; a: string }> }) {
  return (
    <Box
      style={{
        marginBottom: tokens.spacing[6],
      }}
    >
      <Text 
        size="lg" 
        weight="bold" 
        style={{ 
          marginBottom: tokens.spacing[4],
          paddingBottom: tokens.spacing[2],
          borderBottom: '2px solid var(--color-pro-gradient-start)',
          display: 'inline-block',
        }}
      >
        {title}
      </Text>
      <Box>
        {items.map((item, idx) => (
          <FaqItem key={idx} question={item.q} answer={item.a} />
        ))}
      </Box>
    </Box>
  )
}

export default function HelpPage() {
  const { language, t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  
  const faqData = getFaqData(language)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: 'var(--color-bg-primary)',
        color: 'var(--color-text-primary)',
      }}
    >
      {/* Background */}
      <Box
        style={{
          position: 'fixed',
          inset: 0,
          background: `radial-gradient(ellipse at 30% 20%, var(--color-pro-glow) 0%, transparent 50%),
                       radial-gradient(ellipse at 70% 80%, rgba(139, 111, 168, 0.05) 0%, transparent 50%)`,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />

      <TopNav email={email} />

      <Box
        style={{
          maxWidth: 800,
          margin: '0 auto',
          padding: tokens.spacing[6],
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* 标题 */}
        <Box style={{ textAlign: 'center', marginBottom: tokens.spacing[8] }}>
          <Text 
            as="h1" 
            size="3xl" 
            weight="black" 
            style={{ marginBottom: tokens.spacing[3] }}
          >
            {language === 'zh' ? '帮助中心' : 'Help Center'}
          </Text>
          <Text size="md" color="secondary">
            {language === 'zh' 
              ? '常见问题解答，帮助你快速上手' 
              : 'Frequently asked questions to help you get started'}
          </Text>
        </Box>

        {/* 快速操作 */}
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: tokens.spacing[4],
            marginBottom: tokens.spacing[8],
          }}
        >
          <Link href="/pricing" style={{ textDecoration: 'none' }}>
            <Box
              style={{
                padding: tokens.spacing[4],
                background: 'var(--color-pro-glow)',
                borderRadius: tokens.radius.lg,
                border: '1px solid var(--color-pro-gradient-start)',
                textAlign: 'center',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)'
                e.currentTarget.style.boxShadow = '0 8px 24px var(--color-pro-badge-shadow)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)'
                e.currentTarget.style.boxShadow = 'none'
              }}
            >
              <Box style={{ marginBottom: tokens.spacing[2] }}>
                <svg width={24} height={24} viewBox="0 0 24 24" fill="var(--color-pro-gradient-start)">
                  <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                </svg>
              </Box>
              <Text size="sm" weight="bold" style={{ color: 'var(--color-pro-gradient-start)' }}>
                {language === 'zh' ? '升级 Pro' : 'Upgrade to Pro'}
              </Text>
            </Box>
          </Link>

          <Link href="/settings" style={{ textDecoration: 'none' }}>
            <Box
              style={{
                padding: tokens.spacing[4],
                background: 'var(--color-bg-secondary)',
                borderRadius: tokens.radius.lg,
                border: '1px solid var(--color-border-primary)',
                textAlign: 'center',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-text-tertiary)'
                e.currentTarget.style.transform = 'translateY(-2px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border-primary)'
                e.currentTarget.style.transform = 'translateY(0)'
              }}
            >
              <Box style={{ marginBottom: tokens.spacing[2] }}>
                <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="var(--color-text-secondary)" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </Box>
              <Text size="sm" weight="bold" color="secondary">
                {language === 'zh' ? '账户设置' : 'Account Settings'}
              </Text>
            </Box>
          </Link>

          <ContactSupportButton 
            variant="card" 
            label={language === 'zh' ? '联系客服' : 'Contact Support'} 
          />
        </Box>

        {/* FAQ 内容 */}
        <Box
          style={{
            background: 'var(--color-bg-secondary)',
            borderRadius: tokens.radius.xl,
            border: '1px solid var(--color-border-primary)',
            padding: tokens.spacing[6],
          }}
        >
          <FaqSection title={faqData.subscription.title} items={faqData.subscription.items} />
          <FaqSection title={faqData.features.title} items={faqData.features.items} />
          <FaqSection title={faqData.account.title} items={faqData.account.items} />
          <FaqSection title={faqData.contact.title} items={faqData.contact.items} />
        </Box>

        {/* 底部 */}
        <Box style={{ textAlign: 'center', marginTop: tokens.spacing[8], display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" color="tertiary">
            {language === 'zh' 
              ? '没有找到答案？' 
              : 'Didn\'t find an answer?'}
          </Text>
          <ContactSupportButton 
            variant="link" 
            label={language === 'zh' ? '发送私信给我们' : 'Message us'} 
          />
        </Box>
      </Box>

      {/* 动画样式 */}
      <style jsx global>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </Box>
  )
}
