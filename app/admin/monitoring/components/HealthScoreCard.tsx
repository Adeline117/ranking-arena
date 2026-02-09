'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Card from '@/app/components/ui/Card'

interface HealthScoreCardProps {
  health: {
    score: number
    status: 'healthy' | 'warning' | 'critical'
    color: string
    message: string
  }
  timestamp: string
}

export default function HealthScoreCard({ health, timestamp: _timestamp }: HealthScoreCardProps) {
  // Calculate progress for circular indicator
  const circumference = 2 * Math.PI * 45 // radius = 45
  const progress = (health.score / 100) * circumference
  const offset = circumference - progress

  return (
    <Card title="System Health">
      <Box
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: tokens.spacing[4],
        }}
      >
        {/* Circular progress */}
        <Box style={{ position: 'relative', width: 120, height: 120, marginBottom: tokens.spacing[4] }}>
          <svg width="120" height="120" style={{ transform: 'rotate(-90deg)' }}>
            {/* Background circle */}
            <circle
              cx="60"
              cy="60"
              r="45"
              stroke={tokens.colors.border.primary}
              strokeWidth="10"
              fill="none"
            />
            {/* Progress circle */}
            <circle
              cx="60"
              cy="60"
              r="45"
              stroke={health.color}
              strokeWidth="10"
              fill="none"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
              style={{
                transition: 'stroke-dashoffset 0.5s ease',
              }}
            />
          </svg>
          {/* Score text */}
          <Box
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              textAlign: 'center',
            }}
          >
            <Text size="3xl" weight="black" style={{ color: health.color }}>
              {health.score}
            </Text>
            <Text size="xs" color="tertiary">
              / 100
            </Text>
          </Box>
        </Box>

        {/* Status badge */}
        <Box
          style={{
            padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.full,
            background: `${health.color}20`,
            border: `1px solid ${health.color}`,
            marginBottom: tokens.spacing[2],
          }}
        >
          <Text size="sm" weight="bold" style={{ color: health.color, textTransform: 'uppercase' }}>
            {health.status}
          </Text>
        </Box>

        {/* Message */}
        <Text size="sm" color="secondary" style={{ textAlign: 'center' }}>
          {health.message}
        </Text>

        {/* Score breakdown */}
        <Box
          style={{
            width: '100%',
            marginTop: tokens.spacing[4],
            padding: tokens.spacing[3],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.md,
          }}
        >
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
            Health Score Factors:
          </Text>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
            <Box style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Text size="xs" color="secondary">
                Data Freshness
              </Text>
              <Text size="xs" color="secondary">
                {health.score >= 80 ? 'OK' : health.score >= 60 ? 'WARN' : 'FAIL'}
              </Text>
            </Box>
            <Box style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Text size="xs" color="secondary">
                Anomaly Status
              </Text>
              <Text size="xs" color="secondary">
                {health.score >= 80 ? 'OK' : health.score >= 60 ? 'WARN' : 'FAIL'}
              </Text>
            </Box>
            <Box style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Text size="xs" color="secondary">
                Scraper Health
              </Text>
              <Text size="xs" color="secondary">
                {health.score >= 80 ? 'OK' : health.score >= 60 ? 'WARN' : 'FAIL'}
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>
    </Card>
  )
}
