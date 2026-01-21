import type { Meta, StoryObj } from '@storybook/react'
import { Button, Box } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'

const meta: Meta<typeof Button> = {
  title: 'Base/Button',
  component: Button,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'ghost'],
      description: '按钮变体',
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
      description: '按钮大小',
    },
    disabled: {
      control: 'boolean',
      description: '是否禁用',
    },
    loading: {
      control: 'boolean',
      description: '是否加载中',
    },
  },
}

export default meta
type Story = StoryObj<typeof meta>

export const Primary: Story = {
  args: {
    children: '主要按钮',
    variant: 'primary',
    size: 'md',
  },
}

export const Secondary: Story = {
  args: {
    children: '次要按钮',
    variant: 'secondary',
    size: 'md',
  },
}

export const Ghost: Story = {
  args: {
    children: '幽灵按钮',
    variant: 'ghost',
    size: 'md',
  },
}

export const Sizes: Story = {
  render: () => (
    <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
      <Button size="sm" variant="primary">Small</Button>
      <Button size="md" variant="primary">Medium</Button>
      <Button size="lg" variant="primary">Large</Button>
    </Box>
  ),
}

export const AllVariants: Story = {
  render: () => (
    <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
    </Box>
  ),
}

export const Disabled: Story = {
  render: () => (
    <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
      <Button variant="primary" disabled>Primary Disabled</Button>
      <Button variant="secondary" disabled>Secondary Disabled</Button>
      <Button variant="ghost" disabled>Ghost Disabled</Button>
    </Box>
  ),
}

export const Loading: Story = {
  render: () => (
    <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
      <Button variant="primary" loading>Loading...</Button>
      <Button variant="secondary" loading>Loading...</Button>
    </Box>
  ),
}

export const WithIcons: Story = {
  render: () => (
    <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
      <Button variant="primary">
        <span style={{ marginRight: tokens.spacing[2] }}>✓</span>
        确认
      </Button>
      <Button variant="secondary">
        <span style={{ marginRight: tokens.spacing[2] }}>⚙</span>
        设置
      </Button>
      <Button variant="ghost">
        <span style={{ marginRight: tokens.spacing[2] }}>↗</span>
        分享
      </Button>
    </Box>
  ),
}

export const FullWidth: Story = {
  render: () => (
    <Box style={{ width: 300 }}>
      <Button variant="primary" style={{ width: '100%', marginBottom: tokens.spacing[2] }}>
        全宽按钮
      </Button>
      <Button variant="secondary" style={{ width: '100%' }}>
        全宽次要按钮
      </Button>
    </Box>
  ),
}
