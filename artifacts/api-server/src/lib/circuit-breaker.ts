import { logger } from "./logger";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
}

const DEFAULT_OPTIONS: Omit<CircuitBreakerOptions, "name"> = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 2,
};

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private halfOpenAttempts = 0;
  private lastFailureTime = 0;
  private readonly opts: CircuitBreakerOptions;

  constructor(name: string, partial?: Partial<typeof DEFAULT_OPTIONS>) {
    this.opts = { name, ...DEFAULT_OPTIONS, ...partial };
  }

  get currentState(): CircuitState {
    if (this.state === "open" && this.shouldAttemptReset()) {
      this.state = "half-open";
      this.halfOpenAttempts = 0;
      logger.info(
        { component: "circuit-breaker", circuit: this.opts.name },
        "Circuit breaker transitioning to half-open",
      );
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;

    if (state === "open") {
      throw new CircuitBreakerOpenError(this.opts.name);
    }

    if (
      state === "half-open" &&
      this.halfOpenAttempts >= this.opts.halfOpenMaxAttempts
    ) {
      throw new CircuitBreakerOpenError(this.opts.name);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts >= this.opts.halfOpenMaxAttempts) {
        this.state = "closed";
        this.failureCount = 0;
        logger.info(
          { component: "circuit-breaker", circuit: this.opts.name },
          "Circuit breaker closed after successful half-open attempts",
        );
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      this.state = "open";
      logger.warn(
        { component: "circuit-breaker", circuit: this.opts.name },
        "Circuit breaker re-opened after half-open failure",
      );
      return;
    }

    if (this.failureCount >= this.opts.failureThreshold) {
      this.state = "open";
      logger.warn(
        {
          component: "circuit-breaker",
          circuit: this.opts.name,
          failureCount: this.failureCount,
          resetTimeoutMs: this.opts.resetTimeoutMs,
        },
        "Circuit breaker opened after consecutive failures",
      );
    }
  }

  private shouldAttemptReset(): boolean {
    return Date.now() - this.lastFailureTime >= this.opts.resetTimeoutMs;
  }
}

export class CircuitBreakerOpenError extends Error {
  readonly circuit: string;
  constructor(circuit: string) {
    super(
      `Circuit breaker "${circuit}" is open — service temporarily unavailable`,
    );
    this.name = "CircuitBreakerOpenError";
    this.circuit = circuit;
  }
}

const breakers = new Map<string, CircuitBreaker>();

export function getOrCreateCircuitBreaker(
  name: string,
  opts?: Partial<typeof DEFAULT_OPTIONS>,
): CircuitBreaker {
  let cb = breakers.get(name);
  if (!cb) {
    cb = new CircuitBreaker(name, opts);
    breakers.set(name, cb);
  }
  return cb;
}
