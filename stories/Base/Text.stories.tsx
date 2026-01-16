import type { Meta, StoryObj } from '@storybook/react'
import { Text } from '@/app/components/Base'
import { Box } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'

const meta: Meta<typeof Text> = {
  title: 'Base/Text',
  component: Text,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'],
      description: '字体大小',
    },
    weight: {
      control: 'select',
      options: ['normal', 'medium', 'semibold', 'bold', 'black'],
      description: '字体粗细',
    },
    color: {
      control: 'select',
      options: ['primary', 'secondary', 'tertiary'],
      description: '文字颜色',
    },
  },
}

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: '这是一段文本',
    size: 'base',
    weight: 'normal',
    color: 'primary',
  },
}

export const Sizes: Story = {
  render: () => (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      <Text size="xs">Extra Small (xs)</Text>
      <Text size="sm">Small (sm)</Text>
      <Text size="base">Base (base)</Text>
      <Text size="lg">Large (lg)</Text>
      <Text size="xl">Extra Large (xl)</Text>
      <Text size="2xl">2X Large (2xl)</Text>
      <Text size="3xl">3X Large (3xl)</Text>
    </Box>
  ),
}

export const Weights: Story = {
  render: () => (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      <Text weight="normal">Normal Weight</Text>
      <Text weight="medium">Medium Weight</Text>
      <Text weight="semibold">Semibold Weight</Text>
      <Text weight="bold">Bold Weight</Text>
      <Text weight="black">Black Weight</Text>
    </Box>
  ),
}

export const Colors: Story = {
  render: () => (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      <Text color="primary">Primary Color</Text>
      <Text color="secondary">Secondary Color</Text>
      <Text color="tertiary">Tertiary Color</Text>
      <Text style={{ color: tokens.colors.accent.success }}>Success Color</Text>
      <Text style={{ color: tokens.colors.accent.error }}>Error Color</Text>
      <Text style={{ color: tokens.colors.accent.warning }}>Warning Color</Text>
    </Box>
  ),
}

export const MonoFont: Story = {
  render: () => (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      <Text>Regular: 1234567890</Text>
      <Text style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
        Mono: 1234567890
      </Text>
      <Text style={{ fontFamily: tokens.typography.fontFamily.mono.join(', '), color: tokens.colors.accent.success }}>
        +$12,345.67
      </Text>
      <Text style={{ fontFamily: tokens.typography.fontFamily.mono.join(', '), color: tokens.colors.accent.error }}>
        -$1,234.56
      </Text>
    </Box>
  ),
}

export const Combined: Story = {
  render: () => (
    <Box bg="secondary" p={4} radius="md">
      <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
        交易员业绩
      </Text>
      <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
        最近 90 天表现
      </Text>
      <Box style={{ display: 'flex', gap: tokens.spacing[4] }}>
        <Box>
          <Text size="xs" color="tertiary">ROI</Text>
          <Text size="lg" weight="bold" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', '), color: tokens.colors.accent.success }}>
            +125.4%
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary">PnL</Text>
          <Text size="lg" weight="bold" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', '), color: tokens.colors.accent.success }}>
            $45,230
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary">胜率</Text>
          <Text size="lg" weight="bold" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
            68.5%
          </Text>
        </Box>
      </Box>
    </Box>
  ),
}
