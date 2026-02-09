import { Metadata } from 'next'

export const metadata: Metadata = {
  title: '隐私政策 | Arena',
  description: 'Arena平台隐私政策 Privacy Policy',
}

export default function PrivacyPage() {
  return (
    <div style={{ maxWidth: 800, margin: '40px auto', padding: '0 16px 80px', color: 'var(--color-text-primary)', lineHeight: 1.8 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>隐私政策 (Privacy Policy)</h1>
      <p style={{ color: 'var(--color-text-tertiary)', fontSize: 14, marginBottom: 40 }}>最后更新: 2026年2月8日</p>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>1. 收集的数据类型 (Data We Collect)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          我们收集以下类型的数据：
        </p>
        <ul style={{ color: 'var(--color-text-secondary)', fontSize: 15, paddingLeft: 24 }}>
          <li>账号信息：邮箱地址、用户名、头像</li>
          <li>个人资料：你选择公开的简介、社交媒体链接</li>
          <li>使用数据：浏览记录、搜索查询、页面停留时间</li>
          <li>设备信息：浏览器类型、操作系统、IP地址</li>
          <li>用户生成内容：帖子、评论、评分</li>
        </ul>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>2. 使用目的 (How We Use Your Data)</h2>
        <ul style={{ color: 'var(--color-text-secondary)', fontSize: 15, paddingLeft: 24 }}>
          <li>提供和维护平台服务</li>
          <li>个性化用户体验和内容推荐</li>
          <li>平台安全和反欺诈</li>
          <li>数据分析和服务改进</li>
          <li>与你沟通（服务通知、更新）</li>
        </ul>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>3. 数据共享 (Data Sharing)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          我们不会将你的个人数据出售给第三方。仅在以下情况下可能共享数据：
        </p>
        <ul style={{ color: 'var(--color-text-secondary)', fontSize: 15, paddingLeft: 24 }}>
          <li>法律要求：应执法机构或监管机构的合法要求</li>
          <li>服务提供商：与协助我们运营平台的服务提供商（如云托管），这些提供商受数据处理协议约束</li>
          <li>你的同意：经你明确同意后</li>
        </ul>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>4. 用户权利 (Your Rights)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          你享有以下权利：
        </p>
        <ul style={{ color: 'var(--color-text-secondary)', fontSize: 15, paddingLeft: 24 }}>
          <li>访问权 (Right of Access)：查看我们持有的你的数据</li>
          <li>更正权 (Right to Rectification)：修正不准确的数据</li>
          <li>删除权 (Right to Erasure)：要求删除你的数据</li>
          <li>数据可携权 (Right to Data Portability)：以通用格式导出你的数据</li>
          <li>反对权 (Right to Object)：反对某些数据处理活动</li>
        </ul>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15, marginTop: 8 }}>
          行使上述权利，请联系 privacy@arenafi.org
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>5. Cookie使用</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          我们使用Cookie和类似技术来：维持登录状态、记住你的偏好设置、分析平台使用情况。
          你可以通过浏览器设置管理Cookie偏好。禁用某些Cookie可能影响平台功能。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>6. 数据保留 (Data Retention)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          我们在提供服务所需的期间内保留你的数据。账号删除后，我们将在30天内删除或匿名化你的个人数据，
          但法律要求保留的数据除外。使用日志和分析数据保留期为12个月。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>7. 跨境数据传输 (Cross-Border Transfer)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          你的数据可能被传输到并存储在新加坡以外的服务器上。我们会确保接收方提供充分的数据保护，
          并通过合同条款或其他合规机制保障你的数据安全。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>8. 数据保护官 (Data Protection Officer)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          如有任何隐私相关问题，请联系我们的数据保护官：
          <br />
          邮箱: privacy@arenafi.org
        </p>
      </section>

      <section>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>9. 合规声明</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          本隐私政策符合新加坡个人数据保护法 (Personal Data Protection Act, PDPA) 的要求。
          对于欧洲经济区用户，我们同时遵守欧盟通用数据保护条例 (General Data Protection Regulation, GDPR)。
          我们承诺以透明、公正和合法的方式处理你的个人数据。
        </p>
      </section>
    </div>
  )
}
