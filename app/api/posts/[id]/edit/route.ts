import { type NextRequest } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import { handleAtomicPostEditHttp } from '@/lib/posts/post-edit-server'

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const { id: postId } = await params
  const handler = withAuth(
    async ({ user, supabase, request: authenticatedRequest }) =>
      handleAtomicPostEditHttp({
        request: authenticatedRequest,
        supabase,
        actorId: user.id,
        postId,
        envelope: 'direct',
      }),
    { name: 'posts-edit', rateLimit: 'write' }
  )

  return handler(request)
}
