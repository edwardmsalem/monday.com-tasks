/**
 * Circuit Breaker Pattern
 *
 * Prevents cascading failures when external APIs are down.
 * Instead of repeatedly hitting a failing service, the circuit "opens"
 * and rejects calls immediately, allowing the service time to recover.
 *
 * State transitions:
 * - CLOSED → OPEN: when failures >= threshold
 * - OPEN → HALF_OPEN: after resetTimeoutMs passes
 * - HALF_OPEN → CLOSED: if test calls succeed
 * - HALF_OPEN → OPEN: if test call fails
 */

// ============================================================================
// Types
// ============================================================================

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  name: string;
  failureThreshold: number;     // failures before opening (default: 5)
  resetTimeoutMs: number;       // time before trying again (default: 60000)
  halfOpenMaxCalls: number;     // test calls in half-open (default: 3)
}

export interface CircuitStats {
  failures: number;
  successes: number;
  state: CircuitState;
  lastFailure?: Date;
  lastSuccess?: Date;
  openedAt?: Date;
}

// ============================================================================
// Custom Errors
// ============================================================================

/**
 * Error thrown when a call is rejected because the circuit is OPEN
 */
export class CircuitOpenError extends Error {
  public readonly circuitName: string;

  constructor(circuitName: string) {
    super(`Circuit breaker '${circuitName}' is OPEN - service unavailable`);
    this.name = 'CircuitOpenError';
    this.circuitName = circuitName;
  }
}

// ============================================================================
// Circuit Breaker Implementation
// ============================================================================

export class CircuitBreaker {
  private readonly config: Required<CircuitBreakerConfig>;
  private state: CircuitState = 'CLOSED';
  private failures: number = 0;
  private successes: number = 0;
  private halfOpenCalls: number = 0;
  private lastFailure?: Date;
  private lastSuccess?: Date;
  private openedAt?: Date;

  constructor(config: Partial<CircuitBreakerConfig> & { name: string }) {
    this.config = {
      name: config.name,
      failureThreshold: config.failureThreshold ?? 5,
      resetTimeoutMs: config.resetTimeoutMs ?? 60000,
      halfOpenMaxCalls: config.halfOpenMaxCalls ?? 3,
    };
  }

  /**
   * Execute a function through the circuit breaker
   * @throws CircuitOpenError if circuit is OPEN
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.transitionTo('HALF_OPEN');
      } else {
        console.log(`[CircuitBreaker] Call rejected - circuit '${this.config.name}' is OPEN`);
        throw new CircuitOpenError(this.config.name);
      }
    }

    // In HALF_OPEN, limit the number of test calls
    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenCalls >= this.config.halfOpenMaxCalls) {
        console.log(`[CircuitBreaker] Call rejected - circuit '${this.config.name}' is HALF_OPEN (max test calls reached)`);
        throw new CircuitOpenError(this.config.name);
      }
      this.halfOpenCalls++;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    // Check for automatic transition from OPEN to HALF_OPEN
    if (this.state === 'OPEN' && this.shouldAttemptReset()) {
      this.transitionTo('HALF_OPEN');
    }
    return this.state;
  }

  /**
   * Get circuit statistics
   */
  getStats(): CircuitStats {
    return {
      failures: this.failures,
      successes: this.successes,
      state: this.getState(),
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess,
      openedAt: this.openedAt,
    };
  }

