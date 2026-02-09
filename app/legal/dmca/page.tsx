import { Metadata } from 'next'

export const metadata: Metadata = {
  title: '版权政策 | Arena',
  description: 'Arena平台版权与DMCA政策 Copyright/DMCA Policy',
}

export default function DmcaPage() {
  return (
    <div style={{ maxWidth: 800, margin: '40px auto', padding: '0 16px 80px', color: 'var(--color-text-primary)', lineHeight: 1.8 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>版权政策 (Copyright / DMCA Policy)</h1>
      <p style={{ color: 'var(--color-text-tertiary)', fontSize: 14, marginBottom: 40 }}>最后更新: 2026年2月8日</p>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>1. 概述</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          Arena尊重知识产权，并期望平台用户同样尊重知识产权。
          如果你认为本平台上的内容侵犯了你的版权，请按照以下流程提交通知。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>2. 侵权通知流程 (Notice and Takedown)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          如果你是版权所有者或其授权代理人，认为本平台上的内容侵犯了你的版权，请向我们发送包含以下信息的书面通知：
        </p>
        <ul style={{ color: 'var(--color-text-secondary)', fontSize: 15, paddingLeft: 24 }}>
          <li>你的联系信息（姓名、地址、电话、邮箱）</li>
          <li>被侵权作品的描述</li>
          <li>涉嫌侵权内容在本平台上的位置（URL）</li>
          <li>声明你善意认为该内容的使用未经版权所有者、其代理人或法律授权</li>
          <li>声明通知中的信息准确，且你是版权所有者或其授权代理人</li>
          <li>你的签名（电子签名即可）</li>
        </ul>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>3. 反通知流程 (Counter-Notice)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          如果你认为被移除的内容不构成侵权，你可以提交反通知 (counter-notice)，包含以下信息：
        </p>
        <ul style={{ color: 'var(--color-text-secondary)', fontSize: 15, paddingLeft: 24 }}>
          <li>你的联系信息</li>
          <li>被移除内容的描述和原始位置</li>
          <li>声明你善意认为内容被错误移除</li>
          <li>同意接受新加坡法院管辖</li>
          <li>你的签名</li>
        </ul>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15, marginTop: 8 }}>
          收到有效的反通知后，我们将把反通知转发给原投诉人。
          如原投诉人未在10个工作日内提起法律诉讼，我们可能会恢复被移除的内容。
        </p>
      </section>

      <section>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>4. 联系方式 (Contact)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          版权相关事宜请联系：
          <br />
          邮箱: copyright@arenafi.org
          <br /><br />
          请在邮件主题中注明"版权通知"或"DMCA Notice"。
          我们将在收到有效通知后尽快处理（通常在5个工作日内）。
        </p>
      </section>
    </div>
  )
}
