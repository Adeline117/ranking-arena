import React from 'react'
import Link from 'next/link'

/* ---------- styles ---------- */

const containerStyle: React.CSSProperties = {
  maxWidth: 800,
  margin: '0 auto',
  padding: '64px 24px 96px',
  color: 'var(--color-text-primary)',
  lineHeight: 1.7,
}

const h1Style: React.CSSProperties = {
  fontSize: 32,
  fontWeight: 700,
  marginBottom: 8,
}

const subtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: 'var(--color-text-tertiary)',
  marginBottom: 48,
}

const sectionStyle: React.CSSProperties = { marginBottom: 40 }

const h2Style: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  marginBottom: 12,
  color: 'var(--color-text-primary)',
}

const bodyStyle: React.CSSProperties = {
  fontSize: 15,
  color: 'var(--color-text-secondary)',
}

const listStyle: React.CSSProperties = {
  paddingLeft: 20,
  marginTop: 12,
}

const liStyle: React.CSSProperties = { marginBottom: 8 }

const dividerStyle: React.CSSProperties = {
  margin: '64px 0',
  borderTop: '2px solid var(--color-border-primary)',
}

const calloutStyle: React.CSSProperties = {
  padding: '16px 20px',
  background: 'var(--color-bg-secondary)',
  borderRadius: 12,
  border: '1px solid var(--color-border-primary)',
  marginTop: 12,
}

/* ---------- page ---------- */

