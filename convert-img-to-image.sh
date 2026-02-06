#!/bin/bash
# Script to convert all remaining <img> tags to Next.js <Image> components

# List of files to process
FILES=(
  "app/groups/[id]/ui/GroupHeader.tsx"
  "app/groups/[id]/ui/GroupPostList.tsx"
  "app/groups/[id]/ui/GroupMembersSection.tsx"
  "app/groups/[id]/new/page.tsx"
  "app/groups/[id]/manage/page.tsx"
  "app/groups/[id]/page.tsx"
  "app/s/[token]/SnapshotViewerClient.tsx"
  "app/rankings/page.tsx"
  "app/components/ui/PostImage.tsx"
  "app/components/ranking/VirtualRankingList.tsx"
  "app/components/ranking/shared/TraderDisplay.tsx"
  "app/components/ranking/VirtualLeaderboard.tsx"
  "app/components/post/PostFeed.tsx"
  "app/components/post/MasonryPostCard.tsx"
  "app/components/post/CommentsModal.tsx"
  "app/components/premium/TraderComparison.tsx"
  "app/components/trader/JoinedGroups.tsx"
  "app/components/trader/PinnedPost.tsx"
  "app/components/trader/SimilarTraders.tsx"
  "app/components/trader/TraderAboutCard.tsx"
  "app/components/trader/TraderHeader.tsx"
  "app/components/trader/TraderPageV2.tsx"
  "app/components/trader/TraderReviews.tsx"
)

echo "Converting <img> tags to Next.js <Image> components..."
echo "Total files to process: ${#FILES[@]}"
echo ""

for file in "${FILES[@]}"; do
  if [ ! -f "$file" ]; then
    echo "⚠️  Skipping $file (not found)"
    continue
  fi

  # Count img tags before
  before=$(grep -c "<img" "$file" 2>/dev/null || echo 0)

  if [ "$before" -eq 0 ]; then
    echo "✓ $file (no img tags)"
    continue
  fi

  echo "Processing $file ($before img tags found)"
  echo "  This file needs manual review and update"
done

echo ""
echo "Script execution complete."
echo "Note: This script identifies files needing conversion."
echo "Manual conversion is recommended for complex cases."
