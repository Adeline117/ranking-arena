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

const warningBoxStyle: React.CSSProperties = {
  padding: '16px 20px',
  background: 'var(--color-bg-secondary)',
  borderLeft: '4px solid var(--color-accent-warning)',
  borderRadius: 12,
  marginTop: 12,
}

/* ---------- page ---------- */

export default function TermsOfServicePage() {
  return (
    <div style={containerStyle}>
      {/* ======================= ENGLISH ======================= */}
      <h1 style={h1Style}>Terms of Service</h1>
      <p style={subtitleStyle}>Last updated: March 2026 &middot; Arena (arenafi.org)</p>

      <section style={sectionStyle}>
        <h2 style={h2Style}>1. Service Description</h2>
        <div style={bodyStyle}>
          <p>
            Arena is a cryptocurrency trader ranking and performance analytics platform.
            We aggregate publicly available trading data from 25+ centralized and
            decentralized exchanges to compute trader rankings using our proprietary
            Arena Score algorithm.
          </p>
          <div style={warningBoxStyle}>
            <p style={{ margin: 0, fontWeight: 600, color: 'var(--color-accent-warning)' }}>
              Important: Arena is NOT an investment advisory service. Rankings and data
              provided on this platform do not constitute financial advice, trading
              recommendations, or solicitation to trade. Always conduct your own research
              before making any investment decisions.
            </p>
          </div>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>2. Disclaimer</h2>
        <div style={bodyStyle}>
          <ul style={listStyle}>
            <li style={liStyle}>
              Arena is not responsible for any trading losses or outcomes based on
              information displayed on this platform
            </li>
            <li style={liStyle}>
              All data is provided &quot;as-is&quot; without warranties of accuracy,
              completeness, or timeliness
            </li>
            <li style={liStyle}>
              Exchange data may be delayed, incomplete, or subject to errors beyond our control
            </li>
            <li style={liStyle}>
              Past performance does not guarantee future results. Rankings reflect
              historical data only
            </li>
            <li style={liStyle}>
              Cryptocurrency trading involves substantial risk of loss and is not suitable
              for all investors
            </li>
          </ul>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>3. User Responsibilities</h2>
        <div style={bodyStyle}>
          <p>By using Arena, you agree to:</p>
          <ul style={listStyle}>
            <li style={liStyle}>Provide accurate information when creating an account</li>
            <li style={liStyle}>
              Not scrape, crawl, or use automated tools to extract data from the platform
              without written permission
            </li>
            <li style={liStyle}>
              Not attempt to manipulate rankings, game the system, or submit false data
            </li>
            <li style={liStyle}>
              Not use the platform for any illegal or unauthorized purposes
            </li>
            <li style={liStyle}>
              Respect other users and refrain from harassment, spam, or abusive behavior
              in community features
            </li>
            <li style={liStyle}>
              Not reverse-engineer, decompile, or attempt to extract the source code of
              our proprietary systems
            </li>
          </ul>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>4. Intellectual Property</h2>
        <div style={bodyStyle}>
          <p>
            The Arena Score algorithm, platform design, user interface, original content,
            and branding are the intellectual property of Arena. You may not reproduce,
            distribute, or create derivative works from our proprietary content without
            prior written consent.
          </p>
          <p style={{ marginTop: 12 }}>
            User-generated content (posts, comments) remains owned by the user, but by
            posting on Arena you grant us a non-exclusive, worldwide license to display
            and distribute that content within the platform.
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>5. Account Termination</h2>
        <div style={bodyStyle}>
          <p>Arena reserves the right to suspend or terminate accounts for:</p>
          <ul style={listStyle}>
            <li style={liStyle}>Violation of these Terms of Service</li>
            <li style={liStyle}>Abusive or fraudulent behavior</li>
            <li style={liStyle}>Attempted manipulation of rankings or data</li>
            <li style={liStyle}>Extended inactivity (accounts inactive for 24+ months may be archived)</li>
          </ul>
          <p style={{ marginTop: 12 }}>
            Users may delete their own accounts at any time through account settings or
            by messaging{' '}
            <Link href="/u/adelinewen1107" style={{ color: 'var(--color-accent-primary)' }}>
              @adelinewen1107
            </Link>.
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>6. Limitation of Liability</h2>
        <div style={bodyStyle}>
          <p>
            To the maximum extent permitted by law, Arena and its operators shall not be
            liable for any indirect, incidental, special, consequential, or punitive
            damages, including but not limited to loss of profits, data, or trading
            capital, arising from your use of or inability to use the platform.
          </p>
          <p style={{ marginTop: 12 }}>
            Our total liability for any claim shall not exceed the amount you paid to
            Arena in the 12 months preceding the claim, or $100 USD, whichever is greater.
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>7. Pro Subscription</h2>
        <div style={bodyStyle}>
          <p>
            Pro subscriptions are billed monthly or annually via Stripe. Refunds are
            handled on a case-by-case basis. You may cancel your subscription at any time;
            access continues until the end of the billing period.
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>8. Governing Law</h2>
        <div style={bodyStyle}>
          <p>
            These Terms shall be governed by and construed in accordance with the laws
            of the applicable jurisdiction. Any disputes arising from these Terms or your
            use of Arena shall be resolved through good-faith negotiation first, then
            binding arbitration if necessary.
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>9. Changes to Terms</h2>
        <div style={bodyStyle}>
          <p>
            We may update these Terms from time to time. Material changes will be
            communicated via email or a prominent notice on the platform. Continued use
            of Arena after changes constitutes acceptance of the updated Terms.
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>10. Contact</h2>
        <div style={bodyStyle}>
          <p>
            For questions about these Terms, send a message to{' '}
            <Link href="/u/adelinewen1107" style={{ color: 'var(--color-accent-primary)' }}>
              @adelinewen1107
            </Link>
          </p>
        </div>
      </section>

      {/* ======================= DIVIDER ======================= */}
      <div style={dividerStyle} />

      {/* ======================= CHINESE ======================= */}
      <h1 style={h1Style}>服务条款</h1>
      <p style={subtitleStyle}>最后更新：2026 年 3 月 &middot; Arena (arenafi.org)</p>

      <section style={sectionStyle}>
        <h2 style={h2Style}>1. 服务说明</h2>
        <div style={bodyStyle}>
          <p>
            Arena 是一个加密货币交易者排名和绩效分析平台。我们从 25 多个中心化和去中心化交易所聚合公开的交易数据，使用我们专有的 Arena Score 算法计算交易者排名。
          </p>
          <div style={warningBoxStyle}>
            <p style={{ margin: 0, fontWeight: 600, color: 'var(--color-accent-warning)' }}>
              重要提示：Arena 不是投资咨询服务。本平台上提供的排名和数据不构成财务建议、交易推荐或交易招揽。在做出任何投资决定之前，请始终进行自己的研究。
            </p>
          </div>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>2. 免责声明</h2>
        <div style={bodyStyle}>
          <ul style={listStyle}>
            <li style={liStyle}>Arena 不对基于本平台信息的任何交易损失或结果负责</li>
            <li style={liStyle}>所有数据均按&ldquo;原样&rdquo;提供，不对准确性、完整性或时效性作任何保证</li>
            <li style={liStyle}>交易所数据可能存在延迟、不完整或超出我们控制范围的错误</li>
            <li style={liStyle}>过往表现不保证未来收益。排名仅反映历史数据</li>
            <li style={liStyle}>加密货币交易涉及重大亏损风险，不适合所有投资者</li>
          </ul>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>3. 用户责任</h2>
        <div style={bodyStyle}>
          <p>使用 Arena 即表示您同意：</p>
          <ul style={listStyle}>
            <li style={liStyle}>创建账户时提供准确的信息</li>
            <li style={liStyle}>未经书面许可，不得爬取、抓取或使用自动化工具从平台提取数据</li>
            <li style={liStyle}>不得操纵排名、利用系统漏洞或提交虚假数据</li>
            <li style={liStyle}>不得将平台用于任何非法或未经授权的目的</li>
            <li style={liStyle}>尊重其他用户，在社区功能中不得进行骚扰、垃圾信息或滥用行为</li>
            <li style={liStyle}>不得反向工程、反编译或试图提取我们专有系统的源代码</li>
          </ul>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>4. 知识产权</h2>
        <div style={bodyStyle}>
          <p>
            Arena Score 算法、平台设计、用户界面、原创内容和品牌是 Arena 的知识产权。未经事先书面同意，不得复制、分发或创作我们专有内容的衍生作品。
          </p>
          <p style={{ marginTop: 12 }}>
            用户生成的内容（帖子、评论）仍归用户所有，但在 Arena 上发布即表示您授予我们非排他性的全球许可，以在平台内展示和分发该内容。
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>5. 账户终止</h2>
        <div style={bodyStyle}>
          <p>Arena 保留因以下原因暂停或终止账户的权利：</p>
          <ul style={listStyle}>
            <li style={liStyle}>违反本服务条款</li>
            <li style={liStyle}>滥用或欺诈行为</li>
            <li style={liStyle}>试图操纵排名或数据</li>
            <li style={liStyle}>长期不活跃（不活跃超过 24 个月的账户可能被归档）</li>
          </ul>
          <p style={{ marginTop: 12 }}>
            用户可随时通过账户设置或联系{' '}
            <Link href="/u/adelinewen1107" style={{ color: 'var(--color-accent-primary)' }}>
              @adelinewen1107
            </Link>{' '}
            删除自己的账户。
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>6. 责任限制</h2>
        <div style={bodyStyle}>
          <p>
            在法律允许的最大范围内，Arena 及其运营者不对任何间接、附带、特殊、后果性或惩罚性损害赔偿承担责任，包括但不限于利润损失、数据损失或交易资本损失，无论该等损害是因您使用或无法使用本平台而产生。
          </p>
          <p style={{ marginTop: 12 }}>
            我们对任何索赔的总责任不超过您在索赔前 12 个月内向 Arena 支付的金额或 100 美元（以较大者为准）。
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>7. Pro 订阅</h2>
        <div style={bodyStyle}>
          <p>
            Pro 订阅通过 Stripe 按月或按年计费。退款根据具体情况处理。您可以随时取消订阅；访问权限持续到计费周期结束。
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>8. 适用法律</h2>
        <div style={bodyStyle}>
          <p>
            本条款受适用管辖区法律管辖并按其解释。因本条款或您使用 Arena 而产生的任何争议应首先通过善意协商解决，必要时通过具有约束力的仲裁解决。
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>9. 条款变更</h2>
        <div style={bodyStyle}>
          <p>
            我们可能会不时更新本条款。重大变更将通过电子邮件或平台上的显著通知告知您。变更后继续使用 Arena 即表示接受更新后的条款。
          </p>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={h2Style}>10. 联系方式</h2>
        <div style={bodyStyle}>
          <p>
            如对本条款有任何疑问，请私信联系：{' '}
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
