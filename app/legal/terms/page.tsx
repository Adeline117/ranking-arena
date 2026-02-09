import { Metadata } from 'next'

export const metadata: Metadata = {
  title: '服务条款 | Arena',
  description: 'Arena平台服务条款 Terms of Service',
}

export default function TermsPage() {
  return (
    <div style={{ maxWidth: 800, margin: '40px auto', padding: '0 16px 80px', color: 'var(--color-text-primary)', lineHeight: 1.8 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>服务条款 (Terms of Service)</h1>
      <p style={{ color: 'var(--color-text-tertiary)', fontSize: 14, marginBottom: 40 }}>最后更新: 2026年2月8日</p>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>1. 服务说明</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          Arena（以下简称"本平台"）是一个交易员排名和社区平台 (Trader Ranking and Community Platform)。
          本平台提供交易员绩效数据展示、排名、社区讨论等功能。使用本平台即表示你同意以下条款。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>2. 数据来源与准确性</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          本平台展示的数据来源于公开渠道 (publicly available sources)，包括但不限于交易所公开API、链上数据等。
          我们尽力确保数据准确，但不对数据的完整性、准确性或及时性做任何保证 (no warranty of accuracy)。
          数据可能存在延迟、错误或遗漏。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>3. 非投资建议声明 (Not Financial Advice)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          本平台提供的所有信息仅供参考，不构成任何投资建议、财务建议或交易建议。
          本平台不是持牌金融顾问 (licensed financial advisor)，不提供个性化投资建议。
          任何基于本平台信息做出的投资决策，风险由用户自行承担。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>4. 用户风险自担 (Assumption of Risk)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          加密货币和数字资产交易具有高风险，可能导致全部本金损失。
          用户应根据自身风险承受能力做出独立判断。本平台对用户的任何交易损失不承担责任。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>5. 知识产权 (Intellectual Property)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          本平台的设计、代码、商标、排名算法等知识产权归Arena所有。
          用户发布的内容，用户保留其知识产权，但授予本平台在平台范围内展示、分发的非排他性许可。
          未经许可，不得复制、修改或分发本平台的内容。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>6. 用户行为规范 (Code of Conduct)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          用户不得在本平台发布以下内容：垃圾广告、诈骗信息、虚假投资建议、骚扰或侮辱性内容、
          侵犯他人知识产权的内容、任何违反适用法律的内容。
          违反行为规范可能导致内容删除、账号限制或永久封禁。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>7. 账号终止 (Account Termination)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          我们保留在以下情况下终止或限制用户账号的权利：违反本条款、从事欺诈行为、
          滥用平台功能、或出于安全原因。用户可随时申请删除自己的账号。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>8. 免责声明 (Disclaimer)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          本平台按"现状"(as is) 和"可用"(as available) 基础提供服务，不做任何明示或暗示的保证。
          在适用法律允许的最大范围内，本平台不对因使用或无法使用本服务而导致的任何直接、
          间接、附带、特殊或后果性损害承担责任。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>9. 管辖法律 (Governing Law)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          本条款受新加坡共和国法律 (Laws of the Republic of Singapore) 管辖并按其解释。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>10. 争议解决 (Dispute Resolution)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          因本条款引起的或与之相关的任何争议，应提交新加坡国际仲裁中心
          (Singapore International Arbitration Centre, SIAC) 按其现行仲裁规则进行仲裁。
          仲裁语言为英语 (English)。仲裁地为新加坡。仲裁裁决为终局裁决，对双方具有约束力。
        </p>
      </section>

      <section>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>11. 条款修改</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          我们保留随时修改本条款的权利。修改后的条款将在本页面公布，继续使用本平台即视为接受修改后的条款。
          重大变更将通过站内通知或邮件告知用户。
        </p>
      </section>
    </div>
  )
}
