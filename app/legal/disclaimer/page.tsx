import { Metadata } from 'next'

export const metadata: Metadata = {
  title: '风险免责声明 | ArenaFi',
  description: 'ArenaFi平台风险免责声明 Risk Disclaimer',
}

export default function DisclaimerPage() {
  return (
    <div style={{ maxWidth: 800, margin: '40px auto', padding: '0 16px 80px', color: 'var(--color-text-primary)', lineHeight: 1.8 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>风险免责声明 (Risk Disclaimer)</h1>
      <p style={{ color: 'var(--color-text-tertiary)', fontSize: 14, marginBottom: 40 }}>最后更新: 2026年2月8日</p>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>1. 高风险警告 (High Risk Warning)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          加密货币和数字资产交易具有极高风险 (extremely high risk)。价格波动剧烈，
          你可能在短时间内损失全部投资本金。加密货币市场全天候运行，且在大多数司法管辖区不受传统金融监管保护。
          在参与任何交易之前，请确保你充分了解相关风险，并且仅使用你能承受损失的资金进行交易。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>2. 历史表现不代表未来 (Past Performance)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          本平台展示的交易员历史绩效数据仅供参考。过去的表现不保证也不暗示未来的结果
          (past performance is not indicative of future results)。
          市场条件持续变化，过去成功的策略可能在未来失效。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>3. 非金融顾问 (Not a Financial Advisor)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          Arena不是注册金融顾问、投资顾问或经纪商。本平台不提供个性化的投资建议。
          平台上展示的排名、数据和用户观点不应被理解为投资推荐或交易信号。
          在做出任何投资决策前，建议咨询持牌的专业金融顾问。
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>4. 用户自行评估风险 (Your Own Risk Assessment)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          用户应根据自身的财务状况、投资经验和风险承受能力，独立评估所有投资决策。
          本平台对用户基于平台信息做出的任何投资决策及其后果不承担责任。
          你应自行进行充分的研究和尽职调查 (due diligence)。
        </p>
      </section>

      <section>
        <h2 style={{ fontSize: 20, marginBottom: 12 }}>5. 数据来源与准确性 (Data Sources)</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>
          本平台的数据来源于第三方公开渠道，包括加密货币交易所API、区块链网络等。
          我们不对这些第三方数据的准确性、完整性或及时性做任何保证。
          数据可能存在延迟、不完整或错误的情况。用户在使用数据时应自行核实。
        </p>
      </section>
    </div>
  )
}
