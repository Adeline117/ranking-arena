'use client'

import { useState, useEffect } from 'react'
import TopNav from '@/app/components/Layout/TopNav'
import VoteButtons, { generateMockVoteData, mockVoteDataList, type VoteData } from '@/app/components/Features/VoteButtons'
import { Box, Text } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'

export default function VoteDemoPage() {
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  // 使用 mock 数据列表
  const [voteDataList, setVoteDataList] = useState<VoteData[]>(mockVoteDataList)

  // 动态生成更多 mock 数据
  const [dynamicVotes, setDynamicVotes] = useState<VoteData[]>(() => {
    return Array.from({ length: 5 }, (_, i) => generateMockVoteData(i + 100))
  })

  const handleVoteChange = (index: number, vote: 'up' | 'down' | null, data: VoteData) => {
    const newList = [...voteDataList]
    newList[index] = data
    setVoteDataList(newList)
    console.log(`投票变化: 索引 ${index}, 投票: ${vote}, 数据:`, data)
  }

  const handleDynamicVoteChange = (index: number, vote: 'up' | 'down' | null, data: VoteData) => {
    const newList = [...dynamicVotes]
    newList[index] = data
    setDynamicVotes(newList)
    console.log(`动态投票变化: 索引 ${index}, 投票: ${vote}, 数据:`, data)
  }

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <TopNav email={email} />

      <Box
        style={{
          maxWidth: 800,
          margin: '0 auto',
          padding: tokens.spacing[6],
        }}
      >
        <Text size="xl" weight="black" style={{ marginBottom: tokens.spacing[6] }}>
          投票组件演示
        </Text>

        {/* 基础用法 */}
        <Box
          style={{
            marginBottom: tokens.spacing[8],
            padding: tokens.spacing[4],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
            基础用法
          </Text>
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              默认状态（无初始数据）
            </Text>
            <VoteButtons />
          </Box>
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              带初始数据
            </Text>
            <VoteButtons
              initialData={{
                upvotes: 123,
                downvotes: 45,
                userVote: 'up',
              }}
            />
          </Box>
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              禁用状态
            </Text>
            <VoteButtons
              initialData={{
                upvotes: 567,
                downvotes: 89,
                userVote: null,
              }}
              disabled
            />
          </Box>
          <Box>
            <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
              不显示数量
            </Text>
            <VoteButtons
              initialData={{
                upvotes: 999,
                downvotes: 111,
                userVote: 'down',
              }}
              showCount={false}
            />
          </Box>
        </Box>

        {/* Mock 数据列表 */}
        <Box
          style={{
            marginBottom: tokens.spacing[8],
            padding: tokens.spacing[4],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
            Mock 数据列表（预设数据）
          </Text>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {voteDataList.map((data, index) => (
              <Box
                key={index}
                style={{
                  padding: tokens.spacing[3],
                  background: tokens.colors.bg.primary,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.secondary}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Text size="sm" color="secondary">
                  项目 #{index + 1}
                </Text>
                <VoteButtons
                  initialData={data}
                  onVoteChange={(vote, newData) => handleVoteChange(index, vote, newData)}
                />
              </Box>
            ))}
          </Box>
        </Box>

        {/* 动态生成的数据 */}
        <Box
          style={{
            marginBottom: tokens.spacing[8],
            padding: tokens.spacing[4],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
            动态生成的 Mock 数据
          </Text>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {dynamicVotes.map((data, index) => (
              <Box
                key={index}
                style={{
                  padding: tokens.spacing[3],
                  background: tokens.colors.bg.primary,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.secondary}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Box>
                  <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[1] }}>
                    动态项目 #{index + 1}
                  </Text>
                  <Text size="xs" color="tertiary">
                    赞同: {data.upvotes} | 反对: {data.downvotes} | 我的投票: {data.userVote || '无'}
                  </Text>
                </Box>
                <VoteButtons
                  initialData={data}
                  onVoteChange={(vote, newData) => handleDynamicVoteChange(index, vote, newData)}
                />
              </Box>
            ))}
          </Box>
        </Box>

        {/* 使用说明 */}
        <Box
          style={{
            padding: tokens.spacing[4],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
            使用说明
          </Text>
          <Box as="ul" style={{ paddingLeft: tokens.spacing[5], color: tokens.colors.text.secondary }}>
            <li style={{ marginBottom: tokens.spacing[2] }}>
              <Text size="sm">
                <code>initialData</code>: 可选的初始投票数据（upvotes, downvotes, userVote）
              </Text>
            </li>
            <li style={{ marginBottom: tokens.spacing[2] }}>
              <Text size="sm">
                <code>onVoteChange</code>: 投票变化时的回调函数
              </Text>
            </li>
            <li style={{ marginBottom: tokens.spacing[2] }}>
              <Text size="sm">
                <code>showCount</code>: 是否显示投票数量（默认 true）
              </Text>
            </li>
            <li style={{ marginBottom: tokens.spacing[2] }}>
              <Text size="sm">
                <code>disabled</code>: 是否禁用投票（默认 false）
              </Text>
            </li>
            <li style={{ marginBottom: tokens.spacing[2] }}>
              <Text size="sm">
                <code>generateMockVoteData(seed?)</code>: 生成随机 mock 数据
              </Text>
            </li>
            <li>
              <Text size="sm">
                <code>mockVoteDataList</code>: 预设的 mock 数据数组
              </Text>
            </li>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

