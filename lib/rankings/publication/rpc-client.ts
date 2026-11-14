/**
 * The structural RPC surface the publication modules need.
 *
 * Every module dispatches through `Reflect.apply(rpc, client, [name, args])`
 * and validates the response envelope itself, so the only static requirement
 * is "has a callable `rpc`". Both the Supabase service client (route side) and
 * the transaction-bound PostgreSQL adapter in `pg-rpc-client.ts` (worker side)
 * satisfy it without a type cast.
 */
export interface PublicationRpcClient {
  readonly rpc: (...args: never[]) => unknown
}
