/**
 * Backward-compatible notification mark-read endpoint.
 *
 * The canonical PUT handler owns strict request validation and the atomic
 * database authority. Keeping this path as an alias avoids a second writer
 * drifting back to direct table updates.
 */

import { PUT } from '../route'

export const dynamic = 'force-dynamic'
export const POST = PUT
