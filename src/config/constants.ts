/**
 * Centralized Constants
 *
 * All hardcoded values that control timing, limits, and thresholds.
 * Organized by category for easy discovery and maintenance.
 */

// ============================================================================
// API Timeouts
// ============================================================================

/** Timeout for Monday.com API calls (prevents hanging requests) */
export const MONDAY_API_TIMEOUT_MS = 30_000; // 30 seconds

/** Timeout for health check API calls (quick validation) */
export const HEALTH_CHECK_TIMEOUT_MS = 10_000; // 10 seconds

// ============================================================================
// Retry Configuration
// ============================================================================

/**
 * Delays between retry attempts for failed operations.
 * Progressive backoff: 1 minute → 5 minutes → 15 minutes → 1 hour
 */
export const RETRY_DELAYS_MS = [
  60 * 1000,      // 1 minute
  5 * 60 * 1000,  // 5 minutes
  15 * 60 * 1000, // 15 minutes
  60 * 60 * 1000, // 1 hour
] as const;

/** Maximum number of retry attempts before marking as permanently failed */
export const MAX_RETRY_ATTEMPTS = 4;

// ============================================================================
// Cache TTLs
// ============================================================================

/** Health check result cache duration (prevents excessive API calls) */
export const HEALTH_CHECK_CACHE_TTL_MS = 30 * 1000; // 30 seconds

/** Idempotency key expiration (prevents duplicate processing) */
export const IDEMPOTENCY_KEY_TTL_MS = 60 * 60 * 1000; // 1 hour

/** User mapping cache duration (balances freshness vs API calls) */
export const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Slack config cache duration (channel lookups, etc.) */
export const SLACK_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Cleanup Intervals
// ============================================================================

/** How often to clean expired idempotency keys */
export const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** How often to clean expired pending states */
export const PENDING_STATE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** How often to process the job queue for retries */
export const JOB_QUEUE_PROCESS_INTERVAL_MS = 60 * 1000; // 1 minute

/** How often to run the follow-up scheduler */
export const FOLLOW_UP_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ============================================================================
// State TTLs
// ============================================================================

/** Pending task conversation timeout (interactive selection) */
export const PENDING_TASK_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Pending email selection timeout */
export const PENDING_EMAIL_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Cooldown before sending another DM to same user */
export const DM_COOLDOWN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================================
// Circuit Breaker Configuration
// ============================================================================

/** Failures before opening circuit for critical services (Monday, Slack) */
export const CIRCUIT_BREAKER_THRESHOLD_HIGH = 5;

/** Failures before opening circuit for less critical services (Gmail, Calendar) */
export const CIRCUIT_BREAKER_THRESHOLD_LOW = 3;

/** Failures before opening circuit for medium priority services (Claude) */
export const CIRCUIT_BREAKER_THRESHOLD_MEDIUM = 4;

/** Time before attempting to close circuit for critical services */
export const CIRCUIT_BREAKER_RESET_MS_LONG = 60_000; // 1 minute

/** Time before attempting to close circuit for less critical services */
export const CIRCUIT_BREAKER_RESET_MS_SHORT = 30_000; // 30 seconds

/** Time before attempting to close circuit for Claude */
export const CIRCUIT_BREAKER_RESET_MS_MEDIUM = 45_000; // 45 seconds

// ============================================================================
// Rate Limiting
// ============================================================================

/** Delay between Slack message releases (avoid rate limits) */
export const SLACK_RELEASE_DELAY_MS = 1_000; // 1 second

/** Cooldown before sending repeat overdue reminders */
export const REPEAT_REMINDER_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours

// ============================================================================
// File Limits
// ============================================================================

/** Maximum email attachment size */
export const MAX_EMAIL_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

// ============================================================================
// Slack Verification
// ============================================================================

/** Maximum age of Slack request timestamp (prevents replay attacks) */
export const SLACK_TIMESTAMP_MAX_AGE_SECONDS = 60 * 5; // 5 minutes

// ============================================================================
// AI Configuration
// ============================================================================

/** Maximum tokens for Claude task parsing responses */
export const CLAUDE_MAX_TOKENS = 1024;
