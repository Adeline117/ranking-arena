import { DEAD_BLOCKED_PLATFORMS } from '@/lib/constants/exchanges'
import {
  classifyPipelineJobIdentity,
  isAuthoritativePipelineStatusIdentity,
  isRetiredPipelineJobName,
} from '../pipeline-job-lifecycle'

describe('pipeline job lifecycle tombstones', () => {
  test.each([
    'fetch-traders-bybit',
    'batch-fetch-traders-a1',
    'batch-enrich',
    'batch-enrich-gmx',
    'cleanup-violations',
    'compute-derived-metrics',
    'ensure-partitions',
    'retry-dead-letters',
    'unified-connector',
  ])('classifies %s as retired', (jobName) => {
    expect(isRetiredPipelineJobName(jobName)).toBe(true)
  })

  test.each([
    'batch-5min',
    'compute-leaderboard-7D',
    'aggregate-daily-snapshots',
    'cleanup-stuck-logs',
    'check-data-freshness',
  ])('keeps %s active', (jobName) => {
    expect(isRetiredPipelineJobName(jobName)).toBe(false)
  })

  test('fails closed for malformed job identities', () => {
    expect(isRetiredPipelineJobName(null)).toBe(false)
    expect(isRetiredPipelineJobName('')).toBe(false)
    expect(classifyPipelineJobIdentity(null, DEAD_BLOCKED_PLATFORMS)).toBe('invalid')
    expect(classifyPipelineJobIdentity('', DEAD_BLOCKED_PLATFORMS)).toBe('invalid')
    expect(classifyPipelineJobIdentity(' compute-leaderboard-7D', DEAD_BLOCKED_PLATFORMS)).toBe(
      'invalid'
    )
    expect(classifyPipelineJobIdentity('compute leaderboard', DEAD_BLOCKED_PLATFORMS)).toBe(
      'invalid'
    )
  })

  test('uses exact platform identities from the real blocked-platform registry', () => {
    expect(DEAD_BLOCKED_PLATFORMS).toContain('drift')
    expect(classifyPipelineJobIdentity('backfill-avatars-drift', DEAD_BLOCKED_PLATFORMS)).toBe(
      'blocked_platform'
    )
    expect(
      classifyPipelineJobIdentity(
        'backfill-avatars-drift,bitmart,perpetual_protocol',
        DEAD_BLOCKED_PLATFORMS
      )
    ).toBe('blocked_platform')
    expect(
      classifyPipelineJobIdentity(
        'backfill-avatars-drift,toobit,bitfinex,etoro,gains',
        DEAD_BLOCKED_PLATFORMS
      )
    ).toBe('active')
    expect(classifyPipelineJobIdentity('audit-drift-report', DEAD_BLOCKED_PLATFORMS)).toBe('active')
  })

  test.each([
    ['success', 'healthy'],
    ['success', 'stale'],
    ['running', 'running'],
    ['running', 'stuck'],
    ['error', 'failed'],
    ['timeout', 'failed'],
    ['partial_success', 'partial_success'],
  ])('accepts coherent status identity %s/%s', (status, healthStatus) => {
    expect(isAuthoritativePipelineStatusIdentity(status, healthStatus)).toBe(true)
  })

  test.each([
    [null, 'healthy'],
    ['success', null],
    ['', 'healthy'],
    [' success', 'healthy'],
    ['success', 'failed'],
    ['error', 'healthy'],
    ['unknown', 'healthy'],
  ])('rejects malformed or incoherent status identity %p/%p', (status, healthStatus) => {
    expect(isAuthoritativePipelineStatusIdentity(status, healthStatus)).toBe(false)
  })
})
