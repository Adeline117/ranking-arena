import type { Metadata } from 'next'
'use client'

import React from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export const metadata: Metadata = {
  title: '免责声明 - Arena',
  description: 'Arena 平台免责声明和风险提示。',
}

export default function DisclaimerPage() {
  const { language } = useLanguage()
  const isZh = language === 'zh'

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)] py-16 px-4">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-black text-[var(--color-text-primary)] mb-8" style={{ letterSpacing: '-0.3px' }}>
          {isZh ? '免责声明' : 'Disclaimer'}
        </h1>

        <div className="prose prose-invert max-w-none space-y-6 text-[var(--color-text-secondary)]">
          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-3">
              {isZh ? '一般声明' : 'General'}
            </h2>
            <p>
              {isZh
                ? 'Arena 平台提供的所有数据、排名、分析和信息仅供参考和教育目的，不构成任何投资建议、金融建议或交易建议。'
                : 'All data, rankings, analyses, and information provided on the Arena platform are for informational and educational purposes only and do not constitute investment advice, financial advice, or trading advice.'}
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-3">
              {isZh ? '风险警告' : 'Risk Warning'}
            </h2>
            <p>
              {isZh
                ? '加密货币交易存在极高的风险，包括但不限于价格波动风险、流动性风险和技术风险。过往的交易业绩不代表未来表现。您可能会损失全部或部分投资资金。'
                : 'Cryptocurrency trading involves a very high degree of risk, including but not limited to price volatility, liquidity risk, and technological risk. Past trading performance is not indicative of future results. You may lose all or part of your invested capital.'}
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-3">
              {isZh ? '数据准确性' : 'Data Accuracy'}
            </h2>
            <p>
              {isZh
                ? '我们尽力确保数据的准确性和及时性，但不保证所有信息完全准确、完整或最新。交易员排名基于各交易所公开数据计算得出，可能存在延迟或误差。'
                : 'We strive to ensure the accuracy and timeliness of our data, but we do not guarantee that all information is completely accurate, complete, or up to date. Trader rankings are calculated from publicly available exchange data and may be subject to delays or inaccuracies.'}
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-[var(--color-text-primary)] mb-3">
              {isZh ? '责任限制' : 'Limitation of Liability'}
            </h2>
            <p>
              {isZh
                ? 'Arena 及其运营方不对因使用本平台信息而导致的任何直接或间接损失承担责任。用户应自行承担所有投资决策的风险和后果。'
                : 'Arena and its operators shall not be liable for any direct or indirect losses arising from the use of information provided on this platform. Users assume all risks and consequences of their own investment decisions.'}
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
