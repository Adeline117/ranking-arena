export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_bindings: {
        Row: {
          account_id: string | null
          created_at: string | null
          platform: string
          user_id: string
        }
        Insert: {
          account_id?: string | null
          created_at?: string | null
          platform: string
          user_id: string
        }
        Update: {
          account_id?: string | null
          created_at?: string | null
          platform?: string
          user_id?: string
        }
        Relationships: []
      }
      admin_logs: {
        Row: {
          action: string
          admin_id: string
          created_at: string | null
          details: Json | null
          id: string
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          action: string
          admin_id: string
          created_at?: string | null
          details?: Json | null
          id?: string
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          action?: string
          admin_id?: string
          created_at?: string | null
          details?: Json | null
          id?: string
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: []
      }
      advanced_alert_conditions: {
        Row: {
          alert_channel: string[] | null
          alert_type: string
          condition_operator: string
          created_at: string
          id: string
          is_active: boolean | null
          last_triggered_at: string | null
          min_interval_hours: number | null
          threshold_percent: boolean | null
          threshold_value: number
          time_window: string | null
          trader_id: string
          trigger_count: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          alert_channel?: string[] | null
          alert_type: string
          condition_operator: string
          created_at?: string
          id?: string
          is_active?: boolean | null
          last_triggered_at?: string | null
          min_interval_hours?: number | null
          threshold_percent?: boolean | null
          threshold_value: number
          time_window?: string | null
          trader_id: string
          trigger_count?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          alert_channel?: string[] | null
          alert_type?: string
          condition_operator?: string
          created_at?: string
          id?: string
          is_active?: boolean | null
          last_triggered_at?: string | null
          min_interval_hours?: number | null
          threshold_percent?: boolean | null
          threshold_value?: number
          time_window?: string | null
          trader_id?: string
          trigger_count?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "advanced_alert_conditions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advanced_alert_conditions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_follow_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advanced_alert_conditions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      alert_config: {
        Row: {
          enabled: boolean | null
          id: string
          key: string
          updated_at: string | null
          updated_by: string | null
          value: string | null
        }
        Insert: {
          enabled?: boolean | null
          id?: string
          key: string
          updated_at?: string | null
          updated_by?: string | null
          value?: string | null
        }
        Update: {
          enabled?: boolean | null
          id?: string
          key?: string
          updated_at?: string | null
          updated_by?: string | null
          value?: string | null
        }
        Relationships: []
      }
      alert_history: {
        Row: {
          alert_id: string | null
          alert_type: string
          channels_notified: string[] | null
          condition_id: string | null
          data: Json | null
          delivered_at: string
          id: string
          message: string | null
          read_at: string | null
          snapshot_data: Json | null
          threshold_value: number
          trader_id: string
          triggered_at: string | null
          triggered_value: number
          user_id: string
        }
        Insert: {
          alert_id?: string | null
          alert_type: string
          channels_notified?: string[] | null
          condition_id?: string | null
          data?: Json | null
          delivered_at?: string
          id?: string
          message?: string | null
          read_at?: string | null
          snapshot_data?: Json | null
          threshold_value: number
          trader_id: string
          triggered_at?: string | null
          triggered_value: number
          user_id: string
        }
        Update: {
          alert_id?: string | null
          alert_type?: string
          channels_notified?: string[] | null
          condition_id?: string | null
          data?: Json | null
          delivered_at?: string
          id?: string
          message?: string | null
          read_at?: string | null
          snapshot_data?: Json | null
          threshold_value?: number
          trader_id?: string
          triggered_at?: string | null
          triggered_value?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_history_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "trader_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alert_history_condition_id_fkey"
            columns: ["condition_id"]
            isOneToOne: false
            referencedRelation: "advanced_alert_conditions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alert_history_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alert_history_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_follow_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alert_history_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_daily: {
        Row: {
          active_users: number | null
          created_at: string | null
          date: string
          id: string
          new_claims: number | null
          new_follows: number | null
          page_views: number | null
          signups: number | null
          trader_page_views: number | null
        }
        Insert: {
          active_users?: number | null
          created_at?: string | null
          date: string
          id?: string
          new_claims?: number | null
          new_follows?: number | null
          page_views?: number | null
          signups?: number | null
          trader_page_views?: number | null
        }
        Update: {
          active_users?: number | null
          created_at?: string | null
          date?: string
          id?: string
          new_claims?: number | null
          new_follows?: number | null
          page_views?: number | null
          signups?: number | null
          trader_page_views?: number | null
        }
        Relationships: []
      }
      authorization_sync_logs: {
        Row: {
          authorization_id: string
          error_message: string | null
          id: string
          records_synced: number | null
          sync_status: string
          synced_at: string | null
          synced_data: Json | null
        }
        Insert: {
          authorization_id: string
          error_message?: string | null
          id?: string
          records_synced?: number | null
          sync_status: string
          synced_at?: string | null
          synced_data?: Json | null
        }
        Update: {
          authorization_id?: string
          error_message?: string | null
          id?: string
          records_synced?: number | null
          sync_status?: string
          synced_at?: string | null
          synced_data?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "authorization_sync_logs_authorization_id_fkey"
            columns: ["authorization_id"]
            isOneToOne: false
            referencedRelation: "trader_authorizations"
            referencedColumns: ["id"]
          },
        ]
      }
      backup_codes: {
        Row: {
          code_hash: string
          created_at: string | null
          id: string
          used: boolean | null
          used_at: string | null
          user_id: string | null
        }
        Insert: {
          code_hash: string
          created_at?: string | null
          id?: string
          used?: boolean | null
          used_at?: string | null
          user_id?: string | null
        }
        Update: {
          code_hash?: string
          created_at?: string | null
          id?: string
          used?: boolean | null
          used_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      blocked_users: {
        Row: {
          blocked_id: string
          blocker_id: string
          created_at: string | null
        }
        Insert: {
          blocked_id: string
          blocker_id: string
          created_at?: string | null
        }
        Update: {
          blocked_id?: string
          blocker_id?: string
          created_at?: string | null
        }
        Relationships: []
      }
      book_ratings: {
        Row: {
          created_at: string | null
          id: string
          library_item_id: string
          rating: number | null
          review: string | null
          status: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          library_item_id: string
          rating?: number | null
          review?: string | null
          status?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          library_item_id?: string
          rating?: number | null
          review?: string | null
          status?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "book_ratings_library_item_id_fkey"
            columns: ["library_item_id"]
            isOneToOne: false
            referencedRelation: "library_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "book_ratings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      bookmark_folders: {
        Row: {
          avatar_url: string | null
          created_at: string | null
          description: string | null
          id: string
          is_default: boolean | null
          is_public: boolean | null
          name: string
          post_count: number | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          is_default?: boolean | null
          is_public?: boolean | null
          name: string
          post_count?: number | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          is_default?: boolean | null
          is_public?: boolean | null
          name?: string
          post_count?: number | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      bot_equity_curve: {
        Row: {
          bot_id: string | null
          id: string
          period: string
          timestamp: string
          tvl: number | null
          value: number
        }
        Insert: {
          bot_id?: string | null
          id?: string
          period: string
          timestamp: string
          tvl?: number | null
          value: number
        }
        Update: {
          bot_id?: string | null
          id?: string
          period?: string
          timestamp?: string
          tvl?: number | null
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "bot_equity_curve_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bot_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_snapshots: {
        Row: {
          apy: number | null
          arena_score: number | null
          bot_id: string | null
          captured_at: string | null
          id: string
          market_cap: number | null
          max_drawdown: number | null
          mindshare_score: number | null
          revenue: number | null
          roi: number | null
          season_id: string
          sharpe_ratio: number | null
          telegram_members: number | null
          token_holders: number | null
          token_price: number | null
          total_trades: number | null
          total_volume: number | null
          tvl: number | null
          twitter_followers: number | null
          unique_users: number | null
        }
        Insert: {
          apy?: number | null
          arena_score?: number | null
          bot_id?: string | null
          captured_at?: string | null
          id?: string
          market_cap?: number | null
          max_drawdown?: number | null
          mindshare_score?: number | null
          revenue?: number | null
          roi?: number | null
          season_id: string
          sharpe_ratio?: number | null
          telegram_members?: number | null
          token_holders?: number | null
          token_price?: number | null
          total_trades?: number | null
          total_volume?: number | null
          tvl?: number | null
          twitter_followers?: number | null
          unique_users?: number | null
        }
        Update: {
          apy?: number | null
          arena_score?: number | null
          bot_id?: string | null
          captured_at?: string | null
          id?: string
          market_cap?: number | null
          max_drawdown?: number | null
          mindshare_score?: number | null
          revenue?: number | null
          roi?: number | null
          season_id?: string
          sharpe_ratio?: number | null
          telegram_members?: number | null
          token_holders?: number | null
          token_price?: number | null
          total_trades?: number | null
          total_volume?: number | null
          tvl?: number | null
          twitter_followers?: number | null
          unique_users?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "bot_snapshots_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bot_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_sources: {
        Row: {
          category: string
          chain: string | null
          contract_address: string | null
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          launch_date: string | null
          logo_url: string | null
          name: string
          slug: string
          telegram_url: string | null
          token_address: string | null
          token_symbol: string | null
          twitter_handle: string | null
          updated_at: string | null
          website_url: string | null
        }
        Insert: {
          category: string
          chain?: string | null
          contract_address?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          launch_date?: string | null
          logo_url?: string | null
          name: string
          slug: string
          telegram_url?: string | null
          token_address?: string | null
          token_symbol?: string | null
          twitter_handle?: string | null
          updated_at?: string | null
          website_url?: string | null
        }
        Update: {
          category?: string
          chain?: string | null
          contract_address?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          launch_date?: string | null
          logo_url?: string | null
          name?: string
          slug?: string
          telegram_url?: string | null
          token_address?: string | null
          token_symbol?: string | null
          twitter_handle?: string | null
          updated_at?: string | null
          website_url?: string | null
        }
        Relationships: []
      }
      bot_subscriptions: {
        Row: {
          chat_id: string
          created_at: string | null
          enabled: boolean | null
          id: string
          platform_type: string
          platform_user_id: string
          trader_handle: string | null
          trader_id: string
          trader_platform: string | null
          updated_at: string | null
        }
        Insert: {
          chat_id: string
          created_at?: string | null
          enabled?: boolean | null
          id?: string
          platform_type: string
          platform_user_id: string
          trader_handle?: string | null
          trader_id: string
          trader_platform?: string | null
          updated_at?: string | null
        }
        Update: {
          chat_id?: string
          created_at?: string | null
          enabled?: boolean | null
          id?: string
          platform_type?: string
          platform_user_id?: string
          trader_handle?: string | null
          trader_id?: string
          trader_platform?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      channel_members: {
        Row: {
          channel_id: string
          cleared_before: string | null
          id: string
          is_muted: boolean | null
          is_pinned: boolean | null
          joined_at: string | null
          nickname: string | null
          role: string
          user_id: string
        }
        Insert: {
          channel_id: string
          cleared_before?: string | null
          id?: string
          is_muted?: boolean | null
          is_pinned?: boolean | null
          joined_at?: string | null
          nickname?: string | null
          role?: string
          user_id: string
        }
        Update: {
          channel_id?: string
          cleared_before?: string | null
          id?: string
          is_muted?: boolean | null
          is_pinned?: boolean | null
          joined_at?: string | null
          nickname?: string | null
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_members_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "chat_channels"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_message_reads: {
        Row: {
          channel_id: string
          last_read_at: string | null
          user_id: string
        }
        Insert: {
          channel_id: string
          last_read_at?: string | null
          user_id: string
        }
        Update: {
          channel_id?: string
          last_read_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_message_reads_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "chat_channels"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_messages: {
        Row: {
          channel_id: string
          content: string
          created_at: string | null
          id: string
          media_name: string | null
          media_type: string | null
          media_url: string | null
          sender_id: string
        }
        Insert: {
          channel_id: string
          content?: string
          created_at?: string | null
          id?: string
          media_name?: string | null
          media_type?: string | null
          media_url?: string | null
          sender_id: string
        }
        Update: {
          channel_id?: string
          content?: string
          created_at?: string | null
          id?: string
          media_name?: string | null
          media_type?: string | null
          media_url?: string | null
          sender_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_messages_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "chat_channels"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_channels: {
        Row: {
          avatar_url: string | null
          conversation_id: string | null
          created_at: string | null
          created_by: string | null
          description: string | null
          id: string
          last_message_at: string | null
          last_message_preview: string | null
          name: string | null
          type: string
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          conversation_id?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          name?: string | null
          type?: string
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          conversation_id?: string | null
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          name?: string | null
          type?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chat_channels_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      cluster_members: {
        Row: {
          cluster_id: number
          similarity_score: number | null
          wallet_id: number
        }
        Insert: {
          cluster_id: number
          similarity_score?: number | null
          wallet_id: number
        }
        Update: {
          cluster_id?: number
          similarity_score?: number | null
          wallet_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "cluster_members_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "clusters"
            referencedColumns: ["cluster_id"]
          },
          {
            foreignKeyName: "cluster_members_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["wallet_id"]
          },
        ]
      }
      clusters: {
        Row: {
          cluster_id: number
          cluster_type: string | null
          created_at: string | null
          score: number | null
        }
        Insert: {
          cluster_id?: number
          cluster_type?: string | null
          created_at?: string | null
          score?: number | null
        }
        Update: {
          cluster_id?: number
          cluster_type?: string | null
          created_at?: string | null
          score?: number | null
        }
        Relationships: []
      }
      collection_items: {
        Row: {
          added_at: string | null
          collection_id: string
          id: string
          item_id: string
          item_type: string
          note: string | null
        }
        Insert: {
          added_at?: string | null
          collection_id: string
          id?: string
          item_id: string
          item_type: string
          note?: string | null
        }
        Update: {
          added_at?: string | null
          collection_id?: string
          id?: string
          item_id?: string
          item_type?: string
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "collection_items_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "user_collections"
            referencedColumns: ["id"]
          },
        ]
      }
      comment_likes: {
        Row: {
          comment_id: string
          created_at: string | null
          id: string
          reaction_type: string | null
          user_id: string
        }
        Insert: {
          comment_id: string
          created_at?: string | null
          id?: string
          reaction_type?: string | null
          user_id: string
        }
        Update: {
          comment_id?: string
          created_at?: string | null
          id?: string
          reaction_type?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comment_likes_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
        ]
      }
      comments: {
        Row: {
          author_handle: string | null
          author_id: string | null
          content: string
          created_at: string | null
          dislike_count: number | null
          id: string
          like_count: number | null
          parent_id: string | null
          post_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          author_handle?: string | null
          author_id?: string | null
          content: string
          created_at?: string | null
          dislike_count?: number | null
          id?: string
          like_count?: number | null
          parent_id?: string | null
          post_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          author_handle?: string | null
          author_id?: string | null
          content?: string
          created_at?: string | null
          dislike_count?: number | null
          id?: string
          like_count?: number | null
          parent_id?: string | null
          post_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      content_reports: {
        Row: {
          action_taken: string | null
          content_id: string
          content_type: string
          created_at: string | null
          description: string | null
          id: string
          images: string[] | null
          reason: string
          reporter_id: string
          resolved_at: string | null
          resolved_by: string | null
          status: string
        }
        Insert: {
          action_taken?: string | null
          content_id: string
          content_type: string
          created_at?: string | null
          description?: string | null
          id?: string
          images?: string[] | null
          reason: string
          reporter_id: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Update: {
          action_taken?: string | null
          content_id?: string
          content_type?: string
          created_at?: string | null
          description?: string | null
          id?: string
          images?: string[] | null
          reason?: string
          reporter_id?: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Relationships: []
      }
      conversation_members: {
        Row: {
          cleared_before: string | null
          conversation_id: string
          created_at: string
          id: string
          is_blocked: boolean
          is_muted: boolean
          is_pinned: boolean
          remark: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          cleared_before?: string | null
          conversation_id: string
          created_at?: string
          id?: string
          is_blocked?: boolean
          is_muted?: boolean
          is_pinned?: boolean
          remark?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          cleared_before?: string | null
          conversation_id?: string
          created_at?: string
          id?: string
          is_blocked?: boolean
          is_muted?: boolean
          is_pinned?: boolean
          remark?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_members_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          created_at: string | null
          id: string
          last_message_at: string | null
          last_message_preview: string | null
          user1_id: string
          user2_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          user1_id: string
          user2_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          user1_id?: string
          user2_id?: string
        }
        Relationships: []
      }
      copy_trade_configs: {
        Row: {
          active: boolean
          created_at: string
          exchange: string
          id: string
          settings: Json
          trader_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          exchange?: string
          id?: string
          settings?: Json
          trader_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          exchange?: string
          id?: string
          settings?: Json
          trader_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      copy_trade_logs: {
        Row: {
          action: string
          config_id: string
          created_at: string
          error_message: string | null
          id: string
          pair: string
          price: number | null
          size: number | null
          status: string
        }
        Insert: {
          action: string
          config_id: string
          created_at?: string
          error_message?: string | null
          id?: string
          pair: string
          price?: number | null
          size?: number | null
          status?: string
        }
        Update: {
          action?: string
          config_id?: string
          created_at?: string
          error_message?: string | null
          id?: string
          pair?: string
          price?: number | null
          size?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "copy_trade_logs_config_id_fkey"
            columns: ["config_id"]
            isOneToOne: false
            referencedRelation: "copy_trade_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_logs: {
        Row: {
          id: number
          name: string
          ran_at: string
        }
        Insert: {
          id?: number
          name: string
          ran_at?: string
        }
        Update: {
          id?: number
          name?: string
          ran_at?: string
        }
        Relationships: []
      }
      daily_trader_stats: {
        Row: {
          arena_score: number | null
          captured_at: string | null
          followers: number | null
          id: number
          max_drawdown: number | null
          pnl: number | null
          rank: number | null
          roi: number | null
          roi_30d: number | null
          roi_7d: number | null
          snapshot_date: string
          source: string
          source_trader_id: string
          trades_count: number | null
          win_rate: number | null
        }
        Insert: {
          arena_score?: number | null
          captured_at?: string | null
          followers?: number | null
          id?: number
          max_drawdown?: number | null
          pnl?: number | null
          rank?: number | null
          roi?: number | null
          roi_30d?: number | null
          roi_7d?: number | null
          snapshot_date: string
          source: string
          source_trader_id: string
          trades_count?: number | null
          win_rate?: number | null
        }
        Update: {
          arena_score?: number | null
          captured_at?: string | null
          followers?: number | null
          id?: number
          max_drawdown?: number | null
          pnl?: number | null
          rank?: number | null
          roi?: number | null
          roi_30d?: number | null
          roi_7d?: number | null
          snapshot_date?: string
          source?: string
          source_trader_id?: string
          trades_count?: number | null
          win_rate?: number | null
        }
        Relationships: []
      }
      db_cache: {
        Row: {
          key: string
          value: number | null
        }
        Insert: {
          key: string
          value?: number | null
        }
        Update: {
          key?: string
          value?: number | null
        }
        Relationships: []
      }
      direct_messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string | null
          deleted_at: string | null
          id: string
          media_name: string | null
          media_type: string | null
          media_url: string | null
          read: boolean | null
          read_at: string | null
          receiver_id: string
          sender_id: string
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string | null
          deleted_at?: string | null
          id?: string
          media_name?: string | null
          media_type?: string | null
          media_url?: string | null
          read?: boolean | null
          read_at?: string | null
          receiver_id: string
          sender_id: string
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string | null
          deleted_at?: string | null
          id?: string
          media_name?: string | null
          media_type?: string | null
          media_url?: string | null
          read?: boolean | null
          read_at?: string | null
          receiver_id?: string
          sender_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "direct_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      directory_ratings: {
        Row: {
          created_at: string | null
          id: string
          item_id: string
          item_type: string
          rating: number
          review: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          item_id: string
          item_type: string
          rating: number
          review?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          item_id?: string
          item_type?: string
          rating?: number
          review?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      exp_transactions: {
        Row: {
          action: string
          created_at: string | null
          exp_amount: number
          id: number
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string | null
          exp_amount: number
          id?: number
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string | null
          exp_amount?: number
          id?: number
          user_id?: string | null
        }
        Relationships: []
      }
      feedback: {
        Row: {
          created_at: string | null
          id: string
          message: string
          page_url: string | null
          screenshot_url: string | null
          status: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          message: string
          page_url?: string | null
          screenshot_url?: string | null
          status?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          message?: string
          page_url?: string | null
          screenshot_url?: string | null
          status?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      flash_news: {
        Row: {
          category: string | null
          content: string | null
          content_zh: string | null
          created_at: string | null
          id: string
          importance: string | null
          published_at: string
          source: string
          source_url: string | null
          tags: string[] | null
          title: string
          title_en: string | null
          title_zh: string | null
        }
        Insert: {
          category?: string | null
          content?: string | null
          content_zh?: string | null
          created_at?: string | null
          id?: string
          importance?: string | null
          published_at?: string
          source: string
          source_url?: string | null
          tags?: string[] | null
          title: string
          title_en?: string | null
          title_zh?: string | null
        }
        Update: {
          category?: string | null
          content?: string | null
          content_zh?: string | null
          created_at?: string | null
          id?: string
          importance?: string | null
          published_at?: string
          source?: string
          source_url?: string | null
          tags?: string[] | null
          title?: string
          title_en?: string | null
          title_zh?: string | null
        }
        Relationships: []
      }
      follows: {
        Row: {
          created_at: string | null
          trader_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          trader_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          trader_id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      funding_hubs: {
        Row: {
          cluster_id: number | null
          hub_id: number
          hub_type: string | null
          indicator_score: number | null
          wallet_id: number | null
        }
        Insert: {
          cluster_id?: number | null
          hub_id?: number
          hub_type?: string | null
          indicator_score?: number | null
          wallet_id?: number | null
        }
        Update: {
          cluster_id?: number | null
          hub_id?: number
          hub_type?: string | null
          indicator_score?: number | null
          wallet_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "funding_hubs_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "clusters"
            referencedColumns: ["cluster_id"]
          },
          {
            foreignKeyName: "funding_hubs_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["wallet_id"]
          },
        ]
      }
      funding_rates: {
        Row: {
          created_at: string | null
          funding_rate: number
          funding_time: string
          id: string
          platform: string
          symbol: string
        }
        Insert: {
          created_at?: string | null
          funding_rate: number
          funding_time: string
          id?: string
          platform: string
          symbol: string
        }
        Update: {
          created_at?: string | null
          funding_rate?: number
          funding_time?: string
          id?: string
          platform?: string
          symbol?: string
        }
        Relationships: []
      }
      gifts: {
        Row: {
          amount: number
          asset: Database["public"]["Enums"]["gift_asset"]
          created_at: string
          from_user_id: string
          group_id: string
          id: string
          post_id: string
        }
        Insert: {
          amount: number
          asset?: Database["public"]["Enums"]["gift_asset"]
          created_at?: string
          from_user_id?: string
          group_id: string
          id?: string
          post_id: string
        }
        Update: {
          amount?: number
          asset?: Database["public"]["Enums"]["gift_asset"]
          created_at?: string
          from_user_id?: string
          group_id?: string
          id?: string
          post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "gifts_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "gifts_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gifts_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      group_applications: {
        Row: {
          applicant_id: string
          avatar_url: string | null
          created_at: string | null
          description: string | null
          description_en: string | null
          id: string
          is_premium_only: boolean | null
          name: string
          name_en: string | null
          reject_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          role_names: Json | null
          rules: string | null
          rules_json: Json | null
          status: string
        }
        Insert: {
          applicant_id: string
          avatar_url?: string | null
          created_at?: string | null
          description?: string | null
          description_en?: string | null
          id?: string
          is_premium_only?: boolean | null
          name: string
          name_en?: string | null
          reject_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          role_names?: Json | null
          rules?: string | null
          rules_json?: Json | null
          status?: string
        }
        Update: {
          applicant_id?: string
          avatar_url?: string | null
          created_at?: string | null
          description?: string | null
          description_en?: string | null
          id?: string
          is_premium_only?: boolean | null
          name?: string
          name_en?: string | null
          reject_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          role_names?: Json | null
          rules?: string | null
          rules_json?: Json | null
          status?: string
        }
        Relationships: []
      }
      group_audit_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string | null
          details: Json | null
          group_id: string | null
          id: string
          target_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string | null
          details?: Json | null
          group_id?: string | null
          id?: string
          target_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string | null
          details?: Json | null
          group_id?: string | null
          id?: string
          target_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "group_audit_log_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "group_audit_log_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      group_bans: {
        Row: {
          banned_by: string | null
          created_at: string | null
          group_id: string
          reason: string | null
          user_id: string
        }
        Insert: {
          banned_by?: string | null
          created_at?: string | null
          group_id: string
          reason?: string | null
          user_id: string
        }
        Update: {
          banned_by?: string | null
          created_at?: string | null
          group_id?: string
          reason?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_bans_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "group_bans_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      group_edit_applications: {
        Row: {
          applicant_id: string
          avatar_url: string | null
          created_at: string | null
          description: string | null
          description_en: string | null
          group_id: string
          id: string
          is_premium_only: boolean | null
          name: string | null
          name_en: string | null
          reject_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          role_names: Json | null
          rules: string | null
          rules_json: Json | null
          status: string
        }
        Insert: {
          applicant_id: string
          avatar_url?: string | null
          created_at?: string | null
          description?: string | null
          description_en?: string | null
          group_id: string
          id?: string
          is_premium_only?: boolean | null
          name?: string | null
          name_en?: string | null
          reject_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          role_names?: Json | null
          rules?: string | null
          rules_json?: Json | null
          status?: string
        }
        Update: {
          applicant_id?: string
          avatar_url?: string | null
          created_at?: string | null
          description?: string | null
          description_en?: string | null
          group_id?: string
          id?: string
          is_premium_only?: boolean | null
          name?: string | null
          name_en?: string | null
          reject_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          role_names?: Json | null
          rules?: string | null
          rules_json?: Json | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_edit_applications_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "group_edit_applications_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      group_invites: {
        Row: {
          created_at: string | null
          created_by: string | null
          expires_at: string | null
          group_id: string | null
          id: string
          max_uses: number | null
          token_hash: string
          used_count: number | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          group_id?: string | null
          id?: string
          max_uses?: number | null
          token_hash: string
          used_count?: number | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          group_id?: string | null
          id?: string
          max_uses?: number | null
          token_hash?: string
          used_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "group_invites_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "group_invites_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      group_join_requests: {
        Row: {
          answer_text: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          group_id: string
          id: string
          status: string
          user_id: string
        }
        Insert: {
          answer_text?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          group_id: string
          id?: string
          status?: string
          user_id?: string
        }
        Update: {
          answer_text?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          group_id?: string
          id?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_join_requests_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "group_join_requests_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      group_members: {
        Row: {
          group_id: string
          joined_at: string
          mute_reason: string | null
          muted_by: string | null
          muted_until: string | null
          notifications_muted: boolean | null
          role: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Insert: {
          group_id: string
          joined_at?: string
          mute_reason?: string | null
          muted_by?: string | null
          muted_until?: string | null
          notifications_muted?: boolean | null
          role?: Database["public"]["Enums"]["member_role"]
          user_id?: string
        }
        Update: {
          group_id?: string
          joined_at?: string
          mute_reason?: string | null
          muted_by?: string | null
          muted_until?: string | null
          notifications_muted?: boolean | null
          role?: Database["public"]["Enums"]["member_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      group_rules: {
        Row: {
          created_at: string
          group_id: string
          id: string
          rule_text: string
        }
        Insert: {
          created_at?: string
          group_id: string
          id?: string
          rule_text: string
        }
        Update: {
          created_at?: string
          group_id?: string
          id?: string
          rule_text?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_rules_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "group_rules_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      group_subscriptions: {
        Row: {
          cancelled_at: string | null
          created_at: string | null
          expires_at: string
          group_id: string
          id: string
          payment_provider: string | null
          payment_reference: string | null
          price_paid: number | null
          starts_at: string
          status: string
          tier: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          cancelled_at?: string | null
          created_at?: string | null
          expires_at: string
          group_id: string
          id?: string
          payment_provider?: string | null
          payment_reference?: string | null
          price_paid?: number | null
          starts_at?: string
          status?: string
          tier: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          cancelled_at?: string | null
          created_at?: string | null
          expires_at?: string
          group_id?: string
          id?: string
          payment_provider?: string | null
          payment_reference?: string | null
          price_paid?: number | null
          starts_at?: string
          status?: string
          tier?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_subscriptions_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "group_subscriptions_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          allow_trial: boolean | null
          avatar_url: string | null
          created_at: string
          created_by: string
          description: string | null
          description_en: string | null
          dissolved_at: string | null
          id: string
          is_premium_only: boolean | null
          is_verified_only: boolean | null
          join_prompt: string | null
          member_count: number | null
          min_arena_score: number | null
          name: string
          name_en: string | null
          original_price_monthly: number | null
          original_price_yearly: number | null
          role_names: Json | null
          rules: string | null
          rules_json: Json | null
          rules_text: string | null
          subscription_price_monthly: number | null
          subscription_price_yearly: number | null
          trial_days: number | null
          updated_at: string
          visibility: Database["public"]["Enums"]["group_visibility"]
        }
        Insert: {
          allow_trial?: boolean | null
          avatar_url?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          description_en?: string | null
          dissolved_at?: string | null
          id?: string
          is_premium_only?: boolean | null
          is_verified_only?: boolean | null
          join_prompt?: string | null
          member_count?: number | null
          min_arena_score?: number | null
          name: string
          name_en?: string | null
          original_price_monthly?: number | null
          original_price_yearly?: number | null
          role_names?: Json | null
          rules?: string | null
          rules_json?: Json | null
          rules_text?: string | null
          subscription_price_monthly?: number | null
          subscription_price_yearly?: number | null
          trial_days?: number | null
          updated_at?: string
          visibility?: Database["public"]["Enums"]["group_visibility"]
        }
        Update: {
          allow_trial?: boolean | null
          avatar_url?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          description_en?: string | null
          dissolved_at?: string | null
          id?: string
          is_premium_only?: boolean | null
          is_verified_only?: boolean | null
          join_prompt?: string | null
          member_count?: number | null
          min_arena_score?: number | null
          name?: string
          name_en?: string | null
          original_price_monthly?: number | null
          original_price_yearly?: number | null
          role_names?: Json | null
          rules?: string | null
          rules_json?: Json | null
          rules_text?: string | null
          subscription_price_monthly?: number | null
          subscription_price_yearly?: number | null
          trial_days?: number | null
          updated_at?: string
          visibility?: Database["public"]["Enums"]["group_visibility"]
        }
        Relationships: []
      }
      institutions: {
        Row: {
          avg_rating: number | null
          category: string
          chain: string | null
          created_at: string | null
          description: string | null
          description_zh: string | null
          founded_date: string | null
          id: string
          is_active: boolean | null
          logo_url: string | null
          name: string
          name_zh: string | null
          rating_count: number | null
          sort_priority: number | null
          tags: string[] | null
          token_symbol: string | null
          twitter: string | null
          updated_at: string | null
          website: string | null
        }
        Insert: {
          avg_rating?: number | null
          category: string
          chain?: string | null
          created_at?: string | null
          description?: string | null
          description_zh?: string | null
          founded_date?: string | null
          id?: string
          is_active?: boolean | null
          logo_url?: string | null
          name: string
          name_zh?: string | null
          rating_count?: number | null
          sort_priority?: number | null
          tags?: string[] | null
          token_symbol?: string | null
          twitter?: string | null
          updated_at?: string | null
          website?: string | null
        }
        Update: {
          avg_rating?: number | null
          category?: string
          chain?: string | null
          created_at?: string | null
          description?: string | null
          description_zh?: string | null
          founded_date?: string | null
          id?: string
          is_active?: boolean | null
          logo_url?: string | null
          name?: string
          name_zh?: string | null
          rating_count?: number | null
          sort_priority?: number | null
          tags?: string[] | null
          token_symbol?: string | null
          twitter?: string | null
          updated_at?: string | null
          website?: string | null
        }
        Relationships: []
      }
      interactions: {
        Row: {
          action_detail: string | null
          action_type: string | null
          interaction_id: number
          project_id: number | null
          timestamp: string | null
          wallet_id: number | null
        }
        Insert: {
          action_detail?: string | null
          action_type?: string | null
          interaction_id?: number
          project_id?: number | null
          timestamp?: string | null
          wallet_id?: number | null
        }
        Update: {
          action_detail?: string | null
          action_type?: string | null
          interaction_id?: number
          project_id?: number | null
          timestamp?: string | null
          wallet_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "interactions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "interactions_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["wallet_id"]
          },
        ]
      }
      kol_applications: {
        Row: {
          created_at: string | null
          description: string | null
          follower_count: number | null
          id: string
          platform: string | null
          platform_handle: string | null
          proof_url: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          reviewer_notes: string | null
          status: string | null
          tier: string
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          follower_count?: number | null
          id?: string
          platform?: string | null
          platform_handle?: string | null
          proof_url?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewer_notes?: string | null
          status?: string | null
          tier: string
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          follower_count?: number | null
          id?: string
          platform?: string | null
          platform_handle?: string | null
          proof_url?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewer_notes?: string | null
          status?: string | null
          tier?: string
          user_id?: string | null
        }
        Relationships: []
      }
      labels: {
        Row: {
          confidence: number | null
          label: string
          source: string | null
          wallet_id: number
        }
        Insert: {
          confidence?: number | null
          label: string
          source?: string | null
          wallet_id: number
        }
        Update: {
          confidence?: number | null
          label?: string
          source?: string | null
          wallet_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "labels_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["wallet_id"]
          },
        ]
      }
      leaderboard_count_cache: {
        Row: {
          season_id: string
          source: string
          total_count: number
          updated_at: string
        }
        Insert: {
          season_id: string
          source?: string
          total_count?: number
          updated_at?: string
        }
        Update: {
          season_id?: string
          source?: string
          total_count?: number
          updated_at?: string
        }
        Relationships: []
      }
      leaderboard_history: {
        Row: {
          archived_at: string
          avatar_url: string | null
          enrichment_status: string | null
          followers: number | null
          handle: string | null
          id: number
          last_seen_at: string | null
          max_drawdown: number | null
          max_drawdown_30d: number | null
          max_drawdown_7d: number | null
          max_drawdown_90d: number | null
          pnl: number | null
          roi: number | null
          roi_30d: number | null
          roi_7d: number | null
          roi_90d: number | null
          season_id: string | null
          snapshot_data: Json | null
          source: string
          source_trader_id: string
          trades_count: number | null
          win_rate: number | null
          win_rate_30d: number | null
          win_rate_7d: number | null
          win_rate_90d: number | null
        }
        Insert: {
          archived_at?: string
          avatar_url?: string | null
          enrichment_status?: string | null
          followers?: number | null
          handle?: string | null
          id?: number
          last_seen_at?: string | null
          max_drawdown?: number | null
          max_drawdown_30d?: number | null
          max_drawdown_7d?: number | null
          max_drawdown_90d?: number | null
          pnl?: number | null
          roi?: number | null
          roi_30d?: number | null
          roi_7d?: number | null
          roi_90d?: number | null
          season_id?: string | null
          snapshot_data?: Json | null
          source: string
          source_trader_id: string
          trades_count?: number | null
          win_rate?: number | null
          win_rate_30d?: number | null
          win_rate_7d?: number | null
          win_rate_90d?: number | null
        }
        Update: {
          archived_at?: string
          avatar_url?: string | null
          enrichment_status?: string | null
          followers?: number | null
          handle?: string | null
          id?: number
          last_seen_at?: string | null
          max_drawdown?: number | null
          max_drawdown_30d?: number | null
          max_drawdown_7d?: number | null
          max_drawdown_90d?: number | null
          pnl?: number | null
          roi?: number | null
          roi_30d?: number | null
          roi_7d?: number | null
          roi_90d?: number | null
          season_id?: string | null
          snapshot_data?: Json | null
          source?: string
          source_trader_id?: string
          trades_count?: number | null
          win_rate?: number | null
          win_rate_30d?: number | null
          win_rate_7d?: number | null
          win_rate_90d?: number | null
        }
        Relationships: []
      }
      leaderboard_ranks: {
        Row: {
          arena_score: number | null
          avatar_url: string | null
          avg_holding_hours: number | null
          calmar_ratio: number | null
          computed_at: string
          copiers: number | null
          execution_score: number | null
          followers: number | null
          handle: string | null
          id: number
          is_new: boolean | null
          is_outlier: boolean | null
          max_drawdown: number | null
          metrics_estimated: boolean | null
          pnl: number | null
          profit_factor: number | null
          profitability_score: number | null
          rank: number
          rank_change: number | null
          risk_control_score: number | null
          roi: number | null
          score_completeness: string | null
          season_id: string
          sharpe_ratio: number | null
          sortino_ratio: number | null
          source: string
          source_trader_id: string
          source_type: string
          style_confidence: number | null
          trader_type: string | null
          trades_count: number | null
          trading_style: string | null
          win_rate: number | null
        }
        Insert: {
          arena_score?: number | null
          avatar_url?: string | null
          avg_holding_hours?: number | null
          calmar_ratio?: number | null
          computed_at?: string
          copiers?: number | null
          execution_score?: number | null
          followers?: number | null
          handle?: string | null
          id?: number
          is_new?: boolean | null
          is_outlier?: boolean | null
          max_drawdown?: number | null
          metrics_estimated?: boolean | null
          pnl?: number | null
          profit_factor?: number | null
          profitability_score?: number | null
          rank: number
          rank_change?: number | null
          risk_control_score?: number | null
          roi?: number | null
          score_completeness?: string | null
          season_id: string
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          source: string
          source_trader_id: string
          source_type?: string
          style_confidence?: number | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          win_rate?: number | null
        }
        Update: {
          arena_score?: number | null
          avatar_url?: string | null
          avg_holding_hours?: number | null
          calmar_ratio?: number | null
          computed_at?: string
          copiers?: number | null
          execution_score?: number | null
          followers?: number | null
          handle?: string | null
          id?: number
          is_new?: boolean | null
          is_outlier?: boolean | null
          max_drawdown?: number | null
          metrics_estimated?: boolean | null
          pnl?: number | null
          profit_factor?: number | null
          profitability_score?: number | null
          rank?: number
          rank_change?: number | null
          risk_control_score?: number | null
          roi?: number | null
          score_completeness?: string | null
          season_id?: string
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          source?: string
          source_trader_id?: string
          source_type?: string
          style_confidence?: number | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          win_rate?: number | null
        }
        Relationships: []
      }
      leaderboard_snapshots: {
        Row: {
          arena_score: number | null
          avatar_url: string | null
          computed_at: string
          followers_count: number | null
          handle: string | null
          id: number
          market_type: string | null
          pnl: number | null
          rank: number
          roi: number | null
          source: string
          source_trader_id: string
          time_window: string
          trade_count: number | null
          win_rate: number | null
        }
        Insert: {
          arena_score?: number | null
          avatar_url?: string | null
          computed_at?: string
          followers_count?: number | null
          handle?: string | null
          id?: never
          market_type?: string | null
          pnl?: number | null
          rank: number
          roi?: number | null
          source: string
          source_trader_id: string
          time_window?: string
          trade_count?: number | null
          win_rate?: number | null
        }
        Update: {
          arena_score?: number | null
          avatar_url?: string | null
          computed_at?: string
          followers_count?: number | null
          handle?: string | null
          id?: never
          market_type?: string | null
          pnl?: number | null
          rank?: number
          roi?: number | null
          source?: string
          source_trader_id?: string
          time_window?: string
          trade_count?: number | null
          win_rate?: number | null
        }
        Relationships: []
      }
      ledger_entries: {
        Row: {
          amount: number
          asset: Database["public"]["Enums"]["gift_asset"]
          created_at: string
          entry_type: string
          gift_id: string
          group_id: string
          id: string
          meta: Json
          post_id: string
          user_id: string | null
        }
        Insert: {
          amount: number
          asset: Database["public"]["Enums"]["gift_asset"]
          created_at?: string
          entry_type: string
          gift_id: string
          group_id: string
          id?: string
          meta?: Json
          post_id: string
          user_id?: string | null
        }
        Update: {
          amount?: number
          asset?: Database["public"]["Enums"]["gift_asset"]
          created_at?: string
          entry_type?: string
          gift_id?: string
          group_id?: string
          id?: string
          meta?: Json
          post_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ledger_entries_gift_id_fkey"
            columns: ["gift_id"]
            isOneToOne: false
            referencedRelation: "gifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_entries_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "ledger_entries_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_entries_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      library_items: {
        Row: {
          ai_summary: string | null
          author: string | null
          buy_url: string | null
          category: string
          content_url: string | null
          cover_url: string | null
          created_at: string | null
          crypto_symbols: string[] | null
          description: string | null
          doi: string | null
          download_count: number | null
          epub_url: string | null
          file_key: string | null
          file_size_bytes: number | null
          id: string
          is_free: boolean | null
          isbn: string | null
          language: string | null
          language_group_id: string | null
          page_count: number | null
          pdf_url: string | null
          publish_date: string | null
          publisher: string | null
          rating: number | null
          rating_count: number | null
          source: string | null
          source_url: string | null
          subcategory: string | null
          tags: string[] | null
          title: string
          title_en: string | null
          title_zh: string | null
          updated_at: string | null
          view_count: number | null
        }
        Insert: {
          ai_summary?: string | null
          author?: string | null
          buy_url?: string | null
          category: string
          content_url?: string | null
          cover_url?: string | null
          created_at?: string | null
          crypto_symbols?: string[] | null
          description?: string | null
          doi?: string | null
          download_count?: number | null
          epub_url?: string | null
          file_key?: string | null
          file_size_bytes?: number | null
          id?: string
          is_free?: boolean | null
          isbn?: string | null
          language?: string | null
          language_group_id?: string | null
          page_count?: number | null
          pdf_url?: string | null
          publish_date?: string | null
          publisher?: string | null
          rating?: number | null
          rating_count?: number | null
          source?: string | null
          source_url?: string | null
          subcategory?: string | null
          tags?: string[] | null
          title: string
          title_en?: string | null
          title_zh?: string | null
          updated_at?: string | null
          view_count?: number | null
        }
        Update: {
          ai_summary?: string | null
          author?: string | null
          buy_url?: string | null
          category?: string
          content_url?: string | null
          cover_url?: string | null
          created_at?: string | null
          crypto_symbols?: string[] | null
          description?: string | null
          doi?: string | null
          download_count?: number | null
          epub_url?: string | null
          file_key?: string | null
          file_size_bytes?: number | null
          id?: string
          is_free?: boolean | null
          isbn?: string | null
          language?: string | null
          language_group_id?: string | null
          page_count?: number | null
          pdf_url?: string | null
          publish_date?: string | null
          publisher?: string | null
          rating?: number | null
          rating_count?: number | null
          source?: string | null
          source_url?: string | null
          subcategory?: string | null
          tags?: string[] | null
          title?: string
          title_en?: string | null
          title_zh?: string | null
          updated_at?: string | null
          view_count?: number | null
        }
        Relationships: []
      }
      liquidation_stats: {
        Row: {
          created_at: string | null
          hour_bucket: string
          id: string
          long_count: number | null
          long_liquidations_usd: number | null
          platform: string
          short_count: number | null
          short_liquidations_usd: number | null
          symbol: string
        }
        Insert: {
          created_at?: string | null
          hour_bucket: string
          id?: string
          long_count?: number | null
          long_liquidations_usd?: number | null
          platform: string
          short_count?: number | null
          short_liquidations_usd?: number | null
          symbol: string
        }
        Update: {
          created_at?: string | null
          hour_bucket?: string
          id?: string
          long_count?: number | null
          long_liquidations_usd?: number | null
          platform?: string
          short_count?: number | null
          short_liquidations_usd?: number | null
          symbol?: string
        }
        Relationships: []
      }
      liquidations: {
        Row: {
          created_at: string | null
          id: string
          platform: string
          price: number | null
          quantity: number | null
          side: string
          symbol: string
          timestamp: string
          value_usd: number
        }
        Insert: {
          created_at?: string | null
          id?: string
          platform: string
          price?: number | null
          quantity?: number | null
          side: string
          symbol: string
          timestamp: string
          value_usd: number
        }
        Update: {
          created_at?: string | null
          id?: string
          platform?: string
          price?: number | null
          quantity?: number | null
          side?: string
          symbol?: string
          timestamp?: string
          value_usd?: number
        }
        Relationships: []
      }
      login_sessions: {
        Row: {
          created_at: string | null
          device_info: Json | null
          id: string
          ip_address: string | null
          is_current: boolean | null
          last_active_at: string | null
          revoked: boolean | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          device_info?: Json | null
          id?: string
          ip_address?: string | null
          is_current?: boolean | null
          last_active_at?: string | null
          revoked?: boolean | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          device_info?: Json | null
          id?: string
          ip_address?: string | null
          is_current?: boolean | null
          last_active_at?: string | null
          revoked?: boolean | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      manipulation_alert_history: {
        Row: {
          action: string
          alert_id: string
          created_at: string | null
          id: string
          new_status: string | null
          notes: string | null
          old_status: string | null
          performed_by: string | null
        }
        Insert: {
          action: string
          alert_id: string
          created_at?: string | null
          id?: string
          new_status?: string | null
          notes?: string | null
          old_status?: string | null
          performed_by?: string | null
        }
        Update: {
          action?: string
          alert_id?: string
          created_at?: string | null
          id?: string
          new_status?: string | null
          notes?: string | null
          old_status?: string | null
          performed_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "manipulation_alert_history_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "manipulation_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "manipulation_alert_history_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "v_recent_alerts"
            referencedColumns: ["id"]
          },
        ]
      }
      manipulation_alerts: {
        Row: {
          alert_type: string
          auto_action: string | null
          created_at: string | null
          evidence: Json
          id: string
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          status: string | null
          traders: string[]
          updated_at: string | null
        }
        Insert: {
          alert_type: string
          auto_action?: string | null
          created_at?: string | null
          evidence: Json
          id?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity: string
          status?: string | null
          traders: string[]
          updated_at?: string | null
        }
        Update: {
          alert_type?: string
          auto_action?: string | null
          created_at?: string | null
          evidence?: Json
          id?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          status?: string | null
          traders?: string[]
          updated_at?: string | null
        }
        Relationships: []
      }
      market_benchmarks: {
        Row: {
          close_price: number
          created_at: string | null
          daily_return_pct: number | null
          date: string
          high_price: number | null
          id: string
          low_price: number | null
          open_price: number | null
          symbol: string
          volume: number | null
        }
        Insert: {
          close_price: number
          created_at?: string | null
          daily_return_pct?: number | null
          date: string
          high_price?: number | null
          id?: string
          low_price?: number | null
          open_price?: number | null
          symbol: string
          volume?: number | null
        }
        Update: {
          close_price?: number
          created_at?: string | null
          daily_return_pct?: number | null
          date?: string
          high_price?: number | null
          id?: string
          low_price?: number | null
          open_price?: number | null
          symbol?: string
          volume?: number | null
        }
        Relationships: []
      }
      market_conditions: {
        Row: {
          condition: string
          created_at: string | null
          date: string
          id: string
          rsi_14: number | null
          symbol: string
          trend_strength: number | null
          volatility_regime: string | null
        }
        Insert: {
          condition: string
          created_at?: string | null
          date: string
          id?: string
          rsi_14?: number | null
          symbol: string
          trend_strength?: number | null
          volatility_regime?: string | null
        }
        Update: {
          condition?: string
          created_at?: string | null
          date?: string
          id?: string
          rsi_14?: number | null
          symbol?: string
          trend_strength?: number | null
          volatility_regime?: string | null
        }
        Relationships: []
      }
      notification_history: {
        Row: {
          body: string
          channel_id: string | null
          clicked_at: string | null
          data: Json | null
          delivered_at: string | null
          error: string | null
          id: string
          sent_at: string
          status: string
          title: string
          user_id: string
        }
        Insert: {
          body: string
          channel_id?: string | null
          clicked_at?: string | null
          data?: Json | null
          delivered_at?: string | null
          error?: string | null
          id?: string
          sent_at?: string
          status?: string
          title: string
          user_id: string
        }
        Update: {
          body?: string
          channel_id?: string | null
          clicked_at?: string | null
          data?: Json | null
          delivered_at?: string | null
          error?: string | null
          id?: string
          sent_at?: string
          status?: string
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          actor_id: string | null
          created_at: string | null
          id: string
          link: string | null
          message: string
          read: boolean | null
          read_at: string | null
          reference_id: string | null
          title: string
          type: string
          user_id: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string | null
          id?: string
          link?: string | null
          message: string
          read?: boolean | null
          read_at?: string | null
          reference_id?: string | null
          title: string
          type: string
          user_id: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string | null
          id?: string
          link?: string | null
          message?: string
          read?: boolean | null
          read_at?: string | null
          reference_id?: string | null
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      oauth_states: {
        Row: {
          created_at: string | null
          exchange: string
          expires_at: string
          id: string
          state: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          exchange: string
          expires_at: string
          id?: string
          state: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          exchange?: string
          expires_at?: string
          id?: string
          state?: string
          user_id?: string
        }
        Relationships: []
      }
      open_interest: {
        Row: {
          created_at: string | null
          id: string
          open_interest_contracts: number | null
          open_interest_usd: number
          platform: string
          symbol: string
          timestamp: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          open_interest_contracts?: number | null
          open_interest_usd: number
          platform: string
          symbol: string
          timestamp: string
        }
        Update: {
          created_at?: string | null
          id?: string
          open_interest_contracts?: number | null
          open_interest_usd?: number
          platform?: string
          symbol?: string
          timestamp?: string
        }
        Relationships: []
      }
      pipeline_logs: {
        Row: {
          duration_ms: number | null
          ended_at: string | null
          error_message: string | null
          id: number
          job_name: string
          metadata: Json | null
          records_processed: number | null
          started_at: string
          status: string
        }
        Insert: {
          duration_ms?: number | null
          ended_at?: string | null
          error_message?: string | null
          id?: never
          job_name: string
          metadata?: Json | null
          records_processed?: number | null
          started_at?: string
          status?: string
        }
        Update: {
          duration_ms?: number | null
          ended_at?: string | null
          error_message?: string | null
          id?: never
          job_name?: string
          metadata?: Json | null
          records_processed?: number | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      pipeline_metrics: {
        Row: {
          created_at: string
          id: number
          metadata: Json | null
          metric_type: string
          source: string
          value: number
        }
        Insert: {
          created_at?: string
          id?: never
          metadata?: Json | null
          metric_type: string
          source: string
          value?: number
        }
        Update: {
          created_at?: string
          id?: never
          metadata?: Json | null
          metric_type?: string
          source?: string
          value?: number
        }
        Relationships: []
      }
      pipeline_rejected_writes: {
        Row: {
          created_at: string
          field: string
          id: number
          metadata: Json | null
          platform: string
          reason: string
          target_table: string
          trader_key: string
          value: string | null
        }
        Insert: {
          created_at?: string
          field: string
          id?: never
          metadata?: Json | null
          platform: string
          reason: string
          target_table: string
          trader_key: string
          value?: string | null
        }
        Update: {
          created_at?: string
          field?: string
          id?: never
          metadata?: Json | null
          platform?: string
          reason?: string
          target_table?: string
          trader_key?: string
          value?: string | null
        }
        Relationships: []
      }
      pipeline_state: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value?: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      platform_health: {
        Row: {
          circuit_closes_at: string | null
          circuit_opened_at: string | null
          consecutive_failures: number
          last_error: string | null
          last_failure_at: string | null
          last_success_at: string | null
          platform: string
          status: string
          updated_at: string
        }
        Insert: {
          circuit_closes_at?: string | null
          circuit_opened_at?: string | null
          consecutive_failures?: number
          last_error?: string | null
          last_failure_at?: string | null
          last_success_at?: string | null
          platform: string
          status?: string
          updated_at?: string
        }
        Update: {
          circuit_closes_at?: string | null
          circuit_opened_at?: string | null
          consecutive_failures?: number
          last_error?: string | null
          last_failure_at?: string | null
          last_success_at?: string | null
          platform?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      poll_votes: {
        Row: {
          created_at: string | null
          id: string
          option_index: number
          poll_id: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          option_index: number
          poll_id: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          option_index?: number
          poll_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "poll_votes_poll_id_fkey"
            columns: ["poll_id"]
            isOneToOne: false
            referencedRelation: "polls"
            referencedColumns: ["id"]
          },
        ]
      }
      polls: {
        Row: {
          created_at: string | null
          end_at: string | null
          id: string
          options: Json
          post_id: string | null
          question: string
          type: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          end_at?: string | null
          id?: string
          options?: Json
          post_id?: string | null
          question: string
          type?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          end_at?: string | null
          id?: string
          options?: Json
          post_id?: string | null
          question?: string
          type?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "polls_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_bookmarks: {
        Row: {
          created_at: string | null
          folder_id: string | null
          id: string
          post_id: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          folder_id?: string | null
          id?: string
          post_id: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          folder_id?: string | null
          id?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_bookmarks_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "bookmark_folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_bookmarks_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_comments: {
        Row: {
          author_id: string
          content: string
          created_at: string
          group_id: string
          id: string
          like_count: number | null
          parent_id: string | null
          post_id: string
          reply_count: number | null
        }
        Insert: {
          author_id?: string
          content: string
          created_at?: string
          group_id: string
          id?: string
          like_count?: number | null
          parent_id?: string | null
          post_id: string
          reply_count?: number | null
        }
        Update: {
          author_id?: string
          content?: string
          created_at?: string
          group_id?: string
          id?: string
          like_count?: number | null
          parent_id?: string | null
          post_id?: string
          reply_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "post_comments_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "post_comments_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "post_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_likes: {
        Row: {
          created_at: string | null
          id: string
          post_id: string
          reaction_type: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          post_id: string
          reaction_type?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          post_id?: string
          reaction_type?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_likes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_reactions: {
        Row: {
          created_at: string | null
          id: string
          post_id: string
          reaction_type: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          post_id: string
          reaction_type: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          post_id?: string
          reaction_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_reactions_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      post_votes: {
        Row: {
          choice: string
          created_at: string | null
          id: string
          post_id: string
          user_id: string
        }
        Insert: {
          choice: string
          created_at?: string | null
          id?: string
          post_id: string
          user_id: string
        }
        Update: {
          choice?: string
          created_at?: string | null
          id?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_votes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          author_arena_score: number | null
          author_avatar_url: string | null
          author_handle: string | null
          author_id: string
          author_is_verified: boolean | null
          bookmark_count: number | null
          click_count: number | null
          comment_count: number | null
          comments_last_hour: number | null
          content: string
          content_warning: string | null
          created_at: string
          delete_reason: string | null
          deleted_at: string | null
          deleted_by: string | null
          dislike_count: number | null
          group_id: string | null
          hashtags: string[] | null
          hot_score: number | null
          id: string
          images: string[] | null
          impression_count: number | null
          is_pinned: boolean | null
          is_sensitive: boolean | null
          language: string | null
          last_hot_refresh_at: string | null
          like_count: number | null
          likes_last_hour: number | null
          links: Json | null
          locked_reason: string | null
          mentions: string[] | null
          original_post_id: string | null
          poll_bear: number | null
          poll_bull: number | null
          poll_enabled: boolean | null
          poll_id: string | null
          poll_wait: number | null
          report_count: number | null
          repost_count: number | null
          search_hit_count: number | null
          status: Database["public"]["Enums"]["post_status"]
          title: string
          updated_at: string
          velocity_updated_at: string | null
          view_count: number | null
          visibility: string
        }
        Insert: {
          author_arena_score?: number | null
          author_avatar_url?: string | null
          author_handle?: string | null
          author_id?: string
          author_is_verified?: boolean | null
          bookmark_count?: number | null
          click_count?: number | null
          comment_count?: number | null
          comments_last_hour?: number | null
          content?: string
          content_warning?: string | null
          created_at?: string
          delete_reason?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          dislike_count?: number | null
          group_id?: string | null
          hashtags?: string[] | null
          hot_score?: number | null
          id?: string
          images?: string[] | null
          impression_count?: number | null
          is_pinned?: boolean | null
          is_sensitive?: boolean | null
          language?: string | null
          last_hot_refresh_at?: string | null
          like_count?: number | null
          likes_last_hour?: number | null
          links?: Json | null
          locked_reason?: string | null
          mentions?: string[] | null
          original_post_id?: string | null
          poll_bear?: number | null
          poll_bull?: number | null
          poll_enabled?: boolean | null
          poll_id?: string | null
          poll_wait?: number | null
          report_count?: number | null
          repost_count?: number | null
          search_hit_count?: number | null
          status?: Database["public"]["Enums"]["post_status"]
          title: string
          updated_at?: string
          velocity_updated_at?: string | null
          view_count?: number | null
          visibility?: string
        }
        Update: {
          author_arena_score?: number | null
          author_avatar_url?: string | null
          author_handle?: string | null
          author_id?: string
          author_is_verified?: boolean | null
          bookmark_count?: number | null
          click_count?: number | null
          comment_count?: number | null
          comments_last_hour?: number | null
          content?: string
          content_warning?: string | null
          created_at?: string
          delete_reason?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          dislike_count?: number | null
          group_id?: string | null
          hashtags?: string[] | null
          hot_score?: number | null
          id?: string
          images?: string[] | null
          impression_count?: number | null
          is_pinned?: boolean | null
          is_sensitive?: boolean | null
          language?: string | null
          last_hot_refresh_at?: string | null
          like_count?: number | null
          likes_last_hour?: number | null
          links?: Json | null
          locked_reason?: string | null
          mentions?: string[] | null
          original_post_id?: string | null
          poll_bear?: number | null
          poll_bull?: number | null
          poll_enabled?: boolean | null
          poll_id?: string | null
          poll_wait?: number | null
          report_count?: number | null
          repost_count?: number | null
          search_hit_count?: number | null
          status?: Database["public"]["Enums"]["post_status"]
          title?: string
          updated_at?: string
          velocity_updated_at?: string | null
          view_count?: number | null
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "posts_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "posts_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_original_post_id_fkey"
            columns: ["original_post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_poll_id_fkey"
            columns: ["poll_id"]
            isOneToOne: false
            referencedRelation: "polls"
            referencedColumns: ["id"]
          },
        ]
      }
      project_cache: {
        Row: {
          bt_t: number | null
          bw_t: number | null
          claimants: number | null
          hf_t: number | null
          ma_t: number | null
          project: string
          rate: number | null
          rf_t: number | null
          sybils: number | null
          total: number | null
        }
        Insert: {
          bt_t?: number | null
          bw_t?: number | null
          claimants?: number | null
          hf_t?: number | null
          ma_t?: number | null
          project: string
          rate?: number | null
          rf_t?: number | null
          sybils?: number | null
          total?: number | null
        }
        Update: {
          bt_t?: number | null
          bw_t?: number | null
          claimants?: number | null
          hf_t?: number | null
          ma_t?: number | null
          project?: string
          rate?: number | null
          rf_t?: number | null
          sybils?: number | null
          total?: number | null
        }
        Relationships: []
      }
      project_interactions: {
        Row: {
          id: number
          status: string | null
          task_id: number | null
          timestamp: string | null
          wallet_id: number | null
        }
        Insert: {
          id?: number
          status?: string | null
          task_id?: number | null
          timestamp?: string | null
          wallet_id?: number | null
        }
        Update: {
          id?: number
          status?: string | null
          task_id?: number | null
          timestamp?: string | null
          wallet_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "project_interactions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["task_id"]
          },
          {
            foreignKeyName: "project_interactions_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["wallet_id"]
          },
        ]
      }
      project_labels: {
        Row: {
          confidence: number
          confidence_basis: string | null
          evidence_ref: string | null
          imported_at: string | null
          label: string
          project_id: number
          project_label_id: number
          rule_ref: string | null
          source: string
          wallet_id: number
        }
        Insert: {
          confidence: number
          confidence_basis?: string | null
          evidence_ref?: string | null
          imported_at?: string | null
          label: string
          project_id: number
          project_label_id?: number
          rule_ref?: string | null
          source: string
          wallet_id: number
        }
        Update: {
          confidence?: number
          confidence_basis?: string | null
          evidence_ref?: string | null
          imported_at?: string | null
          label?: string
          project_id?: number
          project_label_id?: number
          rule_ref?: string | null
          source?: string
          wallet_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "project_labels_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "project_labels_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["wallet_id"]
          },
        ]
      }
      project_wallets: {
        Row: {
          imported_at: string | null
          project_id: number
          project_wallet_id: number
          source: string
          source_ref: string | null
          wallet_id: number
        }
        Insert: {
          imported_at?: string | null
          project_id: number
          project_wallet_id?: number
          source: string
          source_ref?: string | null
          wallet_id: number
        }
        Update: {
          imported_at?: string | null
          project_id?: number
          project_wallet_id?: number
          source?: string
          source_ref?: string | null
          wallet_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "project_wallets_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["project_id"]
          },
          {
            foreignKeyName: "project_wallets_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["wallet_id"]
          },
        ]
      }
      projects: {
        Row: {
          category: string | null
          chain: string | null
          contract_address: string | null
          name: string | null
          project_id: number
        }
        Insert: {
          category?: string | null
          chain?: string | null
          contract_address?: string | null
          name?: string | null
          project_id?: number
        }
        Update: {
          category?: string | null
          chain?: string | null
          contract_address?: string | null
          name?: string | null
          project_id?: number
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string | null
          created_at: string
          device_id: string | null
          device_name: string | null
          enabled: boolean
          endpoint: string | null
          id: string
          p256dh: string | null
          platform: string | null
          provider: string
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          auth?: string | null
          created_at?: string
          device_id?: string | null
          device_name?: string | null
          enabled?: boolean
          endpoint?: string | null
          id?: string
          p256dh?: string | null
          platform?: string | null
          provider: string
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          auth?: string | null
          created_at?: string
          device_id?: string | null
          device_name?: string | null
          enabled?: boolean
          endpoint?: string | null
          id?: string
          p256dh?: string | null
          platform?: string | null
          provider?: string
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      rank_history: {
        Row: {
          arena_score: number | null
          created_at: string | null
          id: string
          period: string
          platform: string
          rank: number
          snapshot_date: string
          trader_key: string
        }
        Insert: {
          arena_score?: number | null
          created_at?: string | null
          id?: string
          period: string
          platform: string
          rank: number
          snapshot_date: string
          trader_key: string
        }
        Update: {
          arena_score?: number | null
          created_at?: string | null
          id?: string
          period?: string
          platform?: string
          rank?: number
          snapshot_date?: string
          trader_key?: string
        }
        Relationships: []
      }
      ranking_snapshots: {
        Row: {
          category: string | null
          created_at: string
          created_by: string | null
          data_captured_at: string
          data_delay_minutes: number | null
          description: string | null
          exchange: string | null
          expires_at: string | null
          id: string
          is_expired: boolean | null
          is_public: boolean | null
          share_token: string | null
          time_range: string
          title: string | null
          top_trader_handle: string | null
          top_trader_roi: number | null
          total_traders: number
          view_count: number | null
        }
        Insert: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          data_captured_at: string
          data_delay_minutes?: number | null
          description?: string | null
          exchange?: string | null
          expires_at?: string | null
          id?: string
          is_expired?: boolean | null
          is_public?: boolean | null
          share_token?: string | null
          time_range: string
          title?: string | null
          top_trader_handle?: string | null
          top_trader_roi?: number | null
          total_traders?: number
          view_count?: number | null
        }
        Update: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          data_captured_at?: string
          data_delay_minutes?: number | null
          description?: string | null
          exchange?: string | null
          expires_at?: string | null
          id?: string
          is_expired?: boolean | null
          is_public?: boolean | null
          share_token?: string | null
          time_range?: string
          title?: string | null
          top_trader_handle?: string | null
          top_trader_roi?: number | null
          total_traders?: number
          view_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ranking_snapshots_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "public_user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ranking_snapshots_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_follow_counts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ranking_snapshots_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      reading_progress: {
        Row: {
          book_id: string
          current_page: number
          epub_cfi: string | null
          progress_percent: number | null
          total_pages: number
          updated_at: string
          user_id: string
        }
        Insert: {
          book_id: string
          current_page?: number
          epub_cfi?: string | null
          progress_percent?: number | null
          total_pages?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          book_id?: string
          current_page?: number
          epub_cfi?: string | null
          progress_percent?: number | null
          total_pages?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      reading_statistics: {
        Row: {
          avg_speed_chars_per_min: number | null
          book_id: string
          created_at: string
          id: string
          last_session_duration_sec: number | null
          last_session_start: string | null
          pages_read: number
          sessions_count: number
          total_reading_time_sec: number
          updated_at: string
          user_id: string
        }
        Insert: {
          avg_speed_chars_per_min?: number | null
          book_id: string
          created_at?: string
          id?: string
          last_session_duration_sec?: number | null
          last_session_start?: string | null
          pages_read?: number
          sessions_count?: number
          total_reading_time_sec?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          avg_speed_chars_per_min?: number | null
          book_id?: string
          created_at?: string
          id?: string
          last_session_duration_sec?: number | null
          last_session_start?: string | null
          pages_read?: number
          sessions_count?: number
          total_reading_time_sec?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      refresh_jobs: {
        Row: {
          attempts: number
          completed_at: string | null
          created_at: string
          id: string
          idempotency_key: string | null
          job_type: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          market_type: string
          max_attempts: number
          next_run_at: string
          platform: string
          priority: number
          result: Json | null
          started_at: string | null
          status: string
          time_window: string | null
          trader_key: string | null
          updated_at: string
          window: string | null
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          idempotency_key?: string | null
          job_type: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          market_type?: string
          max_attempts?: number
          next_run_at?: string
          platform: string
          priority?: number
          result?: Json | null
          started_at?: string | null
          status?: string
          time_window?: string | null
          trader_key?: string | null
          updated_at?: string
          window?: string | null
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          idempotency_key?: string | null
          job_type?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          market_type?: string
          max_attempts?: number
          next_run_at?: string
          platform?: string
          priority?: number
          result?: Json | null
          started_at?: string | null
          status?: string
          time_window?: string | null
          trader_key?: string | null
          updated_at?: string
          window?: string | null
        }
        Relationships: []
      }
      reports: {
        Row: {
          created_at: string
          group_id: string
          id: string
          note: string | null
          reason: Database["public"]["Enums"]["report_reason"]
          reporter_id: string
          target_id: string
          target_type: string
        }
        Insert: {
          created_at?: string
          group_id: string
          id?: string
          note?: string | null
          reason?: Database["public"]["Enums"]["report_reason"]
          reporter_id?: string
          target_id: string
          target_type: string
        }
        Update: {
          created_at?: string
          group_id?: string
          id?: string
          note?: string | null
          reason?: Database["public"]["Enums"]["report_reason"]
          reporter_id?: string
          target_id?: string
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "group_subscription_stats"
            referencedColumns: ["group_id"]
          },
          {
            foreignKeyName: "reports_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      reposts: {
        Row: {
          comment: string | null
          created_at: string | null
          id: string
          post_id: string
          user_id: string
        }
        Insert: {
          comment?: string | null
          created_at?: string | null
          id?: string
          post_id: string
          user_id: string
        }
        Update: {
          comment?: string | null
          created_at?: string | null
          id?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reposts_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      reviews: {
        Row: {
          content: string | null
          created_at: string | null
          helpful_count: number | null
          id: string
          rating: number
          target_id: string
          target_type: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          content?: string | null
          created_at?: string | null
          helpful_count?: number | null
          id?: string
          rating: number
          target_id: string
          target_type: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          content?: string | null
          created_at?: string | null
          helpful_count?: number | null
          id?: string
          rating?: number
          target_id?: string
          target_type?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      risk_scores: {
        Row: {
          score_type: string
          score_value: number | null
          updated_at: string | null
          wallet_id: number
        }
        Insert: {
          score_type: string
          score_value?: number | null
          updated_at?: string | null
          wallet_id: number
        }
        Update: {
          score_type?: string
          score_value?: number | null
          updated_at?: string | null
          wallet_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "risk_scores_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["wallet_id"]
          },
        ]
      }
      scrape_telemetry: {
        Row: {
          created_at: string
          duration_ms: number | null
          error_message: string | null
          finished_at: string | null
          id: number
          records_fetched: number | null
          records_upserted: number | null
          source: string
          started_at: string
          status: string
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: never
          records_fetched?: number | null
          records_upserted?: number | null
          source: string
          started_at?: string
          status?: string
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          finished_at?: string | null
          id?: never
          records_fetched?: number | null
          records_upserted?: number | null
          source?: string
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      search_analytics: {
        Row: {
          clicked_result_id: string | null
          clicked_result_type: string | null
          created_at: string | null
          id: string
          query: string
          result_count: number
          source: string | null
          user_id: string | null
        }
        Insert: {
          clicked_result_id?: string | null
          clicked_result_type?: string | null
          created_at?: string | null
          id?: string
          query: string
          result_count?: number
          source?: string | null
          user_id?: string | null
        }
        Update: {
          clicked_result_id?: string | null
          clicked_result_type?: string | null
          created_at?: string | null
          id?: string
          query?: string
          result_count?: number
          source?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      signals: {
        Row: {
          created_at: string
          entry: number | null
          exit: number | null
          id: string
          pnl: number | null
          side: string
          symbol: string
          trader_id: string | null
        }
        Insert: {
          created_at?: string
          entry?: number | null
          exit?: number | null
          id?: string
          pnl?: number | null
          side: string
          symbol: string
          trader_id?: string | null
        }
        Update: {
          created_at?: string
          entry?: number | null
          exit?: number | null
          id?: string
          pnl?: number | null
          side?: string
          symbol?: string
          trader_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signals_trader_id_fkey"
            columns: ["trader_id"]
            isOneToOne: false
            referencedRelation: "traders_legacy"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signals_trader_id_fkey"
            columns: ["trader_id"]
            isOneToOne: false
            referencedRelation: "view_leaderboard_top10"
            referencedColumns: ["trader_id"]
          },
        ]
      }
      snapshot_traders: {
        Row: {
          arena_score: number | null
          avatar_url: string | null
          data_availability: Json | null
          drawdown_score: number | null
          followers: number | null
          handle: string | null
          id: string
          max_drawdown: number | null
          pnl: number | null
          rank: number
          return_score: number | null
          roi: number | null
          snapshot_id: string
          source: string
          stability_score: number | null
          trader_id: string
          trades_count: number | null
          win_rate: number | null
        }
        Insert: {
          arena_score?: number | null
          avatar_url?: string | null
          data_availability?: Json | null
          drawdown_score?: number | null
          followers?: number | null
          handle?: string | null
          id?: string
          max_drawdown?: number | null
          pnl?: number | null
          rank: number
          return_score?: number | null
          roi?: number | null
          snapshot_id: string
          source: string
          stability_score?: number | null
          trader_id: string
          trades_count?: number | null
          win_rate?: number | null
        }
        Update: {
          arena_score?: number | null
          avatar_url?: string | null
          data_availability?: Json | null
          drawdown_score?: number | null
          followers?: number | null
          handle?: string | null
          id?: string
          max_drawdown?: number | null
          pnl?: number | null
          rank?: number
          return_score?: number | null
          roi?: number | null
          snapshot_id?: string
          source?: string
          stability_score?: number | null
          trader_id?: string
          trades_count?: number | null
          win_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "snapshot_traders_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "ranking_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      strategies: {
        Row: {
          created_at: string
          id: string
          roi: number
          timeframe: string | null
          title: string
          trader_id: string | null
          win_rate: number
        }
        Insert: {
          created_at?: string
          id?: string
          roi?: number
          timeframe?: string | null
          title: string
          trader_id?: string | null
          win_rate?: number
        }
        Update: {
          created_at?: string
          id?: string
          roi?: number
          timeframe?: string | null
          title?: string
          trader_id?: string | null
          win_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "strategies_trader_id_fkey"
            columns: ["trader_id"]
            isOneToOne: false
            referencedRelation: "traders_legacy"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "strategies_trader_id_fkey"
            columns: ["trader_id"]
            isOneToOne: false
            referencedRelation: "view_leaderboard_top10"
            referencedColumns: ["trader_id"]
          },
        ]
      }
      stripe_events: {
        Row: {
          created_at: string
          event_id: string
          event_type: string
          id: string
          payload: Json | null
          processed_at: string
        }
        Insert: {
          created_at?: string
          event_id: string
          event_type: string
          id?: string
          payload?: Json | null
          processed_at?: string
        }
        Update: {
          created_at?: string
          event_id?: string
          event_type?: string
          id?: string
          payload?: Json | null
          processed_at?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          api_calls_reset_at: string | null
          api_calls_today: number
          comparison_reports_this_month: number
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          exports_this_month: number
          id: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          tier: string
          updated_at: string
          usage_reset_at: string | null
          user_id: string
        }
        Insert: {
          api_calls_reset_at?: string | null
          api_calls_today?: number
          comparison_reports_this_month?: number
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          exports_this_month?: number
          id?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tier?: string
          updated_at?: string
          usage_reset_at?: string | null
          user_id: string
        }
        Update: {
          api_calls_reset_at?: string | null
          api_calls_today?: number
          comparison_reports_this_month?: number
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          exports_this_month?: number
          id?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tier?: string
          updated_at?: string
          usage_reset_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          description: string | null
          name: string | null
          project_id: number | null
          task_id: number
          task_type: string | null
        }
        Insert: {
          description?: string | null
          name?: string | null
          project_id?: number | null
          task_id?: number
          task_type?: string | null
        }
        Update: {
          description?: string | null
          name?: string | null
          project_id?: number | null
          task_id?: number
          task_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["project_id"]
          },
        ]
      }
      tools: {
        Row: {
          avg_rating: number | null
          category: string
          created_at: string | null
          description: string | null
          description_zh: string | null
          github_url: string | null
          id: string
          is_active: boolean | null
          logo_url: string | null
          name: string
          name_zh: string | null
          pricing: string | null
          rating_count: number | null
          sort_priority: number | null
          tags: string[] | null
          updated_at: string | null
          website: string | null
        }
        Insert: {
          avg_rating?: number | null
          category: string
          created_at?: string | null
          description?: string | null
          description_zh?: string | null
          github_url?: string | null
          id?: string
          is_active?: boolean | null
          logo_url?: string | null
          name: string
          name_zh?: string | null
          pricing?: string | null
          rating_count?: number | null
          sort_priority?: number | null
          tags?: string[] | null
          updated_at?: string | null
          website?: string | null
        }
        Update: {
          avg_rating?: number | null
          category?: string
          created_at?: string | null
          description?: string | null
          description_zh?: string | null
          github_url?: string | null
          id?: string
          is_active?: boolean | null
          logo_url?: string | null
          name?: string
          name_zh?: string | null
          pricing?: string | null
          rating_count?: number | null
          sort_priority?: number | null
          tags?: string[] | null
          updated_at?: string | null
          website?: string | null
        }
        Relationships: []
      }
      tph_2026_01: {
        Row: {
          captured_at: string
          close_time: string | null
          closed_size: number | null
          created_at: string
          direction: string
          entry_price: number | null
          exit_price: number | null
          id: string
          margin_mode: string | null
          max_position_size: number | null
          open_time: string | null
          pnl_pct: number | null
          pnl_usd: number | null
          position_type: string | null
          source: string
          source_trader_id: string
          status: string | null
          symbol: string
        }
        Insert: {
          captured_at: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source: string
          source_trader_id: string
          status?: string | null
          symbol: string
        }
        Update: {
          captured_at?: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction?: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source?: string
          source_trader_id?: string
          status?: string | null
          symbol?: string
        }
        Relationships: []
      }
      tph_2026_02: {
        Row: {
          captured_at: string
          close_time: string | null
          closed_size: number | null
          created_at: string
          direction: string
          entry_price: number | null
          exit_price: number | null
          id: string
          margin_mode: string | null
          max_position_size: number | null
          open_time: string | null
          pnl_pct: number | null
          pnl_usd: number | null
          position_type: string | null
          source: string
          source_trader_id: string
          status: string | null
          symbol: string
        }
        Insert: {
          captured_at: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source: string
          source_trader_id: string
          status?: string | null
          symbol: string
        }
        Update: {
          captured_at?: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction?: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source?: string
          source_trader_id?: string
          status?: string | null
          symbol?: string
        }
        Relationships: []
      }
      tph_2026_03: {
        Row: {
          captured_at: string
          close_time: string | null
          closed_size: number | null
          created_at: string
          direction: string
          entry_price: number | null
          exit_price: number | null
          id: string
          margin_mode: string | null
          max_position_size: number | null
          open_time: string | null
          pnl_pct: number | null
          pnl_usd: number | null
          position_type: string | null
          source: string
          source_trader_id: string
          status: string | null
          symbol: string
        }
        Insert: {
          captured_at: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source: string
          source_trader_id: string
          status?: string | null
          symbol: string
        }
        Update: {
          captured_at?: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction?: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source?: string
          source_trader_id?: string
          status?: string | null
          symbol?: string
        }
        Relationships: []
      }
      tph_2026_04: {
        Row: {
          captured_at: string
          close_time: string | null
          closed_size: number | null
          created_at: string
          direction: string
          entry_price: number | null
          exit_price: number | null
          id: string
          margin_mode: string | null
          max_position_size: number | null
          open_time: string | null
          pnl_pct: number | null
          pnl_usd: number | null
          position_type: string | null
          source: string
          source_trader_id: string
          status: string | null
          symbol: string
        }
        Insert: {
          captured_at: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source: string
          source_trader_id: string
          status?: string | null
          symbol: string
        }
        Update: {
          captured_at?: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction?: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source?: string
          source_trader_id?: string
          status?: string | null
          symbol?: string
        }
        Relationships: []
      }
      tph_2026_05: {
        Row: {
          captured_at: string
          close_time: string | null
          closed_size: number | null
          created_at: string
          direction: string
          entry_price: number | null
          exit_price: number | null
          id: string
          margin_mode: string | null
          max_position_size: number | null
          open_time: string | null
          pnl_pct: number | null
          pnl_usd: number | null
          position_type: string | null
          source: string
          source_trader_id: string
          status: string | null
          symbol: string
        }
        Insert: {
          captured_at: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source: string
          source_trader_id: string
          status?: string | null
          symbol: string
        }
        Update: {
          captured_at?: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction?: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source?: string
          source_trader_id?: string
          status?: string | null
          symbol?: string
        }
        Relationships: []
      }
      tph_2026_06: {
        Row: {
          captured_at: string
          close_time: string | null
          closed_size: number | null
          created_at: string
          direction: string
          entry_price: number | null
          exit_price: number | null
          id: string
          margin_mode: string | null
          max_position_size: number | null
          open_time: string | null
          pnl_pct: number | null
          pnl_usd: number | null
          position_type: string | null
          source: string
          source_trader_id: string
          status: string | null
          symbol: string
        }
        Insert: {
          captured_at: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source: string
          source_trader_id: string
          status?: string | null
          symbol: string
        }
        Update: {
          captured_at?: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction?: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source?: string
          source_trader_id?: string
          status?: string | null
          symbol?: string
        }
        Relationships: []
      }
      tph_archive: {
        Row: {
          captured_at: string
          close_time: string | null
          closed_size: number | null
          created_at: string
          direction: string
          entry_price: number | null
          exit_price: number | null
          id: string
          margin_mode: string | null
          max_position_size: number | null
          open_time: string | null
          pnl_pct: number | null
          pnl_usd: number | null
          position_type: string | null
          source: string
          source_trader_id: string
          status: string | null
          symbol: string
        }
        Insert: {
          captured_at: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source: string
          source_trader_id: string
          status?: string | null
          symbol: string
        }
        Update: {
          captured_at?: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction?: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source?: string
          source_trader_id?: string
          status?: string | null
          symbol?: string
        }
        Relationships: []
      }
      trader_activities: {
        Row: {
          activity_text: string
          activity_type: string
          avatar_url: string | null
          created_at: string
          dedup_key: string
          handle: string | null
          id: string
          metric_label: string | null
          metric_value: number | null
          occurred_at: string
          source: string
          source_trader_id: string
        }
        Insert: {
          activity_text: string
          activity_type: string
          avatar_url?: string | null
          created_at?: string
          dedup_key: string
          handle?: string | null
          id?: string
          metric_label?: string | null
          metric_value?: number | null
          occurred_at?: string
          source: string
          source_trader_id: string
        }
        Update: {
          activity_text?: string
          activity_type?: string
          avatar_url?: string | null
          created_at?: string
          dedup_key?: string
          handle?: string | null
          id?: string
          metric_label?: string | null
          metric_value?: number | null
          occurred_at?: string
          source?: string
          source_trader_id?: string
        }
        Relationships: []
      }
      trader_alerts: {
        Row: {
          alert_drawdown: boolean | null
          alert_new_position: boolean | null
          alert_pnl_change: boolean | null
          alert_price_above: boolean | null
          alert_price_below: boolean | null
          alert_rank_change: boolean | null
          alert_roi_change: boolean | null
          alert_score_change: boolean | null
          created_at: string
          drawdown_threshold: number | null
          enabled: boolean
          id: string
          last_triggered_at: string | null
          one_time: boolean | null
          pnl_change_threshold: number | null
          price_above_value: number | null
          price_below_value: number | null
          price_symbol: string | null
          rank_change_threshold: number | null
          roi_change_threshold: number | null
          score_change_threshold: number | null
          source: string | null
          trader_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          alert_drawdown?: boolean | null
          alert_new_position?: boolean | null
          alert_pnl_change?: boolean | null
          alert_price_above?: boolean | null
          alert_price_below?: boolean | null
          alert_rank_change?: boolean | null
          alert_roi_change?: boolean | null
          alert_score_change?: boolean | null
          created_at?: string
          drawdown_threshold?: number | null
          enabled?: boolean
          id?: string
          last_triggered_at?: string | null
          one_time?: boolean | null
          pnl_change_threshold?: number | null
          price_above_value?: number | null
          price_below_value?: number | null
          price_symbol?: string | null
          rank_change_threshold?: number | null
          roi_change_threshold?: number | null
          score_change_threshold?: number | null
          source?: string | null
          trader_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          alert_drawdown?: boolean | null
          alert_new_position?: boolean | null
          alert_pnl_change?: boolean | null
          alert_price_above?: boolean | null
          alert_price_below?: boolean | null
          alert_rank_change?: boolean | null
          alert_roi_change?: boolean | null
          alert_score_change?: boolean | null
          created_at?: string
          drawdown_threshold?: number | null
          enabled?: boolean
          id?: string
          last_triggered_at?: string | null
          one_time?: boolean | null
          pnl_change_threshold?: number | null
          price_above_value?: number | null
          price_below_value?: number | null
          price_symbol?: string | null
          rank_change_threshold?: number | null
          roi_change_threshold?: number | null
          score_change_threshold?: number | null
          source?: string | null
          trader_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      trader_anomalies: {
        Row: {
          anomaly_type: string
          created_at: string | null
          description: string | null
          detected_at: string | null
          detected_value: number | null
          expected_range_max: number | null
          expected_range_min: number | null
          field_name: string
          id: string
          metadata: Json | null
          notes: string | null
          platform: string
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          status: string | null
          trader_id: string
          updated_at: string | null
          z_score: number | null
        }
        Insert: {
          anomaly_type: string
          created_at?: string | null
          description?: string | null
          detected_at?: string | null
          detected_value?: number | null
          expected_range_max?: number | null
          expected_range_min?: number | null
          field_name: string
          id?: string
          metadata?: Json | null
          notes?: string | null
          platform: string
          resolved_at?: string | null
          resolved_by?: string | null
          severity: string
          status?: string | null
          trader_id: string
          updated_at?: string | null
          z_score?: number | null
        }
        Update: {
          anomaly_type?: string
          created_at?: string | null
          description?: string | null
          detected_at?: string | null
          detected_value?: number | null
          expected_range_max?: number | null
          expected_range_min?: number | null
          field_name?: string
          id?: string
          metadata?: Json | null
          notes?: string | null
          platform?: string
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          status?: string | null
          trader_id?: string
          updated_at?: string | null
          z_score?: number | null
        }
        Relationships: []
      }
      trader_asset_breakdown: {
        Row: {
          captured_at: string
          created_at: string | null
          id: string
          period: string
          source: string
          source_trader_id: string
          symbol: string
          updated_at: string | null
          weight_pct: number
        }
        Insert: {
          captured_at: string
          created_at?: string | null
          id?: string
          period: string
          source: string
          source_trader_id: string
          symbol: string
          updated_at?: string | null
          weight_pct: number
        }
        Update: {
          captured_at?: string
          created_at?: string | null
          id?: string
          period?: string
          source?: string
          source_trader_id?: string
          symbol?: string
          updated_at?: string | null
          weight_pct?: number
        }
        Relationships: []
      }
      trader_attestations: {
        Row: {
          arena_score: number | null
          chain_id: number | null
          created_at: string | null
          id: string
          minted_by: string | null
          score_period: string | null
          source: string
          trader_id: string
          tx_hash: string | null
        }
        Insert: {
          arena_score?: number | null
          chain_id?: number | null
          created_at?: string | null
          id?: string
          minted_by?: string | null
          score_period?: string | null
          source: string
          trader_id: string
          tx_hash?: string | null
        }
        Update: {
          arena_score?: number | null
          chain_id?: number | null
          created_at?: string | null
          id?: string
          minted_by?: string | null
          score_period?: string | null
          source?: string
          trader_id?: string
          tx_hash?: string | null
        }
        Relationships: []
      }
      trader_authorizations: {
        Row: {
          created_at: string | null
          data_source: string
          encrypted_api_key: string
          encrypted_api_secret: string
          encrypted_passphrase: string | null
          expires_at: string | null
          id: string
          label: string | null
          last_verified_at: string | null
          notes: string | null
          permissions: Json | null
          platform: string
          status: string
          sync_frequency: string | null
          trader_id: string
          updated_at: string | null
          user_id: string
          verification_error: string | null
        }
        Insert: {
          created_at?: string | null
          data_source?: string
          encrypted_api_key: string
          encrypted_api_secret: string
          encrypted_passphrase?: string | null
          expires_at?: string | null
          id?: string
          label?: string | null
          last_verified_at?: string | null
          notes?: string | null
          permissions?: Json | null
          platform: string
          status?: string
          sync_frequency?: string | null
          trader_id: string
          updated_at?: string | null
          user_id: string
          verification_error?: string | null
        }
        Update: {
          created_at?: string | null
          data_source?: string
          encrypted_api_key?: string
          encrypted_api_secret?: string
          encrypted_passphrase?: string | null
          expires_at?: string | null
          id?: string
          label?: string | null
          last_verified_at?: string | null
          notes?: string | null
          permissions?: Json | null
          platform?: string
          status?: string
          sync_frequency?: string | null
          trader_id?: string
          updated_at?: string | null
          user_id?: string
          verification_error?: string | null
        }
        Relationships: []
      }
      trader_claims: {
        Row: {
          created_at: string | null
          handle: string | null
          id: string
          reject_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          source: string
          status: string
          trader_id: string
          updated_at: string | null
          user_id: string
          verification_data: Json | null
          verification_method: string
          verified_at: string | null
        }
        Insert: {
          created_at?: string | null
          handle?: string | null
          id?: string
          reject_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source: string
          status?: string
          trader_id: string
          updated_at?: string | null
          user_id: string
          verification_data?: Json | null
          verification_method: string
          verified_at?: string | null
        }
        Update: {
          created_at?: string | null
          handle?: string | null
          id?: string
          reject_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          source?: string
          status?: string
          trader_id?: string
          updated_at?: string | null
          user_id?: string
          verification_data?: Json | null
          verification_method?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      trader_daily_snapshots: {
        Row: {
          confidence: string
          created_at: string | null
          cumulative_pnl: number | null
          daily_return_pct: number | null
          date: string
          followers: number | null
          id: string
          max_drawdown: number | null
          platform: string
          pnl: number | null
          roi: number | null
          trader_key: string
          trades_count: number | null
          win_rate: number | null
        }
        Insert: {
          confidence?: string
          created_at?: string | null
          cumulative_pnl?: number | null
          daily_return_pct?: number | null
          date: string
          followers?: number | null
          id?: string
          max_drawdown?: number | null
          platform: string
          pnl?: number | null
          roi?: number | null
          trader_key: string
          trades_count?: number | null
          win_rate?: number | null
        }
        Update: {
          confidence?: string
          created_at?: string | null
          cumulative_pnl?: number | null
          daily_return_pct?: number | null
          date?: string
          followers?: number | null
          id?: string
          max_drawdown?: number | null
          platform?: string
          pnl?: number | null
          roi?: number | null
          trader_key?: string
          trades_count?: number | null
          win_rate?: number | null
        }
        Relationships: []
      }
      trader_equity_curve: {
        Row: {
          captured_at: string
          created_at: string | null
          data_date: string
          id: string
          period: string
          pnl_usd: number | null
          roi_pct: number | null
          source: string
          source_trader_id: string
        }
        Insert: {
          captured_at: string
          created_at?: string | null
          data_date: string
          id?: string
          period: string
          pnl_usd?: number | null
          roi_pct?: number | null
          source: string
          source_trader_id: string
        }
        Update: {
          captured_at?: string
          created_at?: string | null
          data_date?: string
          id?: string
          period?: string
          pnl_usd?: number | null
          roi_pct?: number | null
          source?: string
          source_trader_id?: string
        }
        Relationships: []
      }
      trader_flags: {
        Row: {
          alert_id: string | null
          created_at: string | null
          expires_at: string | null
          flag_status: string
          flagged_by: string | null
          id: string
          notes: string | null
          platform: string
          reason: string
          trader_key: string
          updated_at: string | null
        }
        Insert: {
          alert_id?: string | null
          created_at?: string | null
          expires_at?: string | null
          flag_status: string
          flagged_by?: string | null
          id?: string
          notes?: string | null
          platform: string
          reason: string
          trader_key: string
          updated_at?: string | null
        }
        Update: {
          alert_id?: string | null
          created_at?: string | null
          expires_at?: string | null
          flag_status?: string
          flagged_by?: string | null
          id?: string
          notes?: string | null
          platform?: string
          reason?: string
          trader_key?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trader_flags_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "manipulation_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trader_flags_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "v_recent_alerts"
            referencedColumns: ["id"]
          },
        ]
      }
      trader_follows: {
        Row: {
          created_at: string | null
          id: string
          source: string | null
          trader_id: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          source?: string | null
          trader_id: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          source?: string | null
          trader_id?: string
          user_id?: string
        }
        Relationships: []
      }
      trader_frequently_traded: {
        Row: {
          avg_loss: number | null
          avg_profit: number | null
          captured_at: string
          created_at: string | null
          id: string
          period: string | null
          profitable_pct: number | null
          source: string
          source_trader_id: string
          symbol: string
          trade_count: number | null
          weight_pct: number | null
        }
        Insert: {
          avg_loss?: number | null
          avg_profit?: number | null
          captured_at: string
          created_at?: string | null
          id?: string
          period?: string | null
          profitable_pct?: number | null
          source: string
          source_trader_id: string
          symbol: string
          trade_count?: number | null
          weight_pct?: number | null
        }
        Update: {
          avg_loss?: number | null
          avg_profit?: number | null
          captured_at?: string
          created_at?: string | null
          id?: string
          period?: string | null
          profitable_pct?: number | null
          source?: string
          source_trader_id?: string
          symbol?: string
          trade_count?: number | null
          weight_pct?: number | null
        }
        Relationships: []
      }
      trader_links: {
        Row: {
          created_at: string | null
          handle: string | null
          id: string
          source: string
          trader_id: string
          user_id: string
          verified_at: string | null
        }
        Insert: {
          created_at?: string | null
          handle?: string | null
          id?: string
          source: string
          trader_id: string
          user_id: string
          verified_at?: string | null
        }
        Update: {
          created_at?: string | null
          handle?: string | null
          id?: string
          source?: string
          trader_id?: string
          user_id?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      trader_merges: {
        Row: {
          from_trader_id: string
          id: number
          merged_at: string
          reason: string | null
          to_trader_id: string
        }
        Insert: {
          from_trader_id: string
          id?: number
          merged_at?: string
          reason?: string | null
          to_trader_id: string
        }
        Update: {
          from_trader_id?: string
          id?: number
          merged_at?: string
          reason?: string | null
          to_trader_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trader_merges_from_trader_id_fkey"
            columns: ["from_trader_id"]
            isOneToOne: false
            referencedRelation: "traders_legacy"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trader_merges_from_trader_id_fkey"
            columns: ["from_trader_id"]
            isOneToOne: false
            referencedRelation: "view_leaderboard_top10"
            referencedColumns: ["trader_id"]
          },
          {
            foreignKeyName: "trader_merges_to_trader_id_fkey"
            columns: ["to_trader_id"]
            isOneToOne: false
            referencedRelation: "traders_legacy"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trader_merges_to_trader_id_fkey"
            columns: ["to_trader_id"]
            isOneToOne: false
            referencedRelation: "view_leaderboard_top10"
            referencedColumns: ["trader_id"]
          },
        ]
      }
      trader_portfolio: {
        Row: {
          captured_at: string
          created_at: string | null
          direction: string
          entry_price: number | null
          id: string
          invested_pct: number | null
          pnl: number | null
          source: string
          source_trader_id: string
          symbol: string
        }
        Insert: {
          captured_at: string
          created_at?: string | null
          direction: string
          entry_price?: number | null
          id?: string
          invested_pct?: number | null
          pnl?: number | null
          source: string
          source_trader_id: string
          symbol: string
        }
        Update: {
          captured_at?: string
          created_at?: string | null
          direction?: string
          entry_price?: number | null
          id?: string
          invested_pct?: number | null
          pnl?: number | null
          source?: string
          source_trader_id?: string
          symbol?: string
        }
        Relationships: []
      }
      trader_position_history: {
        Row: {
          captured_at: string
          close_time: string | null
          closed_size: number | null
          created_at: string | null
          direction: string
          entry_price: number | null
          exit_price: number | null
          id: string
          margin_mode: string | null
          max_position_size: number | null
          open_time: string | null
          pnl_pct: number | null
          pnl_usd: number | null
          position_type: string | null
          source: string
          source_trader_id: string
          status: string | null
          symbol: string
        }
        Insert: {
          captured_at: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string | null
          direction: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source: string
          source_trader_id: string
          status?: string | null
          symbol: string
        }
        Update: {
          captured_at?: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string | null
          direction?: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source?: string
          source_trader_id?: string
          status?: string | null
          symbol?: string
        }
        Relationships: []
      }
      trader_position_history_partitioned: {
        Row: {
          captured_at: string
          close_time: string | null
          closed_size: number | null
          created_at: string
          direction: string
          entry_price: number | null
          exit_price: number | null
          id: string
          margin_mode: string | null
          max_position_size: number | null
          open_time: string | null
          pnl_pct: number | null
          pnl_usd: number | null
          position_type: string | null
          source: string
          source_trader_id: string
          status: string | null
          symbol: string
        }
        Insert: {
          captured_at: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source: string
          source_trader_id: string
          status?: string | null
          symbol: string
        }
        Update: {
          captured_at?: string
          close_time?: string | null
          closed_size?: number | null
          created_at?: string
          direction?: string
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          margin_mode?: string | null
          max_position_size?: number | null
          open_time?: string | null
          pnl_pct?: number | null
          pnl_usd?: number | null
          position_type?: string | null
          source?: string
          source_trader_id?: string
          status?: string | null
          symbol?: string
        }
        Relationships: []
      }
      trader_position_summary: {
        Row: {
          avg_leverage: number | null
          id: string
          largest_position_symbol: string | null
          largest_position_value: number | null
          long_positions: number | null
          platform: string
          short_positions: number | null
          total_margin_usd: number | null
          total_positions: number | null
          total_unrealized_pnl: number | null
          trader_key: string
          updated_at: string | null
        }
        Insert: {
          avg_leverage?: number | null
          id?: string
          largest_position_symbol?: string | null
          largest_position_value?: number | null
          long_positions?: number | null
          platform: string
          short_positions?: number | null
          total_margin_usd?: number | null
          total_positions?: number | null
          total_unrealized_pnl?: number | null
          trader_key: string
          updated_at?: string | null
        }
        Update: {
          avg_leverage?: number | null
          id?: string
          largest_position_symbol?: string | null
          largest_position_value?: number | null
          long_positions?: number | null
          platform?: string
          short_positions?: number | null
          total_margin_usd?: number | null
          total_positions?: number | null
          total_unrealized_pnl?: number | null
          trader_key?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      trader_positions_history: {
        Row: {
          closed_at: string
          created_at: string | null
          entry_price: number
          exit_price: number
          fees: number | null
          holding_hours: number | null
          id: string
          leverage: number | null
          market_type: string
          opened_at: string | null
          platform: string
          quantity: number
          realized_pnl: number | null
          realized_pnl_pct: number | null
          side: string
          symbol: string
          trader_key: string
        }
        Insert: {
          closed_at: string
          created_at?: string | null
          entry_price: number
          exit_price: number
          fees?: number | null
          holding_hours?: number | null
          id?: string
          leverage?: number | null
          market_type?: string
          opened_at?: string | null
          platform: string
          quantity: number
          realized_pnl?: number | null
          realized_pnl_pct?: number | null
          side: string
          symbol: string
          trader_key: string
        }
        Update: {
          closed_at?: string
          created_at?: string | null
          entry_price?: number
          exit_price?: number
          fees?: number | null
          holding_hours?: number | null
          id?: string
          leverage?: number | null
          market_type?: string
          opened_at?: string | null
          platform?: string
          quantity?: number
          realized_pnl?: number | null
          realized_pnl_pct?: number | null
          side?: string
          symbol?: string
          trader_key?: string
        }
        Relationships: []
      }
      trader_positions_live: {
        Row: {
          created_at: string | null
          current_price: number | null
          entry_price: number
          id: string
          leverage: number | null
          liquidation_price: number | null
          margin: number | null
          mark_price: number | null
          market_type: string
          opened_at: string | null
          platform: string
          quantity: number
          side: string
          symbol: string
          trader_key: string
          unrealized_pnl: number | null
          unrealized_pnl_pct: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          current_price?: number | null
          entry_price: number
          id?: string
          leverage?: number | null
          liquidation_price?: number | null
          margin?: number | null
          mark_price?: number | null
          market_type?: string
          opened_at?: string | null
          platform: string
          quantity: number
          side: string
          symbol: string
          trader_key: string
          unrealized_pnl?: number | null
          unrealized_pnl_pct?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          current_price?: number | null
          entry_price?: number
          id?: string
          leverage?: number | null
          liquidation_price?: number | null
          margin?: number | null
          mark_price?: number | null
          market_type?: string
          opened_at?: string | null
          platform?: string
          quantity?: number
          side?: string
          symbol?: string
          trader_key?: string
          unrealized_pnl?: number | null
          unrealized_pnl_pct?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      trader_profiles_v2: {
        Row: {
          aum: number | null
          avatar_url: string | null
          bio: string | null
          bio_source: string | null
          bot_category: string | null
          copiers: number | null
          created_at: string
          display_name: string | null
          followers: number | null
          id: string
          is_bot: boolean | null
          last_enriched_at: string | null
          market_type: string
          platform: string
          profile_url: string | null
          provenance: Json | null
          tags: string[] | null
          trader_key: string
          updated_at: string
        }
        Insert: {
          aum?: number | null
          avatar_url?: string | null
          bio?: string | null
          bio_source?: string | null
          bot_category?: string | null
          copiers?: number | null
          created_at?: string
          display_name?: string | null
          followers?: number | null
          id?: string
          is_bot?: boolean | null
          last_enriched_at?: string | null
          market_type?: string
          platform: string
          profile_url?: string | null
          provenance?: Json | null
          tags?: string[] | null
          trader_key: string
          updated_at?: string
        }
        Update: {
          aum?: number | null
          avatar_url?: string | null
          bio?: string | null
          bio_source?: string | null
          bot_category?: string | null
          copiers?: number | null
          created_at?: string
          display_name?: string | null
          followers?: number | null
          id?: string
          is_bot?: boolean | null
          last_enriched_at?: string | null
          market_type?: string
          platform?: string
          profile_url?: string | null
          provenance?: Json | null
          tags?: string[] | null
          trader_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      trader_roi_history: {
        Row: {
          captured_at: string
          created_at: string | null
          daily_roi: number | null
          data_date: string
          id: string
          period: string
          roi: number | null
          source: string
          source_trader_id: string
        }
        Insert: {
          captured_at: string
          created_at?: string | null
          daily_roi?: number | null
          data_date: string
          id?: string
          period: string
          roi?: number | null
          source: string
          source_trader_id: string
        }
        Update: {
          captured_at?: string
          created_at?: string | null
          daily_roi?: number | null
          data_date?: string
          id?: string
          period?: string
          roi?: number | null
          source?: string
          source_trader_id?: string
        }
        Relationships: []
      }
      trader_scores: {
        Row: {
          arena_score: number
          drawdown_score: number | null
          id: number
          meets_threshold: boolean | null
          return_score: number | null
          season_id: string
          source: string
          source_trader_id: string
          stability_score: number | null
          updated_at: string | null
        }
        Insert: {
          arena_score?: number
          drawdown_score?: number | null
          id?: number
          meets_threshold?: boolean | null
          return_score?: number | null
          season_id: string
          source: string
          source_trader_id: string
          stability_score?: number | null
          updated_at?: string | null
        }
        Update: {
          arena_score?: number
          drawdown_score?: number | null
          id?: number
          meets_threshold?: boolean | null
          return_score?: number | null
          season_id?: string
          source?: string
          source_trader_id?: string
          stability_score?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      trader_seasons: {
        Row: {
          arena_score: number
          created_at: string
          id: string
          max_drawdown: number
          roi: number
          season: string
          trader_id: string
        }
        Insert: {
          arena_score: number
          created_at?: string
          id?: string
          max_drawdown?: number
          roi: number
          season: string
          trader_id: string
        }
        Update: {
          arena_score?: number
          created_at?: string
          id?: string
          max_drawdown?: number
          roi?: number
          season?: string
          trader_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trader_seasons_trader_id_fkey"
            columns: ["trader_id"]
            isOneToOne: false
            referencedRelation: "traders_legacy"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trader_seasons_trader_id_fkey"
            columns: ["trader_id"]
            isOneToOne: false
            referencedRelation: "view_leaderboard_top10"
            referencedColumns: ["trader_id"]
          },
        ]
      }
      trader_snapshots: {
        Row: {
          alpha: number | null
          alpha_score: number | null
          arena_score: number | null
          arena_score_v3: number | null
          asset_preference: string[] | null
          aum: number | null
          authorization_id: string | null
          avg_holding_hours: number | null
          beta_btc: number | null
          beta_eth: number | null
          calmar_ratio: number | null
          captured_at: string | null
          consistency_score: number | null
          downside_volatility_pct: number | null
          execution_score: number | null
          followers: number | null
          full_confidence_at: string | null
          holding_days: number | null
          id: number
          is_authorized: boolean | null
          last_qualified_at: string | null
          market_condition_tags: Json | null
          max_consecutive_losses: number | null
          max_consecutive_wins: number | null
          max_drawdown: number | null
          max_drawdown_30d: number | null
          max_drawdown_7d: number | null
          metrics_data_points: number | null
          metrics_quality: string | null
          pnl: number | null
          pnl_30d: number | null
          pnl_7d: number | null
          pnl_score: number | null
          profit_factor: number | null
          profit_loss_ratio: number | null
          profitability_score: number | null
          rank: number | null
          recovery_factor: number | null
          risk_adjusted_score_v3: number | null
          risk_control_score: number | null
          roi: number | null
          roi_30d: number | null
          roi_7d: number | null
          score_completeness: string | null
          score_penalty: number | null
          season_id: string | null
          sharpe_ratio: number | null
          snapshot_date: string | null
          sortino_ratio: number | null
          source: string
          source_trader_id: string
          style_confidence: number | null
          tracked_since: string | null
          trader_type: string | null
          trades_count: number | null
          trading_style: string | null
          volatility_pct: number | null
          win_rate: number | null
          win_rate_30d: number | null
          win_rate_7d: number | null
        }
        Insert: {
          alpha?: number | null
          alpha_score?: number | null
          arena_score?: number | null
          arena_score_v3?: number | null
          asset_preference?: string[] | null
          aum?: number | null
          authorization_id?: string | null
          avg_holding_hours?: number | null
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          captured_at?: string | null
          consistency_score?: number | null
          downside_volatility_pct?: number | null
          execution_score?: number | null
          followers?: number | null
          full_confidence_at?: string | null
          holding_days?: number | null
          id?: number
          is_authorized?: boolean | null
          last_qualified_at?: string | null
          market_condition_tags?: Json | null
          max_consecutive_losses?: number | null
          max_consecutive_wins?: number | null
          max_drawdown?: number | null
          max_drawdown_30d?: number | null
          max_drawdown_7d?: number | null
          metrics_data_points?: number | null
          metrics_quality?: string | null
          pnl?: number | null
          pnl_30d?: number | null
          pnl_7d?: number | null
          pnl_score?: number | null
          profit_factor?: number | null
          profit_loss_ratio?: number | null
          profitability_score?: number | null
          rank?: number | null
          recovery_factor?: number | null
          risk_adjusted_score_v3?: number | null
          risk_control_score?: number | null
          roi?: number | null
          roi_30d?: number | null
          roi_7d?: number | null
          score_completeness?: string | null
          score_penalty?: number | null
          season_id?: string | null
          sharpe_ratio?: number | null
          snapshot_date?: string | null
          sortino_ratio?: number | null
          source: string
          source_trader_id: string
          style_confidence?: number | null
          tracked_since?: string | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          volatility_pct?: number | null
          win_rate?: number | null
          win_rate_30d?: number | null
          win_rate_7d?: number | null
        }
        Update: {
          alpha?: number | null
          alpha_score?: number | null
          arena_score?: number | null
          arena_score_v3?: number | null
          asset_preference?: string[] | null
          aum?: number | null
          authorization_id?: string | null
          avg_holding_hours?: number | null
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          captured_at?: string | null
          consistency_score?: number | null
          downside_volatility_pct?: number | null
          execution_score?: number | null
          followers?: number | null
          full_confidence_at?: string | null
          holding_days?: number | null
          id?: number
          is_authorized?: boolean | null
          last_qualified_at?: string | null
          market_condition_tags?: Json | null
          max_consecutive_losses?: number | null
          max_consecutive_wins?: number | null
          max_drawdown?: number | null
          max_drawdown_30d?: number | null
          max_drawdown_7d?: number | null
          metrics_data_points?: number | null
          metrics_quality?: string | null
          pnl?: number | null
          pnl_30d?: number | null
          pnl_7d?: number | null
          pnl_score?: number | null
          profit_factor?: number | null
          profit_loss_ratio?: number | null
          profitability_score?: number | null
          rank?: number | null
          recovery_factor?: number | null
          risk_adjusted_score_v3?: number | null
          risk_control_score?: number | null
          roi?: number | null
          roi_30d?: number | null
          roi_7d?: number | null
          score_completeness?: string | null
          score_penalty?: number | null
          season_id?: string | null
          sharpe_ratio?: number | null
          snapshot_date?: string | null
          sortino_ratio?: number | null
          source?: string
          source_trader_id?: string
          style_confidence?: number | null
          tracked_since?: string | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          volatility_pct?: number | null
          win_rate?: number | null
          win_rate_30d?: number | null
          win_rate_7d?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trader_snapshots_authorization_id_fkey"
            columns: ["authorization_id"]
            isOneToOne: false
            referencedRelation: "trader_authorizations"
            referencedColumns: ["id"]
          },
        ]
      }
      trader_snapshots_v2: {
        Row: {
          alpha: number | null
          arena_score: number | null
          as_of_ts: string
          beta_btc: number | null
          beta_eth: number | null
          calmar_ratio: number | null
          copiers: number | null
          created_at: string
          downside_volatility_pct: number | null
          drawdown_score: number | null
          followers: number | null
          id: string
          market_type: string
          max_drawdown: number | null
          metrics: Json
          metrics_data_points: number | null
          metrics_quality: string | null
          platform: string
          pnl_usd: number | null
          provenance: Json | null
          quality_flags: Json | null
          return_score: number | null
          roi_pct: number | null
          sharpe_ratio: number | null
          sortino_ratio: number | null
          stability_score: number | null
          trader_key: string
          trades_count: number | null
          updated_at: string
          volatility_pct: number | null
          win_rate: number | null
          window: string
        }
        Insert: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window: string
        }
        Update: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform?: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key?: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window?: string
        }
        Relationships: []
      }
      trader_snapshots_v2_p_default: {
        Row: {
          alpha: number | null
          arena_score: number | null
          as_of_ts: string
          beta_btc: number | null
          beta_eth: number | null
          calmar_ratio: number | null
          copiers: number | null
          created_at: string
          downside_volatility_pct: number | null
          drawdown_score: number | null
          followers: number | null
          id: string
          market_type: string
          max_drawdown: number | null
          metrics: Json
          metrics_data_points: number | null
          metrics_quality: string | null
          platform: string
          pnl_usd: number | null
          provenance: Json | null
          quality_flags: Json | null
          return_score: number | null
          roi_pct: number | null
          sharpe_ratio: number | null
          sortino_ratio: number | null
          stability_score: number | null
          trader_key: string
          trades_count: number | null
          updated_at: string
          volatility_pct: number | null
          win_rate: number | null
          window: string
        }
        Insert: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window: string
        }
        Update: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform?: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key?: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window?: string
        }
        Relationships: []
      }
      trader_snapshots_v2_p2025_12: {
        Row: {
          alpha: number | null
          arena_score: number | null
          as_of_ts: string
          beta_btc: number | null
          beta_eth: number | null
          calmar_ratio: number | null
          copiers: number | null
          created_at: string
          downside_volatility_pct: number | null
          drawdown_score: number | null
          followers: number | null
          id: string
          market_type: string
          max_drawdown: number | null
          metrics: Json
          metrics_data_points: number | null
          metrics_quality: string | null
          platform: string
          pnl_usd: number | null
          provenance: Json | null
          quality_flags: Json | null
          return_score: number | null
          roi_pct: number | null
          sharpe_ratio: number | null
          sortino_ratio: number | null
          stability_score: number | null
          trader_key: string
          trades_count: number | null
          updated_at: string
          volatility_pct: number | null
          win_rate: number | null
          window: string
        }
        Insert: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window: string
        }
        Update: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform?: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key?: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window?: string
        }
        Relationships: []
      }
      trader_snapshots_v2_p2026_01: {
        Row: {
          alpha: number | null
          arena_score: number | null
          as_of_ts: string
          beta_btc: number | null
          beta_eth: number | null
          calmar_ratio: number | null
          copiers: number | null
          created_at: string
          downside_volatility_pct: number | null
          drawdown_score: number | null
          followers: number | null
          id: string
          market_type: string
          max_drawdown: number | null
          metrics: Json
          metrics_data_points: number | null
          metrics_quality: string | null
          platform: string
          pnl_usd: number | null
          provenance: Json | null
          quality_flags: Json | null
          return_score: number | null
          roi_pct: number | null
          sharpe_ratio: number | null
          sortino_ratio: number | null
          stability_score: number | null
          trader_key: string
          trades_count: number | null
          updated_at: string
          volatility_pct: number | null
          win_rate: number | null
          window: string
        }
        Insert: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window: string
        }
        Update: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform?: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key?: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window?: string
        }
        Relationships: []
      }
      trader_snapshots_v2_p2026_02: {
        Row: {
          alpha: number | null
          arena_score: number | null
          as_of_ts: string
          beta_btc: number | null
          beta_eth: number | null
          calmar_ratio: number | null
          copiers: number | null
          created_at: string
          downside_volatility_pct: number | null
          drawdown_score: number | null
          followers: number | null
          id: string
          market_type: string
          max_drawdown: number | null
          metrics: Json
          metrics_data_points: number | null
          metrics_quality: string | null
          platform: string
          pnl_usd: number | null
          provenance: Json | null
          quality_flags: Json | null
          return_score: number | null
          roi_pct: number | null
          sharpe_ratio: number | null
          sortino_ratio: number | null
          stability_score: number | null
          trader_key: string
          trades_count: number | null
          updated_at: string
          volatility_pct: number | null
          win_rate: number | null
          window: string
        }
        Insert: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window: string
        }
        Update: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform?: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key?: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window?: string
        }
        Relationships: []
      }
      trader_snapshots_v2_p2026_03: {
        Row: {
          alpha: number | null
          arena_score: number | null
          as_of_ts: string
          beta_btc: number | null
          beta_eth: number | null
          calmar_ratio: number | null
          copiers: number | null
          created_at: string
          downside_volatility_pct: number | null
          drawdown_score: number | null
          followers: number | null
          id: string
          market_type: string
          max_drawdown: number | null
          metrics: Json
          metrics_data_points: number | null
          metrics_quality: string | null
          platform: string
          pnl_usd: number | null
          provenance: Json | null
          quality_flags: Json | null
          return_score: number | null
          roi_pct: number | null
          sharpe_ratio: number | null
          sortino_ratio: number | null
          stability_score: number | null
          trader_key: string
          trades_count: number | null
          updated_at: string
          volatility_pct: number | null
          win_rate: number | null
          window: string
        }
        Insert: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window: string
        }
        Update: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform?: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key?: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window?: string
        }
        Relationships: []
      }
      trader_snapshots_v2_p2026_04: {
        Row: {
          alpha: number | null
          arena_score: number | null
          as_of_ts: string
          beta_btc: number | null
          beta_eth: number | null
          calmar_ratio: number | null
          copiers: number | null
          created_at: string
          downside_volatility_pct: number | null
          drawdown_score: number | null
          followers: number | null
          id: string
          market_type: string
          max_drawdown: number | null
          metrics: Json
          metrics_data_points: number | null
          metrics_quality: string | null
          platform: string
          pnl_usd: number | null
          provenance: Json | null
          quality_flags: Json | null
          return_score: number | null
          roi_pct: number | null
          sharpe_ratio: number | null
          sortino_ratio: number | null
          stability_score: number | null
          trader_key: string
          trades_count: number | null
          updated_at: string
          volatility_pct: number | null
          win_rate: number | null
          window: string
        }
        Insert: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window: string
        }
        Update: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform?: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key?: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window?: string
        }
        Relationships: []
      }
      trader_snapshots_v2_p2026_05: {
        Row: {
          alpha: number | null
          arena_score: number | null
          as_of_ts: string
          beta_btc: number | null
          beta_eth: number | null
          calmar_ratio: number | null
          copiers: number | null
          created_at: string
          downside_volatility_pct: number | null
          drawdown_score: number | null
          followers: number | null
          id: string
          market_type: string
          max_drawdown: number | null
          metrics: Json
          metrics_data_points: number | null
          metrics_quality: string | null
          platform: string
          pnl_usd: number | null
          provenance: Json | null
          quality_flags: Json | null
          return_score: number | null
          roi_pct: number | null
          sharpe_ratio: number | null
          sortino_ratio: number | null
          stability_score: number | null
          trader_key: string
          trades_count: number | null
          updated_at: string
          volatility_pct: number | null
          win_rate: number | null
          window: string
        }
        Insert: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window: string
        }
        Update: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform?: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key?: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window?: string
        }
        Relationships: []
      }
      trader_snapshots_v2_p2026_06: {
        Row: {
          alpha: number | null
          arena_score: number | null
          as_of_ts: string
          beta_btc: number | null
          beta_eth: number | null
          calmar_ratio: number | null
          copiers: number | null
          created_at: string
          downside_volatility_pct: number | null
          drawdown_score: number | null
          followers: number | null
          id: string
          market_type: string
          max_drawdown: number | null
          metrics: Json
          metrics_data_points: number | null
          metrics_quality: string | null
          platform: string
          pnl_usd: number | null
          provenance: Json | null
          quality_flags: Json | null
          return_score: number | null
          roi_pct: number | null
          sharpe_ratio: number | null
          sortino_ratio: number | null
          stability_score: number | null
          trader_key: string
          trades_count: number | null
          updated_at: string
          volatility_pct: number | null
          win_rate: number | null
          window: string
        }
        Insert: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window: string
        }
        Update: {
          alpha?: number | null
          arena_score?: number | null
          as_of_ts?: string
          beta_btc?: number | null
          beta_eth?: number | null
          calmar_ratio?: number | null
          copiers?: number | null
          created_at?: string
          downside_volatility_pct?: number | null
          drawdown_score?: number | null
          followers?: number | null
          id?: string
          market_type?: string
          max_drawdown?: number | null
          metrics?: Json
          metrics_data_points?: number | null
          metrics_quality?: string | null
          platform?: string
          pnl_usd?: number | null
          provenance?: Json | null
          quality_flags?: Json | null
          return_score?: number | null
          roi_pct?: number | null
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          stability_score?: number | null
          trader_key?: string
          trades_count?: number | null
          updated_at?: string
          volatility_pct?: number | null
          win_rate?: number | null
          window?: string
        }
        Relationships: []
      }
      trader_sources: {
        Row: {
          activity_tier: string | null
          avatar_url: string | null
          bot_category: string | null
          claimed_by_user_id: string | null
          created_at: string | null
          handle: string | null
          id: number
          identity_type: string
          is_active: boolean | null
          is_bot: boolean | null
          last_refreshed_at: string | null
          last_seen_at: string | null
          market_type: string | null
          next_refresh_at: string | null
          profile_url: string | null
          refresh_priority: number | null
          score_confidence: string | null
          source: string
          source_kind: string
          source_trader_id: string
          source_type: string | null
          tier_updated_at: string | null
          trader_id: string | null
          verified_by_user: boolean
        }
        Insert: {
          activity_tier?: string | null
          avatar_url?: string | null
          bot_category?: string | null
          claimed_by_user_id?: string | null
          created_at?: string | null
          handle?: string | null
          id?: number
          identity_type?: string
          is_active?: boolean | null
          is_bot?: boolean | null
          last_refreshed_at?: string | null
          last_seen_at?: string | null
          market_type?: string | null
          next_refresh_at?: string | null
          profile_url?: string | null
          refresh_priority?: number | null
          score_confidence?: string | null
          source: string
          source_kind?: string
          source_trader_id: string
          source_type?: string | null
          tier_updated_at?: string | null
          trader_id?: string | null
          verified_by_user?: boolean
        }
        Update: {
          activity_tier?: string | null
          avatar_url?: string | null
          bot_category?: string | null
          claimed_by_user_id?: string | null
          created_at?: string | null
          handle?: string | null
          id?: number
          identity_type?: string
          is_active?: boolean | null
          is_bot?: boolean | null
          last_refreshed_at?: string | null
          last_seen_at?: string | null
          market_type?: string | null
          next_refresh_at?: string | null
          profile_url?: string | null
          refresh_priority?: number | null
          score_confidence?: string | null
          source?: string
          source_kind?: string
          source_trader_id?: string
          source_type?: string | null
          tier_updated_at?: string | null
          trader_id?: string | null
          verified_by_user?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "trader_sources_trader_id_fkey"
            columns: ["trader_id"]
            isOneToOne: false
            referencedRelation: "traders_legacy"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trader_sources_trader_id_fkey"
            columns: ["trader_id"]
            isOneToOne: false
            referencedRelation: "view_leaderboard_top10"
            referencedColumns: ["trader_id"]
          },
        ]
      }
      trader_sources_v2: {
        Row: {
          created_at: string
          discovered_at: string
          display_name: string | null
          id: string
          is_active: boolean
          last_seen_at: string
          market_type: string
          platform: string
          profile_url: string | null
          raw: Json | null
          trader_key: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          discovered_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          last_seen_at?: string
          market_type?: string
          platform: string
          profile_url?: string | null
          raw?: Json | null
          trader_key: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          discovered_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          last_seen_at?: string
          market_type?: string
          platform?: string
          profile_url?: string | null
          raw?: Json | null
          trader_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      trader_stats_detail: {
        Row: {
          aum: number | null
          avg_holding_time_hours: number | null
          avg_loss: number | null
          avg_profit: number | null
          captured_at: string
          copiers_count: number | null
          copiers_pnl: number | null
          created_at: string | null
          current_drawdown: number | null
          id: string
          largest_loss: number | null
          largest_win: number | null
          max_drawdown: number | null
          period: string | null
          profitable_trades_pct: number | null
          roi: number | null
          sharpe_ratio: number | null
          source: string
          source_trader_id: string
          total_positions: number | null
          total_trades: number | null
          volatility: number | null
          winning_positions: number | null
        }
        Insert: {
          aum?: number | null
          avg_holding_time_hours?: number | null
          avg_loss?: number | null
          avg_profit?: number | null
          captured_at: string
          copiers_count?: number | null
          copiers_pnl?: number | null
          created_at?: string | null
          current_drawdown?: number | null
          id?: string
          largest_loss?: number | null
          largest_win?: number | null
          max_drawdown?: number | null
          period?: string | null
          profitable_trades_pct?: number | null
          roi?: number | null
          sharpe_ratio?: number | null
          source: string
          source_trader_id: string
          total_positions?: number | null
          total_trades?: number | null
          volatility?: number | null
          winning_positions?: number | null
        }
        Update: {
          aum?: number | null
          avg_holding_time_hours?: number | null
          avg_loss?: number | null
          avg_profit?: number | null
          captured_at?: string
          copiers_count?: number | null
          copiers_pnl?: number | null
          created_at?: string | null
          current_drawdown?: number | null
          id?: string
          largest_loss?: number | null
          largest_win?: number | null
          max_drawdown?: number | null
          period?: string | null
          profitable_trades_pct?: number | null
          roi?: number | null
          sharpe_ratio?: number | null
          source?: string
          source_trader_id?: string
          total_positions?: number | null
          total_trades?: number | null
          volatility?: number | null
          winning_positions?: number | null
        }
        Relationships: []
      }
      trader_timeseries: {
        Row: {
          as_of_ts: string
          created_at: string
          data: Json
          id: string
          market_type: string
          platform: string
          provenance: Json | null
          series_type: string
          trader_key: string
          updated_at: string
        }
        Insert: {
          as_of_ts?: string
          created_at?: string
          data?: Json
          id?: string
          market_type?: string
          platform: string
          provenance?: Json | null
          series_type: string
          trader_key: string
          updated_at?: string
        }
        Update: {
          as_of_ts?: string
          created_at?: string
          data?: Json
          id?: string
          market_type?: string
          platform?: string
          provenance?: Json | null
          series_type?: string
          trader_key?: string
          updated_at?: string
        }
        Relationships: []
      }
      traders: {
        Row: {
          activity_tier: string | null
          aum: number | null
          avatar_url: string | null
          bio: string | null
          bio_source: string | null
          bot_category: string | null
          claimed_by_user_id: string | null
          copiers: number | null
          created_at: string | null
          followers: number | null
          handle: string | null
          id: string
          is_active: boolean | null
          is_bot: boolean | null
          last_refreshed_at: string | null
          last_seen_at: string | null
          market_type: string
          next_refresh_at: string | null
          platform: string
          profile_url: string | null
          provenance: Json | null
          refresh_priority: number | null
          score_confidence: string | null
          tags: string[] | null
          trader_key: string
          trader_type: string | null
          updated_at: string | null
          verified_by_user: boolean | null
        }
        Insert: {
          activity_tier?: string | null
          aum?: number | null
          avatar_url?: string | null
          bio?: string | null
          bio_source?: string | null
          bot_category?: string | null
          claimed_by_user_id?: string | null
          copiers?: number | null
          created_at?: string | null
          followers?: number | null
          handle?: string | null
          id?: string
          is_active?: boolean | null
          is_bot?: boolean | null
          last_refreshed_at?: string | null
          last_seen_at?: string | null
          market_type?: string
          next_refresh_at?: string | null
          platform: string
          profile_url?: string | null
          provenance?: Json | null
          refresh_priority?: number | null
          score_confidence?: string | null
          tags?: string[] | null
          trader_key: string
          trader_type?: string | null
          updated_at?: string | null
          verified_by_user?: boolean | null
        }
        Update: {
          activity_tier?: string | null
          aum?: number | null
          avatar_url?: string | null
          bio?: string | null
          bio_source?: string | null
          bot_category?: string | null
          claimed_by_user_id?: string | null
          copiers?: number | null
          created_at?: string | null
          followers?: number | null
          handle?: string | null
          id?: string
          is_active?: boolean | null
          is_bot?: boolean | null
          last_refreshed_at?: string | null
          last_seen_at?: string | null
          market_type?: string
          next_refresh_at?: string | null
          platform?: string
          profile_url?: string | null
          provenance?: Json | null
          refresh_priority?: number | null
          score_confidence?: string | null
          tags?: string[] | null
          trader_key?: string
          trader_type?: string | null
          updated_at?: string | null
          verified_by_user?: boolean | null
        }
        Relationships: []
      }
      traders_legacy: {
        Row: {
          bio: string | null
          created_at: string
          followers: number
          handle: string
          id: string
          merged_to: string | null
          roi: number | null
          season: string
          source: string | null
          source_trader_id: string | null
          updated_at: string | null
          win_rate: number | null
        }
        Insert: {
          bio?: string | null
          created_at?: string
          followers?: number
          handle: string
          id?: string
          merged_to?: string | null
          roi?: number | null
          season?: string
          source?: string | null
          source_trader_id?: string | null
          updated_at?: string | null
          win_rate?: number | null
        }
        Update: {
          bio?: string | null
          created_at?: string
          followers?: number
          handle?: string
          id?: string
          merged_to?: string | null
          roi?: number | null
          season?: string
          source?: string | null
          source_trader_id?: string | null
          updated_at?: string | null
          win_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "traders_merged_to_fkey"
            columns: ["merged_to"]
            isOneToOne: false
            referencedRelation: "traders_legacy"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "traders_merged_to_fkey"
            columns: ["merged_to"]
            isOneToOne: false
            referencedRelation: "view_leaderboard_top10"
            referencedColumns: ["trader_id"]
          },
        ]
      }
      transactions: {
        Row: {
          block_number: number | null
          chain: string | null
          gas_price: number | null
          gas_used: number | null
          hash: string | null
          method: string | null
          raw_input: string | null
          success: boolean | null
          timestamp: string | null
          tx_id: number
          wallet_id: number | null
        }
        Insert: {
          block_number?: number | null
          chain?: string | null
          gas_price?: number | null
          gas_used?: number | null
          hash?: string | null
          method?: string | null
          raw_input?: string | null
          success?: boolean | null
          timestamp?: string | null
          tx_id?: number
          wallet_id?: number | null
        }
        Update: {
          block_number?: number | null
          chain?: string | null
          gas_price?: number | null
          gas_used?: number | null
          hash?: string | null
          method?: string | null
          raw_input?: string | null
          success?: boolean | null
          timestamp?: string | null
          tx_id?: number
          wallet_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "transactions_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["wallet_id"]
          },
        ]
      }
      transfers: {
        Row: {
          amount: number | null
          chain: string | null
          from_wallet_id: number | null
          timestamp: string | null
          to_wallet_id: number | null
          token_address: string | null
          transfer_id: number
          tx_hash: string | null
        }
        Insert: {
          amount?: number | null
          chain?: string | null
          from_wallet_id?: number | null
          timestamp?: string | null
          to_wallet_id?: number | null
          token_address?: string | null
          transfer_id?: number
          tx_hash?: string | null
        }
        Update: {
          amount?: number | null
          chain?: string | null
          from_wallet_id?: number | null
          timestamp?: string | null
          to_wallet_id?: number | null
          token_address?: string | null
          transfer_id?: number
          tx_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "transfers_from_wallet_id_fkey"
            columns: ["from_wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["wallet_id"]
          },
          {
            foreignKeyName: "transfers_to_wallet_id_fkey"
            columns: ["to_wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["wallet_id"]
          },
        ]
      }
      translation_cache: {
        Row: {
          content_hash: string
          content_id: string
          content_type: string
          created_at: string | null
          id: string
          source_lang: string
          target_lang: string
          translated_text: string
          updated_at: string | null
        }
        Insert: {
          content_hash: string
          content_id: string
          content_type: string
          created_at?: string | null
          id?: string
          source_lang: string
          target_lang: string
          translated_text: string
          updated_at?: string | null
        }
        Update: {
          content_hash?: string
          content_id?: string
          content_type?: string
          created_at?: string | null
          id?: string
          source_lang?: string
          target_lang?: string
          translated_text?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      user_2fa_secrets: {
        Row: {
          created_at: string | null
          totp_secret: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          totp_secret?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          totp_secret?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_activities: {
        Row: {
          activity_type: string
          created_at: string
          id: string
          metadata: Json | null
          target_id: string
          target_type: string
          user_id: string
        }
        Insert: {
          activity_type: string
          created_at?: string
          id?: string
          metadata?: Json | null
          target_id: string
          target_type: string
          user_id: string
        }
        Update: {
          activity_type?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          target_id?: string
          target_type?: string
          user_id?: string
        }
        Relationships: []
      }
      user_activity: {
        Row: {
          action: string
          created_at: string
          id: string
          metadata: Json | null
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          metadata?: Json | null
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      user_collections: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          is_public: boolean | null
          name: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_public?: boolean | null
          name: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          is_public?: boolean | null
          name?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_exchange_connections: {
        Row: {
          access_token_encrypted: string | null
          api_key_encrypted: string
          api_secret_encrypted: string
          created_at: string | null
          exchange: string
          exchange_user_id: string | null
          expires_at: string | null
          id: string
          is_active: boolean | null
          last_sync_at: string | null
          last_sync_error: string | null
          last_sync_status: string | null
          last_verified_at: string | null
          passphrase_encrypted: string | null
          refresh_token_encrypted: string | null
          updated_at: string | null
          user_id: string
          verified_uid: string | null
        }
        Insert: {
          access_token_encrypted?: string | null
          api_key_encrypted: string
          api_secret_encrypted: string
          created_at?: string | null
          exchange: string
          exchange_user_id?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          last_sync_at?: string | null
          last_sync_error?: string | null
          last_sync_status?: string | null
          last_verified_at?: string | null
          passphrase_encrypted?: string | null
          refresh_token_encrypted?: string | null
          updated_at?: string | null
          user_id: string
          verified_uid?: string | null
        }
        Update: {
          access_token_encrypted?: string | null
          api_key_encrypted?: string
          api_secret_encrypted?: string
          created_at?: string | null
          exchange?: string
          exchange_user_id?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          last_sync_at?: string | null
          last_sync_error?: string | null
          last_sync_status?: string | null
          last_verified_at?: string | null
          passphrase_encrypted?: string | null
          refresh_token_encrypted?: string | null
          updated_at?: string | null
          user_id?: string
          verified_uid?: string | null
        }
        Relationships: []
      }
      user_follows: {
        Row: {
          created_at: string | null
          follower_id: string
          following_id: string
          id: string
        }
        Insert: {
          created_at?: string | null
          follower_id: string
          following_id: string
          id?: string
        }
        Update: {
          created_at?: string | null
          follower_id?: string
          following_id?: string
          id?: string
        }
        Relationships: []
      }
      user_interactions: {
        Row: {
          action: string
          created_at: string | null
          id: string
          metadata: Json | null
          target_id: string
          target_type: string
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          target_id: string
          target_type: string
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string | null
          id?: string
          metadata?: Json | null
          target_id?: string
          target_type?: string
          user_id?: string
        }
        Relationships: []
      }
      user_levels: {
        Row: {
          created_at: string | null
          daily_exp_date: string | null
          daily_exp_earned: number | null
          exp: number | null
          is_pro: boolean | null
          level: number | null
          pro_expires_at: string | null
          pro_plan: string | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          daily_exp_date?: string | null
          daily_exp_earned?: number | null
          exp?: number | null
          is_pro?: boolean | null
          level?: number | null
          pro_expires_at?: string | null
          pro_plan?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          daily_exp_date?: string | null
          daily_exp_earned?: number | null
          exp?: number | null
          is_pro?: boolean | null
          level?: number | null
          pro_expires_at?: string | null
          pro_plan?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_linked_traders: {
        Row: {
          created_at: string | null
          display_order: number | null
          id: string
          is_primary: boolean | null
          label: string | null
          market_type: string | null
          source: string
          trader_id: string
          updated_at: string | null
          user_id: string
          verification_method: string
          verified_at: string
        }
        Insert: {
          created_at?: string | null
          display_order?: number | null
          id?: string
          is_primary?: boolean | null
          label?: string | null
          market_type?: string | null
          source: string
          trader_id: string
          updated_at?: string | null
          user_id: string
          verification_method: string
          verified_at?: string
        }
        Update: {
          created_at?: string | null
          display_order?: number | null
          id?: string
          is_primary?: boolean | null
          label?: string | null
          market_type?: string | null
          source?: string
          trader_id?: string
          updated_at?: string | null
          user_id?: string
          verification_method?: string
          verified_at?: string
        }
        Relationships: []
      }
      user_portfolio_snapshots: {
        Row: {
          id: string
          portfolio_id: string
          snapshot_at: string
          total_equity: number
          total_pnl: number
          total_pnl_pct: number
        }
        Insert: {
          id?: string
          portfolio_id: string
          snapshot_at?: string
          total_equity?: number
          total_pnl?: number
          total_pnl_pct?: number
        }
        Update: {
          id?: string
          portfolio_id?: string
          snapshot_at?: string
          total_equity?: number
          total_pnl?: number
          total_pnl_pct?: number
        }
        Relationships: [
          {
            foreignKeyName: "user_portfolio_snapshots_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "user_portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      user_portfolios: {
        Row: {
          api_key_encrypted: string
          api_secret_encrypted: string
          created_at: string
          exchange: string
          id: string
          label: string | null
          user_id: string
        }
        Insert: {
          api_key_encrypted: string
          api_secret_encrypted: string
          created_at?: string
          exchange: string
          id?: string
          label?: string | null
          user_id: string
        }
        Update: {
          api_key_encrypted?: string
          api_secret_encrypted?: string
          created_at?: string
          exchange?: string
          id?: string
          label?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_positions: {
        Row: {
          entry_price: number
          id: string
          leverage: number
          mark_price: number
          pnl: number
          pnl_pct: number
          portfolio_id: string
          side: string
          size: number
          symbol: string
          updated_at: string
        }
        Insert: {
          entry_price?: number
          id?: string
          leverage?: number
          mark_price?: number
          pnl?: number
          pnl_pct?: number
          portfolio_id: string
          side: string
          size?: number
          symbol: string
          updated_at?: string
        }
        Update: {
          entry_price?: number
          id?: string
          leverage?: number
          mark_price?: number
          pnl?: number
          pnl_pct?: number
          portfolio_id?: string
          side?: string
          size?: number
          symbol?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_positions_portfolio_id_fkey"
            columns: ["portfolio_id"]
            isOneToOne: false
            referencedRelation: "user_portfolios"
            referencedColumns: ["id"]
          },
        ]
      }
      user_preferences: {
        Row: {
          created_at: string | null
          email_notifications: boolean | null
          push_notifications: boolean | null
          ranking_change_threshold: number | null
          updated_at: string | null
          user_id: string
          watched_traders: Json | null
        }
        Insert: {
          created_at?: string | null
          email_notifications?: boolean | null
          push_notifications?: boolean | null
          ranking_change_threshold?: number | null
          updated_at?: string | null
          user_id: string
          watched_traders?: Json | null
        }
        Update: {
          created_at?: string | null
          email_notifications?: boolean | null
          push_notifications?: boolean | null
          ranking_change_threshold?: number | null
          updated_at?: string | null
          user_id?: string
          watched_traders?: Json | null
        }
        Relationships: []
      }
      user_profiles: {
        Row: {
          avatar_url: string | null
          ban_expires_at: string | null
          banned_at: string | null
          banned_by: string | null
          banned_reason: string | null
          bio: string | null
          cover_url: string | null
          created_at: string | null
          credit_score: number | null
          deleted_at: string | null
          deletion_reason: string | null
          deletion_scheduled_at: string | null
          dm_permission: string | null
          email: string | null
          email_digest: string | null
          email_digest_last_sent: string | null
          follower_count: number | null
          following_count: number | null
          handle: string | null
          id: string
          interests: Json | null
          is_banned: boolean | null
          is_online: boolean | null
          is_pro: boolean | null
          is_verified: boolean | null
          is_verified_trader: boolean | null
          kol_tier: string | null
          last_seen_at: string | null
          linked_trader_count: number | null
          market_pairs: Json | null
          notify_comment: boolean | null
          notify_follow: boolean | null
          notify_like: boolean | null
          notify_mention: boolean | null
          notify_message: boolean | null
          onboarding_completed: boolean | null
          original_email: string | null
          original_handle: string | null
          pro_expires_at: string | null
          pro_plan: string | null
          reputation_score: number | null
          role: string | null
          search_history: Json | null
          settings_version: number | null
          show_followers: boolean | null
          show_following: boolean | null
          show_pro_badge: boolean | null
          stripe_subscription_id: string | null
          subscription_tier: string | null
          totp_enabled: boolean | null
          totp_secret: string | null
          updated_at: string | null
          utm_campaign: string | null
          utm_medium: string | null
          utm_source: string | null
          verified_at: string | null
          verified_trader_id: string | null
          verified_trader_source: string | null
          wallet_address: string | null
          weight: number | null
        }
        Insert: {
          avatar_url?: string | null
          ban_expires_at?: string | null
          banned_at?: string | null
          banned_by?: string | null
          banned_reason?: string | null
          bio?: string | null
          cover_url?: string | null
          created_at?: string | null
          credit_score?: number | null
          deleted_at?: string | null
          deletion_reason?: string | null
          deletion_scheduled_at?: string | null
          dm_permission?: string | null
          email?: string | null
          email_digest?: string | null
          email_digest_last_sent?: string | null
          follower_count?: number | null
          following_count?: number | null
          handle?: string | null
          id: string
          interests?: Json | null
          is_banned?: boolean | null
          is_online?: boolean | null
          is_pro?: boolean | null
          is_verified?: boolean | null
          is_verified_trader?: boolean | null
          kol_tier?: string | null
          last_seen_at?: string | null
          linked_trader_count?: number | null
          market_pairs?: Json | null
          notify_comment?: boolean | null
          notify_follow?: boolean | null
          notify_like?: boolean | null
          notify_mention?: boolean | null
          notify_message?: boolean | null
          onboarding_completed?: boolean | null
          original_email?: string | null
          original_handle?: string | null
          pro_expires_at?: string | null
          pro_plan?: string | null
          reputation_score?: number | null
          role?: string | null
          search_history?: Json | null
          settings_version?: number | null
          show_followers?: boolean | null
          show_following?: boolean | null
          show_pro_badge?: boolean | null
          stripe_subscription_id?: string | null
          subscription_tier?: string | null
          totp_enabled?: boolean | null
          totp_secret?: string | null
          updated_at?: string | null
          utm_campaign?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          verified_at?: string | null
          verified_trader_id?: string | null
          verified_trader_source?: string | null
          wallet_address?: string | null
          weight?: number | null
        }
        Update: {
          avatar_url?: string | null
          ban_expires_at?: string | null
          banned_at?: string | null
          banned_by?: string | null
          banned_reason?: string | null
          bio?: string | null
          cover_url?: string | null
          created_at?: string | null
          credit_score?: number | null
          deleted_at?: string | null
          deletion_reason?: string | null
          deletion_scheduled_at?: string | null
          dm_permission?: string | null
          email?: string | null
          email_digest?: string | null
          email_digest_last_sent?: string | null
          follower_count?: number | null
          following_count?: number | null
          handle?: string | null
          id?: string
          interests?: Json | null
          is_banned?: boolean | null
          is_online?: boolean | null
          is_pro?: boolean | null
          is_verified?: boolean | null
          is_verified_trader?: boolean | null
          kol_tier?: string | null
          last_seen_at?: string | null
          linked_trader_count?: number | null
          market_pairs?: Json | null
          notify_comment?: boolean | null
          notify_follow?: boolean | null
          notify_like?: boolean | null
          notify_mention?: boolean | null
          notify_message?: boolean | null
          onboarding_completed?: boolean | null
          original_email?: string | null
          original_handle?: string | null
          pro_expires_at?: string | null
          pro_plan?: string | null
          reputation_score?: number | null
          role?: string | null
          search_history?: Json | null
          settings_version?: number | null
          show_followers?: boolean | null
          show_following?: boolean | null
          show_pro_badge?: boolean | null
          stripe_subscription_id?: string | null
          subscription_tier?: string | null
          totp_enabled?: boolean | null
          totp_secret?: string | null
          updated_at?: string | null
          utm_campaign?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          verified_at?: string | null
          verified_trader_id?: string | null
          verified_trader_source?: string | null
          wallet_address?: string | null
          weight?: number | null
        }
        Relationships: []
      }
      user_streaks: {
        Row: {
          current_streak: number
          last_active_date: string | null
          longest_streak: number
          total_active_days: number
          user_id: string
        }
        Insert: {
          current_streak?: number
          last_active_date?: string | null
          longest_streak?: number
          total_active_days?: number
          user_id: string
        }
        Update: {
          current_streak?: number
          last_active_date?: string | null
          longest_streak?: number
          total_active_days?: number
          user_id?: string
        }
        Relationships: []
      }
      users: {
        Row: {
          created_at: string | null
          email: string | null
          id: string
          nickname: string | null
          wallet_address: string | null
        }
        Insert: {
          created_at?: string | null
          email?: string | null
          id: string
          nickname?: string | null
          wallet_address?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string | null
          id?: string
          nickname?: string | null
          wallet_address?: string | null
        }
        Relationships: []
      }
      verified_traders: {
        Row: {
          avatar_url: string | null
          bio: string | null
          can_pin_posts: boolean | null
          can_receive_messages: boolean | null
          can_reply_reviews: boolean | null
          created_at: string | null
          discord_url: string | null
          display_name: string | null
          id: string
          is_primary: boolean | null
          source: string
          telegram_url: string | null
          trader_id: string
          twitter_url: string | null
          updated_at: string | null
          user_id: string
          verification_method: string
          verified_at: string
          website_url: string | null
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          can_pin_posts?: boolean | null
          can_receive_messages?: boolean | null
          can_reply_reviews?: boolean | null
          created_at?: string | null
          discord_url?: string | null
          display_name?: string | null
          id?: string
          is_primary?: boolean | null
          source: string
          telegram_url?: string | null
          trader_id: string
          twitter_url?: string | null
          updated_at?: string | null
          user_id: string
          verification_method: string
          verified_at?: string
          website_url?: string | null
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          can_pin_posts?: boolean | null
          can_receive_messages?: boolean | null
          can_reply_reviews?: boolean | null
          created_at?: string | null
          discord_url?: string | null
          display_name?: string | null
          id?: string
          is_primary?: boolean | null
          source?: string
          telegram_url?: string | null
          trader_id?: string
          twitter_url?: string | null
          updated_at?: string | null
          user_id?: string
          verification_method?: string
          verified_at?: string
          website_url?: string | null
        }
        Relationships: []
      }
      wallet_metadata: {
        Row: {
          key: string
          source: string | null
          value: string | null
          wallet_id: number
        }
        Insert: {
          key: string
          source?: string | null
          value?: string | null
          wallet_id: number
        }
        Update: {
          key?: string
          source?: string | null
          value?: string | null
          wallet_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "wallet_metadata_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["wallet_id"]
          },
        ]
      }
      wallets: {
        Row: {
          address: string
          chain: string | null
          created_by: string | null
          first_seen: string | null
          is_flagged: boolean | null
          last_seen: string | null
          risk_level: string | null
          sybil_score: number | null
          wallet_id: number
          wallet_type: string | null
        }
        Insert: {
          address: string
          chain?: string | null
          created_by?: string | null
          first_seen?: string | null
          is_flagged?: boolean | null
          last_seen?: string | null
          risk_level?: string | null
          sybil_score?: number | null
          wallet_id?: number
          wallet_type?: string | null
        }
        Update: {
          address?: string
          chain?: string | null
          created_by?: string | null
          first_seen?: string | null
          is_flagged?: boolean | null
          last_seen?: string | null
          risk_level?: string | null
          sybil_score?: number | null
          wallet_id?: number
          wallet_type?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      arena_leaderboard_30d: {
        Row: {
          arena_score: number | null
          avatar_url: string | null
          drawdown_score: number | null
          followers: number | null
          handle: string | null
          id: string | null
          max_drawdown: number | null
          pnl: number | null
          rank: number | null
          return_score: number | null
          roi: number | null
          source: string | null
          stability_score: number | null
          trades_count: number | null
          win_rate: number | null
        }
        Relationships: []
      }
      arena_leaderboard_7d: {
        Row: {
          arena_score: number | null
          avatar_url: string | null
          drawdown_score: number | null
          followers: number | null
          handle: string | null
          id: string | null
          max_drawdown: number | null
          pnl: number | null
          rank: number | null
          return_score: number | null
          roi: number | null
          source: string | null
          stability_score: number | null
          trades_count: number | null
          win_rate: number | null
        }
        Relationships: []
      }
      arena_leaderboard_90d: {
        Row: {
          arena_score: number | null
          avatar_url: string | null
          drawdown_score: number | null
          followers: number | null
          handle: string | null
          id: string | null
          max_drawdown: number | null
          pnl: number | null
          rank: number | null
          return_score: number | null
          roi: number | null
          source: string | null
          stability_score: number | null
          trades_count: number | null
          win_rate: number | null
        }
        Relationships: []
      }
      group_subscription_stats: {
        Row: {
          active_subscribers: number | null
          group_id: string | null
          is_premium_only: boolean | null
          name: string | null
          subscription_price_monthly: number | null
          subscription_price_yearly: number | null
          total_revenue: number | null
          trial_users: number | null
        }
        Relationships: []
      }
      mv_daily_rankings: {
        Row: {
          avatar_url: string | null
          avg_arena_score: number | null
          avg_roi: number | null
          day: string | null
          handle: string | null
          market_type: string | null
          max_pnl: number | null
          snapshot_count: number | null
          source: string | null
          source_trader_id: string | null
          time_window: string | null
        }
        Relationships: []
      }
      pipeline_job_stats: {
        Row: {
          avg_duration_ms: number | null
          error_count: number | null
          job_name: string | null
          last_run_at: string | null
          success_count: number | null
          success_rate: number | null
          timeout_count: number | null
          total_records_processed: number | null
          total_runs: number | null
        }
        Relationships: []
      }
      pipeline_job_status: {
        Row: {
          duration_ms: number | null
          ended_at: string | null
          error_message: string | null
          health_status: string | null
          job_name: string | null
          records_processed: number | null
          started_at: string | null
          status: string | null
        }
        Relationships: []
      }
      public_user_profiles: {
        Row: {
          avatar_url: string | null
          bio: string | null
          cover_url: string | null
          created_at: string | null
          credit_score: number | null
          follower_count: number | null
          following_count: number | null
          handle: string | null
          id: string | null
          is_online: boolean | null
          is_pro: boolean | null
          is_verified: boolean | null
          is_verified_trader: boolean | null
          kol_tier: string | null
          last_seen_at: string | null
          linked_trader_count: number | null
          onboarding_completed: boolean | null
          reputation_score: number | null
          show_followers: boolean | null
          show_following: boolean | null
          show_pro_badge: boolean | null
          verified_trader_id: string | null
          verified_trader_source: string | null
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          cover_url?: string | null
          created_at?: string | null
          credit_score?: number | null
          follower_count?: number | null
          following_count?: number | null
          handle?: string | null
          id?: string | null
          is_online?: boolean | null
          is_pro?: boolean | null
          is_verified?: boolean | null
          is_verified_trader?: boolean | null
          kol_tier?: string | null
          last_seen_at?: string | null
          linked_trader_count?: number | null
          onboarding_completed?: boolean | null
          reputation_score?: number | null
          show_followers?: boolean | null
          show_following?: boolean | null
          show_pro_badge?: boolean | null
          verified_trader_id?: string | null
          verified_trader_source?: string | null
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          cover_url?: string | null
          created_at?: string | null
          credit_score?: number | null
          follower_count?: number | null
          following_count?: number | null
          handle?: string | null
          id?: string | null
          is_online?: boolean | null
          is_pro?: boolean | null
          is_verified?: boolean | null
          is_verified_trader?: boolean | null
          kol_tier?: string | null
          last_seen_at?: string | null
          linked_trader_count?: number | null
          onboarding_completed?: boolean | null
          reputation_score?: number | null
          show_followers?: boolean | null
          show_following?: boolean | null
          show_pro_badge?: boolean | null
          verified_trader_id?: string | null
          verified_trader_source?: string | null
        }
        Relationships: []
      }
      trader_sources_compat: {
        Row: {
          activity_tier: string | null
          avatar_url: string | null
          bot_category: string | null
          claimed_by_user_id: string | null
          created_at: string | null
          handle: string | null
          id: string | null
          identity_type: string | null
          is_active: boolean | null
          is_bot: boolean | null
          last_refreshed_at: string | null
          last_seen_at: string | null
          market_type: string | null
          next_refresh_at: string | null
          profile_url: string | null
          refresh_priority: number | null
          score_confidence: string | null
          source: string | null
          source_kind: string | null
          source_trader_id: string | null
          source_type: string | null
          tier_updated_at: string | null
          trader_id: string | null
          verified_by_user: boolean | null
        }
        Insert: {
          activity_tier?: string | null
          avatar_url?: string | null
          bot_category?: string | null
          claimed_by_user_id?: string | null
          created_at?: string | null
          handle?: string | null
          id?: string | null
          identity_type?: never
          is_active?: boolean | null
          is_bot?: boolean | null
          last_refreshed_at?: string | null
          last_seen_at?: string | null
          market_type?: string | null
          next_refresh_at?: string | null
          profile_url?: string | null
          refresh_priority?: number | null
          score_confidence?: string | null
          source?: string | null
          source_kind?: never
          source_trader_id?: string | null
          source_type?: string | null
          tier_updated_at?: never
          trader_id?: never
          verified_by_user?: boolean | null
        }
        Update: {
          activity_tier?: string | null
          avatar_url?: string | null
          bot_category?: string | null
          claimed_by_user_id?: string | null
          created_at?: string | null
          handle?: string | null
          id?: string | null
          identity_type?: never
          is_active?: boolean | null
          is_bot?: boolean | null
          last_refreshed_at?: string | null
          last_seen_at?: string | null
          market_type?: string | null
          next_refresh_at?: string | null
          profile_url?: string | null
          refresh_priority?: number | null
          score_confidence?: string | null
          source?: string | null
          source_kind?: never
          source_trader_id?: string | null
          source_type?: string | null
          tier_updated_at?: never
          trader_id?: never
          verified_by_user?: boolean | null
        }
        Relationships: []
      }
      trader_unified_view: {
        Row: {
          arena_score: number | null
          avatar_url: string | null
          avg_holding_hours: number | null
          bio: string | null
          calmar_ratio: number | null
          computed_at: string | null
          copiers: number | null
          display_name: string | null
          followers: number | null
          handle: string | null
          is_outlier: boolean | null
          market_type: string | null
          max_drawdown: number | null
          period: string | null
          platform: string | null
          pnl: number | null
          profile_url: string | null
          profit_factor: number | null
          profitability_score: number | null
          rank: number | null
          risk_control_score: number | null
          roi: number | null
          score_completeness: string | null
          sharpe_ratio: number | null
          sortino_ratio: number | null
          source_type: string | null
          trader_key: string | null
          trader_type: string | null
          trades_count: number | null
          trading_style: string | null
          win_rate: number | null
        }
        Relationships: []
      }
      user_follow_counts: {
        Row: {
          followers_count: number | null
          following_count: number | null
          handle: string | null
          id: string | null
        }
        Relationships: []
      }
      user_subscription_status: {
        Row: {
          current_period_end: string | null
          is_expired: boolean | null
          is_premium: boolean | null
          status: string | null
          tier: string | null
          user_id: string | null
        }
        Insert: {
          current_period_end?: string | null
          is_expired?: never
          is_premium?: never
          status?: string | null
          tier?: string | null
          user_id?: string | null
        }
        Update: {
          current_period_end?: string | null
          is_expired?: never
          is_premium?: never
          status?: string | null
          tier?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      v_recent_alerts: {
        Row: {
          alert_type: string | null
          auto_action: string | null
          created_at: string | null
          flagged_traders: number | null
          id: string | null
          severity: string | null
          status: string | null
          trader_count: number | null
          traders: string[] | null
          updated_at: string | null
        }
        Relationships: []
      }
      v_suspicious_traders: {
        Row: {
          alert_count: number | null
          alert_types: string[] | null
          flag_status: string | null
          last_flagged_at: string | null
          max_severity: string | null
          platform: string | null
          trader_key: string | null
        }
        Relationships: []
      }
      view_leaderboard_top10: {
        Row: {
          captured_at: string | null
          followers: number | null
          handle: string | null
          roi: number | null
          trader_id: string | null
          win_rate: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      archive_old_notifications: { Args: never; Returns: undefined }
      arena_score: {
        Args: {
          max_drawdown: number
          period: string
          pnl: number
          roi: number
          win_rate: number
        }
        Returns: number
      }
      bulk_update_snapshot_metrics: { Args: { updates: Json }; Returns: number }
      bulk_enrich_sync_v2: { Args: { updates: Json }; Returns: number }
      bytea_to_text: { Args: { data: string }; Returns: string }
      calculate_arena_score:
        | {
            Args: { p_period: string; p_pnl: number; p_roi: number }
            Returns: number
          }
        | {
            Args: {
              max_drawdown: number
              period: string
              pnl: number
              roi: number
              win_rate: number
            }
            Returns: {
              drawdown_score: number
              meets_threshold: boolean
              return_score: number
              stability_score: number
              total_score: number
            }[]
          }
      calculate_hot_score:
        | {
            Args: {
              p_author_id: string
              p_comment_count: number
              p_comments_last_hour: number
              p_content: string
              p_created_at: string
              p_dislike_count: number
              p_images: Json
              p_like_count: number
              p_likes_last_hour: number
              p_poll_id: string
              p_report_count: number
              p_repost_count: number
              p_view_count: number
            }
            Returns: number
          }
        | {
            Args: {
              p_author_id: string
              p_comment_count: number
              p_comments_last_hour: number
              p_content: string
              p_created_at: string
              p_dislike_count: number
              p_images: string[]
              p_like_count: number
              p_likes_last_hour: number
              p_poll_id: string
              p_report_count: number
              p_repost_count: number
              p_view_count: number
            }
            Returns: number
          }
      calculate_overall_score: {
        Args: { score_30d: number; score_7d: number; score_90d: number }
        Returns: number
      }
      calculate_user_weight: { Args: { p_user_id: string }; Returns: number }
      can_access_group: {
        Args: { p_group_id: string; p_user_id: string }
        Returns: boolean
      }
      check_dm_permission: {
        Args: { p_receiver_id: string; p_sender_id: string }
        Returns: Json
      }
      check_mutual_follow: {
        Args: { user_a: string; user_b: string }
        Returns: boolean
      }
      claim_refresh_job: {
        Args: {
          p_job_types?: string[]
          p_platforms?: string[]
          p_worker_id: string
        }
        Returns: {
          attempts: number
          completed_at: string | null
          created_at: string
          id: string
          idempotency_key: string | null
          job_type: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          market_type: string
          max_attempts: number
          next_run_at: string
          platform: string
          priority: number
          result: Json | null
          started_at: string | null
          status: string
          time_window: string | null
          trader_key: string | null
          updated_at: string
          window: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "refresh_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claimant_counts: {
        Args: never
        Returns: {
          cnt: number
          project: string
        }[]
      }
      cleanup_all_data_violations: {
        Args: { batch_limit?: number }
        Returns: {
          fixed: number
          issue: string
          target_table: string
        }[]
      }
      cleanup_old_refresh_jobs: { Args: never; Returns: number }
      cleanup_snapshot_violations: {
        Args: { batch_limit?: number }
        Returns: {
          fixed: number
          issue: string
        }[]
      }
      clip: {
        Args: { max_val: number; min_val: number; val: number }
        Returns: number
      }
      compute_leaderboard_snapshot: { Args: never; Returns: number }
      count_distinct_projects: { Args: never; Returns: number }
      count_trader_followers: {
        Args: { trader_ids: string[] }
        Returns: {
          cnt: number
          trader_id: string
        }[]
      }
      create_monthly_partition: {
        Args: { p_table_name?: string; p_target_date?: string }
        Returns: string
      }
      create_next_tph_partition: { Args: never; Returns: undefined }
      db_stats: {
        Args: never
        Returns: {
          n_projects: number
          total_claimants: number
          total_eligible: number
          total_sybils: number
        }[]
      }
      decrement_bookmark_count: {
        Args: { post_id: string }
        Returns: {
          bookmark_count: number
        }[]
      }
      decrement_comment_count: {
        Args: { post_id: string }
        Returns: {
          comment_count: number
        }[]
      }
      decrement_comment_like_count: {
        Args: { p_comment_id: string }
        Returns: number
      }
      decrement_like_count: {
        Args: { post_id: string }
        Returns: {
          like_count: number
        }[]
      }
      decrement_member_count: {
        Args: { group_id: string }
        Returns: {
          member_count: number
        }[]
      }
      ensure_default_bookmark_folder: {
        Args: { p_user_id: string }
        Returns: string
      }
      ensure_default_collections: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      ensure_future_partitions: {
        Args: { p_months_ahead?: number }
        Returns: string[]
      }
      exec_sql: { Args: { sql: string }; Returns: undefined }
      expire_group_subscriptions: { Args: never; Returns: number }
      expire_trader_flags: { Args: never; Returns: undefined }
      fill_null_pnl_from_siblings: { Args: never; Returns: number }
      fix_snapshot_violations: {
        Args: { batch_size?: number }
        Returns: {
          fixed: number
          issue: string
        }[]
      }
      generate_share_token: { Args: never; Returns: string }
      get_author_weight: { Args: { p_author_id: string }; Returns: number }
      get_content_quality_score: {
        Args: { p_content: string; p_images: Json; p_poll_id: string }
        Returns: number
      }
      get_distinct_sources:
        | {
            Args: never
            Returns: {
              count: number
              latest_captured_at: string
              source: string
            }[]
          }
        | {
            Args: { p_season_id: string }
            Returns: {
              source: string
            }[]
          }
      get_diverse_leaderboard: {
        Args: {
          p_per_platform?: number
          p_season_id?: string
          p_total_limit?: number
        }
        Returns: {
          arena_score: number | null
          avatar_url: string | null
          avg_holding_hours: number | null
          calmar_ratio: number | null
          computed_at: string
          copiers: number | null
          execution_score: number | null
          followers: number | null
          handle: string | null
          id: number
          is_new: boolean | null
          is_outlier: boolean | null
          max_drawdown: number | null
          metrics_estimated: boolean | null
          pnl: number | null
          profit_factor: number | null
          profitability_score: number | null
          rank: number
          rank_change: number | null
          risk_control_score: number | null
          roi: number | null
          score_completeness: string | null
          season_id: string
          sharpe_ratio: number | null
          sortino_ratio: number | null
          source: string
          source_trader_id: string
          source_type: string
          style_confidence: number | null
          trader_type: string | null
          trades_count: number | null
          trading_style: string | null
          win_rate: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "leaderboard_ranks"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_dm_count_before_reply: {
        Args: { receiver: string; sender: string }
        Returns: number
      }
      get_following_feed: {
        Args: { p_limit?: number; p_offset?: number; p_user_id: string }
        Returns: {
          author_arena_score: number | null
          author_avatar_url: string | null
          author_handle: string | null
          author_id: string
          author_is_verified: boolean | null
          bookmark_count: number | null
          click_count: number | null
          comment_count: number | null
          comments_last_hour: number | null
          content: string
          content_warning: string | null
          created_at: string
          delete_reason: string | null
          deleted_at: string | null
          deleted_by: string | null
          dislike_count: number | null
          group_id: string | null
          hashtags: string[] | null
          hot_score: number | null
          id: string
          images: string[] | null
          impression_count: number | null
          is_pinned: boolean | null
          is_sensitive: boolean | null
          language: string | null
          last_hot_refresh_at: string | null
          like_count: number | null
          likes_last_hour: number | null
          links: Json | null
          locked_reason: string | null
          mentions: string[] | null
          original_post_id: string | null
          poll_bear: number | null
          poll_bull: number | null
          poll_enabled: boolean | null
          poll_id: string | null
          poll_wait: number | null
          report_count: number | null
          repost_count: number | null
          search_hit_count: number | null
          status: Database["public"]["Enums"]["post_status"]
          title: string
          updated_at: string
          velocity_updated_at: string | null
          view_count: number | null
          visibility: string
        }[]
        SetofOptions: {
          from: "*"
          to: "posts"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_hero_stats: {
        Args: never
        Returns: {
          exchange_count: number
          trader_count: number
        }[]
      }
      get_latest_funding_rates: {
        Args: never
        Returns: {
          funding_rate: number
          funding_time: string
          platform: string
          symbol: string
        }[]
      }
      get_latest_open_interest: {
        Args: never
        Returns: {
          open_interest_contracts: number
          open_interest_usd: number
          platform: string
          symbol: string
          timestamp: string
        }[]
      }
      get_latest_prev_snapshots: {
        Args: { before_date: string; target_platforms: string[] }
        Returns: {
          date: string
          platform: string
          pnl: number
          roi: number
          trader_key: string
        }[]
      }
      get_latest_snapshots_for_date: {
        Args: { target_date: string }
        Returns: {
          followers: number
          max_drawdown: number
          pnl: number
          roi: number
          source: string
          source_trader_id: string
          trades_count: number
          win_rate: number
        }[]
      }
      get_latest_timestamps_by_source: {
        Args: { p_season_id?: string }
        Returns: {
          captured_at: string
          source: string
        }[]
      }
      get_leaderboard_category_counts: {
        Args: { p_season_id: string }
        Returns: {
          count: number
          source_type: string
        }[]
      }
      get_leaderboard_latest_by_source: {
        Args: never
        Returns: {
          computed_at: string
          source: string
        }[]
      }
      get_library_category_counts: {
        Args: never
        Returns: {
          category: string
          count: number
        }[]
      }
      get_monitoring_freshness_summary: {
        Args: never
        Returns: {
          last_update: string
          max_drawdown_count: number
          roi_count: number
          source: string
          total: number
          win_rate_count: number
        }[]
      }
      get_next_refresh_time: {
        Args: { base_time?: string; tier: string }
        Returns: string
      }
      get_or_create_conversation: {
        Args: { user_a: string; user_b: string }
        Returns: string
      }
      get_pending_critical_anomalies_count: { Args: never; Returns: number }
      get_personalized_feed: {
        Args: { p_limit?: number; p_offset?: number; p_user_id: string }
        Returns: {
          final_score: number
          post_id: string
        }[]
      }
      get_pipeline_job_stats_recent: {
        Args: never
        Returns: {
          avg_duration_ms: number
          error_count: number
          job_name: string
          last_run_at: string
          success_count: number
          success_rate: number
          total_runs: number
        }[]
      }
      get_pipeline_job_statuses_recent: {
        Args: never
        Returns: {
          error_message: string
          health_status: string
          job_name: string
          records_processed: number
          started_at: string
          status: string
        }[]
      }
      get_platform_stats: {
        Args: { p_season_id?: string }
        Returns: {
          avg_roi: number
          avg_score: number
          avg_win_rate: number
          median_score: number
          platform: string
          trader_count: number
        }[]
      }
      get_post_penalty: {
        Args: {
          p_dislike_count: number
          p_like_count: number
          p_report_count: number
        }
        Returns: number
      }
      get_related_groups: {
        Args: { p_group_id: string; p_limit?: number }
        Returns: {
          avatar_url: string
          id: string
          member_count: number
          name: string
          name_en: string
        }[]
      }
      get_time_decay: { Args: { p_hours: number }; Returns: number }
      get_trader_tracked_since: {
        Args: { p_source: string; p_source_trader_id: string }
        Returns: string
      }
      get_translations_batch: {
        Args: {
          p_content_ids: string[]
          p_content_type: string
          p_target_lang: string
        }
        Returns: {
          content_id: string
          translated_text: string
        }[]
      }
      has_valid_group_subscription: {
        Args: { p_group_id: string; p_user_id: string }
        Returns: boolean
      }
      http: {
        Args: { request: Database["public"]["CompositeTypes"]["http_request"] }
        Returns: Database["public"]["CompositeTypes"]["http_response"]
        SetofOptions: {
          from: "http_request"
          to: "http_response"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_delete:
        | {
            Args: { uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: { content: string; content_type: string; uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      http_get:
        | {
            Args: { uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: { data: Json; uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      http_head: {
        Args: { uri: string }
        Returns: Database["public"]["CompositeTypes"]["http_response"]
        SetofOptions: {
          from: "*"
          to: "http_response"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_header: {
        Args: { field: string; value: string }
        Returns: Database["public"]["CompositeTypes"]["http_header"]
        SetofOptions: {
          from: "*"
          to: "http_header"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_list_curlopt: {
        Args: never
        Returns: {
          curlopt: string
          value: string
        }[]
      }
      http_patch: {
        Args: { content: string; content_type: string; uri: string }
        Returns: Database["public"]["CompositeTypes"]["http_response"]
        SetofOptions: {
          from: "*"
          to: "http_response"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_post:
        | {
            Args: { content: string; content_type: string; uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: { data: Json; uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      http_put: {
        Args: { content: string; content_type: string; uri: string }
        Returns: Database["public"]["CompositeTypes"]["http_response"]
        SetofOptions: {
          from: "*"
          to: "http_response"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_reset_curlopt: { Args: never; Returns: boolean }
      http_set_curlopt: {
        Args: { curlopt: string; value: string }
        Returns: boolean
      }
      increment_bookmark_count: {
        Args: { post_id: string }
        Returns: {
          bookmark_count: number
        }[]
      }
      increment_comment_count: {
        Args: { post_id: string }
        Returns: {
          comment_count: number
        }[]
      }
      increment_comment_like_count: {
        Args: { p_comment_id: string }
        Returns: number
      }
      increment_like_count: {
        Args: { post_id: string }
        Returns: {
          like_count: number
        }[]
      }
      increment_member_count:
        | {
            Args: { group_id: string }
            Returns: {
              member_count: number
            }[]
          }
        | { Args: { p_delta?: number; p_group_id: string }; Returns: undefined }
      increment_snapshot_view_count: {
        Args: { snapshot_share_token: string }
        Returns: undefined
      }
      increment_view_count: { Args: { post_id: string }; Returns: undefined }
      is_group_admin: { Args: { gid: string; uid: string }; Returns: boolean }
      library_items_by_lang: {
        Args: {
          p_category?: string
          p_limit?: number
          p_offset?: number
          p_preferred_lang?: string
        }
        Returns: {
          ai_summary: string | null
          author: string | null
          buy_url: string | null
          category: string
          content_url: string | null
          cover_url: string | null
          created_at: string | null
          crypto_symbols: string[] | null
          description: string | null
          doi: string | null
          download_count: number | null
          epub_url: string | null
          file_key: string | null
          file_size_bytes: number | null
          id: string
          is_free: boolean | null
          isbn: string | null
          language: string | null
          language_group_id: string | null
          page_count: number | null
          pdf_url: string | null
          publish_date: string | null
          publisher: string | null
          rating: number | null
          rating_count: number | null
          source: string | null
          source_url: string | null
          subcategory: string | null
          tags: string[] | null
          title: string
          title_en: string | null
          title_zh: string | null
          updated_at: string | null
          view_count: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "library_items"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      migrate_position_history_batch: {
        Args: { batch_size?: number }
        Returns: number
      }
      project_stats: {
        Args: never
        Returns: {
          bt_t: number
          bw_t: number
          hf_t: number
          ma_t: number
          project: string
          rate: number
          rf_t: number
          sybils: number
          total: number
        }[]
      }
      recalculate_all_user_weights: {
        Args: never
        Returns: {
          new_weight: number
          old_weight: number
          user_id: string
        }[]
      }
      recommend_by_collaborative_filtering: {
        Args: { p_limit?: number; p_target_type?: string; p_user_id: string }
        Returns: {
          score: number
          target_id: string
        }[]
      }
      recommend_groups_for_user: {
        Args: { p_limit?: number; p_user_id: string }
        Returns: {
          group_id: string
          group_name: string
          reason: string
          score: number
        }[]
      }
      refresh_hot_scores: { Args: never; Returns: undefined }
      refresh_hot_scores_incremental: { Args: never; Returns: number }
      refresh_leaderboard_count_cache: { Args: never; Returns: undefined }
      refresh_materialized_views: { Args: never; Returns: undefined }
      release_stale_locks: { Args: never; Returns: number }
      reset_daily_api_calls: { Args: never; Returns: undefined }
      reset_monthly_usage: { Args: never; Returns: undefined }
      safe_log1p: { Args: { x: number }; Returns: number }
      scan_data_quality_anomalies: {
        Args: never
        Returns: {
          anomaly_type: string
          count: number
          detail: string
          platform: string
          severity: string
        }[]
      }
      search_did_you_mean: {
        Args: { search_query: string; suggestion_limit?: number }
        Returns: {
          similarity_score: number
          suggested_query: string
        }[]
      }
      search_posts_with_weight: {
        Args: {
          result_limit?: number
          result_offset?: number
          search_query: string
          weight_factor?: number
        }
        Returns: {
          author_handle: string
          author_id: string
          author_weight: number
          bookmark_count: number
          comment_count: number
          content: string
          created_at: string
          dislike_count: number
          group_id: string
          group_name: string
          group_name_en: string
          hot_score: number
          id: string
          images: string[]
          is_pinned: boolean
          like_count: number
          original_post_id: string
          poll_bear: number
          poll_bull: number
          poll_enabled: boolean
          poll_id: string
          poll_wait: number
          repost_count: number
          title: string
          updated_at: string
          view_count: number
          weighted_score: number
        }[]
      }
      search_traders_fuzzy: {
        Args: {
          platform_filter?: string
          result_limit?: number
          search_query: string
        }
        Returns: {
          arena_score: number
          avatar_url: string
          handle: string
          pnl: number
          rank: number
          relevance_score: number
          roi: number
          source: string
          source_trader_id: string
          trader_type: string
        }[]
      }
      text_to_bytea: { Args: { data: string }; Returns: string }
      trunc_hour: { Args: { ts: string }; Returns: string }
      update_post_velocity: { Args: never; Returns: number }
      update_subscription_and_profile: {
        Args: {
          p_cancel_at_period_end?: boolean
          p_period_end: string
          p_period_start: string
          p_plan: string
          p_status: string
          p_stripe_customer_id: string
          p_stripe_sub_id: string
          p_tier: string
          p_user_id: string
        }
        Returns: undefined
      }
      urlencode:
        | { Args: { data: Json }; Returns: string }
        | {
            Args: { string: string }
            Returns: {
              error: true
            } & "Could not choose the best candidate function between: public.urlencode(string => bytea), public.urlencode(string => varchar). Try renaming the parameters or the function itself in the database so function overloading can be resolved"
          }
        | {
            Args: { string: string }
            Returns: {
              error: true
            } & "Could not choose the best candidate function between: public.urlencode(string => bytea), public.urlencode(string => varchar). Try renaming the parameters or the function itself in the database so function overloading can be resolved"
          }
      verify_group_member_counts: {
        Args: never
        Returns: {
          actual_count: number
          group_id: string
          group_name: string
          is_consistent: boolean
          stored_count: number
        }[]
      }
      wilson_score_lower: {
        Args: { downs: number; ups: number }
        Returns: number
      }
    }
    Enums: {
      gift_asset: "fiat" | "token"
      group_visibility: "open" | "apply"
      member_role: "owner" | "admin" | "member"
      post_status: "active" | "locked" | "deleted"
      report_reason: "spam" | "scam" | "harassment" | "illegal" | "other"
    }
    CompositeTypes: {
      http_header: {
        field: string | null
        value: string | null
      }
      http_request: {
        method: unknown
        uri: string | null
        headers: Database["public"]["CompositeTypes"]["http_header"][] | null
        content_type: string | null
        content: string | null
      }
      http_response: {
        status: number | null
        content_type: string | null
        headers: Database["public"]["CompositeTypes"]["http_header"][] | null
        content: string | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      gift_asset: ["fiat", "token"],
      group_visibility: ["open", "apply"],
      member_role: ["owner", "admin", "member"],
      post_status: ["active", "locked", "deleted"],
      report_reason: ["spam", "scam", "harassment", "illegal", "other"],
    },
  },
} as const

