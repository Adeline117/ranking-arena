import type { Meta, StoryObj } from '@storybook/react'
import { Box, Text } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'

const meta: Meta<typeof Box> = {
  title: 'Base/Box',
  component: Box,
  tags: ['autodocs'],
  argTypes: {
    bg: {
      control: 'select',
      options: ['primary', 'secondary', 'tertiary'],
      description: '背景色',
    },
    p: {
      control: 'number',
      description: '内边距 (spacing 单位)',
    },
    px: {
      control: 'number',
      description: '水平内边距',
    },
    py: {
      control: 'number',
      description: '垂直内边距',
    },
    radius: {
      control: 'select',
      options: ['none', 'sm', 'md', 'lg', 'full'],
      description: '圆角',
    },
    border: {
      control: 'select',
      options: ['none', 'primary', 'secondary'],
      description: '边框',
    },
  },
}

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    bg: 'secondary',
    p: 4,
    radius: 'md',
    children: <Text>这是一个 Box 组件</Text>,
  },
}

export const WithBorder: Story = {
  args: {
    bg: 'secondary',
    p: 4,
    radius: 'md',
    border: 'primary',
    children: <Text>带边框的 Box</Text>,
  },
}

export const WithShadow: Story = {
  render: () => (
    <Box
      bg="secondary"
      p={4}
      radius="lg"
      style={{ boxShadow: tokens.shadow.md }}
    >
      <Text>带阴影的 Box</Text>
    </Box>
  ),
}

export const Nested: Story = {
  render: () => (
    <Box bg="secondary" p={4} radius="lg">
      <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
        外层 Box
      </Text>
      <Box bg="tertiary" p={3} radius="md">
        <Text>内层 Box</Text>
      </Box>
    </Box>
  ),
}

export const FlexLayout: Story = {
  render: () => (
    <Box
      bg="secondary"
      p={4}
      radius="md"
      style={{ display: 'flex', gap: tokens.spacing[3] }}
    >
      <Box bg="tertiary" p={3} radius="sm" style={{ flex: 1 }}>
        <Text>Item 1</Text>
      </Box>
      <Box bg="tertiary" p={3} radius="sm" style={{ flex: 1 }}>
        <Text>Item 2</Text>
      </Box>
      <Box bg="tertiary" p={3} radius="sm" style={{ flex: 1 }}>
        <Text>Item 3</Text>
      </Box>
    </Box>
  ),
}
