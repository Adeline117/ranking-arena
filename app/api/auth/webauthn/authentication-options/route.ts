/**
 * WebAuthn Authentication Options (PUBLIC — passwordless login start)
 * POST: generate discoverable-credential authentication options and store the
 * challenge under a random opaque `challengeKey` (no user yet at this point).
 */

import { randomBytes } from 'crypto'
import { generateAuthenticationOptions } from '@simplewebauthn/server'
import { withPublic } from '@/lib/api/middleware'
import { serverError } from '@/lib/api/response'
import { NextResponse } from 'next/server'
import { getWebAuthnConfig, storeAuthenticationChallenge } from '@/lib/auth/webauthn'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('webauthn-authentication-options')

export const dynamic = 'force-dynamic'

export const POST = withPublic(
  async ({ request }) => {
    try {
      const { rpID } = getWebAuthnConfig(request)

      const options = await generateAuthenticationOptions({
        rpID,
        // Empty allowCredentials → usernameless / discoverable credential flow:
        // the authenticator offers the user any passkey it holds for this RP.
        allowCredentials: [],
        userVerification: 'preferred',
      })

      const challengeKey = randomBytes(32).toString('hex')
      await storeAuthenticationChallenge(challengeKey, options.challenge)

      return NextResponse.json({ optionsJSON: options, challengeKey })
    } catch (err) {
      logger.error('[authentication-options] Error:', err)
      return serverError('Failed to generate authentication options')
    }
  },
  {
    name: 'webauthn-authentication-options',
    rateLimit: 'auth',
    skipCsrf: true,
  }
)
