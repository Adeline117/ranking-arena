import { Metadata } from 'next'

export const metadata: Metadata = {
  title: '服务条款',
  description: 'Arena 服务条款',
}

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)] py-16 px-4">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl font-bold text-[var(--color-text-primary)] mb-8">
          服务条款
        </h1>
        
        <div className="prose prose-invert max-w-none space-y-6 text-[var(--color-text-secondary)]">
          <p className="text-sm text-[var(--color-text-tertiary)]">
            最后更新日期：2024年1月
          </p>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              1. 接受条款
            </h2>
            <p>
              欢迎使用 Arena（以下简称&ldquo;本平台&rdquo;或&ldquo;我们&rdquo;）。通过访问或使用我们的服务，
              您同意受本服务条款（以下简称&ldquo;条款&rdquo;）的约束。如果您不同意这些条款的任何部分，
              请不要使用我们的服务。
            </p>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              2. 服务描述
            </h2>
            <p>
              Arena 是一个加密货币交易员排行榜与社区平台，提供以下服务：
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>聚合多个交易所的交易员排行数据</li>
              <li>提供交易员绩效分析和统计</li>
              <li>社区讨论和内容分享功能</li>
              <li>用户关注和互动功能</li>
            </ul>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              3. 用户账户
            </h2>
            <h3 className="text-lg font-medium text-[var(--color-text-primary)] mt-6 mb-3">
              3.1 账户创建
            </h3>
            <p>
              使用某些服务功能需要创建账户。您必须提供准确、完整的信息，并保持信息的最新状态。
            </p>
            
            <h3 className="text-lg font-medium text-[var(--color-text-primary)] mt-6 mb-3">
              3.2 账户安全
            </h3>
            <p>
              您有责任保护您的账户安全，包括保密您的登录凭据。您对通过您账户进行的所有活动负责。
            </p>
            
            <h3 className="text-lg font-medium text-[var(--color-text-primary)] mt-6 mb-3">
              3.3 年龄要求
            </h3>
            <p>
              您必须年满 18 岁才能使用本服务。通过使用本服务，您声明并保证您已年满 18 岁。
            </p>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              4. 用户行为
            </h2>
            <p>
              您同意不进行以下行为：
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>发布虚假、误导性或欺诈性内容</li>
              <li>骚扰、威胁或侮辱其他用户</li>
              <li>发布垃圾信息或未经请求的广告</li>
              <li>尝试未经授权访问其他用户账户或系统</li>
              <li>使用自动化工具大量抓取数据</li>
              <li>违反任何适用法律或法规</li>
              <li>侵犯他人的知识产权</li>
            </ul>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              5. 内容
            </h2>
            <h3 className="text-lg font-medium text-[var(--color-text-primary)] mt-6 mb-3">
              5.1 用户内容
            </h3>
            <p>
              您对您发布的内容保留所有权利。通过发布内容，您授予我们非独家、免版税、
              全球性的许可，以使用、复制、修改和展示该内容。
            </p>
            
            <h3 className="text-lg font-medium text-[var(--color-text-primary)] mt-6 mb-3">
              5.2 内容审核
            </h3>
            <p>
              我们保留审核、编辑或删除任何违反本条款或我们政策的内容的权利，恕不另行通知。
            </p>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              6. 免责声明
            </h2>
            <div className="bg-[var(--color-bg-secondary)] p-4 rounded-lg mt-4">
              <p className="font-medium text-[var(--color-accent-warning)]">
                重要提示：
              </p>
              <ul className="list-disc pl-6 space-y-2 mt-2">
                <li>本平台提供的数据仅供参考，不构成投资建议</li>
                <li>过去的表现不代表未来的结果</li>
                <li>加密货币交易具有高风险，可能导致重大损失</li>
                <li>您应该在做出任何投资决定前进行独立研究</li>
              </ul>
            </div>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              7. 责任限制
            </h2>
            <p>
              在法律允许的最大范围内，本平台及其关联方不对以下情况承担责任：
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>任何间接、附带、特殊或后果性损害</li>
              <li>因使用或无法使用服务而导致的损失</li>
              <li>基于本平台数据做出的投资决策产生的损失</li>
              <li>服务中断或数据丢失</li>
            </ul>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              8. 知识产权
            </h2>
            <p>
              本平台的所有内容、功能和技术（包括但不限于文本、图形、徽标、图标、软件和代码）
              均受知识产权法保护。未经我们明确书面许可，您不得复制、修改、分发或以其他方式使用这些内容。
            </p>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              9. 服务变更和终止
            </h2>
            <p>
              我们保留以下权利：
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-4">
              <li>随时修改或终止服务（或其任何部分），无需事先通知</li>
              <li>因任何原因暂停或终止您的账户访问</li>
              <li>修改本条款，修改后的条款将在发布后立即生效</li>
            </ul>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              10. 适用法律
            </h2>
            <p>
              本条款受中华人民共和国法律管辖并按其解释。与本条款相关的任何争议应提交至
              有管辖权的人民法院解决。
            </p>
          </section>
          
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mt-8 mb-4">
              11. 联系我们
            </h2>
            <p>
              如果您对本服务条款有任何问题，请通过以下方式联系我们：
            </p>
            <p className="mt-4">
              电子邮件：legal@arenafi.org
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
