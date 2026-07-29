/**
 * Direct Tier-A execution is intentionally disabled.
 *
 * Tier-A serving writes now require the production worker's composite region
 * authority. This scripts/** path is not part of the attested worker release,
 * so letting it manufacture or borrow that authority would make the roster's
 * release identity untrue and could bypass native-region startup gates.
 *
 * Run Tier-A through the region-owned BullMQ worker. A future manual driver
 * must live under worker/**, carry a complete job identity, use exact-cycle
 * smoke cleanup, and participate in the normal signal/drain lifecycle.
 */

throw new Error(
  '[ingest-test] direct Tier-A execution is disabled; use the region-authorized worker queue'
)
