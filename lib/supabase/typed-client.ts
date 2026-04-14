/**
 * Type helpers for Supabase Database types.
 *
 * Usage:
 *   import type { TypedSupabaseClient, Row, Insert, Update } from '@/lib/supabase/typed-client'
 *
 *   // Get a row type for a table:
 *   type Trader = Row<'trader_sources'>
 *
 *   // Get an insert type:
 *   type NewTrader = Insert<'trader_sources'>
 *
 *   // Get an update type:
 *   type TraderUpdate = Update<'trader_sources'>
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

/** Supabase client with full Database type information */
export type TypedSupabaseClient = SupabaseClient<Database>

/** All public tables */
export type Tables = Database['public']['Tables']

/** All public views */
export type Views = Database['public']['Views']

/** Valid table names */
export type TableName = keyof Tables

/** Row type for a given table */
export type Row<T extends TableName> = Tables[T]['Row']

/** Insert type for a given table */
export type Insert<T extends TableName> = Tables[T]['Insert']

/** Update type for a given table */
export type Update<T extends TableName> = Tables[T]['Update']

/** All public enums */
export type Enums = Database['public']['Enums']

/** Get the type of a specific enum */
export type EnumType<T extends keyof Enums> = Enums[T]
