import type { Meta, StoryObj } from '@storybook/react'
import EquityCurve from '@/app/components/Charts/EquityCurve'

// 生成模拟数据
function generateMockData(
  days: number,
  startValue: number,
  volatility: number,
  trend: 'up' | 'down' | 'flat'
) {
  const data = []
  let value = startValue
  const trendFactor = trend === 'up' ? 0.003 : trend === 'down' ? -0.003 : 0
  
  for (let i = 0; i < days; i++) {
    const date = new Date()
    date.setDate(date.getDate() - days + i)
    const dateStr = date.toISOString().split('T')[0]
    
    // 随机波动 + 趋势
    const change = (Math.random() - 0.5) * volatility + trendFactor * value
    value = Math.max(value + change, startValue * 0.1)
    
    data.push({ time: dateStr, value })
  }
  
  return data
}

const meta: Meta<typeof EquityCurve> = {
  title: 'Charts/EquityCurve',
  component: EquityCurve,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
  },
  argTypes: {
    height: {
      control: { type: 'range', min: 150, max: 500, step: 50 },
      description: '图表高度',
    },
    title: {
      control: 'text',
      description: '图表标题',
    },
    showTooltip: {
      control: 'boolean',
      description: '是否显示提示框',
    },
  },
}

export default meta
type Story = StoryObj<typeof meta>

export const Uptrend: Story = {
  args: {
    data: generateMockData(90, 10000, 200, 'up'),
    height: 300,
    title: '资金曲线（上涨趋势）',
    showTooltip: true,
  },
}

export const Downtrend: Story = {
  args: {
    data: generateMockData(90, 10000, 200, 'down'),
    height: 300,
    title: '资金曲线（下跌趋势）',
    showTooltip: true,
  },
}

export const Flat: Story = {
  args: {
    data: generateMockData(90, 10000, 100, 'flat'),
    height: 300,
    title: '资金曲线（横盘）',
    showTooltip: true,
  },
}

export const ShortPeriod: Story = {
  args: {
    data: generateMockData(7, 10000, 300, 'up'),
    height: 200,
    title: '7 天资金曲线',
    showTooltip: true,
  },
}

export const LongPeriod: Story = {
  args: {
    data: generateMockData(365, 10000, 150, 'up'),
    height: 400,
    title: '年度资金曲线',
    showTooltip: true,
  },
}

export const CustomColors: Story = {
  args: {
    data: generateMockData(90, 10000, 200, 'up'),
    height: 300,
    title: '自定义颜色',
    showTooltip: true,
    lineColor: '#8b5cf6',
    areaTopColor: 'rgba(139, 92, 246, 0.4)',
    areaBottomColor: 'rgba(139, 92, 246, 0.0)',
  },
}

export const Empty: Story = {
  args: {
    data: [],
    height: 300,
    title: '无数据',
    showTooltip: true,
  },
}

export const Compact: Story = {
  render: () => (
    <div style={{ width: 400 }}>
      <EquityCurve
        data={generateMockData(30, 10000, 200, 'up')}
        height={150}
        title="紧凑视图"
        showTooltip={false}
      />
    </div>
  ),
}
