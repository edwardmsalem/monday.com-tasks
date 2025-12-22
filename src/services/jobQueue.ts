/**
 * File-based Job Queue for Retry Operations
 *
 * Provides durable, persistent retry logic for failed operations.
 * Jobs survive server restarts and are processed with exponential backoff.
 *
 * Supported job types:
 * - monday_file_upload: Retry file uploads to Monday.com
 * - slack_notification: Retry Slack message sends
 * - pdf_conversion: Retry PDF conversions
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import {
  RETRY_DELAYS_MS,
  MAX_RETRY_ATTEMPTS,
  JOB_QUEUE_PROCESS_INTERVAL_MS,
} from '../config/constants.js';

// ============================================================================
// Types
// ============================================================================

export interface Job {
  id: string;
  type: 'monday_file_upload' | 'slack_notification' | 'pdf_conversion';
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;        // timestamp
  createdAt: number;          // timestamp
  lastError?: string;
  lastAttemptAt?: number;     // timestamp
  status: 'pending' | 'failed';  // failed = exceeded max attempts
}

export interface JobQueueConfig {
  maxAttempts?: number;        // default: 4
  retryDelays?: number[];      // default: [60000, 300000, 900000, 3600000] (1m, 5m, 15m, 1hr)
}

interface JobQueueState {
  jobs: Job[];
  savedAt: number;
}

export interface QueueStats {
  pending: number;
  failed: number;
  byType: Record<string, number>;
}

export type JobProcessor = (payload: Record<string, unknown>) => Promise<void>;

// ============================================================================
// Constants
// ============================================================================

const DATA_DIR = './data';
const QUEUE_FILE = `${DATA_DIR}/job-queue.json`;

// Use centralized constants for retry configuration
const DEFAULT_RETRY_DELAYS = [...RETRY_DELAYS_MS];
const DEFAULT_MAX_ATTEMPTS = MAX_RETRY_ATTEMPTS;
const PROCESS_INTERVAL_MS = JOB_QUEUE_PROCESS_INTERVAL_MS;

// ============================================================================
// State
// ============================================================================

let jobs: Job[] = [];
let processInterval: NodeJS.Timeout | null = null;
let isProcessing = false;

// Job processors registry - will be populated by registerProcessor
const processors: Map<Job['type'], JobProcessor> = new Map();

// ============================================================================
// File Operations
// ============================================================================

function ensureDataDirectory(): void {
  if (!existsSync(DATA_DIR)) {
    const { mkdirSync } = require('fs');
    mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[JobQueue] Created data directory: ${DATA_DIR}`);
  }
}

function loadJobs(): Job[] {
  try {
    if (!existsSync(QUEUE_FILE)) {
      return [];
    }
    const content = readFileSync(QUEUE_FILE, 'utf-8');
    const state = JSON.parse(content) as JobQueueState;
    console.log(`[JobQueue] Loaded ${state.jobs.length} jobs from disk`);
    return state.jobs;
  } catch (error) {
    console.error('[JobQueue] Failed to load jobs (starting fresh):', error);
    return [];
  }
}

function saveJobs(): void {
  try {
    ensureDataDirectory();
    const state: JobQueueState = {
      jobs,
      savedAt: Date.now(),
    };
    writeFileSync(QUEUE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    console.error('[JobQueue] Failed to save jobs:', error);
  }
}

// ============================================================================
// Retry Delay Calculation
// ============================================================================

/**
 * Get the delay before the next retry attempt
 * Uses the delays array, capping at the last value for additional attempts
 */
