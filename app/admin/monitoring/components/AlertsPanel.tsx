'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Card from '@/app/components/ui/Card'

interface Alert {
  id: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  message: string
  timestamp: string
}

interface AlertsPanelProps {
  alerts: {
    total: number
    critical: number
    warning: number
    items: Alert[]
  }
}

const SEVERITY_CONFIG = {
  critical: {
    color: '#FF7C7C',
    bgColor: '#FF7C7C20',
    icon: '🔴',
    label: 'Critical',
  },
  warning: {
    color: '#FFD700',
    bgColor: '#FFD70020',
    icon: '⚠️',
    label: 'Warning',
  },
  info: {
    color: '#7CFFB2',
    bgColor: '#7CFFB220',
    icon: 'ℹ️',
    label: 'Info',
  },
}

export default function AlertsPanel({ alerts }: AlertsPanelProps) {
  return (
    <Card title="Active Alerts">
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {/* Alert summary */}
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: tokens.spacing[3],
          }}
        >
          <Box
            style={{
              padding: tokens.spacing[3],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              Total Alerts
            </Text>
            <Text size="2xl" weight="black">
              {alerts.total}
            </Text>
          </Box>

          <Box
            style={{
              padding: tokens.spacing[3],
              background: `${SEVERITY_CONFIG.critical.color}10`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${SEVERITY_CONFIG.critical.color}`,
            }}
          >
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              Critical
            </Text>
            <Text size="2xl" weight="black" style={{ color: SEVERITY_CONFIG.critical.color }}>
              {alerts.critical}
            </Text>
          </Box>

          <Box
            style={{
              padding: tokens.spacing[3],
              background: `${SEVERITY_CONFIG.warning.color}10`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${SEVERITY_CONFIG.warning.color}`,
            }}
          >
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              Warning
            </Text>
            <Text size="2xl" weight="black" style={{ color: SEVERITY_CONFIG.warning.color }}>
              {alerts.warning}
            </Text>
          </Box>
        </Box>

        {/* Alert list */}
        <Box
          style={{
            maxHeight: '300px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[2],
          }}
        >
          {alerts.items.length === 0 ? (
            <Box
              style={{
                padding: tokens.spacing[6],
                textAlign: 'center',
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.md,
              }}
            >
              <Text size="lg" style={{ marginBottom: tokens.spacing[2] }}>
                ✅
              </Text>
              <Text size="sm" color="secondary">
                No active alerts
              </Text>
              <Text size="xs" color="tertiary">
                All systems operating normally
              </Text>
            </Box>
          ) : (
            alerts.items.map((alert) => {
              const config = SEVERITY_CONFIG[alert.severity]
              return (
                <Box
                  key={alert.id}
                  style={{
                    padding: tokens.spacing[3],
                    background: config.bgColor,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${config.color}`,
                  }}
                >
                  <Box style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[2] }}>
                    <Text size="md">{config.icon}</Text>
                    <Box style={{ flex: 1 }}>
                      <Box
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          marginBottom: tokens.spacing[1],
                        }}
                      >
                        <Text size="sm" weight="bold" style={{ color: config.color }}>
                          {alert.title}
                        </Text>
                        <Text size="xs" color="tertiary">
                          {new Date(alert.timestamp).toLocaleTimeString()}
                        </Text>
                      </Box>
                      <Text size="xs" color="secondary">
                        {alert.message}
                      </Text>
                    </Box>
                  </Box>
                </Box>
              )
            })
          )}
        </Box>
      </Box>
    </Card>
  )
}
