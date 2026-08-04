import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import postcss, { type Rule } from 'postcss'
import {
  PaymentSuccessLoadingFallback,
  PaymentSuccessState,
  type PaymentVerificationStatus,
} from '../PaymentSuccessState'

const copy: Record<string, string> = {
  activatingMembership: 'Activating membership...',
  syncingSubscription: 'Please wait while we sync your subscription',
  thisUsuallyTakesSeconds: 'This usually takes a few seconds',
  paymentSuccess: 'Payment Successful',
  congratsProMember: 'Congratulations! You are now a Pro member',
  proMember: 'Pro Member',
  proGetStarted: 'Get started with Pro',
  proStep1: 'Explore rankings with advanced Pro filters',
  proStep2: 'Compare top traders side by side',
  proStep3: 'Set up trader alerts & preferences',
  inviteFriendsTitle: 'Invite friends to Arena',
  inviteFriendsDesc: 'Share Arena and unlock referral rewards',
  inviteFriendsCta: 'Invite',
  exploreProRankings: 'Explore Pro rankings',
  startExploring: 'Start Exploring',
  receiptSentTo: 'Receipt sent to {email}',
  receiptEmailed: 'A receipt has been emailed to you',
  paymentStatusUnconfirmed: "We couldn't confirm your payment",
  paymentStatusUnconfirmedDesc:
    "We couldn't confirm your subscription status. If you were charged, your membership usually activates within a few minutes.",
  contactSupportIfFails:
    'If it still fails after retrying, please contact adelinewen1107@outlook.com',
  retrying: 'Retrying...',
  retryActivation: 'Retry Activation',
  backToHome: 'Back to Home',
}

const t = (key: string) => copy[key] ?? key

function renderState(
  status: PaymentVerificationStatus,
  overrides: Partial<React.ComponentProps<typeof PaymentSuccessState>> = {}
) {
  const props: React.ComponentProps<typeof PaymentSuccessState> = {
    status,
    email: null,
    retrying: false,
    onRetry: jest.fn(),
    t,
    ...overrides,
  }

  return { ...render(<PaymentSuccessState {...props} />), props }
}

describe('PaymentSuccessState accessibility and actions', () => {
  it('announces a non-interactive verifying state as busy', () => {
    const { container } = renderState('verifying')

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('heading', { name: copy.activatingMembership })).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('exposes one focus target per success action and sends compare to the compare flow', () => {
    const longEmail = `${'very-long-receipt-address-'.repeat(5)}@example.com`
    const { container } = renderState('success', { email: longEmail })

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByRole('heading', { name: copy.paymentSuccess })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: copy.proStep1 })).toHaveAttribute('href', '/rankings')
    expect(screen.getByRole('link', { name: copy.proStep2 })).toHaveAttribute('href', '/compare')
    expect(screen.getByRole('link', { name: copy.proStep3 })).toHaveAttribute('href', '/settings')
    expect(screen.getByRole('link', { name: copy.exploreProRankings })).toHaveAttribute(
      'href',
      '/rankings'
    )
    expect(screen.getByText(`Receipt sent to ${longEmail}`)).toBeInTheDocument()
    expect(container.querySelectorAll('a button')).toHaveLength(0)
  })

  it('announces the error assertively and keeps retry as a real button', () => {
    const onRetry = jest.fn()
    const { container } = renderState('error', { onRetry })

    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive')
    fireEvent.click(screen.getByRole('button', { name: copy.retryActivation }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: copy.backToHome })).toHaveAttribute('href', '/')
    expect(container.querySelectorAll('a button')).toHaveLength(0)
  })

  it.each(['success', 'error'] as const)(
    'moves focus to the %s heading when verification completes',
    async (nextStatus) => {
      const { rerender } = render(
        <PaymentSuccessState
          status="verifying"
          email={null}
          retrying={false}
          onRetry={jest.fn()}
          t={t}
        />
      )

      rerender(
        <PaymentSuccessState
          status={nextStatus}
          email={null}
          retrying={false}
          onRetry={jest.fn()}
          t={t}
        />
      )

      const heading = screen.getByRole('heading', {
        name: nextStatus === 'success' ? copy.paymentSuccess : copy.paymentStatusUnconfirmed,
      })
      await waitFor(() => expect(heading).toHaveFocus())
    }
  )

  it('gives the Suspense fallback an accessible loading name', () => {
    render(<PaymentSuccessLoadingFallback />)

    expect(screen.getByRole('status', { name: 'Loading payment confirmation' })).toHaveAttribute(
      'aria-busy',
      'true'
    )
  })
})

