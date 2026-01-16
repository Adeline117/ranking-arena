import type { Meta, StoryObj } from '@storybook/react'
import Card from '@/app/components/UI/Card'
import { Box, Text } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'

const meta: Meta<typeof Card> = {
  title: 'UI/Card',
  component: Card,
  tags: ['autodocs'],
  argTypes: {
    title: {
      control: 'text',
      description: '卡片标题',
    },
  },
}

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    title: '卡片标题',
    children: (
      <Text color="secondary">
        这是卡片内容。卡片是一个灵活的容器组件，可以包含各种内容。
      </Text>
    ),
  },
}

export const WithoutTitle: Story = {
  args: {
    children: (
      <Box>
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          自定义标题
        </Text>
        <Text color="secondary">
          没有使用 title prop 的卡片，可以自定义标题区域。
        </Text>
      </Box>
    ),
  },
}

export const WithList: Story = {
  args: {
    title: '热门讨论',
    children: (
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {[1, 2, 3].map((i) => (
          <Box
            key={i}
            style={{
              padding: tokens.spacing[2],
              background: tokens.colors.bg.tertiary,
              borderRadius: tokens.radius.sm,
            }}
          >
            <Text size="sm" weight="medium">
              讨论话题 {i}
            </Text>
            <Text size="xs" color="tertiary">
              5 分钟前 · 12 条评论
            </Text>
          </Box>
        ))}
      </Box>
    ),
  },
}

export const WithStats: Story = {
  args: {
    title: '数据统计',
    children: (
      <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: tokens.spacing[3] }}>
        <Box>
          <Text size="xs" color="tertiary">总交易员</Text>
          <Text size="xl" weight="bold">1,234</Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary">活跃用户</Text>
          <Text size="xl" weight="bold">567</Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary">今日新增</Text>
          <Text size="xl" weight="bold" style={{ color: tokens.colors.accent.success }}>+89</Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary">总帖子</Text>
          <Text size="xl" weight="bold">3,456</Text>
        </Box>
      </Box>
    ),
  },
}

export const Compact: Story = {
  render: () => (
    <Box style={{ width: 300 }}>
      <Card title="紧凑卡片">
        <Text size="sm" color="secondary">
          适合侧边栏使用的紧凑卡片样式。
        </Text>
      </Card>
    </Box>
  ),
}
