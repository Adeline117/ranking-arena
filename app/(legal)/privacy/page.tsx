import { Metadata } from 'next'

export const metadata: Metadata = {
  title: '隐私政策',
  description: 'Ranking Arena 隐私政策',
}

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)] py-16 px-4">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold text-[var(--color-text-primary)] mb-8">
          隐私政策
        </h1>
        
        <div className="prose prose-invert max-w-none space-y-6 text-[var(--color-text-secondary)]">
          <p className="text-sm text-[var(--color-text-tertiary)]">
            最后更新日期：2026年1月15日
          </p>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              1. 信息收集
            </h2>
            <p>
              我们收集以下类型的信息：
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li><strong>账户信息</strong>：当您注册账户时，我们收集您的电子邮件地址和您选择的用户名。</li>
              <li><strong>使用数据</strong>：我们自动收集有关您如何使用我们服务的信息，包括访问时间、浏览的页面和点击的链接。</li>
              <li><strong>设备信息</strong>：我们收集有关您用于访问服务的设备的信息，包括设备类型、操作系统和浏览器类型。</li>
            </ul>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              2. 信息使用
            </h2>
            <p>
              我们使用收集的信息用于：
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>提供、维护和改进我们的服务</li>
              <li>处理交易和发送相关信息</li>
              <li>发送技术通知、更新、安全警报和支持消息</li>
              <li>响应您的评论、问题和请求</li>
              <li>监控和分析趋势、使用情况和活动</li>
              <li>检测、调查和防止欺诈交易和其他非法活动</li>
            </ul>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              3. 信息共享
            </h2>
            <p>
              我们不会出售您的个人信息。我们可能在以下情况下共享您的信息：
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li><strong>服务提供商</strong>：与帮助我们运营服务的第三方服务提供商共享</li>
              <li><strong>法律要求</strong>：如果法律要求或为了保护我们的权利</li>
              <li><strong>业务转让</strong>：在合并、收购或资产出售的情况下</li>
            </ul>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              4. 数据安全
            </h2>
            <p>
              我们采取合理的措施来保护您的个人信息，包括：
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>使用 SSL/TLS 加密传输数据</li>
              <li>使用 AES-256 加密存储敏感数据</li>
              <li>定期安全审计和漏洞扫描</li>
              <li>严格的访问控制和身份验证</li>
            </ul>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              5. 您的权利
            </h2>
            <p>
              您对您的个人信息拥有以下权利：
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li><strong>访问权</strong>：您可以请求访问我们持有的关于您的个人信息</li>
              <li><strong>更正权</strong>：您可以请求更正不准确的个人信息</li>
              <li><strong>删除权</strong>：您可以请求删除您的个人信息</li>
              <li><strong>数据可携带权</strong>：您可以请求以机器可读格式导出您的数据</li>
            </ul>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              6. Cookie 使用
            </h2>
            <p>
              我们使用 Cookie 和类似技术来：
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>保持您的登录状态</li>
              <li>记住您的偏好设置</li>
              <li>分析网站使用情况</li>
              <li>提供个性化内容</li>
            </ul>
            <p className="mt-4">
              您可以通过浏览器设置管理 Cookie 偏好。
            </p>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              7. 儿童隐私
            </h2>
            <p>
              我们的服务不面向 18 岁以下的用户。我们不会故意收集儿童的个人信息。
            </p>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              8. 政策变更
            </h2>
            <p>
              我们可能会不时更新本隐私政策。更新后的政策将在本页面发布，并更新"最后更新日期"。
              建议您定期查看本政策以了解任何变更。
            </p>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              9. 联系我们
            </h2>
            <p>
              如果您对本隐私政策有任何问题或疑虑，请通过以下方式联系我们：
            </p>
            <p className="mt-4">
              电子邮件：adelinewen1107@outlook.com
            </p>
          </section>
        </div>
        
        <div className="mt-12 pt-8 border-t border-[var(--color-border-primary)]">
          <a
            href="/"
            className="text-[var(--color-accent-primary)] hover:underline"
          >
            ← 返回首页
          </a>
        </div>
      </div>
    </div>
  )
}
