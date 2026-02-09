'use client'

import React from 'react'
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
    color: 'var(--color-accent-error)',
    bgColor: 'var(--color-accent-error-10)',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--color-accent-error)" stroke="none"><circle cx="12" cy="12" r="10"/></svg>,
    label: 'Critical',
  },
  warning: {
    color: 'var(--color-medal-gold)',
    bgColor: 'var(--color-gold-bg)',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-medal-gold)" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
    label: 'Warning',
  },
  info: {
    color: 'var(--color-chart-green)',
    bgColor: 'var(--color-accent-success-20)',
    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-chart-green)" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
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
              <Box style={{ display: 'flex', justifyContent: 'center', marginBottom: tokens.spacing[2], color: tokens.colors.accent.success }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              </Box>
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
                    <span style={{ display: 'flex', alignItems: 'center' }}>{config.icon}</span>
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
