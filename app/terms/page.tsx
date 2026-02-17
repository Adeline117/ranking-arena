import { Metadata } from 'next'
import { tokens } from '@/lib/design-tokens'

export const metadata: Metadata = {
  title: 'Terms of Service | Arena',
  description: 'Arena platform terms of service and user agreement.',
}

export default function TermsPage() {
  return (
    <div style={{
      maxWidth: 800,
      margin: '0 auto',
      padding: '40px 20px',
      color: 'var(--color-text-primary)',
      lineHeight: 1.8,
    }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 32 }}>Terms of Service</h1>
      <p style={{ color: 'var(--color-text-secondary)', marginBottom: 24 }}>Last updated: February 17, 2026</p>

      <Section title="1. Acceptance of Terms">
        By accessing or using Arena (arenafi.org), you agree to be bound by these Terms of Service. If you do not agree, do not use the platform.
      </Section>

      <Section title="2. Description of Service">
        Arena is a social trading platform that aggregates publicly available trader performance data from various cryptocurrency exchanges. Arena provides ranking, analytics, and social features for informational and educational purposes only.
      </Section>

      <Section title="3. User Accounts">
        You may create an account using email, social login (Google, X/Twitter, Discord), or Web3 wallet. You are responsible for maintaining the security of your account credentials. You must be at least 18 years old to use the platform.
      </Section>

      <Section title="4. User Content">
        You retain ownership of content you post on Arena (posts, comments, reviews). By posting, you grant Arena a non-exclusive license to display your content on the platform. You agree not to post illegal, abusive, or misleading content.
      </Section>

      <Section title="5. Prohibited Activities">
        You may not: manipulate rankings or data, impersonate other users or traders, use automated tools to scrape data without permission, or engage in any activity that disrupts the platform.
      </Section>

      <Section title="6. Disclaimer">
        Arena does not provide financial advice. Trader performance data is aggregated from third-party sources and may contain inaccuracies. Past performance does not guarantee future results. You are solely responsible for your trading decisions.
      </Section>

      <Section title="7. Limitation of Liability">
        Arena is provided &quot;as is&quot; without warranties. We are not liable for any losses arising from your use of the platform, including but not limited to trading losses based on information displayed on Arena.
      </Section>

      <Section title="8. Intellectual Property">
        The Arena platform, including its design, features, and aggregated data presentations, is protected by intellectual property laws. Exchange data remains the property of their respective owners.
      </Section>

      <Section title="9. Termination">
        We may suspend or terminate accounts that violate these terms. You may delete your account at any time through account settings.
      </Section>

      <Section title="10. Changes to Terms">
        We may update these terms from time to time. Continued use of the platform after changes constitutes acceptance.
      </Section>

      <Section title="11. Contact">
        For questions about these terms, contact us through the platform or at the information provided on our website.
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{title}</h2>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 15 }}>{children}</p>
    </div>
  )
}