const stylesheetSource = readFileSync(
  join(process.cwd(), 'app/(app)/pricing/success/PaymentSuccessState.module.css'),
  'utf8'
)
const stylesheet = postcss.parse(stylesheetSource)

function normalized(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function mediaMatchesWidth(params: string, width: number) {
  const query = normalized(params).toLowerCase()
  const constraints = Array.from(
    query.matchAll(/\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/g)
  )

  return constraints.every(([, boundary, rawValue]) => {
    const value = Number(rawValue)
    return boundary === 'min' ? width >= value : width <= value
  })
}

function ruleMatchesWidth(rule: Rule, width: number) {
  let parent = rule.parent

  while (parent) {
    if (
      parent.type === 'atrule' &&
      parent.name === 'media' &&
      /(?:min|max)-width/.test(parent.params) &&
      !mediaMatchesWidth(parent.params, width)
    ) {
      return false
    }
    parent = parent.parent
  }

  return true
}

function resolveDeclarations(selector: string, width: number) {
  const declarations: Record<string, string> = {}

  stylesheet.walkRules((rule) => {
    const selectors = normalized(rule.selector)
      .split(',')
      .map((part) => part.trim())
    if (!selectors.includes(selector) || !ruleMatchesWidth(rule, width)) return

    rule.nodes.forEach((node) => {
      if (node.type === 'decl') declarations[node.prop] = normalized(node.value)
    })
  })

  return declarations
}

describe('PaymentSuccessState responsive geometry contract', () => {
  it.each([
    [
      320,
      'max(12px, env(safe-area-inset-left, 0px))',
      'max(32px, env(safe-area-inset-bottom, 0px))',
    ],
    [
      375,
      'max(16px, env(safe-area-inset-left, 0px))',
      'max(32px, env(safe-area-inset-bottom, 0px))',
    ],
    [
      1440,
      'max(24px, env(safe-area-inset-left, 0px))',
      'max(40px, env(safe-area-inset-bottom, 0px))',
    ],
  ])('keeps %ipx inside the viewport and safe area', (width, paddingLeft, paddingBottom) => {
    expect(resolveDeclarations('.page', width)).toMatchObject({
      width: '100%',
      'max-width': '100%',
      'min-height': 'calc(100dvh - 56px)',
      'overflow-x': 'clip',
    })
    expect(resolveDeclarations('.content', width)).toMatchObject({
      width: '100%',
      'max-width': '600px',
      'padding-left': paddingLeft,
      'padding-bottom': paddingBottom,
    })
    expect(resolveDeclarations('.actions', width)['flex-direction']).toBe(
      width <= 480 ? 'column' : 'row'
    )
  })

  it('keeps every interactive result control at least 48px tall', () => {
    expect(resolveDeclarations('.stepCard', 320)['min-height']).toBe('48px')
    expect(resolveDeclarations('.referralCard', 320)['min-height']).toBe('56px')
    expect(resolveDeclarations('.actionControl', 320)).toMatchObject({
      'min-height': '48px',
      width: '100%',
    })
    expect(resolveDeclarations('.retryButton', 320)).toMatchObject({
      'min-height': '48px',
      width: '100%',
    })
  })

  it('ships keyboard focus and reduced-motion rules with the route', () => {
    expect(stylesheetSource).toContain('.stepLink:focus-visible,')
    expect(stylesheetSource).toContain('outline: 2px solid var(--color-brand);')
    expect(stylesheetSource).toContain(':global(.mobile-bottom-nav-spacer)')
    expect(stylesheetSource).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.spinner\s*{\s*animation: none;/
    )
  })
})
