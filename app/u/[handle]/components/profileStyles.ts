import { tokens } from '@/lib/design-tokens'

export const profileStyles = `
  .profile-tabs::-webkit-scrollbar { display: none; }
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (max-width: 768px) {
    .page-container {
      padding: ${tokens.spacing[3]} !important;
    }
    .profile-grid {
      grid-template-columns: 1fr !important;
    }
  }
`

export const userProfileStyles = `
  .profile-tabs::-webkit-scrollbar { display: none; }
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (max-width: 768px) {
    .page-container {
      padding: ${tokens.spacing[3]} !important;
    }
    .profile-content, .profile-grid {
      grid-template-columns: 1fr !important;
    }
    .profile-header {
      flex-direction: column !important;
      align-items: center !important;
      text-align: center !important;
      padding: ${tokens.spacing[4]} !important;
      min-height: auto !important;
    }
    .profile-header-info {
      flex-direction: column !important;
      align-items: center !important;
    }
    .profile-header-avatar {
      width: 56px !important;
      height: 56px !important;
    }
    .profile-header-actions {
      margin-top: ${tokens.spacing[3]} !important;
      width: 100%;
      justify-content: center !important;
    }
    .profile-tabs {
      margin-left: -${tokens.spacing[3]} !important;
      margin-right: -${tokens.spacing[3]} !important;
      padding: 0 ${tokens.spacing[3]} !important;
    }
  }
`
