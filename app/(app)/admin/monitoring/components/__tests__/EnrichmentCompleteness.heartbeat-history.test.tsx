import { render, screen, waitFor } from '@testing-library/react'
import { tokens } from '@/lib/design-tokens'
import EnrichmentCompleteness from '../EnrichmentCompleteness'

const UNAVAILABLE_PAYLOAD = {
  enrichment_stats: [],
  dead_letter_queue: [],
  dead_letter_total: 0,
  pipeline_24h: { total: 0, success: 0, success_rate_pct: 0 },
  heartbeats: [],
  heartbeat_history: {
    availability: false,
    code: 'HEARTBEAT_HISTORY_NOT_PUBLISHED',
  },
}

describe('EnrichmentCompleteness heartbeat history hold', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => UNAVAILABLE_PAYLOAD,
    }) as jest.Mock
  })

  it('renders a neutral unavailable status instead of a healthy-looking 0/0', async () => {
    render(<EnrichmentCompleteness accessToken="admin-token" />)

    await waitFor(() => expect(screen.getByText('Unavailable')).toBeInTheDocument())

    expect(screen.getByText('Heartbeat history is not published in V1.')).toBeInTheDocument()
    expect(screen.getByText('Unavailable')).toHaveStyle({
      color: tokens.colors.text.tertiary,
    })
    expect(screen.queryByText(/^0\/0$/)).not.toBeInTheDocument()
  })
})