  /**
   * Manually reset the circuit (for testing)
   */
  reset(): void {
    console.log(`[CircuitBreaker] Circuit '${this.config.name}' manually reset`);
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.halfOpenCalls = 0;
    this.openedAt = undefined;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private recordSuccess(): void {
    this.lastSuccess = new Date();
    this.successes++;

    if (this.state === 'HALF_OPEN') {
      // In HALF_OPEN, successes close the circuit
      this.transitionTo('CLOSED');
    } else if (this.state === 'CLOSED') {
      // In CLOSED, reset failure count on success
      this.failures = 0;
    }
  }

  private recordFailure(): void {
    this.lastFailure = new Date();
    this.failures++;

    if (this.state === 'HALF_OPEN') {
      // In HALF_OPEN, any failure opens the circuit
      this.transitionTo('OPEN');
    } else if (this.state === 'CLOSED') {
      // In CLOSED, check if we should open
      if (this.failures >= this.config.failureThreshold) {
        this.transitionTo('OPEN');
      }
    }
  }

  private shouldAttemptReset(): boolean {
    if (!this.openedAt) return false;
    const elapsed = Date.now() - this.openedAt.getTime();
    return elapsed >= this.config.resetTimeoutMs;
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    switch (newState) {
      case 'OPEN':
        this.openedAt = new Date();
        this.halfOpenCalls = 0;
        console.log(
          `[CircuitBreaker] Circuit '${this.config.name}' OPENED after ${this.failures} failures ` +
          `(will retry in ${this.config.resetTimeoutMs / 1000}s)`
        );
        break;

      case 'HALF_OPEN':
        this.halfOpenCalls = 0;
        console.log(
          `[CircuitBreaker] Circuit '${this.config.name}' HALF_OPEN - testing with ${this.config.halfOpenMaxCalls} calls`
        );
        break;

      case 'CLOSED':
        this.failures = 0;
        this.openedAt = undefined;
        this.halfOpenCalls = 0;
        if (oldState !== 'CLOSED') {
          console.log(`[CircuitBreaker] Circuit '${this.config.name}' CLOSED - service recovered`);
        }
        break;
    }
  }
}

// ============================================================================
// Pre-configured Circuit Breaker Instances
// ============================================================================

/**
 * Monday.com API circuit breaker
 * - Higher threshold since it's critical
 * - Longer timeout for rate limit recovery
 */
export const mondayCircuit = new CircuitBreaker({
  name: 'monday',
  failureThreshold: 5,
  resetTimeoutMs: 60000,  // 1 minute
  halfOpenMaxCalls: 3,
});

/**
 * Slack API circuit breaker
 * - Higher threshold since it's critical
 * - Longer timeout for rate limit recovery
 */
export const slackCircuit = new CircuitBreaker({
  name: 'slack',
  failureThreshold: 5,
  resetTimeoutMs: 60000,  // 1 minute
  halfOpenMaxCalls: 3,
});

/**
 * Gmail API circuit breaker
 * - Lower threshold since it's less critical
 * - Shorter timeout for faster recovery
 */
export const gmailCircuit = new CircuitBreaker({
  name: 'gmail',
  failureThreshold: 3,
  resetTimeoutMs: 30000,  // 30 seconds
  halfOpenMaxCalls: 2,
});

/**
 * ConvertAPI circuit breaker
 * - Lower threshold since it's less critical
 * - Shorter timeout for faster recovery
 */
export const convertApiCircuit = new CircuitBreaker({
  name: 'convertapi',
  failureThreshold: 3,
  resetTimeoutMs: 30000,  // 30 seconds
  halfOpenMaxCalls: 2,
});

/**
 * Claude/Anthropic API circuit breaker
 * - Medium threshold
 * - Medium timeout
 */
export const claudeCircuit = new CircuitBreaker({
  name: 'claude',
  failureThreshold: 4,
  resetTimeoutMs: 45000,  // 45 seconds
  halfOpenMaxCalls: 2,
});

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get status of all circuit breakers (for health checks/debugging)
 */
export function getAllCircuitStats(): Record<string, CircuitStats> {
  return {
    monday: mondayCircuit.getStats(),
    slack: slackCircuit.getStats(),
    gmail: gmailCircuit.getStats(),
    convertapi: convertApiCircuit.getStats(),
    claude: claudeCircuit.getStats(),
  };
}

/**
 * Reset all circuits (for testing)
 */
export function resetAllCircuits(): void {
  mondayCircuit.reset();
  slackCircuit.reset();
  gmailCircuit.reset();
  convertApiCircuit.reset();
  claudeCircuit.reset();
}
