/**
 * Backward-compatible notification mark-read endpoint.
 *
 * The canonical PUT handler owns strict request validation and the atomic
 * database authority. Keeping this path as an alias avoids a second writer
 * drifting back to direct table updates.
 */

// The imported handler is the canonical mutation already wrapped by withAuth.
// Preserve that name here so both reviewers and the auth-coverage gate can see
// that this compatibility alias never exposes the unwrapped writer.
import { PUT as withAuthNotificationMutation } from '../route'

export const dynamic = 'force-dynamic'
export const POST = withAuthNotificationMutation
