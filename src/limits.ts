/** Default per-member summary retained in the durable handoff. */
export const DEFAULT_HANDOFF_SUMMARY_MAX_CHARS = 16_000
/** Smallest useful configurable handoff summary. */
export const MIN_HANDOFF_SUMMARY_MAX_CHARS = 1_000
/** Hard ceiling that keeps one member from dominating stored/model-facing context. */
export const MAX_HANDOFF_SUMMARY_MAX_CHARS = 32_000
