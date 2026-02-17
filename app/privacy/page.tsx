import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Policy | Arena',
  description: 'Arena platform privacy policy - how we collect, use, and protect your data.',
}

export default function PrivacyPage() {
  return (
    <div style={{
      maxWidth: 800,
      margin: '0 auto',
      padding: '40px 20px',
      color: 'var(--color-text-primary)',
      lineHeight: 1.8,
    }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 32 }}>Privacy Policy</h1>
      <p style={{ color: 'var(--color-text-secondary)', marginBottom: 24 }}>Last updated: February 17, 2026</p>

      <Section title="1. Information We Collect">
        We collect information you provide when creating an account (email, social profile data, wallet address), content you post, and usage data (pages visited, features used). We use cookies and similar technologies for authentication and analytics.
      </Section>

      <Section title="2. How We Use Your Information">
        We use your information to: provide and improve the platform, personalize your experience (recommendations, feed), communicate important updates, ensure platform security, and comply with legal obligations.
      </Section>

      <Section title="3. Third-Party Services">
        We use the following third-party services: Supabase (authentication and database), Vercel (hosting), Google Analytics (usage analytics), Stripe (payments), Sentry (error tracking), and Upstash (caching). Each service has its own privacy policy.
      </Section>

      <Section title="4. Social Login">
        When you sign in with Google, X/Twitter, Discord, or Web3 wallet, we receive basic profile information (name, email, profile picture) as authorized by you. We do not post on your behalf or access your contacts without explicit permission.
      </Section>

      <Section title="5. Data Sharing">
        We do not sell your personal information. We may share data with: service providers who assist in operating the platform, law enforcement when required by law, or in connection with a business transfer. Your public profile and posts are visible to other users.
      </Section>

      <Section title="6. Data Security">
        We implement industry-standard security measures including encryption, row-level security policies, and secure authentication. However, no method of transmission over the internet is 100% secure.
      </Section>

      <Section title="7. Your Rights">
        You may: access, update, or delete your account data through settings, request a copy of your data, opt out of non-essential communications. For data deletion requests, use the account settings or contact us.
      </Section>

      <Section title="8. Data Retention">
        We retain your data as long as your account is active. After account deletion, we may retain certain data for legal compliance for up to 30 days before permanent deletion.
      </Section>

      <Section title="9. International Users">
        Arena is hosted in the United States. By using the platform, you consent to the transfer and processing of your data in the US.
      </Section>

      <Section title="10. Children">
        Arena is not intended for users under 18. We do not knowingly collect data from minors.
      </Section>

      <Section title="11. Changes">
        We may update this policy from time to time. We will notify you of significant changes through the platform.
      </Section>

      <Section title="12. Contact">
        For privacy-related questions or requests, contact us through the platform.
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