function getNextRetryDelay(attempts: number, delays: number[] = DEFAULT_RETRY_DELAYS): number {
  return delays[Math.min(attempts, delays.length - 1)];
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Register a processor for a job type
 * Must be called before jobs of that type can be processed
 */
export function registerProcessor(type: Job['type'], processor: JobProcessor): void {
  processors.set(type, processor);
  console.log(`[JobQueue] Registered processor for type: ${type}`);
}

/**
 * Add a job to the queue
 * Returns the job ID for tracking
 */
export function addJob(
  type: Job['type'],
  payload: Record<string, unknown>,
  config?: JobQueueConfig
): string {
  const id = randomUUID();
  const now = Date.now();
  const maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelays = config?.retryDelays ?? DEFAULT_RETRY_DELAYS;

  const job: Job = {
    id,
    type,
    payload,
    attempts: 0,
    maxAttempts,
    nextRetryAt: now + getNextRetryDelay(0, retryDelays),
    createdAt: now,
    status: 'pending',
  };

  jobs.push(job);
  saveJobs();

  console.log(`[JobQueue] Added job ${id} (${type}) - retry at ${new Date(job.nextRetryAt).toISOString()}`);
  return id;
}

/**
 * Process all jobs that are ready for retry
 * Called automatically every 60 seconds
 */
export async function processJobs(): Promise<void> {
  if (isProcessing) {
    console.log('[JobQueue] Already processing, skipping');
    return;
  }

  isProcessing = true;
  const now = Date.now();

  // Find jobs ready for processing
  const readyJobs = jobs.filter(
    job => job.status === 'pending' && job.nextRetryAt <= now
  );

  if (readyJobs.length === 0) {
    isProcessing = false;
    return;
  }

  console.log(`[JobQueue] Processing ${readyJobs.length} ready job(s)`);

  for (const job of readyJobs) {
    const processor = processors.get(job.type);

    if (!processor) {
      console.error(`[JobQueue] No processor registered for type: ${job.type}`);
      continue;
    }

    try {
      console.log(`[JobQueue] Processing job ${job.id} (${job.type}) - attempt ${job.attempts + 1}/${job.maxAttempts}`);

      await processor(job.payload);

      // Success - remove job from queue
      console.log(`[JobQueue] Job ${job.id} completed successfully`);
      jobs = jobs.filter(j => j.id !== job.id);
      saveJobs();

    } catch (error) {
      // Failure - update job for retry
      job.attempts++;
      job.lastAttemptAt = now;
      job.lastError = error instanceof Error ? error.message : String(error);

      if (job.attempts >= job.maxAttempts) {
        // Exceeded max attempts - mark as failed
        job.status = 'failed';
        console.error(`[JobQueue] Job ${job.id} failed permanently after ${job.attempts} attempts: ${job.lastError}`);
      } else {
        // Schedule next retry
        const delay = getNextRetryDelay(job.attempts);
        job.nextRetryAt = now + delay;
        console.warn(
          `[JobQueue] Job ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}), ` +
          `retrying in ${Math.round(delay / 1000)}s: ${job.lastError}`
        );
      }

      saveJobs();
    }
  }

  isProcessing = false;
}

/**
 * Get queue statistics
 */
export function getQueueStats(): QueueStats {
  const pending = jobs.filter(j => j.status === 'pending').length;
  const failed = jobs.filter(j => j.status === 'failed').length;

  const byType: Record<string, number> = {};
  for (const job of jobs) {
    byType[job.type] = (byType[job.type] ?? 0) + 1;
  }

  return { pending, failed, byType };
}

/**
 * Get all failed jobs (for manual inspection/retry)
 */
export function getFailedJobs(): Job[] {
  return jobs.filter(j => j.status === 'failed');
}

/**
 * Get all pending jobs
 */
export function getPendingJobs(): Job[] {
  return jobs.filter(j => j.status === 'pending');
}

/**
 * Manually retry a failed job
 * Resets attempts and schedules for immediate processing
 */
export function retryJob(jobId: string): boolean {
  const job = jobs.find(j => j.id === jobId);

  if (!job) {
    console.warn(`[JobQueue] Job ${jobId} not found`);
    return false;
  }

  job.attempts = 0;
  job.status = 'pending';
  job.nextRetryAt = Date.now();
  job.lastError = undefined;
  job.lastAttemptAt = undefined;

  saveJobs();
  console.log(`[JobQueue] Job ${jobId} reset for retry`);
  return true;
}

/**
 * Remove a job from the queue entirely
 */
export function removeJob(jobId: string): boolean {
  const initialLength = jobs.length;
  jobs = jobs.filter(j => j.id !== jobId);

  if (jobs.length < initialLength) {
    saveJobs();
    console.log(`[JobQueue] Job ${jobId} removed`);
    return true;
  }

  console.warn(`[JobQueue] Job ${jobId} not found`);
  return false;
}

/**
 * Clear all failed jobs
 */
export function clearFailedJobs(): number {
  const failedCount = jobs.filter(j => j.status === 'failed').length;
  jobs = jobs.filter(j => j.status !== 'failed');
  saveJobs();
  console.log(`[JobQueue] Cleared ${failedCount} failed jobs`);
  return failedCount;
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Initialize the job queue
 * Loads existing jobs and starts the processing interval
 */
export function initializeJobQueue(): void {
  ensureDataDirectory();
  jobs = loadJobs();

  const stats = getQueueStats();
  console.log(`[JobQueue] Initialized with ${stats.pending} pending, ${stats.failed} failed jobs`);

  // Start processing interval
  if (!processInterval) {
    processInterval = setInterval(() => {
      processJobs().catch(err => {
        console.error('[JobQueue] Error processing jobs:', err);
      });
    }, PROCESS_INTERVAL_MS);

    console.log(`[JobQueue] Started processing interval (every ${PROCESS_INTERVAL_MS / 1000}s)`);
  }

  // Process immediately on startup (after a short delay to allow processors to register)
  setTimeout(() => {
    processJobs().catch(err => {
      console.error('[JobQueue] Error in initial job processing:', err);
    });
  }, 5000);
}

/**
 * Stop the job queue processing
 */
export function stopJobQueue(): void {
  if (processInterval) {
    clearInterval(processInterval);
    processInterval = null;
    console.log('[JobQueue] Stopped processing interval');
  }
}

/**
 * Get a specific job by ID
 */
export function getJob(jobId: string): Job | undefined {
  return jobs.find(j => j.id === jobId);
}
