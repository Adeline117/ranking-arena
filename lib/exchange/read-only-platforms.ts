/**
 * Client-safe exchange capability registry.
 *
 * A platform belongs in READ_ONLY_ACCESS_PLATFORMS only after its own API can
 * prove the submitted credential has no trading, withdrawal, or transfer
 * capability. API_KEY_CONNECTION_PLATFORMS additionally requires the legacy
 * exchange sync route to have a working adapter.
 */
export const READ_ONLY_ACCESS_PLATFORMS = ['binance', 'bybit', 'okx', 'bitget'] as const

export const API_KEY_CONNECTION_PLATFORMS = ['binance', 'bybit', 'bitget'] as const

export type ReadOnlyAccessPlatform = (typeof READ_ONLY_ACCESS_PLATFORMS)[number]
export type ApiKeyConnectionPlatform = (typeof API_KEY_CONNECTION_PLATFORMS)[number]
