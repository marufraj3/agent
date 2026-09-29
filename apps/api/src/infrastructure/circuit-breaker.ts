export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitOpenError extends Error {
  constructor(readonly service: string) { super(`${service} circuit is temporarily open`); this.name = 'CircuitOpenError'; }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: CircuitState = 'closed';

  constructor(
    readonly service: string,
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (this.state === 'open') {
      if (now - this.openedAt < this.cooldownMs) throw new CircuitOpenError(this.service);
      this.state = 'half_open';
    }
    try {
      const result = await operation();
      this.failures = 0; this.state = 'closed';
      return result;
    } catch (error) {
      this.failures += 1;
      if (this.state === 'half_open' || this.failures >= this.failureThreshold) {
        this.state = 'open'; this.openedAt = now;
      }
      throw error;
    }
  }

  snapshot() { return { service: this.service, state: this.state, failures: this.failures, openedAt: this.openedAt || null }; }
}

const breakers = new Map<string, CircuitBreaker>();
export function getCircuitBreaker(service: string, threshold = 5, cooldownMs = 30_000) {
  let breaker = breakers.get(service);
  if (!breaker) { breaker = new CircuitBreaker(service, threshold, cooldownMs); breakers.set(service, breaker); }
  return breaker;
}
export function circuitBreakerSnapshots() { return [...breakers.values()].map((breaker) => breaker.snapshot()); }
