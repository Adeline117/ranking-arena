/**
 * Barrel re-export for all page skeleton components.
 * Individual skeletons live in ./skeletons/ for maintainability.
 */

// Shared wrapper
export { PageShell } from './skeletons/PageShell'

// Rankings, market, trading
export {
  MarketPageSkeleton,
  ComparePageSkeleton,
  RankingsPageSkeleton,
  PortfolioPageSkeleton,
  PricingPageSkeleton,
  MembershipPageSkeleton,
  TraderProfilePageSkeleton,
} from './skeletons/RankingAndMarketSkeletons'

// Social: groups, posts, messages, notifications
export {
  GroupsPageSkeleton,
  GroupDetailPageSkeleton,
  GroupManagePageSkeleton,
  PostFeedPageSkeleton,
  PostDetailPageSkeleton,
  NotificationsPageSkeleton,
  MessagesPageSkeleton,
  ConversationPageSkeleton,
  ChannelsPageSkeleton,
  FavoritesPageSkeleton,
} from './skeletons/SocialSkeletons'

// Library: books, reader
export {
  LibraryPageSkeleton,
  BookDetailPageSkeleton,
  ReaderPageSkeleton,
} from './skeletons/LibrarySkeletons'

// Utility: settings, forms, admin, search, misc
export {
  SettingsPageSkeleton,
  CenteredFormSkeleton,
  CenteredMessageSkeleton,
  FormPageSkeleton,
  SearchPageSkeleton,
  StatusPageSkeleton,
  AdminPageSkeleton,
  HelpPageSkeleton,
  GovernancePageSkeleton,
  OnboardingPageSkeleton,
  FlashNewsPageSkeleton,
  UserCenterPageSkeleton,
  UserProfilePageSkeleton,
} from './skeletons/UtilitySkeletons'
