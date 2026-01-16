import type { Meta, StoryObj } from '@storybook/react'
import PnLChart from '@/app/components/Charts/PnLChart'

// 生成模拟 PnL 数据
function generateMockPnLData(days: number, avgValue: number, winRate: number) {
  const data = []
  
  for (let i = 0; i < days; i++) {
    const date = new Date()
    date.setDate(date.getDate() - days + i)
    const dateStr = date.toISOString().split('T')[0]
    
    // 根据胜率决定是盈利还是亏损
    const isWin = Math.random() < winRate
    const magnitude = Math.random() * avgValue * 2
    const value = isWin ? magnitude : -magnitude * 0.7
    
    data.push({ time: dateStr, value })
  }
  
  return data
}

const meta: Meta<typeof PnLChart> = {
  title: 'Charts/PnLChart',
  component: PnLChart,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
  },
  argTypes: {
    height: {
      control: { type: 'range', min: 150, max: 400, step: 50 },
      description: '图表高度',
    },
    title: {
      control: 'text',
      description: '图表标题',
    },
  },
}

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    data: generateMockPnLData(30, 500, 0.6),
    height: 200,
    title: '每日盈亏分布',
  },
}

export const HighWinRate: Story = {
  args: {
    data: generateMockPnLData(30, 500, 0.8),
    height: 200,
    title: '高胜率交易员',
  },
}

export const LowWinRate: Story = {
  args: {
    data: generateMockPnLData(30, 500, 0.3),
    height: 200,
    title: '低胜率交易员',
  },
}

export const LargePnL: Story = {
  args: {
    data: generateMockPnLData(30, 5000, 0.55),
    height: 200,
    title: '大额交易',
  },
}

export const WeeklyData: Story = {
  args: {
    data: generateMockPnLData(7, 1000, 0.6),
    height: 200,
    title: '本周盈亏',
  },
}

export const QuarterlyData: Story = {
  args: {
    data: generateMockPnLData(90, 300, 0.55),
    height: 250,
    title: '季度盈亏分布',
  },
}

export const CustomColors: Story = {
  args: {
    data: generateMockPnLData(30, 500, 0.6),
    height: 200,
    title: '自定义颜色',
    positiveColor: '#10b981',
    negativeColor: '#f43f5e',
  },
}

export const Empty: Story = {
  args: {
    data: [],
    height: 200,
    title: '无数据',
  },
}
