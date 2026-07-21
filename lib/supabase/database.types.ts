// AUTO-GENERATED from production schema via scripts/gen-types.sh — DO NOT EDIT BY HAND.
// Regenerate: npm run gen:types   |   Drift gate: CI 'gen-types-check' job.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '14.5'
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
      account_recovery_tokens: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          token_hash: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          token_hash: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          token_hash?: string
          used_at?: string | null
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
            foreignKeyName: 'advanced_alert_conditions_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'advanced_alert_conditions_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'advanced_alert_conditions_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
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
          delivery_id: string | null
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
          delivery_id?: string | null
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
          delivery_id?: string | null
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
            foreignKeyName: 'alert_history_alert_id_fkey'
            columns: ['alert_id']
            isOneToOne: false
            referencedRelation: 'trader_alerts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'alert_history_condition_id_fkey'
            columns: ['condition_id']
            isOneToOne: false
            referencedRelation: 'advanced_alert_conditions'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'alert_history_delivery_id_fkey'
            columns: ['delivery_id']
            isOneToOne: false
            referencedRelation: 'trader_alert_deliveries'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'alert_history_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'alert_history_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'alert_history_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
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
      api_key_usage_daily: {
        Row: {
          api_key_id: string
          date: string
          id: string
          request_count: number
        }
        Insert: {
          api_key_id: string
          date: string
          id?: string
          request_count?: number
        }
        Update: {
          api_key_id?: string
          date?: string
          id?: string
          request_count?: number
        }
        Relationships: [
          {
            foreignKeyName: 'api_key_usage_daily_api_key_id_fkey'
            columns: ['api_key_id']
            isOneToOne: false
            referencedRelation: 'api_keys'
            referencedColumns: ['id']
          },
        ]
      }
      api_keys: {
        Row: {
          active: boolean
          created_at: string
          daily_limit: number
          id: string
          key: string
          last_used_at: string | null
          name: string
          request_count_today: number
          revoked_at: string | null
          tier: string
          user_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          daily_limit?: number
          id?: string
          key: string
          last_used_at?: string | null
          name?: string
          request_count_today?: number
          revoked_at?: string | null
          tier?: string
          user_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          daily_limit?: number
          id?: string
          key?: string
          last_used_at?: string | null
          name?: string
          request_count_today?: number
          revoked_at?: string | null
          tier?: string
          user_id?: string
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
            foreignKeyName: 'authorization_sync_logs_authorization_id_fkey'
            columns: ['authorization_id']
            isOneToOne: false
            referencedRelation: 'trader_authorizations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'authorization_sync_logs_authorization_id_fkey'
            columns: ['authorization_id']
            isOneToOne: false
            referencedRelation: 'verified_data_authorizations'
            referencedColumns: ['authorization_id']
          },
        ]
      }
      avoid_votes: {
        Row: {
          created_at: string
          follow_duration_days: number | null
          id: string
          loss_amount: number | null
          loss_percent: number | null
          reason: string | null
          reason_type: string | null
          screenshot_url: string | null
          source: string
          status: string
          trader_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          follow_duration_days?: number | null
          id?: string
          loss_amount?: number | null
          loss_percent?: number | null
          reason?: string | null
          reason_type?: string | null
          screenshot_url?: string | null
          source: string
          status?: string
          trader_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          follow_duration_days?: number | null
          id?: string
          loss_amount?: number | null
          loss_percent?: number | null
          reason?: string | null
          reason_type?: string | null
          screenshot_url?: string | null
          source?: string
          status?: string
          trader_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
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
            foreignKeyName: 'channel_members_channel_id_fkey'
            columns: ['channel_id']
            isOneToOne: false
            referencedRelation: 'chat_channels'
            referencedColumns: ['id']
          },
        ]
      }
      channel_message_reactions: {
        Row: {
          created_at: string | null
          emoji: string
          id: string
          message_id: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          emoji: string
          id?: string
          message_id: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          emoji?: string
          id?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'channel_message_reactions_message_id_fkey'
            columns: ['message_id']
            isOneToOne: false
            referencedRelation: 'channel_messages'
            referencedColumns: ['id']
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
            foreignKeyName: 'channel_message_reads_channel_id_fkey'
            columns: ['channel_id']
            isOneToOne: false
            referencedRelation: 'chat_channels'
            referencedColumns: ['id']
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
          reply_to_id: string | null
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
          reply_to_id?: string | null
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
          reply_to_id?: string | null
          sender_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'channel_messages_channel_id_fkey'
            columns: ['channel_id']
            isOneToOne: false
            referencedRelation: 'chat_channels'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'channel_messages_reply_to_id_fkey'
            columns: ['reply_to_id']
            isOneToOne: false
            referencedRelation: 'channel_messages'
            referencedColumns: ['id']
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
            foreignKeyName: 'chat_channels_conversation_id_fkey'
            columns: ['conversation_id']
            isOneToOne: false
            referencedRelation: 'conversations'
            referencedColumns: ['id']
          },
        ]
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
            foreignKeyName: 'collection_items_collection_id_fkey'
            columns: ['collection_id']
            isOneToOne: false
            referencedRelation: 'user_collections'
            referencedColumns: ['id']
          },
        ]
      }
      comment_likes: {
        Row: {
          comment_id: string
          created_at: string | null
          id: string
          reaction_type: string
          user_id: string
        }
        Insert: {
          comment_id: string
          created_at?: string | null
          id?: string
          reaction_type?: string
          user_id: string
        }
        Update: {
          comment_id?: string
          created_at?: string | null
          id?: string
          reaction_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'comment_likes_comment_id_fkey'
            columns: ['comment_id']
            isOneToOne: false
            referencedRelation: 'comments'
            referencedColumns: ['id']
          },
        ]
      }
      comments: {
        Row: {
          author_handle: string | null
          author_id: string | null
          content: string
          created_at: string | null
          delete_reason: string | null
          deleted_at: string | null
          deleted_by: string | null
          dislike_count: number
          id: string
          like_count: number
          parent_id: string | null
          post_id: string
          ranking_score: number
          updated_at: string | null
          user_id: string
        }
        Insert: {
          author_handle?: string | null
          author_id?: string | null
          content: string
          created_at?: string | null
          delete_reason?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          dislike_count?: number
          id?: string
          like_count?: number
          parent_id?: string | null
          post_id: string
          ranking_score?: number
          updated_at?: string | null
          user_id: string
        }
        Update: {
          author_handle?: string | null
          author_id?: string | null
          content?: string
          created_at?: string | null
          delete_reason?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          dislike_count?: number
          id?: string
          like_count?: number
          parent_id?: string | null
          post_id?: string
          ranking_score?: number
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'comments_parent_id_fkey'
            columns: ['parent_id']
            isOneToOne: false
            referencedRelation: 'comments'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'comments_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
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
          images: string[]
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
          images: string[]
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
          images?: string[]
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
            foreignKeyName: 'conversation_members_conversation_id_fkey'
            columns: ['conversation_id']
            isOneToOne: false
            referencedRelation: 'conversations'
            referencedColumns: ['id']
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
            foreignKeyName: 'copy_trade_logs_config_id_fkey'
            columns: ['config_id']
            isOneToOne: false
            referencedRelation: 'copy_trade_configs'
            referencedColumns: ['id']
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
          reply_to_id: string | null
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
          reply_to_id?: string | null
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
          reply_to_id?: string | null
          sender_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'direct_messages_conversation_id_fkey'
            columns: ['conversation_id']
            isOneToOne: false
            referencedRelation: 'conversations'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'direct_messages_reply_to_id_fkey'
            columns: ['reply_to_id']
            isOneToOne: false
            referencedRelation: 'direct_messages'
            referencedColumns: ['id']
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
          content_en: string | null
          content_ja: string | null
          content_ko: string | null
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
          title_ja: string | null
          title_ko: string | null
          title_zh: string | null
        }
        Insert: {
          category?: string | null
          content?: string | null
          content_en?: string | null
          content_ja?: string | null
          content_ko?: string | null
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
          title_ja?: string | null
          title_ko?: string | null
          title_zh?: string | null
        }
        Update: {
          category?: string | null
          content?: string | null
          content_en?: string | null
          content_ja?: string | null
          content_ko?: string | null
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
          title_ja?: string | null
          title_ko?: string | null
          title_zh?: string | null
        }
        Relationships: []
      }
      folder_subscriptions: {
        Row: {
          created_at: string
          folder_id: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          folder_id: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          folder_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'folder_subscriptions_folder_id_fkey'
            columns: ['folder_id']
            isOneToOne: false
            referencedRelation: 'bookmark_folders'
            referencedColumns: ['id']
          },
        ]
      }
      follows: {
        Row: {
          created_at: string | null
          trader_id: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          trader_id: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          trader_id?: string
          user_id?: string
        }
        Relationships: []
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
          asset: Database['public']['Enums']['gift_asset']
          created_at: string
          from_user_id: string
          group_id: string
          id: string
          post_id: string
          to_user_id: string | null
        }
        Insert: {
          amount: number
          asset?: Database['public']['Enums']['gift_asset']
          created_at?: string
          from_user_id?: string
          group_id: string
          id?: string
          post_id: string
          to_user_id?: string | null
        }
        Update: {
          amount?: number
          asset?: Database['public']['Enums']['gift_asset']
          created_at?: string
          from_user_id?: string
          group_id?: string
          id?: string
          post_id?: string
          to_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'gifts_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'gifts_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'gifts_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
          },
        ]
      }
      group_application_operation_results: {
        Row: {
          actor_id: string
          created_at: string
          intent_fingerprint: string
          operation_id: string
          operation_kind: string
          result: Json
        }
        Insert: {
          actor_id: string
          created_at?: string
          intent_fingerprint: string
          operation_id: string
          operation_kind: string
          result: Json
        }
        Update: {
          actor_id?: string
          created_at?: string
          intent_fingerprint?: string
          operation_id?: string
          operation_kind?: string
          result?: Json
        }
        Relationships: []
      }
      group_applications: {
        Row: {
          applicant_id: string
          avatar_url: string | null
          created_at: string | null
          description: string | null
          description_en: string | null
          group_id: string | null
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
          group_id?: string | null
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
          group_id?: string | null
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
        Relationships: [
          {
            foreignKeyName: 'group_applications_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'group_applications_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
        ]
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
            foreignKeyName: 'group_audit_log_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'group_audit_log_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
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
            foreignKeyName: 'group_bans_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'group_bans_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
        ]
      }
      group_edit_application_operation_results: {
        Row: {
          actor_id: string
          created_at: string
          intent_fingerprint: string
          operation_id: string
          operation_kind: string
          result: Json
        }
        Insert: {
          actor_id: string
          created_at?: string
          intent_fingerprint: string
          operation_id: string
          operation_kind: string
          result: Json
        }
        Update: {
          actor_id?: string
          created_at?: string
          intent_fingerprint?: string
          operation_id?: string
          operation_kind?: string
          result?: Json
        }
        Relationships: []
      }
      group_edit_applications: {
        Row: {
          applicant_id: string
          avatar_url: string | null
          created_at: string
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
          created_at?: string
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
          created_at?: string
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
            foreignKeyName: 'group_edit_applications_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'group_edit_applications_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
        ]
      }
      group_invite_redemptions: {
        Row: {
          group_id: string
          invite_id: string
          redeemed_at: string
          user_id: string
        }
        Insert: {
          group_id: string
          invite_id: string
          redeemed_at?: string
          user_id: string
        }
        Update: {
          group_id?: string
          invite_id?: string
          redeemed_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'group_invite_redemptions_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'group_invite_redemptions_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'group_invite_redemptions_invite_id_fkey'
            columns: ['invite_id']
            isOneToOne: false
            referencedRelation: 'group_invites'
            referencedColumns: ['id']
          },
        ]
      }
      group_invites: {
        Row: {
          created_at: string | null
          created_by: string | null
          expires_at: string
          group_id: string
          id: string
          max_uses: number
          revoked_at: string | null
          revoked_by: string | null
          token_hash: string
          used_count: number
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          expires_at: string
          group_id: string
          id?: string
          max_uses?: number
          revoked_at?: string | null
          revoked_by?: string | null
          token_hash: string
          used_count?: number
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          expires_at?: string
          group_id?: string
          id?: string
          max_uses?: number
          revoked_at?: string | null
          revoked_by?: string | null
          token_hash?: string
          used_count?: number
        }
        Relationships: [
          {
            foreignKeyName: 'group_invites_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'group_invites_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
        ]
      }
      group_join_requests: {
        Row: {
          answer_text: string
          consumed_at: string | null
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
          consumed_at?: string | null
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
          consumed_at?: string | null
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
            foreignKeyName: 'group_join_requests_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'group_join_requests_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
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
          pinned: boolean
          role: Database['public']['Enums']['member_role']
          self_notify_muted: boolean
          user_id: string
        }
        Insert: {
          group_id: string
          joined_at?: string
          mute_reason?: string | null
          muted_by?: string | null
          muted_until?: string | null
          notifications_muted?: boolean | null
          pinned?: boolean
          role?: Database['public']['Enums']['member_role']
          self_notify_muted?: boolean
          user_id?: string
        }
        Update: {
          group_id?: string
          joined_at?: string
          mute_reason?: string | null
          muted_by?: string | null
          muted_until?: string | null
          notifications_muted?: boolean | null
          pinned?: boolean
          role?: Database['public']['Enums']['member_role']
          self_notify_muted?: boolean
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'group_members_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'group_members_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
        ]
      }
      group_mute_operations: {
        Row: {
          action: string
          actor_id: string
          audit_log_id: string | null
          created_at: string
          evidence_action: string
          evidence_actor_id: string
          evidence_audit_id: string
          evidence_details: Json
          evidence_kind: string
          evidence_operation_id: string | null
          group_id: string
          initial_applied: boolean
          muted_until: string | null
          operation_id: string
          previous_muted_by: string | null
          previous_muted_until: string | null
          previous_reason: string | null
          reason: string | null
          result_group_name: string
          result_muted_by: string | null
          result_muted_until: string | null
          result_reason: string | null
          sequence_id: number
          target_id: string
        }
        Insert: {
          action: string
          actor_id: string
          audit_log_id?: string | null
          created_at?: string
          evidence_action: string
          evidence_actor_id: string
          evidence_audit_id: string
          evidence_details: Json
          evidence_kind: string
          evidence_operation_id?: string | null
          group_id: string
          initial_applied: boolean
          muted_until?: string | null
          operation_id: string
          previous_muted_by?: string | null
          previous_muted_until?: string | null
          previous_reason?: string | null
          reason?: string | null
          result_group_name: string
          result_muted_by?: string | null
          result_muted_until?: string | null
          result_reason?: string | null
          sequence_id?: never
          target_id: string
        }
        Update: {
          action?: string
          actor_id?: string
          audit_log_id?: string | null
          created_at?: string
          evidence_action?: string
          evidence_actor_id?: string
          evidence_audit_id?: string
          evidence_details?: Json
          evidence_kind?: string
          evidence_operation_id?: string | null
          group_id?: string
          initial_applied?: boolean
          muted_until?: string | null
          operation_id?: string
          previous_muted_by?: string | null
          previous_muted_until?: string | null
          previous_reason?: string | null
          reason?: string | null
          result_group_name?: string
          result_muted_by?: string | null
          result_muted_until?: string | null
          result_reason?: string | null
          sequence_id?: never
          target_id?: string
        }
        Relationships: []
      }
      group_pass_refund_revocation_acks: {
        Row: {
          acknowledged_at: string
          amount_paid: number
          id: string
          membership_action: string
          ownership_id: string
          payment_member_joined_at: string | null
          refund_snapshot_event_created_at: string
          refund_snapshot_event_id: string
          refund_succeeded_amount: number
          revocation_action_reference: string
          stripe_charge_id: string
          subscription_action: string
          subscription_expires_at_after: string | null
          subscription_expires_at_before: string | null
          subscription_id: string
          subscription_status_after: string | null
          subscription_status_before: string | null
        }
        Insert: {
          acknowledged_at?: string
          amount_paid: number
          id?: string
          membership_action: string
          ownership_id: string
          payment_member_joined_at?: string | null
          refund_snapshot_event_created_at: string
          refund_snapshot_event_id: string
          refund_succeeded_amount: number
          revocation_action_reference: string
          stripe_charge_id: string
          subscription_action: string
          subscription_expires_at_after?: string | null
          subscription_expires_at_before?: string | null
          subscription_id: string
          subscription_status_after?: string | null
          subscription_status_before?: string | null
        }
        Update: {
          acknowledged_at?: string
          amount_paid?: number
          id?: string
          membership_action?: string
          ownership_id?: string
          payment_member_joined_at?: string | null
          refund_snapshot_event_created_at?: string
          refund_snapshot_event_id?: string
          refund_succeeded_amount?: number
          revocation_action_reference?: string
          stripe_charge_id?: string
          subscription_action?: string
          subscription_expires_at_after?: string | null
          subscription_expires_at_before?: string | null
          subscription_id?: string
          subscription_status_after?: string | null
          subscription_status_before?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'group_pass_refund_revocation_acks_ownership_id_fkey'
            columns: ['ownership_id']
            isOneToOne: false
            referencedRelation: 'stripe_payment_ownerships'
            referencedColumns: ['id']
          },
        ]
      }
      group_payment_consumptions: {
        Row: {
          amount_cents: number
          checkout_session_id: string | null
          consumed_at: string
          currency: string
          group_id: string
          id: string
          outcome: string
          payment_intent_id: string
          payment_member_joined_at: string | null
          provider: string
          result: Json
          stripe_charge_id: string | null
          stripe_customer_id: string | null
          subscription_id: string
          tier: string
          user_id: string
        }
        Insert: {
          amount_cents: number
          checkout_session_id?: string | null
          consumed_at?: string
          currency: string
          group_id: string
          id?: string
          outcome: string
          payment_intent_id: string
          payment_member_joined_at?: string | null
          provider: string
          result: Json
          stripe_charge_id?: string | null
          stripe_customer_id?: string | null
          subscription_id: string
          tier: string
          user_id: string
        }
        Update: {
          amount_cents?: number
          checkout_session_id?: string | null
          consumed_at?: string
          currency?: string
          group_id?: string
          id?: string
          outcome?: string
          payment_intent_id?: string
          payment_member_joined_at?: string | null
          provider?: string
          result?: Json
          stripe_charge_id?: string | null
          stripe_customer_id?: string | null
          subscription_id?: string
          tier?: string
          user_id?: string
        }
        Relationships: []
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
            foreignKeyName: 'group_rules_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'group_rules_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
        ]
      }
      group_subscriptions: {
        Row: {
          cancel_at_period_end: boolean
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
          cancel_at_period_end?: boolean
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
          cancel_at_period_end?: boolean
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
            foreignKeyName: 'group_subscriptions_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'group_subscriptions_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
        ]
      }
      group_trial_consumptions: {
        Row: {
          consumed_at: string
          group_id: string
          subscription_id: string
          user_id: string
        }
        Insert: {
          consumed_at?: string
          group_id: string
          subscription_id: string
          user_id: string
        }
        Update: {
          consumed_at?: string
          group_id?: string
          subscription_id?: string
          user_id?: string
        }
        Relationships: []
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
          member_count: number
          min_arena_score: number | null
          name: string
          name_en: string | null
          original_price_monthly: number | null
          original_price_yearly: number | null
          role_names: Json | null
          rules: string | null
          rules_json: Json | null
          rules_text: string | null
          slug: string | null
          subscription_price_monthly: number | null
          subscription_price_yearly: number | null
          trial_days: number | null
          updated_at: string
          visibility: Database['public']['Enums']['group_visibility']
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
          member_count?: number
          min_arena_score?: number | null
          name: string
          name_en?: string | null
          original_price_monthly?: number | null
          original_price_yearly?: number | null
          role_names?: Json | null
          rules?: string | null
          rules_json?: Json | null
          rules_text?: string | null
          slug?: string | null
          subscription_price_monthly?: number | null
          subscription_price_yearly?: number | null
          trial_days?: number | null
          updated_at?: string
          visibility?: Database['public']['Enums']['group_visibility']
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
          member_count?: number
          min_arena_score?: number | null
          name?: string
          name_en?: string | null
          original_price_monthly?: number | null
          original_price_yearly?: number | null
          role_names?: Json | null
          rules?: string | null
          rules_json?: Json | null
          rules_text?: string | null
          slug?: string | null
          subscription_price_monthly?: number | null
          subscription_price_yearly?: number | null
          trial_days?: number | null
          updated_at?: string
          visibility?: Database['public']['Enums']['group_visibility']
        }
        Relationships: []
      }
      hashtags: {
        Row: {
          created_at: string | null
          id: string
          post_count: number | null
          tag: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          post_count?: number | null
          tag: string
        }
        Update: {
          created_at?: string | null
          id?: string
          post_count?: number | null
          tag?: string
        }
        Relationships: []
      }
      hot_topics: {
        Row: {
          category: string
          created_at: string | null
          heat_score: number
          id: string
          keyword: string
          keyword_zh: string | null
          mention_count: number
          related_coins: string[] | null
          source: string
          trend: string
          updated_at: string | null
        }
        Insert: {
          category?: string
          created_at?: string | null
          heat_score?: number
          id?: string
          keyword: string
          keyword_zh?: string | null
          mention_count?: number
          related_coins?: string[] | null
          source?: string
          trend?: string
          updated_at?: string | null
        }
        Update: {
          category?: string
          created_at?: string | null
          heat_score?: number
          id?: string
          keyword?: string
          keyword_zh?: string | null
          mention_count?: number
          related_coins?: string[] | null
          source?: string
          trend?: string
          updated_at?: string | null
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
          arena_score_v3: number | null
          arena_score_v4: number | null
          avatar_url: string | null
          avg_holding_hours: number | null
          calmar_ratio: number | null
          computed_at: string | null
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
          rank: number | null
          rank_change: number | null
          risk_control_score: number | null
          roi: number | null
          score_completeness: string | null
          score_factors: Json | null
          season_id: string
          sharpe_ratio: number | null
          sortino_ratio: number | null
          source: string
          source_trader_id: string
          source_type: string | null
          style_confidence: number | null
          trader_type: string | null
          trades_count: number | null
          trading_style: string | null
          win_rate: number | null
        }
        Insert: {
          arena_score?: number | null
          arena_score_v3?: number | null
          arena_score_v4?: number | null
          avatar_url?: string | null
          avg_holding_hours?: number | null
          calmar_ratio?: number | null
          computed_at?: string | null
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
          rank?: number | null
          rank_change?: number | null
          risk_control_score?: number | null
          roi?: number | null
          score_completeness?: string | null
          score_factors?: Json | null
          season_id: string
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          source: string
          source_trader_id: string
          source_type?: string | null
          style_confidence?: number | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          win_rate?: number | null
        }
        Update: {
          arena_score?: number | null
          arena_score_v3?: number | null
          arena_score_v4?: number | null
          avatar_url?: string | null
          avg_holding_hours?: number | null
          calmar_ratio?: number | null
          computed_at?: string | null
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
          rank?: number | null
          rank_change?: number | null
          risk_control_score?: number | null
          roi?: number | null
          score_completeness?: string | null
          score_factors?: Json | null
          season_id?: string
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          source?: string
          source_trader_id?: string
          source_type?: string | null
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
      leaderboard_source_freshness: {
        Row: {
          recorded_at: string
          season_id: string
          source: string
          source_as_of: string
        }
        Insert: {
          recorded_at?: string
          season_id: string
          source: string
          source_as_of: string
        }
        Update: {
          recorded_at?: string
          season_id?: string
          source?: string
          source_as_of?: string
        }
        Relationships: []
      }
      ledger_entries: {
        Row: {
          amount: number
          asset: Database['public']['Enums']['gift_asset']
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
          asset: Database['public']['Enums']['gift_asset']
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
          asset?: Database['public']['Enums']['gift_asset']
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
            foreignKeyName: 'ledger_entries_gift_id_fkey'
            columns: ['gift_id']
            isOneToOne: false
            referencedRelation: 'gifts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'ledger_entries_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'ledger_entries_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'ledger_entries_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
          },
        ]
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
      lr_30d: {
        Row: {
          arena_score: number | null
          arena_score_v3: number | null
          arena_score_v4: number | null
          avatar_url: string | null
          avg_holding_hours: number | null
          calmar_ratio: number | null
          computed_at: string | null
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
          rank: number | null
          rank_change: number | null
          risk_control_score: number | null
          roi: number | null
          score_completeness: string | null
          score_factors: Json | null
          season_id: string
          sharpe_ratio: number | null
          sortino_ratio: number | null
          source: string
          source_trader_id: string
          source_type: string | null
          style_confidence: number | null
          trader_type: string | null
          trades_count: number | null
          trading_style: string | null
          win_rate: number | null
        }
        Insert: {
          arena_score?: number | null
          arena_score_v3?: number | null
          arena_score_v4?: number | null
          avatar_url?: string | null
          avg_holding_hours?: number | null
          calmar_ratio?: number | null
          computed_at?: string | null
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
          rank?: number | null
          rank_change?: number | null
          risk_control_score?: number | null
          roi?: number | null
          score_completeness?: string | null
          score_factors?: Json | null
          season_id: string
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          source: string
          source_trader_id: string
          source_type?: string | null
          style_confidence?: number | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          win_rate?: number | null
        }
        Update: {
          arena_score?: number | null
          arena_score_v3?: number | null
          arena_score_v4?: number | null
          avatar_url?: string | null
          avg_holding_hours?: number | null
          calmar_ratio?: number | null
          computed_at?: string | null
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
          rank?: number | null
          rank_change?: number | null
          risk_control_score?: number | null
          roi?: number | null
          score_completeness?: string | null
          score_factors?: Json | null
          season_id?: string
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          source?: string
          source_trader_id?: string
          source_type?: string | null
          style_confidence?: number | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          win_rate?: number | null
        }
        Relationships: []
      }
      lr_7d: {
        Row: {
          arena_score: number | null
          arena_score_v3: number | null
          arena_score_v4: number | null
          avatar_url: string | null
          avg_holding_hours: number | null
          calmar_ratio: number | null
          computed_at: string | null
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
          rank: number | null
          rank_change: number | null
          risk_control_score: number | null
          roi: number | null
          score_completeness: string | null
          score_factors: Json | null
          season_id: string
          sharpe_ratio: number | null
          sortino_ratio: number | null
          source: string
          source_trader_id: string
          source_type: string | null
          style_confidence: number | null
          trader_type: string | null
          trades_count: number | null
          trading_style: string | null
          win_rate: number | null
        }
        Insert: {
          arena_score?: number | null
          arena_score_v3?: number | null
          arena_score_v4?: number | null
          avatar_url?: string | null
          avg_holding_hours?: number | null
          calmar_ratio?: number | null
          computed_at?: string | null
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
          rank?: number | null
          rank_change?: number | null
          risk_control_score?: number | null
          roi?: number | null
          score_completeness?: string | null
          score_factors?: Json | null
          season_id: string
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          source: string
          source_trader_id: string
          source_type?: string | null
          style_confidence?: number | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          win_rate?: number | null
        }
        Update: {
          arena_score?: number | null
          arena_score_v3?: number | null
          arena_score_v4?: number | null
          avatar_url?: string | null
          avg_holding_hours?: number | null
          calmar_ratio?: number | null
          computed_at?: string | null
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
          rank?: number | null
          rank_change?: number | null
          risk_control_score?: number | null
          roi?: number | null
          score_completeness?: string | null
          score_factors?: Json | null
          season_id?: string
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          source?: string
          source_trader_id?: string
          source_type?: string | null
          style_confidence?: number | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          win_rate?: number | null
        }
        Relationships: []
      }
      lr_90d: {
        Row: {
          arena_score: number | null
          arena_score_v3: number | null
          arena_score_v4: number | null
          avatar_url: string | null
          avg_holding_hours: number | null
          calmar_ratio: number | null
          computed_at: string | null
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
          rank: number | null
          rank_change: number | null
          risk_control_score: number | null
          roi: number | null
          score_completeness: string | null
          score_factors: Json | null
          season_id: string
          sharpe_ratio: number | null
          sortino_ratio: number | null
          source: string
          source_trader_id: string
          source_type: string | null
          style_confidence: number | null
          trader_type: string | null
          trades_count: number | null
          trading_style: string | null
          win_rate: number | null
        }
        Insert: {
          arena_score?: number | null
          arena_score_v3?: number | null
          arena_score_v4?: number | null
          avatar_url?: string | null
          avg_holding_hours?: number | null
          calmar_ratio?: number | null
          computed_at?: string | null
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
          rank?: number | null
          rank_change?: number | null
          risk_control_score?: number | null
          roi?: number | null
          score_completeness?: string | null
          score_factors?: Json | null
          season_id: string
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          source: string
          source_trader_id: string
          source_type?: string | null
          style_confidence?: number | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          win_rate?: number | null
        }
        Update: {
          arena_score?: number | null
          arena_score_v3?: number | null
          arena_score_v4?: number | null
          avatar_url?: string | null
          avg_holding_hours?: number | null
          calmar_ratio?: number | null
          computed_at?: string | null
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
          rank?: number | null
          rank_change?: number | null
          risk_control_score?: number | null
          roi?: number | null
          score_completeness?: string | null
          score_factors?: Json | null
          season_id?: string
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          source?: string
          source_trader_id?: string
          source_type?: string | null
          style_confidence?: number | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          win_rate?: number | null
        }
        Relationships: []
      }
      lr_default: {
        Row: {
          arena_score: number | null
          arena_score_v3: number | null
          arena_score_v4: number | null
          avatar_url: string | null
          avg_holding_hours: number | null
          calmar_ratio: number | null
          computed_at: string | null
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
          rank: number | null
          rank_change: number | null
          risk_control_score: number | null
          roi: number | null
          score_completeness: string | null
          score_factors: Json | null
          season_id: string
          sharpe_ratio: number | null
          sortino_ratio: number | null
          source: string
          source_trader_id: string
          source_type: string | null
          style_confidence: number | null
          trader_type: string | null
          trades_count: number | null
          trading_style: string | null
          win_rate: number | null
        }
        Insert: {
          arena_score?: number | null
          arena_score_v3?: number | null
          arena_score_v4?: number | null
          avatar_url?: string | null
          avg_holding_hours?: number | null
          calmar_ratio?: number | null
          computed_at?: string | null
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
          rank?: number | null
          rank_change?: number | null
          risk_control_score?: number | null
          roi?: number | null
          score_completeness?: string | null
          score_factors?: Json | null
          season_id: string
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          source: string
          source_trader_id: string
          source_type?: string | null
          style_confidence?: number | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          win_rate?: number | null
        }
        Update: {
          arena_score?: number | null
          arena_score_v3?: number | null
          arena_score_v4?: number | null
          avatar_url?: string | null
          avg_holding_hours?: number | null
          calmar_ratio?: number | null
          computed_at?: string | null
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
          rank?: number | null
          rank_change?: number | null
          risk_control_score?: number | null
          roi?: number | null
          score_completeness?: string | null
          score_factors?: Json | null
          season_id?: string
          sharpe_ratio?: number | null
          sortino_ratio?: number | null
          source?: string
          source_trader_id?: string
          source_type?: string | null
          style_confidence?: number | null
          trader_type?: string | null
          trades_count?: number | null
          trading_style?: string | null
          win_rate?: number | null
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
            foreignKeyName: 'manipulation_alert_history_alert_id_fkey'
            columns: ['alert_id']
            isOneToOne: false
            referencedRelation: 'manipulation_alerts'
            referencedColumns: ['id']
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
      message_reactions: {
        Row: {
          created_at: string | null
          emoji: string
          id: string
          message_id: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          emoji: string
          id?: string
          message_id: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          emoji?: string
          id?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'message_reactions_message_id_fkey'
            columns: ['message_id']
            isOneToOne: false
            referencedRelation: 'direct_messages'
            referencedColumns: ['id']
          },
        ]
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
          code_verifier: string | null
          created_at: string | null
          exchange: string
          expires_at: string
          id: string
          state: string
          user_id: string
        }
        Insert: {
          code_verifier?: string | null
          created_at?: string | null
          exchange: string
          expires_at: string
          id?: string
          state: string
          user_id: string
        }
        Update: {
          code_verifier?: string | null
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
      payment_history: {
        Row: {
          amount: number | null
          created_at: string
          currency: string | null
          id: number
          status: string
          stripe_invoice_id: string | null
          stripe_payment_intent_id: string | null
          user_id: string | null
        }
        Insert: {
          amount?: number | null
          created_at?: string
          currency?: string | null
          id?: never
          status: string
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          user_id?: string | null
        }
        Update: {
          amount?: number | null
          created_at?: string
          currency?: string | null
          id?: never
          status?: string
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          user_id?: string | null
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
          last_seen_at: string | null
          metadata: Json | null
          occurrence_count: number
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
          last_seen_at?: string | null
          metadata?: Json | null
          occurrence_count?: number
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
          last_seen_at?: string | null
          metadata?: Json | null
          occurrence_count?: number
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
            foreignKeyName: 'poll_votes_poll_id_fkey'
            columns: ['poll_id']
            isOneToOne: false
            referencedRelation: 'polls'
            referencedColumns: ['id']
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
            foreignKeyName: 'polls_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
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
            foreignKeyName: 'post_bookmarks_folder_id_fkey'
            columns: ['folder_id']
            isOneToOne: false
            referencedRelation: 'bookmark_folders'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'post_bookmarks_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
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
            foreignKeyName: 'post_comments_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'post_comments_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'post_comments_parent_id_fkey'
            columns: ['parent_id']
            isOneToOne: false
            referencedRelation: 'post_comments'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'post_comments_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
          },
        ]
      }
      post_emoji_reactions: {
        Row: {
          created_at: string | null
          emoji: string
          id: string
          post_id: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          emoji: string
          id?: string
          post_id: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          emoji?: string
          id?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'post_emoji_reactions_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
          },
        ]
      }
      post_hashtags: {
        Row: {
          hashtag_id: string
          post_id: string
        }
        Insert: {
          hashtag_id: string
          post_id: string
        }
        Update: {
          hashtag_id?: string
          post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'post_hashtags_hashtag_id_fkey'
            columns: ['hashtag_id']
            isOneToOne: false
            referencedRelation: 'hashtags'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'post_hashtags_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
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
            foreignKeyName: 'post_likes_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
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
            foreignKeyName: 'post_reactions_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
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
            foreignKeyName: 'post_votes_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
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
          status: Database['public']['Enums']['post_status']
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
          status?: Database['public']['Enums']['post_status']
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
          status?: Database['public']['Enums']['post_status']
          title?: string
          updated_at?: string
          velocity_updated_at?: string | null
          view_count?: number | null
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: 'posts_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'posts_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'posts_original_post_id_fkey'
            columns: ['original_post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'posts_poll_id_fkey'
            columns: ['poll_id']
            isOneToOne: false
            referencedRelation: 'polls'
            referencedColumns: ['id']
          },
        ]
      }
      pro_entitlement_grants: {
        Row: {
          created_at: string
          expires_at: string | null
          grant_kind: string
          granted_at: string | null
          granted_days: number | null
          id: string
          metadata: Json
          revoked_at: string | null
          source: string
          source_key: string
          starts_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          grant_kind?: string
          granted_at?: string | null
          granted_days?: number | null
          id?: string
          metadata?: Json
          revoked_at?: string | null
          source: string
          source_key: string
          starts_at: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          grant_kind?: string
          granted_at?: string | null
          granted_days?: number | null
          id?: string
          metadata?: Json
          revoked_at?: string | null
          source?: string
          source_key?: string
          starts_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'pro_entitlement_grants_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'pro_entitlement_grants_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'pro_entitlement_grants_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
          },
        ]
      }
      pro_official_group_members: {
        Row: {
          created_at: string
          id: string
          pro_group_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          pro_group_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          pro_group_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'pro_official_group_members_pro_group_id_fkey'
            columns: ['pro_group_id']
            isOneToOne: false
            referencedRelation: 'pro_official_groups'
            referencedColumns: ['id']
          },
        ]
      }
      pro_official_groups: {
        Row: {
          created_at: string
          current_member_count: number
          group_id: string
          group_number: number
          id: string
          is_active: boolean
        }
        Insert: {
          created_at?: string
          current_member_count?: number
          group_id: string
          group_number: number
          id?: string
          is_active?: boolean
        }
        Update: {
          created_at?: string
          current_member_count?: number
          group_id?: string
          group_number?: number
          id?: string
          is_active?: boolean
        }
        Relationships: [
          {
            foreignKeyName: 'pro_official_groups_group_id_fkey'
            columns: ['group_id']
            isOneToOne: true
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'pro_official_groups_group_id_fkey'
            columns: ['group_id']
            isOneToOne: true
            referencedRelation: 'groups'
            referencedColumns: ['id']
          },
        ]
      }
      product_events: {
        Row: {
          anonymous_id_hash: string | null
          event_id: string
          event_name: string
          id: string
          occurred_at: string
          path: string | null
          properties: Json
          received_at: string
          session_id_hash: string | null
          source: string
          user_id: string | null
        }
        Insert: {
          anonymous_id_hash?: string | null
          event_id: string
          event_name: string
          id?: string
          occurred_at: string
          path?: string | null
          properties?: Json
          received_at?: string
          session_id_hash?: string | null
          source?: string
          user_id?: string | null
        }
        Update: {
          anonymous_id_hash?: string | null
          event_id?: string
          event_name?: string
          id?: string
          occurred_at?: string
          path?: string | null
          properties?: Json
          received_at?: string
          session_id_hash?: string | null
          source?: string
          user_id?: string | null
        }
        Relationships: []
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
      quiz_results: {
        Row: {
          answers: Json | null
          created_at: string | null
          id: string
          language: string | null
          match_percent: number | null
          primary_type: string
          scores: Json | null
          secondary_type: string | null
          session_id: string
          user_id: string | null
        }
        Insert: {
          answers?: Json | null
          created_at?: string | null
          id?: string
          language?: string | null
          match_percent?: number | null
          primary_type: string
          scores?: Json | null
          secondary_type?: string | null
          session_id: string
          user_id?: string | null
        }
        Update: {
          answers?: Json | null
          created_at?: string | null
          id?: string
          language?: string | null
          match_percent?: number | null
          primary_type?: string
          scores?: Json | null
          secondary_type?: string | null
          session_id?: string
          user_id?: string | null
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
            foreignKeyName: 'ranking_snapshots_created_by_fkey'
            columns: ['created_by']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'ranking_snapshots_created_by_fkey'
            columns: ['created_by']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'ranking_snapshots_created_by_fkey'
            columns: ['created_by']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
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
      referral_attributions: {
        Row: {
          created_at: string
          friend_granted: boolean
          id: string
          provider: string | null
          qualified_at: string | null
          referred_id: string
          referrer_id: string
          signup_ip_hash: string | null
        }
        Insert: {
          created_at?: string
          friend_granted?: boolean
          id?: string
          provider?: string | null
          qualified_at?: string | null
          referred_id: string
          referrer_id: string
          signup_ip_hash?: string | null
        }
        Update: {
          created_at?: string
          friend_granted?: boolean
          id?: string
          provider?: string | null
          qualified_at?: string | null
          referred_id?: string
          referrer_id?: string
          signup_ip_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'referral_attributions_referred_id_fkey'
            columns: ['referred_id']
            isOneToOne: true
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'referral_attributions_referred_id_fkey'
            columns: ['referred_id']
            isOneToOne: true
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'referral_attributions_referred_id_fkey'
            columns: ['referred_id']
            isOneToOne: true
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'referral_attributions_referrer_id_fkey'
            columns: ['referrer_id']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'referral_attributions_referrer_id_fkey'
            columns: ['referrer_id']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'referral_attributions_referrer_id_fkey'
            columns: ['referrer_id']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
          },
        ]
      }
      referral_rewards: {
        Row: {
          created_at: string
          granted_days: number | null
          id: string
          referrer_id: string
          reward_type: string
        }
        Insert: {
          created_at?: string
          granted_days?: number | null
          id?: string
          referrer_id: string
          reward_type: string
        }
        Update: {
          created_at?: string
          granted_days?: number | null
          id?: string
          referrer_id?: string
          reward_type?: string
        }
        Relationships: [
          {
            foreignKeyName: 'referral_rewards_referrer_id_fkey'
            columns: ['referrer_id']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'referral_rewards_referrer_id_fkey'
            columns: ['referrer_id']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'referral_rewards_referrer_id_fkey'
            columns: ['referrer_id']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
          },
        ]
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
      report_evidence_uploads: {
        Row: {
          created_at: string
          evidence_ref: string
          expires_at: string
          lease_expires_at: string | null
          lease_token: string | null
          mime_type: string
          object_name: string
          report_id: string | null
          reporter_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          evidence_ref: string
          expires_at: string
          lease_expires_at?: string | null
          lease_token?: string | null
          mime_type: string
          object_name: string
          report_id?: string | null
          reporter_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          evidence_ref?: string
          expires_at?: string
          lease_expires_at?: string | null
          lease_token?: string | null
          mime_type?: string
          object_name?: string
          report_id?: string | null
          reporter_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'report_evidence_uploads_report_id_fkey'
            columns: ['report_id']
            isOneToOne: false
            referencedRelation: 'content_reports'
            referencedColumns: ['id']
          },
        ]
      }
      report_moderation_operations: {
        Row: {
          action: string
          action_taken: string
          actor_id: string
          author_id: string | null
          content_id: string
          content_soft_deleted: boolean | null
          content_type: string
          created_at: string
          initial_applied: boolean
          initial_content_affected_count: number
          initial_strike_id: string | null
          initial_strike_type: string | null
          operation_id: string
          report_count: number
          report_ids: string[]
          report_status: string
        }
        Insert: {
          action: string
          action_taken: string
          actor_id: string
          author_id?: string | null
          content_id: string
          content_soft_deleted?: boolean | null
          content_type: string
          created_at?: string
          initial_applied: boolean
          initial_content_affected_count: number
          initial_strike_id?: string | null
          initial_strike_type?: string | null
          operation_id: string
          report_count: number
          report_ids: string[]
          report_status: string
        }
        Update: {
          action?: string
          action_taken?: string
          actor_id?: string
          author_id?: string | null
          content_id?: string
          content_soft_deleted?: boolean | null
          content_type?: string
          created_at?: string
          initial_applied?: boolean
          initial_content_affected_count?: number
          initial_strike_id?: string | null
          initial_strike_type?: string | null
          operation_id?: string
          report_count?: number
          report_ids?: string[]
          report_status?: string
        }
        Relationships: []
      }
      reports: {
        Row: {
          created_at: string
          group_id: string
          id: string
          note: string | null
          reason: Database['public']['Enums']['report_reason']
          reporter_id: string
          target_id: string
          target_type: string
        }
        Insert: {
          created_at?: string
          group_id: string
          id?: string
          note?: string | null
          reason?: Database['public']['Enums']['report_reason']
          reporter_id?: string
          target_id: string
          target_type: string
        }
        Update: {
          created_at?: string
          group_id?: string
          id?: string
          note?: string | null
          reason?: Database['public']['Enums']['report_reason']
          reporter_id?: string
          target_id?: string
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: 'reports_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'group_subscription_stats'
            referencedColumns: ['group_id']
          },
          {
            foreignKeyName: 'reports_group_id_fkey'
            columns: ['group_id']
            isOneToOne: false
            referencedRelation: 'groups'
            referencedColumns: ['id']
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
            foreignKeyName: 'reposts_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
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
      saved_filters: {
        Row: {
          created_at: string
          description: string | null
          filter_config: Json
          id: string
          is_default: boolean
          last_used_at: string | null
          name: string
          updated_at: string
          use_count: number
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          filter_config?: Json
          id?: string
          is_default?: boolean
          last_used_at?: string | null
          name: string
          updated_at?: string
          use_count?: number
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          filter_config?: Json
          id?: string
          is_default?: boolean
          last_used_at?: string | null
          name?: string
          updated_at?: string
          use_count?: number
          user_id?: string
        }
        Relationships: []
      }
      score_backtest_runs: {
        Row: {
          horizon_days: number
          id: number
          n: number
          quintiles: Json
          rank_corr: number | null
          run_at: string
          season: string
          snapshot_date: string
          top_minus_bottom: number | null
        }
        Insert: {
          horizon_days: number
          id?: never
          n: number
          quintiles: Json
          rank_corr?: number | null
          run_at?: string
          season: string
          snapshot_date: string
          top_minus_bottom?: number | null
        }
        Update: {
          horizon_days?: number
          id?: never
          n?: number
          quintiles?: Json
          rank_corr?: number | null
          run_at?: string
          season?: string
          snapshot_date?: string
          top_minus_bottom?: number | null
        }
        Relationships: []
      }
      score_backtest_snapshots: {
        Row: {
          arena_score: number
          equity: number
          run_date: string
          season: string
          source: string
          source_trader_id: string
        }
        Insert: {
          arena_score: number
          equity: number
          run_date: string
          season: string
          source: string
          source_trader_id: string
        }
        Update: {
          arena_score?: number
          equity?: number
          run_date?: string
          season?: string
          source?: string
          source_trader_id?: string
        }
        Relationships: []
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
            foreignKeyName: 'snapshot_traders_snapshot_id_fkey'
            columns: ['snapshot_id']
            isOneToOne: false
            referencedRelation: 'ranking_snapshots'
            referencedColumns: ['id']
          },
        ]
      }
      stripe_charge_refund_tombstone_events: {
        Row: {
          event_created_at: string
          event_id: string
          observations: Json
          observed_at: string
          refund_state: string
          refund_succeeded_amount: number
          stripe_charge_id: string
        }
        Insert: {
          event_created_at: string
          event_id: string
          observations?: Json
          observed_at?: string
          refund_state: string
          refund_succeeded_amount: number
          stripe_charge_id: string
        }
        Update: {
          event_created_at?: string
          event_id?: string
          observations?: Json
          observed_at?: string
          refund_state?: string
          refund_succeeded_amount?: number
          stripe_charge_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'stripe_charge_refund_tombstone_events_stripe_charge_id_fkey'
            columns: ['stripe_charge_id']
            isOneToOne: false
            referencedRelation: 'stripe_charge_refund_tombstones'
            referencedColumns: ['stripe_charge_id']
          },
        ]
      }
      stripe_charge_refund_tombstones: {
        Row: {
          amount_paid: number
          captured: boolean
          created_at: string
          currency: string
          latest_refund_event_created_at: string
          latest_refund_event_id: string
          merged_payment_id: string | null
          refund_snapshot_event_created_at: string
          refund_snapshot_event_id: string
          refund_state: string
          refund_succeeded_amount: number
          resolution_kind: string
          resolution_ownership_id: string | null
          resolution_reference: string | null
          stripe_charge_id: string
          stripe_customer_id: string
          stripe_payment_intent_id: string | null
          updated_at: string
        }
        Insert: {
          amount_paid: number
          captured: boolean
          created_at?: string
          currency: string
          latest_refund_event_created_at: string
          latest_refund_event_id: string
          merged_payment_id?: string | null
          refund_snapshot_event_created_at: string
          refund_snapshot_event_id: string
          refund_state: string
          refund_succeeded_amount: number
          resolution_kind?: string
          resolution_ownership_id?: string | null
          resolution_reference?: string | null
          stripe_charge_id: string
          stripe_customer_id: string
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_paid?: number
          captured?: boolean
          created_at?: string
          currency?: string
          latest_refund_event_created_at?: string
          latest_refund_event_id?: string
          merged_payment_id?: string | null
          refund_snapshot_event_created_at?: string
          refund_snapshot_event_id?: string
          refund_state?: string
          refund_succeeded_amount?: number
          resolution_kind?: string
          resolution_ownership_id?: string | null
          resolution_reference?: string | null
          stripe_charge_id?: string
          stripe_customer_id?: string
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'stripe_charge_refund_tombstones_merged_payment_id_fkey'
            columns: ['merged_payment_id']
            isOneToOne: false
            referencedRelation: 'stripe_entitlement_payments'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_charge_refund_tombstones_resolution_ownership_id_fkey'
            columns: ['resolution_ownership_id']
            isOneToOne: false
            referencedRelation: 'stripe_payment_ownerships'
            referencedColumns: ['id']
          },
        ]
      }
      stripe_entitlement_effects: {
        Row: {
          attempt_count: number
          available_at: string
          completed_at: string | null
          created_at: string
          effect_type: string
          entitlement_payment_id: string | null
          external_ref: string | null
          id: string
          last_error: string | null
          lease_expires_at: string | null
          lease_token: string | null
          operation_key: string
          payload: Json
          source_key: string
          source_kind: string
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          attempt_count?: number
          available_at?: string
          completed_at?: string | null
          created_at?: string
          effect_type: string
          entitlement_payment_id?: string | null
          external_ref?: string | null
          id?: string
          last_error?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          operation_key: string
          payload?: Json
          source_key: string
          source_kind: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          attempt_count?: number
          available_at?: string
          completed_at?: string | null
          created_at?: string
          effect_type?: string
          entitlement_payment_id?: string | null
          external_ref?: string | null
          id?: string
          last_error?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          operation_key?: string
          payload?: Json
          source_key?: string
          source_kind?: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'stripe_entitlement_effects_entitlement_payment_id_fkey'
            columns: ['entitlement_payment_id']
            isOneToOne: false
            referencedRelation: 'stripe_entitlement_payments'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_entitlement_effects_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_entitlement_effects_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_entitlement_effects_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
          },
        ]
      }
      stripe_entitlement_payments: {
        Row: {
          amount_paid: number
          checkout_session_id: string | null
          created_at: string
          currency: string
          id: string
          latest_refund_event_created_at: string | null
          latest_refund_event_id: string | null
          payment_kind: string
          payment_status: string
          period_end: string | null
          period_start: string
          plan: string
          refund_snapshot_event_created_at: string | null
          refund_snapshot_event_id: string | null
          refund_state: string
          refund_succeeded_amount: number
          stripe_charge_id: string
          stripe_customer_id: string
          stripe_invoice_id: string | null
          stripe_payment_intent_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          amount_paid: number
          checkout_session_id?: string | null
          created_at?: string
          currency: string
          id?: string
          latest_refund_event_created_at?: string | null
          latest_refund_event_id?: string | null
          payment_kind: string
          payment_status: string
          period_end?: string | null
          period_start: string
          plan: string
          refund_snapshot_event_created_at?: string | null
          refund_snapshot_event_id?: string | null
          refund_state?: string
          refund_succeeded_amount?: number
          stripe_charge_id: string
          stripe_customer_id: string
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          amount_paid?: number
          checkout_session_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          latest_refund_event_created_at?: string | null
          latest_refund_event_id?: string | null
          payment_kind?: string
          payment_status?: string
          period_end?: string | null
          period_start?: string
          plan?: string
          refund_snapshot_event_created_at?: string | null
          refund_snapshot_event_id?: string | null
          refund_state?: string
          refund_succeeded_amount?: number
          stripe_charge_id?: string
          stripe_customer_id?: string
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'stripe_entitlement_payments_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_entitlement_payments_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_entitlement_payments_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
          },
        ]
      }
      stripe_entitlement_refund_events: {
        Row: {
          entitlement_payment_id: string
          event_created_at: string
          event_id: string
          observations: Json
          observed_at: string
          refund_state: string
          refund_succeeded_amount: number
          stripe_subscription_status: string | null
          user_id: string | null
        }
        Insert: {
          entitlement_payment_id: string
          event_created_at: string
          event_id: string
          observations?: Json
          observed_at?: string
          refund_state: string
          refund_succeeded_amount: number
          stripe_subscription_status?: string | null
          user_id?: string | null
        }
        Update: {
          entitlement_payment_id?: string
          event_created_at?: string
          event_id?: string
          observations?: Json
          observed_at?: string
          refund_state?: string
          refund_succeeded_amount?: number
          stripe_subscription_status?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'stripe_entitlement_refund_events_entitlement_payment_id_fkey'
            columns: ['entitlement_payment_id']
            isOneToOne: false
            referencedRelation: 'stripe_entitlement_payments'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_entitlement_refund_events_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_entitlement_refund_events_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_entitlement_refund_events_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
          },
        ]
      }
      stripe_events: {
        Row: {
          attempts: number
          created_at: string
          event_id: string
          event_type: string
          id: string
          last_error: string | null
          payload: Json | null
          processed_at: string | null
          started_at: string | null
          status: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          event_id: string
          event_type: string
          id?: string
          last_error?: string | null
          payload?: Json | null
          processed_at?: string | null
          started_at?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          event_id?: string
          event_type?: string
          id?: string
          last_error?: string | null
          payload?: Json | null
          processed_at?: string | null
          started_at?: string | null
          status?: string
        }
        Relationships: []
      }
      stripe_legacy_lifetime_seat_claims: {
        Row: {
          created_at: string
          id: string
          legacy_subscription_id: string
          release_reference: string | null
          released_at: string | null
          status: string
          stripe_customer_id: string
          stripe_subscription_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          legacy_subscription_id: string
          release_reference?: string | null
          released_at?: string | null
          status?: string
          stripe_customer_id: string
          stripe_subscription_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          legacy_subscription_id?: string
          release_reference?: string | null
          released_at?: string | null
          status?: string
          stripe_customer_id?: string
          stripe_subscription_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      stripe_lifetime_seat_reservations: {
        Row: {
          checkout_expires_at: string
          checkout_session_id: string | null
          converted_payment_id: string | null
          created_at: string
          expires_at: string
          id: string
          release_event_created_at: string | null
          release_event_id: string | null
          release_reason: string | null
          released_at: string | null
          request_nonce: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          checkout_expires_at: string
          checkout_session_id?: string | null
          converted_payment_id?: string | null
          created_at?: string
          expires_at: string
          id?: string
          release_event_created_at?: string | null
          release_event_id?: string | null
          release_reason?: string | null
          released_at?: string | null
          request_nonce: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          checkout_expires_at?: string
          checkout_session_id?: string | null
          converted_payment_id?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          release_event_created_at?: string | null
          release_event_id?: string | null
          release_reason?: string | null
          released_at?: string | null
          request_nonce?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'stripe_lifetime_seat_reservations_converted_payment_id_fkey'
            columns: ['converted_payment_id']
            isOneToOne: false
            referencedRelation: 'stripe_entitlement_payments'
            referencedColumns: ['id']
          },
        ]
      }
      stripe_manual_reviews: {
        Row: {
          action: string
          created_at: string
          id: string
          metadata: Json
          object_id: string
          object_type: string
          reason: string
          reason_key: string
          resolved_at: string | null
          state: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          action?: string
          created_at?: string
          id?: string
          metadata?: Json
          object_id: string
          object_type: string
          reason: string
          reason_key: string
          resolved_at?: string | null
          state?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          metadata?: Json
          object_id?: string
          object_type?: string
          reason?: string
          reason_key?: string
          resolved_at?: string | null
          state?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'stripe_manual_reviews_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_manual_reviews_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_manual_reviews_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
          },
        ]
      }
      stripe_payment_ownerships: {
        Row: {
          amount_paid: number
          checkout_session_id: string | null
          claimed_at: string
          currency: string
          id: string
          ledger_id: string
          owner_user_id: string | null
          product_kind: string
          stripe_charge_id: string
          stripe_customer_id: string
          stripe_payment_intent_id: string | null
        }
        Insert: {
          amount_paid: number
          checkout_session_id?: string | null
          claimed_at?: string
          currency: string
          id?: string
          ledger_id: string
          owner_user_id?: string | null
          product_kind: string
          stripe_charge_id: string
          stripe_customer_id: string
          stripe_payment_intent_id?: string | null
        }
        Update: {
          amount_paid?: number
          checkout_session_id?: string | null
          claimed_at?: string
          currency?: string
          id?: string
          ledger_id?: string
          owner_user_id?: string | null
          product_kind?: string
          stripe_charge_id?: string
          stripe_customer_id?: string
          stripe_payment_intent_id?: string | null
        }
        Relationships: []
      }
      stripe_subscription_state_events: {
        Row: {
          cancel_at_period_end: boolean
          canceled_at: string | null
          current_invoice_id: string | null
          event_created_at: string
          event_id: string
          observed_at: string
          outcome: string
          period_end: string
          period_start: string
          plan: string
          requested_grace_expires_at: string | null
          stripe_customer_id: string
          stripe_status: string
          stripe_subscription_id: string
          user_id: string | null
        }
        Insert: {
          cancel_at_period_end: boolean
          canceled_at?: string | null
          current_invoice_id?: string | null
          event_created_at: string
          event_id: string
          observed_at?: string
          outcome?: string
          period_end: string
          period_start: string
          plan: string
          requested_grace_expires_at?: string | null
          stripe_customer_id: string
          stripe_status: string
          stripe_subscription_id: string
          user_id?: string | null
        }
        Update: {
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          current_invoice_id?: string | null
          event_created_at?: string
          event_id?: string
          observed_at?: string
          outcome?: string
          period_end?: string
          period_start?: string
          plan?: string
          requested_grace_expires_at?: string | null
          stripe_customer_id?: string
          stripe_status?: string
          stripe_subscription_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'stripe_subscription_state_events_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_subscription_state_events_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_subscription_state_events_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
          },
        ]
      }
      stripe_trial_entitlements: {
        Row: {
          created_at: string
          id: string
          period_end: string
          period_start: string
          plan: string
          revoke_reason: string | null
          revoked_at: string | null
          stripe_customer_id: string
          stripe_subscription_id: string
          updated_at: string
          user_id: string
          verified_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          period_end: string
          period_start: string
          plan: string
          revoke_reason?: string | null
          revoked_at?: string | null
          stripe_customer_id: string
          stripe_subscription_id: string
          updated_at?: string
          user_id: string
          verified_at: string
        }
        Update: {
          created_at?: string
          id?: string
          period_end?: string
          period_start?: string
          plan?: string
          revoke_reason?: string | null
          revoked_at?: string | null
          stripe_customer_id?: string
          stripe_subscription_id?: string
          updated_at?: string
          user_id?: string
          verified_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'stripe_trial_entitlements_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_trial_entitlements_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'stripe_trial_entitlements_user_id_fkey'
            columns: ['user_id']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
          },
        ]
      }
      subscriptions: {
        Row: {
          api_calls_reset_at: string | null
          api_calls_today: number
          cancel_at_period_end: boolean
          canceled_at: string | null
          comparison_reports_this_month: number
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          entitlement_payment_id: string | null
          entitlement_trial_id: string | null
          entitlement_trial_verified_at: string | null
          exports_this_month: number
          id: string
          plan: string | null
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
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          comparison_reports_this_month?: number
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          entitlement_payment_id?: string | null
          entitlement_trial_id?: string | null
          entitlement_trial_verified_at?: string | null
          exports_this_month?: number
          id?: string
          plan?: string | null
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
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          comparison_reports_this_month?: number
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          entitlement_payment_id?: string | null
          entitlement_trial_id?: string | null
          entitlement_trial_verified_at?: string | null
          exports_this_month?: number
          id?: string
          plan?: string | null
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          tier?: string
          updated_at?: string
          usage_reset_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'subscriptions_entitlement_payment_fkey'
            columns: ['entitlement_payment_id']
            isOneToOne: false
            referencedRelation: 'stripe_entitlement_payments'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'subscriptions_entitlement_trial_fkey'
            columns: ['entitlement_trial_id']
            isOneToOne: false
            referencedRelation: 'stripe_trial_entitlements'
            referencedColumns: ['id']
          },
        ]
      }
      tips: {
        Row: {
          amount_cents: number
          completed_at: string | null
          created_at: string
          currency: string | null
          from_user_id: string
          id: string
          message: string | null
          post_id: string | null
          status: string
          stripe_charge_id: string | null
          stripe_checkout_session_id: string | null
          stripe_customer_id: string | null
          stripe_payment_intent_id: string | null
          to_user_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          completed_at?: string | null
          created_at?: string
          currency?: string | null
          from_user_id: string
          id?: string
          message?: string | null
          post_id?: string | null
          status?: string
          stripe_charge_id?: string | null
          stripe_checkout_session_id?: string | null
          stripe_customer_id?: string | null
          stripe_payment_intent_id?: string | null
          to_user_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          completed_at?: string | null
          created_at?: string
          currency?: string | null
          from_user_id?: string
          id?: string
          message?: string | null
          post_id?: string | null
          status?: string
          stripe_charge_id?: string | null
          stripe_checkout_session_id?: string | null
          stripe_customer_id?: string | null
          stripe_payment_intent_id?: string | null
          to_user_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'tips_post_id_fkey'
            columns: ['post_id']
            isOneToOne: false
            referencedRelation: 'posts'
            referencedColumns: ['id']
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
      trader_alert_deliveries: {
        Row: {
          absolute_change: number
          alert_id: string
          attempt_count: number
          baseline_version: number
          created_at: string
          delivered_at: string | null
          id: string
          last_error: string | null
          link: string
          message: string
          metric: string
          new_value: number
          notification_type: string
          old_value: number
          status: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          absolute_change: number
          alert_id: string
          attempt_count?: number
          baseline_version: number
          created_at?: string
          delivered_at?: string | null
          id?: string
          last_error?: string | null
          link: string
          message: string
          metric: string
          new_value: number
          notification_type: string
          old_value: number
          status?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          absolute_change?: number
          alert_id?: string
          attempt_count?: number
          baseline_version?: number
          created_at?: string
          delivered_at?: string | null
          id?: string
          last_error?: string | null
          link?: string
          message?: string
          metric?: string
          new_value?: number
          notification_type?: string
          old_value?: number
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'trader_alert_deliveries_alert_id_fkey'
            columns: ['alert_id']
            isOneToOne: false
            referencedRelation: 'trader_alerts'
            referencedColumns: ['id']
          },
        ]
      }
      trader_alert_logs: {
        Row: {
          alert_id: string | null
          alert_type: string
          change_percent: number | null
          created_at: string
          delivery_id: string | null
          id: string
          message: string | null
          new_value: number | null
          old_value: number | null
          trader_id: string
          user_id: string
        }
        Insert: {
          alert_id?: string | null
          alert_type: string
          change_percent?: number | null
          created_at?: string
          delivery_id?: string | null
          id?: string
          message?: string | null
          new_value?: number | null
          old_value?: number | null
          trader_id: string
          user_id: string
        }
        Update: {
          alert_id?: string | null
          alert_type?: string
          change_percent?: number | null
          created_at?: string
          delivery_id?: string | null
          id?: string
          message?: string | null
          new_value?: number | null
          old_value?: number | null
          trader_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'trader_alert_logs_alert_id_fkey'
            columns: ['alert_id']
            isOneToOne: false
            referencedRelation: 'trader_alerts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'trader_alert_logs_delivery_id_fkey'
            columns: ['delivery_id']
            isOneToOne: false
            referencedRelation: 'trader_alert_deliveries'
            referencedColumns: ['id']
          },
        ]
      }
      trader_alert_states: {
        Row: {
          alert_id: string
          baseline_value: number
          baseline_version: number
          last_value: number
          metric: string
          observed_at: string
          updated_at: string
        }
        Insert: {
          alert_id: string
          baseline_value: number
          baseline_version?: number
          last_value: number
          metric: string
          observed_at?: string
          updated_at?: string
        }
        Update: {
          alert_id?: string
          baseline_value?: number
          baseline_version?: number
          last_value?: number
          metric?: string
          observed_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'trader_alert_states_alert_id_fkey'
            columns: ['alert_id']
            isOneToOne: false
            referencedRelation: 'trader_alerts'
            referencedColumns: ['id']
          },
        ]
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
          read_at: string | null
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
          read_at?: string | null
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
          read_at?: string | null
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
          attestation_uid: string | null
          chain_id: number | null
          created_at: string | null
          id: string
          minted_by: string | null
          published_at: string | null
          score_period: string | null
          source: string
          trader_handle: string | null
          trader_id: string
          tx_hash: string | null
          updated_at: string | null
        }
        Insert: {
          arena_score?: number | null
          attestation_uid?: string | null
          chain_id?: number | null
          created_at?: string | null
          id?: string
          minted_by?: string | null
          published_at?: string | null
          score_period?: string | null
          source: string
          trader_handle?: string | null
          trader_id: string
          tx_hash?: string | null
          updated_at?: string | null
        }
        Update: {
          arena_score?: number | null
          attestation_uid?: string | null
          chain_id?: number | null
          created_at?: string | null
          id?: string
          minted_by?: string | null
          published_at?: string | null
          score_period?: string | null
          source?: string
          trader_handle?: string | null
          trader_id?: string
          tx_hash?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      trader_authorizations: {
        Row: {
          consecutive_failures: number
          created_at: string | null
          data_source: string
          encrypted_api_key: string
          encrypted_api_secret: string
          encrypted_passphrase: string | null
          expires_at: string | null
          id: string
          label: string | null
          last_sync_at: string | null
          last_sync_status: string | null
          last_verified_at: string | null
          notes: string | null
          permissions: Json | null
          platform: string
          read_only_verified_at: string | null
          status: string
          sync_frequency: string | null
          trader_id: string
          updated_at: string | null
          user_id: string
          verification_error: string | null
        }
        Insert: {
          consecutive_failures?: number
          created_at?: string | null
          data_source?: string
          encrypted_api_key: string
          encrypted_api_secret: string
          encrypted_passphrase?: string | null
          expires_at?: string | null
          id?: string
          label?: string | null
          last_sync_at?: string | null
          last_sync_status?: string | null
          last_verified_at?: string | null
          notes?: string | null
          permissions?: Json | null
          platform: string
          read_only_verified_at?: string | null
          status?: string
          sync_frequency?: string | null
          trader_id: string
          updated_at?: string | null
          user_id: string
          verification_error?: string | null
        }
        Update: {
          consecutive_failures?: number
          created_at?: string | null
          data_source?: string
          encrypted_api_key?: string
          encrypted_api_secret?: string
          encrypted_passphrase?: string | null
          expires_at?: string | null
          id?: string
          label?: string | null
          last_sync_at?: string | null
          last_sync_status?: string | null
          last_verified_at?: string | null
          notes?: string | null
          permissions?: Json | null
          platform?: string
          read_only_verified_at?: string | null
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
          created_at: string
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
          created_at?: string
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
          created_at?: string
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
      trader_position_seen: {
        Row: {
          first_seen_at: string
          side: string
          source: string
          symbol: string
          trader_id: string
        }
        Insert: {
          first_seen_at?: string
          side?: string
          source?: string
          symbol: string
          trader_id: string
        }
        Update: {
          first_seen_at?: string
          side?: string
          source?: string
          symbol?: string
          trader_id?: string
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
      trader_sources: {
        Row: {
          activity_tier: string | null
          avatar_url: string | null
          bot_category: string | null
          claimed_by_user_id: string | null
          contract_bytecode_size: number | null
          contract_checked_at: string | null
          created_at: string | null
          handle: string | null
          id: number
          identity_type: string
          is_active: boolean | null
          is_bot: boolean | null
          is_contract: boolean | null
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
          contract_bytecode_size?: number | null
          contract_checked_at?: string | null
          created_at?: string | null
          handle?: string | null
          id?: number
          identity_type?: string
          is_active?: boolean | null
          is_bot?: boolean | null
          is_contract?: boolean | null
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
          contract_bytecode_size?: number | null
          contract_checked_at?: string | null
          created_at?: string | null
          handle?: string | null
          id?: number
          identity_type?: string
          is_active?: boolean | null
          is_bot?: boolean | null
          is_contract?: boolean | null
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
      trader_watchlist: {
        Row: {
          created_at: string
          handle: string | null
          id: string
          source: string
          source_trader_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          handle?: string | null
          id?: string
          source: string
          source_trader_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          handle?: string | null
          id?: string
          source?: string
          source_trader_id?: string
          user_id?: string
        }
        Relationships: []
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
      user_activity_days: {
        Row: {
          activity_date: string
          first_seen_at: string
          heartbeat_count: number
          last_seen_at: string
          user_id: string
        }
        Insert: {
          activity_date: string
          first_seen_at: string
          heartbeat_count?: number
          last_seen_at: string
          user_id: string
        }
        Update: {
          activity_date?: string
          first_seen_at?: string
          heartbeat_count?: number
          last_seen_at?: string
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
          scope_permissions: Json | null
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
          scope_permissions?: Json | null
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
          scope_permissions?: Json | null
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
      user_passkeys: {
        Row: {
          counter: number
          created_at: string | null
          credential_id: string
          device_name: string | null
          id: string
          last_used_at: string | null
          public_key: string
          transports: string[] | null
          user_id: string
        }
        Insert: {
          counter?: number
          created_at?: string | null
          credential_id: string
          device_name?: string | null
          id?: string
          last_used_at?: string | null
          public_key: string
          transports?: string[] | null
          user_id: string
        }
        Update: {
          counter?: number
          created_at?: string | null
          credential_id?: string
          device_name?: string | null
          id?: string
          last_used_at?: string | null
          public_key?: string
          transports?: string[] | null
          user_id?: string
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
            foreignKeyName: 'user_portfolio_snapshots_portfolio_id_fkey'
            columns: ['portfolio_id']
            isOneToOne: false
            referencedRelation: 'user_portfolios'
            referencedColumns: ['id']
          },
        ]
      }
      user_portfolios: {
        Row: {
          api_key_encrypted: string
          api_passphrase_encrypted: string | null
          api_secret_encrypted: string
          created_at: string
          exchange: string
          id: string
          label: string | null
          user_id: string
        }
        Insert: {
          api_key_encrypted: string
          api_passphrase_encrypted?: string | null
          api_secret_encrypted: string
          created_at?: string
          exchange: string
          id?: string
          label?: string | null
          user_id: string
        }
        Update: {
          api_key_encrypted?: string
          api_passphrase_encrypted?: string | null
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
            foreignKeyName: 'user_positions_portfolio_id_fkey'
            columns: ['portfolio_id']
            isOneToOne: false
            referencedRelation: 'user_portfolios'
            referencedColumns: ['id']
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
          api_stripe_subscription_id: string | null
          api_tier: string
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
          handle: string
          id: string
          interests: Json | null
          is_banned: boolean
          is_online: boolean | null
          is_pro: boolean | null
          is_verified: boolean | null
          is_verified_trader: boolean | null
          kol_tier: string | null
          last_export_at: string | null
          last_seen_at: string | null
          linked_trader_count: number | null
          market_pairs: Json | null
          nft_minted_at: string | null
          nft_token_id: string | null
          notify_comment: boolean | null
          notify_follow: boolean | null
          notify_like: boolean | null
          notify_mention: boolean | null
          notify_message: boolean | null
          notify_trader_events: boolean
          onboarding_completed: boolean | null
          original_email: string | null
          original_handle: string | null
          pro_expires_at: string | null
          pro_plan: string | null
          referral_code: string | null
          referred_by: string | null
          reputation_score: number | null
          role: string | null
          search_history: Json | null
          settings_version: number | null
          show_followers: boolean | null
          show_following: boolean | null
          show_pro_badge: boolean | null
          stripe_customer_id: string | null
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
          api_stripe_subscription_id?: string | null
          api_tier?: string
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
          handle: string
          id: string
          interests?: Json | null
          is_banned?: boolean
          is_online?: boolean | null
          is_pro?: boolean | null
          is_verified?: boolean | null
          is_verified_trader?: boolean | null
          kol_tier?: string | null
          last_export_at?: string | null
          last_seen_at?: string | null
          linked_trader_count?: number | null
          market_pairs?: Json | null
          nft_minted_at?: string | null
          nft_token_id?: string | null
          notify_comment?: boolean | null
          notify_follow?: boolean | null
          notify_like?: boolean | null
          notify_mention?: boolean | null
          notify_message?: boolean | null
          notify_trader_events?: boolean
          onboarding_completed?: boolean | null
          original_email?: string | null
          original_handle?: string | null
          pro_expires_at?: string | null
          pro_plan?: string | null
          referral_code?: string | null
          referred_by?: string | null
          reputation_score?: number | null
          role?: string | null
          search_history?: Json | null
          settings_version?: number | null
          show_followers?: boolean | null
          show_following?: boolean | null
          show_pro_badge?: boolean | null
          stripe_customer_id?: string | null
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
          api_stripe_subscription_id?: string | null
          api_tier?: string
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
          handle?: string
          id?: string
          interests?: Json | null
          is_banned?: boolean
          is_online?: boolean | null
          is_pro?: boolean | null
          is_verified?: boolean | null
          is_verified_trader?: boolean | null
          kol_tier?: string | null
          last_export_at?: string | null
          last_seen_at?: string | null
          linked_trader_count?: number | null
          market_pairs?: Json | null
          nft_minted_at?: string | null
          nft_token_id?: string | null
          notify_comment?: boolean | null
          notify_follow?: boolean | null
          notify_like?: boolean | null
          notify_mention?: boolean | null
          notify_message?: boolean | null
          notify_trader_events?: boolean
          onboarding_completed?: boolean | null
          original_email?: string | null
          original_handle?: string | null
          pro_expires_at?: string | null
          pro_plan?: string | null
          referral_code?: string | null
          referred_by?: string | null
          reputation_score?: number | null
          role?: string | null
          search_history?: Json | null
          settings_version?: number | null
          show_followers?: boolean | null
          show_following?: boolean | null
          show_pro_badge?: boolean | null
          stripe_customer_id?: string | null
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
        Relationships: [
          {
            foreignKeyName: 'user_profiles_referred_by_fkey'
            columns: ['referred_by']
            isOneToOne: false
            referencedRelation: 'public_user_profiles'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'user_profiles_referred_by_fkey'
            columns: ['referred_by']
            isOneToOne: false
            referencedRelation: 'user_follow_counts'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'user_profiles_referred_by_fkey'
            columns: ['referred_by']
            isOneToOne: false
            referencedRelation: 'user_profiles'
            referencedColumns: ['id']
          },
        ]
      }
      user_strikes: {
        Row: {
          created_at: string | null
          expires_at: string | null
          id: string
          issued_by: string | null
          reason: string
          strike_type: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          issued_by?: string | null
          reason: string
          strike_type: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          expires_at?: string | null
          id?: string
          issued_by?: string | null
          reason?: string
          strike_type?: string
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
    }
    Views: {
      group_member_directory: {
        Row: {
          group_id: string
          joined_at: string
          role: Database['public']['Enums']['member_role']
          user_id: string
        }
        Relationships: []
      }
      group_member_moderation_directory: {
        Row: {
          group_id: string
          joined_at: string
          mute_reason: string | null
          muted_until: string | null
          role: Database['public']['Enums']['member_role']
          user_id: string
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
      mv_popular_tokens_90d: {
        Row: {
          token: string | null
          total_pnl: number | null
          trade_count: number | null
          trader_count: number | null
        }
        Relationships: []
      }
      mv_token_trader_daily_90d: {
        Row: {
          pnl_pct_count: number | null
          pnl_pct_sum: number | null
          source: string | null
          source_trader_id: string | null
          token: string | null
          token_pnl: number | null
          trade_count: number | null
          trade_date: string | null
          win_count: number | null
        }
        Relationships: []
      }
      own_group_memberships: {
        Row: {
          group_id: string
          joined_at: string
          muted_until: string | null
          pinned: boolean
          role: Database['public']['Enums']['member_role']
          user_id: string
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
      trader_avoid_scores: {
        Row: {
          avg_follow_days: number | null
          avg_loss_percent: number | null
          avoid_count: number | null
          fake_data_count: number | null
          high_drawdown_count: number | null
          inconsistent_count: number | null
          latest_vote_at: string | null
          source: string | null
          trader_id: string | null
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
      verified_data_authorizations: {
        Row: {
          authorization_id: string | null
          last_sync_at: string | null
          platform: string | null
          trader_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      ack_report_evidence_cleanup: {
        Args: {
          p_evidence_ref: string
          p_lease_token: string
          p_reporter_id: string
        }
        Returns: boolean
      }
      acknowledge_group_pass_full_refund_revocation_atomic: {
        Args: {
          p_ownership_id: string
          p_refund_snapshot_event_id: string
          p_refund_succeeded_amount: number
          p_revocation_action_reference: string
          p_subscription_id: string
        }
        Returns: Json
      }
      acquire_leaderboard_lock: { Args: { season: string }; Returns: boolean }
      acquire_post_audience_block_edges: {
        Args: { p_actor_id: string; p_author_ids: string[] }
        Returns: undefined
      }
      activate_group_subscription_atomic: {
        Args: {
          p_actor_id: string
          p_amount_cents: number
          p_checkout_session_id: string | null
          p_currency: string | null
          p_group_id: string
          p_payment_intent_id: string | null
          p_payment_provider: string | null
          p_tier: string
        }
        Returns: Json
      }
      activate_group_subscription_with_stripe_ownership_atomic: {
        Args: {
          p_actor_id: string
          p_amount_cents: number
          p_checkout_session_id: string
          p_currency: string
          p_group_id: string
          p_payment_intent_id: string
          p_stripe_charge_id: string
          p_stripe_customer_id: string
          p_tier: string
        }
        Returns: Json
      }
      activate_lifetime_membership: {
        Args: { p_stripe_customer_id: string; p_user_id: string }
        Returns: undefined
      }
      activate_lifetime_membership_with_identity_atomic: {
        Args: {
          p_amount_paid: number
          p_checkout_session_id: string
          p_currency: string
          p_paid_at: string
          p_payment_status: string
          p_reservation_id: string | null
          p_stripe_charge_id: string
          p_stripe_customer_id: string
          p_stripe_payment_intent_id: string
          p_user_id: string
        }
        Returns: Json
      }
      activate_recurring_entitlement_payment_atomic: {
        Args: {
          p_amount_paid: number
          p_currency: string
          p_payment_status: string
          p_period_end: string
          p_period_start: string
          p_plan: string
          p_stripe_charge_id: string
          p_stripe_customer_id: string
          p_stripe_invoice_id: string
          p_stripe_payment_intent_id: string | null
          p_stripe_subscription_id: string
          p_stripe_subscription_status: string
          p_user_id: string
        }
        Returns: Json
      }
      activate_recurring_trial_entitlement_atomic: {
        Args: {
          p_period_end: string
          p_period_start: string
          p_plan: string
          p_stripe_customer_id: string
          p_stripe_subscription_id: string
          p_stripe_subscription_status: string
          p_user_id: string
        }
        Returns: Json
      }
      activate_trader_claim: {
        Args: { p_claim_id: string; p_reviewer_id: string }
        Returns: Json
      }
      add_channel_members_atomic: {
        Args: {
          p_actor_id: string
          p_candidate_ids: string[]
          p_channel_id: string
        }
        Returns: Json
      }
      archive_old_notifications: { Args: never; Returns: undefined }
      arena_apply_onchain_enrichment: {
        Args: {
          p_exchange_trader_id: string
          p_extras: Json
          p_source: string
          p_win_rate?: number
        }
        Returns: number
      }
      arena_avatar_mirrors: {
        Args: { p_sources: string[]; p_trader_ids: string[] }
        Returns: {
          avatar_url_mirror: string
          exchange_trader_id: string
          source: string
        }[]
      }
      arena_backfill_panel: { Args: never; Returns: Json }
      arena_bot_header: {
        Args: { p_source: string; p_trader_key: string }
        Returns: Json
      }
      arena_copier_aggregate: {
        Args: { p_source: string; p_trader: string }
        Returns: Json
      }
      arena_core_modules: {
        Args: { p_source: string; p_timeframe: number; p_trader: string }
        Returns: Json
      }
      arena_exchange_rankings: { Args: { p_timeframe: number }; Returns: Json }
      arena_first_screen: {
        Args: { p_source: string; p_trader: string }
        Returns: Json
      }
      arena_freshness_expected_sources: {
        Args: never
        Returns: {
          exchange_name: string
          filter_source: string
          registry_slug: string
          season_id: string
        }[]
      }
      arena_latest_snapshot_at: { Args: never; Returns: string }
      arena_pipeline_panel: {
        Args: never
        Returns: {
          actual_count: number
          compat_platform: string
          compat_rows: number
          last_passed_at: string
          phase: number
          rejects_24h: number
          serving_mode: string
          slug: string
          status: string
          timeframe: number
        }[]
      }
      arena_records_page: {
        Args: {
          p_cursor?: string
          p_kind: string
          p_limit?: number
          p_source: string
          p_tf?: number
          p_trader: string
        }
        Returns: Json
      }
      arena_resolve_trader: {
        Args: { p_handle: string; p_source?: string }
        Returns: Json
      }
      arena_roi_sparklines: {
        Args: { p_pairs: Json; p_points?: number; p_timeframe?: number }
        Returns: {
          pts: number[]
          source: string
          trader_key: string
        }[]
      }
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
      arena_score_features: {
        Args: { p_source: string; p_trader: string }
        Returns: Json
      }
      arena_score_inputs: {
        Args: {
          p_max_age_hours?: number
          p_per_platform_limit?: number
          p_window: string
        }
        Returns: {
          as_of: string
          avatar_url: string
          board_rank: number
          calmar_ratio: number
          copiers: number
          currency: string
          handle: string
          market_type: string
          max_drawdown: number
          platform: string
          pnl_usd: number
          roi_pct: number
          sharpe_ratio: number
          sortino_ratio: number
          trader_key: string
          trader_kind: string
          trades_count: number
          volatility_pct: number
          win_rate: number
        }[]
      }
      arena_score_inputs_json: {
        Args: {
          p_max_age_hours?: number
          p_per_platform_limit?: number
          p_window: string
        }
        Returns: Json
      }
      arena_serving_sources: { Args: never; Returns: string[] }
      arena_set_trader_claimed: {
        Args: {
          p_claimed: boolean
          p_platform: string
          p_trader_key: string
          p_user_id: string
        }
        Returns: number
      }
      arena_source_capabilities: { Args: never; Returns: Json }
      arena_trust_scorecard: { Args: never; Returns: Json }
      arena_visible_sources: {
        Args: { p_season_id?: string }
        Returns: {
          cache_updated_at: string
          exchange_name: string
          exchange_slug: string
          filter_source: string
          product_type: string
          registry_slug: string
          trader_count: number
        }[]
      }
      arena_weekly_leaders: { Args: { p_limit?: number }; Returns: Json }
      b2c_product_metrics: { Args: { p_window_days?: number }; Returns: Json }
      bind_group_pass_stripe_ownership_atomic: {
        Args: {
          p_payment_intent_id: string
          p_payment_member_joined_at: string | null
          p_stripe_charge_id: string
          p_stripe_customer_id: string
        }
        Returns: Json
      }
      bind_lifetime_membership_reservation_session_atomic: {
        Args: {
          p_checkout_session_id: string
          p_request_nonce: string
          p_reservation_id: string
          p_session_expires_at: string
          p_user_id: string
        }
        Returns: Json
      }
      bind_stripe_customer_owner_atomic: {
        Args: {
          p_expected_previous_stripe_customer_id: string | null
          p_new_stripe_customer_id: string
          p_user_id: string
        }
        Returns: Json
      }
      bulk_enrich_sync_v2: { Args: { updates: Json }; Returns: number }
      bulk_update_snapshot_metrics: { Args: { updates: Json }; Returns: number }
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
      can_actor_read_activity_id: {
        Args: { p_activity_id: string; p_actor_id?: string | null }
        Returns: boolean
      }
      can_actor_read_post_fields: {
        Args: {
          p_author_id: string
          p_deleted_at: string
          p_group_id: string
          p_status: Database['public']['Enums']['post_status']
          p_viewer_id: string
          p_visibility: string
        }
        Returns: boolean
      }
      can_actor_read_post_id: {
        Args: { p_post_id: string; p_viewer_id: string }
        Returns: boolean
      }
      can_current_user_read_collection_item: {
        Args: { p_item_id: string; p_item_type: string }
        Returns: boolean
      }
      can_current_user_read_repost_root: {
        Args: { p_original_post_id: string }
        Returns: boolean
      }
      can_service_actor_read_activity: {
        Args: { p_activity_id: string; p_actor_id?: string | null }
        Returns: boolean
      }
      can_service_actor_read_post: {
        Args: { p_actor_id?: string; p_post_id: string }
        Returns: boolean
      }
      cancel_group_subscription_atomic: {
        Args: { p_actor_id: string; p_subscription_id: string }
        Returns: Json
      }
      cast_post_poll_vote_atomic: {
        Args: {
          p_actor_id: string
          p_option_indexes: number[]
          p_post_id: string
        }
        Returns: Json
      }
      check_dm_permission: {
        Args: { p_receiver_id: string; p_sender_id: string }
        Returns: Json
      }
      check_lifetime_spots_available: {
        Args: { max_spots?: number }
        Returns: boolean
      }
      check_mutual_follow: {
        Args: { user_a: string; user_b: string }
        Returns: boolean
      }
      check_trader_suspicion: {
        Args: { p_platform: string; p_trader_id: string }
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
          from: '*'
          to: 'refresh_jobs'
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_stripe_event: {
        Args: {
          p_event_id: string
          p_event_type: string
          p_stale_after?: string
        }
        Returns: string
      }
      claim_stripe_payment_ownership_atomic: {
        Args: { p_stripe_charge_id: string; p_stripe_payment_intent_id: string | null }
        Returns: Json
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
      cleanup_old_heartbeats: { Args: never; Returns: undefined }
      cleanup_old_refresh_jobs: { Args: never; Returns: number }
      cleanup_snapshot_violations: {
        Args: { batch_limit?: number }
        Returns: {
          fixed: number
          issue: string
        }[]
      }
      cleanup_stale_platform_rows: {
        Args: {
          p_keep_trader_ids: string[]
          p_season_id: string
          p_source: string
        }
        Returns: number
      }
      clip: {
        Args: { max_val: number; min_val: number; val: number }
        Returns: number
      }
      complete_tip_with_stripe_ownership_atomic: {
        Args: {
          p_amount_paid: number
          p_checkout_session_id: string
          p_completed_at: string
          p_currency: string
          p_stripe_charge_id: string
          p_stripe_customer_id: string
          p_stripe_payment_intent_id: string
          p_tip_id: string
        }
        Returns: Json
      }
      content_report_evidence_refs_valid: {
        Args: { p_images: string[]; p_reporter_id: string }
        Returns: boolean
      }
      count_distinct_projects: { Args: never; Returns: number }
      count_trader_account_followers: {
        Args: { p_sources: string[]; p_trader_ids: string[] }
        Returns: {
          cnt: number
          source: string
          trader_id: string
        }[]
      }
      count_trader_followers: {
        Args: { trader_ids: string[] }
        Returns: {
          cnt: number
          trader_id: string
        }[]
      }
      create_group_channel_atomic: {
        Args: {
          p_actor_id: string
          p_candidate_ids: string[]
          p_channel_id: string
          p_description: string | null
          p_name: string
        }
        Returns: Json
      }
      create_group_invite_atomic: {
        Args: {
          p_actor_id: string
          p_expires_at: string
          p_group_id: string
          p_max_uses?: number
          p_token_hash: string
        }
        Returns: Json
      }
      create_monthly_partition: {
        Args: { p_table_name?: string; p_target_date?: string }
        Returns: string
      }
      create_next_tph_partition: { Args: never; Returns: undefined }
      current_user_can_read_post_with_current_entitlement: {
        Args: { p_post_id: string }
        Returns: boolean
      }
      current_user_has_current_group_entitlement: {
        Args: { p_group_id: string }
        Returns: boolean
      }
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
      delete_direct_message_atomic: {
        Args: { p_actor_id: string; p_message_id: string }
        Returns: Json
      }
      delete_own_comment: {
        Args: { p_comment_id: string; p_post_id: string; p_user_id: string }
        Returns: {
          comment_count: number
          deleted_count: number
        }[]
      }
      delete_own_comment_locked_impl: {
        Args: { p_comment_id: string; p_post_id: string; p_user_id: string }
        Returns: {
          comment_count: number
          deleted_count: number
        }[]
      }
      dissolve_group_atomic: {
        Args: { p_actor_id: string; p_group_id: string }
        Returns: Json
      }
      dissolve_group_channel_atomic: {
        Args: { p_actor_id: string; p_channel_id: string }
        Returns: Json
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
      evaluate_score_backtest: {
        Args: { p_horizon_days?: number }
        Returns: Json
      }
      exec_sql: { Args: { sql: string }; Returns: undefined }
      expire_group_subscriptions: { Args: never; Returns: number }
      fill_null_pnl_from_siblings: { Args: never; Returns: number }
      finalize_report_evidence_upload: {
        Args: { p_evidence_ref: string; p_reporter_id: string }
        Returns: Json
      }
      finalize_trader_alert_delivery: {
        Args: {
          p_delivery_id: string
          p_last_value: number
          p_observed_at?: string
        }
        Returns: boolean
      }
      find_data_gaps: {
        Args: { p_limit?: number; p_max_age_hours?: number }
        Returns: {
          gap_hours: number
          last_computed: string
          source: string
          source_trader_id: string
        }[]
      }
      finish_stripe_entitlement_effect_atomic: {
        Args: {
          p_effect_id: string
          p_error: string | null
          p_external_ref: string | null
          p_lease_token: string
          p_retry_after_seconds: number | null
          p_succeeded: boolean
        }
        Returns: Json
      }
      finish_stripe_event: {
        Args: { p_error?: string; p_event_id: string; p_succeeded: boolean }
        Returns: boolean
      }
      fix_snapshot_violations: {
        Args: { batch_size?: number }
        Returns: {
          fixed: number
          issue: string
        }[]
      }
      generate_share_token: { Args: never; Returns: string }
      get_active_connections: { Args: never; Returns: number }
      get_author_weight: { Args: { p_author_id: string }; Returns: number }
      get_connection_stats: {
        Args: never
        Returns: {
          count: number
          oldest_query_seconds: number
          state: string
        }[]
      }
      get_content_quality_score: {
        Args: { p_content: string; p_images: Json; p_poll_id: string }
        Returns: number
      }
      get_data_gap_summary: {
        Args: { p_max_age_hours?: number }
        Returns: {
          avg_gap_hours: number
          gap_count: number
          max_gap_hours: number
          source: string
        }[]
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
          arena_score_v3: number | null
          arena_score_v4: number | null
          avatar_url: string | null
          avg_holding_hours: number | null
          calmar_ratio: number | null
          computed_at: string | null
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
          rank: number | null
          rank_change: number | null
          risk_control_score: number | null
          roi: number | null
          score_completeness: string | null
          score_factors: Json | null
          season_id: string
          sharpe_ratio: number | null
          sortino_ratio: number | null
          source: string
          source_trader_id: string
          source_type: string | null
          style_confidence: number | null
          trader_type: string | null
          trades_count: number | null
          trading_style: string | null
          win_rate: number | null
        }[]
        SetofOptions: {
          from: '*'
          to: 'leaderboard_ranks'
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_dm_count_before_reply: {
        Args: { receiver: string; sender: string }
        Returns: number
      }
      get_expected_platform_counts: {
        Args: { p_season_id: string }
        Returns: {
          expected_count: number
          source: string
        }[]
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
          status: Database['public']['Enums']['post_status']
          title: string
          updated_at: string
          velocity_updated_at: string | null
          view_count: number | null
          visibility: string
        }[]
        SetofOptions: {
          from: '*'
          to: 'posts'
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_following_posts_page: {
        Args: {
          p_author_handle?: string
          p_before_created_at?: string
          p_before_id?: string
          p_group_id?: string
          p_group_ids?: string[]
          p_language?: string
          p_limit?: number
          p_viewer_id: string
        }
        Returns: Json
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
      get_own_profile_sensitive: {
        Args: never
        Returns: {
          email: string
          email_digest: string
          interests: Json
          market_pairs: Json
          notify_comment: boolean
          notify_follow: boolean
          notify_like: boolean
          notify_mention: boolean
          notify_message: boolean
          notify_trader_events: boolean
          onboarding_completed: boolean
          original_email: string
          pro_expires_at: string
          pro_plan: string
          search_history: Json
          settings_version: number
          stripe_subscription_id: string
          totp_enabled: boolean
          utm_campaign: string
          utm_medium: string
          utm_source: string
          wallet_address: string
        }[]
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
      get_platform_freshness: {
        Args: never
        Returns: {
          latest: string
          source: string
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
      get_popular_tokens: {
        Args: { lookback_days?: number; max_tokens?: number }
        Returns: {
          token: string
          total_pnl: number
          trade_count: number
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
      get_pro_official_group_atomic: {
        Args: { p_actor_id: string }
        Returns: Json
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
      get_token_trader_rankings: {
        Args: {
          lookback_days?: number
          max_traders?: number
          row_offset?: number
          token_symbol: string
        }
        Returns: {
          source: string
          source_trader_id: string
          token_avg_pnl_pct: number
          token_pnl: number
          token_trade_count: number
          token_win_rate: number
          total_count: number
        }[]
      }
      get_top_trust_ratio: {
        Args: { p_season_id?: string; p_top_n?: number }
        Returns: {
          full_count: number
          ratio: number
          total_count: number
        }[]
      }
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
      get_user_notifications: {
        Args: {
          p_limit?: number
          p_offset?: number
          p_unread_only?: boolean
          p_user_id: string
        }
        Returns: {
          actor_avatar_url: string
          actor_handle: string
          actor_id: string
          created_at: string
          id: string
          link: string
          message: string
          read: boolean
          reference_id: string
          title: string
          type: string
          unread_count: number
          user_id: string
        }[]
      }
      grant_pro_entitlement_days_atomic: {
        Args: {
          p_days: number
          p_granted_at: string
          p_metadata: Json
          p_source: string
          p_source_key: string
          p_user_id: string
        }
        Returns: Json
      }
      group_pass_full_refund_revocation_is_effective_v2: {
        Args: { p_ownership_id: string }
        Returns: boolean
      }
      group_pass_has_independent_current_authority_v2: {
        Args: {
          p_excluded_ownership_id: string
          p_excluded_subscription_id: string
          p_group_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      has_block_with_current_user: {
        Args: { p_other_user_id: string }
        Returns: boolean
      }
      has_current_global_pro_entitlement: {
        Args: { p_actor_id: string }
        Returns: boolean
      }
      has_current_group_entitlement: {
        Args: { p_actor_id: string; p_group_id: string }
        Returns: boolean
      }
      has_valid_group_subscription: {
        Args: { p_group_id: string; p_user_id: string }
        Returns: boolean
      }
      http: {
        Args: { request: Database['public']['CompositeTypes']['http_request'] }
        Returns: Database['public']['CompositeTypes']['http_response']
        SetofOptions: {
          from: 'http_request'
          to: 'http_response'
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_delete:
        | {
            Args: { uri: string }
            Returns: Database['public']['CompositeTypes']['http_response']
            SetofOptions: {
              from: '*'
              to: 'http_response'
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: { content: string; content_type: string; uri: string }
            Returns: Database['public']['CompositeTypes']['http_response']
            SetofOptions: {
              from: '*'
              to: 'http_response'
              isOneToOne: true
              isSetofReturn: false
            }
          }
      http_get:
        | {
            Args: { uri: string }
            Returns: Database['public']['CompositeTypes']['http_response']
            SetofOptions: {
              from: '*'
              to: 'http_response'
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: { data: Json; uri: string }
            Returns: Database['public']['CompositeTypes']['http_response']
            SetofOptions: {
              from: '*'
              to: 'http_response'
              isOneToOne: true
              isSetofReturn: false
            }
          }
      http_head: {
        Args: { uri: string }
        Returns: Database['public']['CompositeTypes']['http_response']
        SetofOptions: {
          from: '*'
          to: 'http_response'
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_header: {
        Args: { field: string; value: string }
        Returns: Database['public']['CompositeTypes']['http_header']
        SetofOptions: {
          from: '*'
          to: 'http_header'
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
        Returns: Database['public']['CompositeTypes']['http_response']
        SetofOptions: {
          from: '*'
          to: 'http_response'
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_post:
        | {
            Args: { content: string; content_type: string; uri: string }
            Returns: Database['public']['CompositeTypes']['http_response']
            SetofOptions: {
              from: '*'
              to: 'http_response'
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: { data: Json; uri: string }
            Returns: Database['public']['CompositeTypes']['http_response']
            SetofOptions: {
              from: '*'
              to: 'http_response'
              isOneToOne: true
              isSetofReturn: false
            }
          }
      http_put: {
        Args: { content: string; content_type: string; uri: string }
        Returns: Database['public']['CompositeTypes']['http_response']
        SetofOptions: {
          from: '*'
          to: 'http_response'
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_reset_curlopt: { Args: never; Returns: boolean }
      http_set_curlopt: {
        Args: { curlopt: string; value: string }
        Returns: boolean
      }
      immutable_date_trunc_hour: { Args: { ts: string }; Returns: string }
      increment_api_key_usage: {
        Args: { p_key: string }
        Returns: {
          allowed: boolean
          daily_limit: number
          remaining: number
        }[]
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
      increment_impression_count: {
        Args: { post_id: string }
        Returns: undefined
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
      inspect_group_invite_atomic: {
        Args: {
          p_actor_id: string
          p_group_id: string
          p_pro_free_promo?: boolean
          p_token_hash: string
        }
        Returns: Json
      }
      is_current_user_active_for_direct_messages: {
        Args: never
        Returns: boolean
      }
      is_current_user_channel_member: {
        Args: { p_channel_id: string }
        Returns: boolean
      }
      is_group_admin: { Args: { gid: string; uid: string }; Returns: boolean }
      join_pro_official_group_atomic: {
        Args: { p_actor_id: string; p_owner_id: string }
        Returns: Json
      }
      lease_report_evidence_cleanup: {
        Args: { p_evidence_ref: string; p_reporter_id: string }
        Returns: Json
      }
      lease_stale_report_evidence_cleanup: {
        Args: { p_limit?: number }
        Returns: Json
      }
      lease_stripe_entitlement_effects_atomic: {
        Args: { p_lease_seconds: number; p_limit: number }
        Returns: {
          attempt_count: number
          available_at: string
          completed_at: string | null
          created_at: string
          effect_type: string
          entitlement_payment_id: string | null
          external_ref: string | null
          id: string
          last_error: string | null
          lease_expires_at: string | null
          lease_token: string | null
          operation_key: string
          payload: Json
          source_key: string
          source_kind: string
          status: string
          updated_at: string
          user_id: string | null
        }[]
        SetofOptions: {
          from: '*'
          to: 'stripe_entitlement_effects'
          isOneToOne: false
          isSetofReturn: true
        }
      }
      leave_pro_official_group_atomic: {
        Args: { p_actor_id: string }
        Returns: Json
      }
      lock_actor_can_interact_with_post: {
        Args: { p_actor_id: string; p_post_id: string }
        Returns: boolean
      }
      lock_actor_can_interact_with_post_locked_impl: {
        Args: { p_actor_id: string; p_post_id: string }
        Returns: boolean
      }
      lock_post_interaction_block_edges: {
        Args: {
          p_actor_id: string
          p_post_id: string
          p_target_comment_id?: string | null
        }
        Returns: boolean
      }
      moderate_comment: {
        Args: {
          p_action: string
          p_actor_id: string
          p_comment_id: string
          p_reason?: string
        }
        Returns: {
          affected_count: number
          comment_count: number
          post_id: string
        }[]
      }
      moderate_group_member_atomic: {
        Args: {
          p_action: string
          p_actor_id: string
          p_group_id: string
          p_reason?: string | null
          p_target_id: string
        }
        Returns: Json
      }
      moderate_group_mute_atomic: {
        Args: {
          p_action: string
          p_actor_id: string
          p_group_id: string
          p_muted_until: string | null
          p_operation_id: string
          p_reason: string | null
          p_target_id: string
        }
        Returns: Json
      }
      moderate_report_queue_atomic: {
        Args: {
          p_action: string
          p_actor_id: string
          p_content_id: string
          p_content_type: string
          p_operation_id: string
        }
        Returns: {
          action_taken: string
          applied: boolean
          author_id: string | null
          content_affected_count: number
          content_soft_deleted: boolean | null
          report_count: number
          report_status: string
          result_action: string
          result_content_id: string
          result_content_type: string
          result_operation_id: string
          strike_id: string | null
          strike_type: string | null
        }[]
      }
      moderate_report_queue_atomic_v1_internal: {
        Args: {
          p_action: string
          p_actor_id: string
          p_content_id: string
          p_content_type: string
        }
        Returns: {
          action_taken: string
          applied: boolean
          author_id: string | null
          content_affected_count: number
          content_soft_deleted: boolean | null
          report_count: number
          report_status: string
          result_action: string
          result_content_id: string
          result_content_type: string
          strike_id: string | null
          strike_type: string | null
        }[]
      }
      mutate_collection_item_atomic: {
        Args: {
          p_action: string
          p_actor_id: string
          p_collection_id: string
          p_item_id: string
          p_item_type: string
          p_note?: string | null
        }
        Returns: Json
      }
      mutate_group_join_request_atomic: {
        Args: {
          p_action: string
          p_actor_id: string
          p_answer_text?: string | null
          p_group_id: string
          p_pro_free_promo?: boolean
        }
        Returns: Json
      }
      mutate_group_membership_atomic: {
        Args: {
          p_action: string
          p_actor_id: string
          p_group_id: string
          p_pro_free_promo?: boolean
        }
        Returns: Json
      }
      mutate_user_block_atomic: {
        Args: { p_action: string; p_actor_id: string; p_target_id: string }
        Returns: Json
      }
      mutate_user_collection_atomic: {
        Args: {
          p_action: string
          p_actor_id: string
          p_collection_id: string | null
          p_description: string | null
          p_description_present: boolean
          p_is_public: boolean | null
          p_is_public_present: boolean
          p_name: string | null
          p_name_present: boolean
        }
        Returns: Json
      }
      mutate_user_follow_atomic: {
        Args: { p_action: string; p_actor_id: string; p_target_id: string }
        Returns: Json
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
      purge_deleted_account_group_edges: {
        Args: { p_user_id: string }
        Returns: Json
      }
      qa_schema_inventory: { Args: never; Returns: Json }
      read_group_subscription_atomic: {
        Args: { p_actor_id: string; p_group_id: string }
        Returns: Json
      }
      recalculate_direct_message_conversation_summary: {
        Args: { p_conversation_id: string }
        Returns: boolean
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
      reconcile_due_pro_entitlement_projections_atomic: {
        Args: { p_after_user_id: string | null; p_limit: number }
        Returns: Json
      }
      reconcile_recurring_subscription_state_atomic: {
        Args: {
          p_cancel_at_period_end: boolean
          p_canceled_at: string | null
          p_current_invoice_id: string | null
          p_event_created_at: string
          p_event_id: string
          p_grace_expires_at: string | null
          p_period_end: string
          p_period_start: string
          p_plan: string
          p_stripe_customer_id: string
          p_stripe_status: string
          p_stripe_subscription_id: string
          p_user_id: string
        }
        Returns: Json
      }
      reconcile_stripe_entitlement_refund_atomic: {
        Args: {
          p_amount_paid: number
          p_checkout_session_id: string | null
          p_currency: string
          p_payment_kind: string
          p_payment_status: string
          p_period_end: string | null
          p_period_start: string
          p_plan: string
          p_refund_event_created_at: string
          p_refund_event_id: string
          p_refund_state: string
          p_refund_succeeded_amount: number
          p_stripe_charge_id: string
          p_stripe_customer_id: string
          p_stripe_invoice_id: string | null
          p_stripe_payment_intent_id: string | null
          p_stripe_subscription_id: string | null
          p_stripe_subscription_status: string | null
          p_user_id: string | null
        }
        Returns: Json
      }
      record_charge_refund_tombstone_atomic: {
        Args: {
          p_amount_paid: number
          p_captured: boolean
          p_currency: string
          p_refund_event_created_at: string
          p_refund_event_id: string
          p_refund_state: string
          p_refund_succeeded_amount: number
          p_stripe_charge_id: string
          p_stripe_customer_id: string
          p_stripe_payment_intent_id: string | null
          p_user_id: string | null
        }
        Returns: Json
      }
      record_charge_refund_tombstone_financial_legacy_v2: {
        Args: {
          p_amount_paid: number
          p_captured: boolean
          p_currency: string
          p_refund_event_created_at: string
          p_refund_event_id: string
          p_refund_state: string
          p_refund_succeeded_amount: number
          p_stripe_charge_id: string
          p_stripe_customer_id: string
          p_stripe_payment_intent_id: string
          p_user_id: string
        }
        Returns: Json
      }
      record_post_impression: {
        Args: { p_metadata?: Json | null; p_post_id: string; p_user_id: string }
        Returns: boolean
      }
      record_rejected_writes: { Args: { p_rows: Json }; Returns: undefined }
      record_stripe_manual_review_atomic: {
        Args: {
          p_context: Json
          p_object_id: string
          p_object_type: string
          p_reason: string
          p_reason_key: string
          p_user_id: string | null
        }
        Returns: Json
      }
      record_user_activity: {
        Args: { p_seen_at?: string; p_user_id: string }
        Returns: undefined
      }
      recount_all_follow_counts: {
        Args: never
        Returns: {
          updated_count: number
        }[]
      }
      recount_hashtag_posts: {
        Args: { hashtag_ids: string[] }
        Returns: undefined
      }
      redeem_group_invite_atomic: {
        Args: {
          p_actor_id: string
          p_group_id: string
          p_pro_free_promo?: boolean
          p_token_hash: string
        }
        Returns: Json
      }
      refresh_hot_scores: { Args: never; Returns: undefined }
      refresh_hot_scores_incremental: { Args: never; Returns: number }
      refresh_leaderboard_count_cache: { Args: never; Returns: undefined }
      refresh_materialized_views: { Args: never; Returns: undefined }
      refresh_popular_tokens_mv: { Args: never; Returns: undefined }
      refresh_source_capabilities_mv: { Args: never; Returns: undefined }
      release_leaderboard_lock: { Args: { season: string }; Returns: boolean }
      release_lifetime_membership_reservation_atomic: {
        Args: {
          p_checkout_session_id: string | null
          p_event_created_at: string | null
          p_event_id: string | null
          p_release_reason: string
          p_request_nonce: string
          p_reservation_id: string
          p_user_id: string
        }
        Returns: Json
      }
      release_report_evidence_cleanup: {
        Args: {
          p_evidence_ref: string
          p_lease_token: string
          p_reporter_id: string
        }
        Returns: boolean
      }
      release_stale_locks: { Args: never; Returns: number }
      rerank_leaderboard: { Args: { p_season_id: string }; Returns: number }
      reserve_lifetime_membership_spot_atomic: {
        Args: {
          p_request_nonce: string
          p_ttl_seconds: number
          p_user_id: string
        }
        Returns: Json
      }
      reserve_report_evidence_upload: {
        Args: {
          p_extension: string
          p_mime_type: string
          p_reporter_id: string
        }
        Returns: Json
      }
      reset_api_key_daily_counts: { Args: never; Returns: undefined }
      reset_daily_api_calls: { Args: never; Returns: undefined }
      reset_monthly_usage: { Args: never; Returns: undefined }
      resolve_content_report_atomic: {
        Args: {
          p_action: string
          p_actor_id: string
          p_reason: string | null
          p_report_id: string
        }
        Returns: {
          action_taken: string
          admin_log_id: string
          applied: boolean
          content_affected_count: number
          content_id: string
          content_soft_deleted: boolean | null
          content_type: string
          report_id: string
          report_status: string
          result_action: string
          result_code: string
        }[]
      }
      restore_pending_account: {
        Args: { p_recovery_token_hash?: string; p_user_id: string }
        Returns: string
      }
      review_group_application_atomic: {
        Args: {
          p_application_id: string
          p_decision: string
          p_operation_id?: string | null
          p_promo_unlocked?: boolean
          p_reject_reason?: string | null
          p_reviewer_id: string
        }
        Returns: Json
      }
      review_group_edit_application_atomic: {
        Args: {
          p_application_id: string
          p_decision: string
          p_operation_id: string
          p_reject_reason: string | null
          p_reviewer_id: string
        }
        Returns: Json
      }
      review_group_join_request_atomic: {
        Args: { p_actor_id: string; p_decision: string; p_request_id: string }
        Returns: Json
      }
      revoke_group_invite_atomic: {
        Args: { p_actor_id: string; p_group_id: string; p_invite_id: string }
        Returns: Json
      }
      revoke_pro_entitlement_grant_atomic: {
        Args: {
          p_revoked_at: string
          p_source: string
          p_source_key: string
          p_user_id: string
        }
        Returns: Json
      }
      rollup_api_key_usage: { Args: never; Returns: undefined }
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
      schedule_account_deletion: {
        Args: {
          p_reason: string
          p_recovery_token_hash: string
          p_scheduled_at: string
          p_user_id: string
        }
        Returns: string
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
      send_direct_message_atomic: {
        Args: {
          p_content: string
          p_media_name?: string | null
          p_media_type?: string | null
          p_media_url?: string | null
          p_receiver_id: string
          p_reply_to_id?: string | null
          p_sender_id: string
        }
        Returns: Json
      }
      service_actor_has_current_global_pro_entitlement: {
        Args: { p_actor_id: string }
        Returns: boolean
      }
      service_actor_has_current_group_entitlement: {
        Args: { p_actor_id: string; p_group_id: string }
        Returns: boolean
      }
      set_primary_linked_trader: {
        Args: { p_link_id: string; p_user_id: string }
        Returns: {
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
        SetofOptions: {
          from: '*'
          to: 'user_linked_traders'
          isOneToOne: true
          isSetofReturn: false
        }
      }
      snapshot_score_backtest: { Args: never; Returns: number }
      stripe_entitlement_effect_is_current_v2: {
        Args: { p_effect_id: string }
        Returns: boolean
      }
      stripe_has_current_pro_authority_v2: {
        Args: { p_actor_id: string }
        Returns: boolean
      }
      stripe_legacy_snapshot_grant_is_exact_v2: {
        Args: { p_grant_id: string }
        Returns: boolean
      }
      stripe_lifetime_claimed_seat_count_v2: { Args: never; Returns: number }
      stripe_merge_charge_refund_tombstone_v2: {
        Args: { p_payment_id: string }
        Returns: Json
      }
      stripe_paid_launch_readiness_entitlement_only_legacy_v2: {
        Args: never
        Returns: Json
      }
      stripe_paid_launch_readiness_v2: { Args: never; Returns: Json }
      stripe_payment_ownership_is_exact_v2: {
        Args: { p_ownership_id: string }
        Returns: boolean
      }
      stripe_refund_tombstone_is_resolved_v2: {
        Args: { p_stripe_charge_id: string }
        Returns: boolean
      }
      stripe_resolve_non_entitlement_refund_tombstone_atomic: {
        Args: { p_ownership_id: string }
        Returns: Json
      }
      stripe_subscription_has_exact_payment_binding_v2: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      stripe_subscription_has_exact_trial_binding_v2: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      submit_content_report: {
        Args: {
          p_content_id: string
          p_content_type: string
          p_description?: string | null
          p_images?: string[]
          p_reason: string
          p_reporter_id: string
        }
        Returns: Json
      }
      submit_group_application_atomic: {
        Args: {
          p_actor_id: string
          p_avatar_url?: string | null
          p_description?: string | null
          p_description_en?: string | null
          p_is_premium_only?: boolean
          p_name: string
          p_name_en?: string | null
          p_operation_id?: string | null
          p_promo_unlocked?: boolean
          p_role_names?: Json | null
          p_rules?: string | null
          p_rules_json?: Json | null
        }
        Returns: Json
      }
      submit_group_edit_application_atomic: {
        Args: {
          p_actor_id: string
          p_avatar_url: string | null
          p_description: string | null
          p_description_en: string | null
          p_group_id: string
          p_is_premium_only: boolean
          p_name: string
          p_name_en: string | null
          p_operation_id: string
          p_role_names: Json | null
          p_rules: string | null
          p_rules_json: Json | null
        }
        Returns: Json
      }
      submit_trader_claim: {
        Args: {
          p_source: string
          p_trader_id: string
          p_user_id: string
          p_verification_data: Json
          p_verification_method: string
        }
        Returns: {
          created_at: string
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
        SetofOptions: {
          from: '*'
          to: 'trader_claims'
          isOneToOne: true
          isSetofReturn: false
        }
      }
      sync_current_pro_projection_atomic: {
        Args: { p_user_id: string }
        Returns: boolean
      }
      text_to_bytea: { Args: { data: string }; Returns: string }
      toggle_comment_reaction: {
        Args: {
          p_comment_id: string
          p_post_id: string
          p_reaction_type?: string
          p_user_id: string
        }
        Returns: Json
      }
      toggle_comment_reaction_locked_impl: {
        Args: {
          p_comment_id: string
          p_post_id: string
          p_reaction_type?: string
          p_user_id: string
        }
        Returns: Json
      }
      toggle_post_bookmark_atomic: {
        Args: { p_actor_id: string; p_folder_id?: string | null; p_post_id: string }
        Returns: Json
      }
      toggle_post_emoji_reaction_atomic: {
        Args: { p_actor_id: string; p_emoji: string; p_post_id: string }
        Returns: Json
      }
      toggle_post_reaction: {
        Args: { p_post_id: string; p_reaction_type?: string; p_user_id: string }
        Returns: Json
      }
      toggle_post_vote_atomic: {
        Args: { p_actor_id: string; p_choice: string; p_post_id: string }
        Returns: Json
      }
      trunc_hour: { Args: { ts: string }; Returns: string }
      unlink_linked_trader: {
        Args: { p_link_id: string; p_user_id: string }
        Returns: {
          promoted_link_id: string
          remaining_count: number
          removed_source: string
          removed_trader_id: string
        }[]
      }
      update_own_comment: {
        Args: {
          p_comment_id: string
          p_content: string
          p_post_id: string
          p_user_id: string
        }
        Returns: {
          author_handle: string | null
          author_id: string | null
          content: string
          created_at: string | null
          delete_reason: string | null
          deleted_at: string | null
          deleted_by: string | null
          dislike_count: number
          id: string
          like_count: number
          parent_id: string | null
          post_id: string
          ranking_score: number
          updated_at: string | null
          user_id: string
        }[]
        SetofOptions: {
          from: '*'
          to: 'comments'
          isOneToOne: false
          isSetofReturn: true
        }
      }
      update_own_comment_locked_impl: {
        Args: {
          p_comment_id: string
          p_content: string
          p_post_id: string
          p_user_id: string
        }
        Returns: {
          author_handle: string | null
          author_id: string | null
          content: string
          created_at: string | null
          delete_reason: string | null
          deleted_at: string | null
          deleted_by: string | null
          dislike_count: number
          id: string
          like_count: number
          parent_id: string | null
          post_id: string
          ranking_score: number
          updated_at: string | null
          user_id: string
        }[]
        SetofOptions: {
          from: '*'
          to: 'comments'
          isOneToOne: false
          isSetofReturn: true
        }
      }
      update_post_report_counts: { Args: never; Returns: number }
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
      update_user_api_tier: {
        Args: {
          p_api_tier: string
          p_daily_limit: number
          p_stripe_subscription_id: string
          p_user_id: string
        }
        Returns: undefined
      }
      upsert_pro_entitlement_grant_atomic: {
        Args: {
          p_expires_at: string | null
          p_metadata: Json
          p_source: string
          p_source_key: string
          p_starts_at: string
          p_user_id: string
        }
        Returns: Json
      }
      urlencode:
        | { Args: { data: Json }; Returns: string }
        | {
            Args: { string: string }
            Returns: {
              error: true
            } & 'Could not choose the best candidate function between: public.urlencode(string => bytea), public.urlencode(string => varchar). Try renaming the parameters or the function itself in the database so function overloading can be resolved'
          }
        | {
            Args: { string: string }
            Returns: {
              error: true
            } & 'Could not choose the best candidate function between: public.urlencode(string => bytea), public.urlencode(string => varchar). Try renaming the parameters or the function itself in the database so function overloading can be resolved'
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
      gift_asset: 'fiat' | 'token'
      group_visibility: 'open' | 'apply'
      member_role: 'owner' | 'admin' | 'member'
      post_status: 'active' | 'locked' | 'deleted'
      report_reason: 'spam' | 'scam' | 'harassment' | 'illegal' | 'other'
    }
    CompositeTypes: {
      http_header: {
        field: string | null
        value: string | null
      }
      http_request: {
        method: unknown
        uri: string | null
        headers: Database['public']['CompositeTypes']['http_header'][] | null
        content_type: string | null
        content: string | null
      }
      http_response: {
        status: number | null
        content_type: string | null
        headers: Database['public']['CompositeTypes']['http_header'][] | null
        content: string | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema['Enums']
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema['CompositeTypes']
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      gift_asset: ['fiat', 'token'],
      group_visibility: ['open', 'apply'],
      member_role: ['owner', 'admin', 'member'],
      post_status: ['active', 'locked', 'deleted'],
      report_reason: ['spam', 'scam', 'harassment', 'illegal', 'other'],
    },
  },
} as const