export default function PrivacyPolicyPage() {
  return (
    <div style={containerStyle}>
      {/* ======================= ENGLISH ======================= */}
      <h1 style={h1Style}>Privacy Policy</h1>
      <p style={subtitleStyle}>Last updated: March 2026 &middot; Arena (arenafi.org)</p>

      <section style={sectionStyle}>
        <h2 style={h2Style}>1. Overview</h2>
        <div style={bodyStyle}>
          <p>
            Arena (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) operates the website{' '}
            <strong>arenafi.org</strong> and related services. This Privacy Policy explains
            what personal information we collect, how we use it, and your rights regarding
            that information.
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>2. Information We Collect</h2>
        <div style={bodyStyle}>
          <p><strong>Information you provide:</strong></p>
          <ul style={listStyle}>
            <li style={liStyle}>Email address when you create an account</li>
            <li style={liStyle}>Wallet addresses when you connect via Web3 login (Privy)</li>
            <li style={liStyle}>Profile information you choose to add (display name, avatar)</li>
            <li style={liStyle}>Content you post (comments, group posts)</li>
          </ul>
          <p style={{ marginTop: 16 }}><strong>Information collected automatically:</strong></p>
          <ul style={listStyle}>
            <li style={liStyle}>Usage analytics (page views, feature interactions) via Vercel Analytics</li>
            <li style={liStyle}>Device and browser information (user agent, screen resolution)</li>
            <li style={liStyle}>IP address (used for security and anti-abuse, not stored long-term)</li>
          </ul>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>3. How We Use Your Data</h2>
        <div style={bodyStyle}>
          <ul style={listStyle}>
            <li style={liStyle}>To provide and improve the trader ranking service</li>
            <li style={liStyle}>To display leaderboard rankings and performance analytics</li>
            <li style={liStyle}>To authenticate your identity and manage your account</li>
            <li style={liStyle}>To process Pro subscription payments</li>
            <li style={liStyle}>To send important service updates (opt-in for marketing)</li>
            <li style={liStyle}>To detect and prevent abuse, fraud, and security threats</li>
          </ul>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>4. Third-Party Services</h2>
        <div style={bodyStyle}>
          <p>We use the following third-party services to operate Arena:</p>
          <ul style={listStyle}>
            <li style={liStyle}><strong>Supabase</strong> &mdash; Database and authentication</li>
            <li style={liStyle}><strong>Vercel</strong> &mdash; Hosting and analytics</li>
            <li style={liStyle}><strong>Stripe</strong> &mdash; Payment processing for Pro subscriptions</li>
            <li style={liStyle}><strong>Privy</strong> &mdash; Web3 wallet authentication</li>
            <li style={liStyle}><strong>Upstash</strong> &mdash; Redis caching layer</li>
          </ul>
          <p style={{ marginTop: 12 }}>
            Each of these providers has their own privacy policy and data handling practices.
            We only share the minimum data necessary for each service to function.
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>5. Cookies</h2>
        <div style={bodyStyle}>
          <p>
            Arena uses <strong>essential cookies only</strong> for authentication and session
            management. We use Vercel Analytics for usage tracking, which does not use
            third-party cookies. We do not serve targeted advertising or use tracking cookies.
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>6. Your Rights</h2>
        <div style={bodyStyle}>
          <p>You have the right to:</p>
          <ul style={listStyle}>
            <li style={liStyle}><strong>Access</strong> &mdash; Request a copy of your personal data</li>
            <li style={liStyle}><strong>Correction</strong> &mdash; Update or correct inaccurate information</li>
            <li style={liStyle}><strong>Deletion</strong> &mdash; Request deletion of your account and data</li>
            <li style={liStyle}><strong>Export</strong> &mdash; Download your data in a portable format</li>
            <li style={liStyle}><strong>Opt-out</strong> &mdash; Unsubscribe from non-essential communications</li>
          </ul>
          <div style={calloutStyle}>
            <p style={{ margin: 0 }}>
              To exercise any of these rights, send a message to{' '}
              <Link href="/u/adelinewen1107" style={{ color: 'var(--color-accent-primary)' }}>
                @adelinewen1107
              </Link>
            </p>
          </div>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>7. GDPR &amp; CCPA Compliance</h2>
        <div style={bodyStyle}>
          <p>
            Arena is committed to complying with applicable data protection regulations,
            including the General Data Protection Regulation (GDPR) and the California
            Consumer Privacy Act (CCPA). If you are a resident of the European Economic
            Area or California, you have additional rights as outlined in those regulations.
            We will respond to any data subject request within 30 days.
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>8. Data Security &amp; Retention</h2>
        <div style={bodyStyle}>
          <p>
            We implement industry-standard security measures including encryption in
            transit (TLS), encrypted storage, Row Level Security (RLS) policies, and
            regular access audits. We retain personal data only as long as necessary to
            provide our services or as required by law. You may request deletion at any time.
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>9. Changes to This Policy</h2>
        <div style={bodyStyle}>
          <p>
            We may update this Privacy Policy from time to time. Significant changes will
            be communicated via email or a prominent notice on our website. Continued use
            of Arena after changes constitutes acceptance of the updated policy.
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>10. Contact</h2>
        <div style={bodyStyle}>
          <p>
            For questions or concerns about this Privacy Policy, please send a message to{' '}
            <Link href="/u/adelinewen1107" style={{ color: 'var(--color-accent-primary)' }}>
              @adelinewen1107
            </Link>
          </p>
        </div>
      </section>

      {/* ======================= DIVIDER ======================= */}
      <div style={dividerStyle} />

      {/* ======================= CHINESE ======================= */}
      <h1 style={h1Style}>隐私政策</h1>
      <p style={subtitleStyle}>最后更新：2026 年 3 月 &middot; Arena (arenafi.org)</p>

      <section style={sectionStyle}>
        <h2 style={h2Style}>1. 概述</h2>
        <div style={bodyStyle}>
          <p>
            Arena（以下简称&ldquo;我们&rdquo;）运营网站 <strong>arenafi.org</strong> 及相关服务。本隐私政策说明我们收集哪些个人信息、如何使用这些信息，以及您对这些信息享有的权利。
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>2. 我们收集的信息</h2>
        <div style={bodyStyle}>
          <p><strong>您主动提供的信息：</strong></p>
          <ul style={listStyle}>
            <li style={liStyle}>创建账户时的电子邮箱地址</li>
            <li style={liStyle}>通过 Web3 登录（Privy）连接时的钱包地址</li>
            <li style={liStyle}>您选择添加的个人资料（显示名称、头像）</li>
            <li style={liStyle}>您发布的内容（评论、群组帖子）</li>
          </ul>
          <p style={{ marginTop: 16 }}><strong>自动收集的信息：</strong></p>
          <ul style={listStyle}>
            <li style={liStyle}>使用分析数据（页面浏览量、功能交互），通过 Vercel Analytics 收集</li>
            <li style={liStyle}>设备和浏览器信息（用户代理、屏幕分辨率）</li>
            <li style={liStyle}>IP 地址（用于安全和反滥用，不长期存储）</li>
          </ul>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>3. 我们如何使用您的数据</h2>
        <div style={bodyStyle}>
          <ul style={listStyle}>
            <li style={liStyle}>提供和改进交易者排名服务</li>
            <li style={liStyle}>展示排行榜排名和绩效分析</li>
            <li style={liStyle}>验证您的身份并管理您的账户</li>
            <li style={liStyle}>处理 Pro 订阅付款</li>
            <li style={liStyle}>发送重要的服务更新（营销通讯需选择加入）</li>
            <li style={liStyle}>检测和防止滥用、欺诈和安全威胁</li>
          </ul>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>4. 第三方服务</h2>
        <div style={bodyStyle}>
          <p>我们使用以下第三方服务来运营 Arena：</p>
          <ul style={listStyle}>
            <li style={liStyle}><strong>Supabase</strong> &mdash; 数据库和身份验证</li>
            <li style={liStyle}><strong>Vercel</strong> &mdash; 托管和分析</li>
            <li style={liStyle}><strong>Stripe</strong> &mdash; Pro 订阅付款处理</li>
            <li style={liStyle}><strong>Privy</strong> &mdash; Web3 钱包身份验证</li>
            <li style={liStyle}><strong>Upstash</strong> &mdash; Redis 缓存层</li>
          </ul>
          <p style={{ marginTop: 12 }}>
            每个服务提供商都有自己的隐私政策和数据处理惯例。我们仅共享每项服务运行所需的最少数据。
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>5. Cookie 政策</h2>
        <div style={bodyStyle}>
          <p>
            Arena <strong>仅使用必要的 Cookie</strong> 用于身份验证和会话管理。我们使用 Vercel Analytics 进行使用跟踪，不使用第三方 Cookie。我们不提供定向广告，也不使用跟踪 Cookie。
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>6. 您的权利</h2>
        <div style={bodyStyle}>
          <p>您有权：</p>
          <ul style={listStyle}>
            <li style={liStyle}><strong>访问</strong> &mdash; 请求获取您的个人数据副本</li>
            <li style={liStyle}><strong>更正</strong> &mdash; 更新或更正不准确的信息</li>
            <li style={liStyle}><strong>删除</strong> &mdash; 请求删除您的账户和数据</li>
            <li style={liStyle}><strong>导出</strong> &mdash; 以可移植格式下载您的数据</li>
            <li style={liStyle}><strong>退订</strong> &mdash; 取消订阅非必要通讯</li>
          </ul>
          <div style={calloutStyle}>
            <p style={{ margin: 0 }}>
              如需行使上述任何权利，请私信联系：{' '}
              <Link href="/u/adelinewen1107" style={{ color: 'var(--color-accent-primary)' }}>
                @adelinewen1107
              </Link>
            </p>
          </div>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>7. GDPR 和 CCPA 合规</h2>
        <div style={bodyStyle}>
          <p>
            Arena 致力于遵守适用的数据保护法规，包括《通用数据保护条例》(GDPR) 和《加利福尼亚消费者隐私法》(CCPA)。如果您是欧洲经济区或加利福尼亚州的居民，您享有这些法规规定的额外权利。我们将在 30 天内回复任何数据主体请求。
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>8. 数据安全和保留</h2>
        <div style={bodyStyle}>
          <p>
            我们实施行业标准安全措施，包括传输加密 (TLS)、加密存储、行级安全 (RLS) 策略和定期访问审计。我们仅在提供服务所需或法律要求的期限内保留个人数据。您可以随时请求删除。
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>9. 政策变更</h2>
        <div style={bodyStyle}>
          <p>
            我们可能会不时更新本隐私政策。重大变更将通过电子邮件或网站上的显著通知告知您。变更后继续使用 Arena 即表示接受更新后的政策。
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>10. 联系方式</h2>
        <div style={bodyStyle}>
          <p>
            如对本隐私政策有任何疑问或顾虑，请私信联系：{' '}
            <Link href="/u/adelinewen1107" style={{ color: 'var(--color-accent-primary)' }}>
              @adelinewen1107
            </Link>
          </p>
        </div>
      </section>

      {/* Back link */}
      <div style={{ marginTop: 64, paddingTop: 24, borderTop: '1px solid var(--color-border-primary)' }}>
        <Link
          href="/"
          style={{
            color: 'var(--color-accent-primary)',
            textDecoration: 'none',
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          &larr; Back to Home
        </Link>
      </div>
    </div>
  )
}
