/**
 * Bounded latency accumulator.
 *
 * `RequestStats.latencies` used to be a plain `number[]` pushed on every request,
 * so it grew without bound for the life of the process and `averageLatency` was a
 * lifetime mean — useless for spotting a provider that just went slow. This is a
 * fixed-capacity ring buffer with the same `push()` call shape, so the call sites
 * in `proxy.ts` are unchanged.
 */
export class RollingLatency {
  private buf: Float64Array
  private writeIndex = 0
  private filled = 0

  constructor(capacity = 1024) {
    this.buf = new Float64Array(capacity)
  }

  /** Same signature as Array#push so proxy.ts call sites don't change. */
  push(ms: number) {
    this.buf[this.writeIndex] = ms
    this.writeIndex = (this.writeIndex + 1) % this.buf.length
    if (this.filled < this.buf.length) this.filled++
  }

  /** Number of samples currently retained (caps at capacity). */
  get count(): number {
    return this.filled
  }

  mean(): number {
    if (this.filled === 0) return 0
    let sum = 0
    for (let i = 0; i < this.filled; i++) sum += this.buf[i]
    return sum / this.filled
  }

  /**
   * Nearest-rank percentile over the retained window. Sorts a copy, so this is
   * only cheap because the window is small — call it on demand, not per request.
   */
  percentile(p: number): number {
    if (this.filled === 0) return 0
    const sorted = Array.from(this.buf.subarray(0, this.filled)).sort((a, b) => a - b)
    const rank = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]
  }

  reset() {
    this.buf.fill(0)
    this.writeIndex = 0
    this.filled = 0
  }
}
