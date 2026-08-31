import type { ProviderConfig, SanitizeDetail } from './types.js'

/**
 * Learns the correct request-sanitization mode per provider so operators don't
 * have to know it. Some upstreams (e.g. AgentRouter) fingerprint the client and
 * REQUIRE the untouched Claude Code headers/system prompt — sanitizing breaks
 * them (401 "unauthorized client detected"). Others (e.g. FreeModel) break ON
 * those markers and NEED sanitizing. There's no static default that fits both.
 *
 * The gateway starts with a guess (sanitize = true, the safe default for most
 * proxies), and if a request fails with a mismatch signature it flips the mode,
 * retries, and remembers whichever mode produced a real success. State is
 * in-memory and keyed by provider name — same lifecycle as HealthTracker
 * (resets on restart, which is fine: re-learning costs at most one request).
 *
 * The mode is learned by default. A provider can opt out by setting `sanitize`
 * in providers.json, which pins the mode and skips the probe entirely — see
 * pin()/syncPins(). Passthrough providers are pinned to false by proxy.ts.
 */
export class SanitizeLearner {
  private learned: Map<string, boolean> = new Map()
  /** Providers with an explicit sanitize value from config — never auto-flipped. */
  private pinned: Map<string, boolean> = new Map()

  /** The default mode to try first when nothing has been learned yet. */
  static readonly DEFAULT_MODE = true

  /**
   * Pin a provider to an explicit sanitize mode supplied from config.
   * Pinned providers are treated as already-learned and are never flipped.
   */
  pin(providerName: string, mode: boolean) {
    this.pinned.set(providerName, mode)
    this.learned.set(providerName, mode)
  }

  /** Learned mode for a provider, or the default guess if not yet learned. */
  modeFor(providerName: string): boolean {
    return this.learned.get(providerName) ?? SanitizeLearner.DEFAULT_MODE
  }

  isLearned(providerName: string): boolean {
    return this.learned.has(providerName)
  }

  /**
   * Record the mode that produced a genuine success for this provider.
   * No-op for pinned providers — their mode is fixed by config.
   */
  recordSuccess(providerName: string, mode: boolean) {
    if (this.pinned.has(providerName)) return
    this.learned.set(providerName, mode)
  }

  /** Snapshot of learned modes for observability (GET /stats). */
  snapshot(): Record<string, boolean> {
    return Object.fromEntries(this.learned)
  }

  /**
   * Like snapshot(), but says whether each mode was pinned by config or learned
   * at runtime. `snapshot()` can't distinguish them and its shape is asserted by
   * sanitize-learner.test.ts, so this is a separate method rather than a change.
   */
  detail(): Record<string, SanitizeDetail> {
    const out: Record<string, SanitizeDetail> = {}
    for (const [name, mode] of this.learned) {
      out[name] = { mode, source: this.pinned.has(name) ? 'pinned' : 'learned' }
    }
    return out
  }

  /** Drop a pin so the provider goes back to auto-learning from scratch. */
  unpin(providerName: string) {
    this.pinned.delete(providerName)
    this.learned.delete(providerName)
  }

  /**
   * Reconcile pins with the current provider list. Called at boot AND on every
   * hot reload — pinning only at construction meant a reload never re-pinned,
   * and removing `sanitize` from the file left the old pin in place forever.
   *
   * Providers that were never pinned keep whatever they learned; only pins are
   * added, updated, or withdrawn.
   */
  syncPins(providers: ProviderConfig[]) {
    const desired = new Map<string, boolean>()
    for (const p of providers) {
      if (typeof p.sanitize === 'boolean') desired.set(p.name, p.sanitize)
    }

    for (const name of [...this.pinned.keys()]) {
      if (!desired.has(name)) this.unpin(name)
    }
    for (const [name, mode] of desired) {
      this.pin(name, mode)
    }
  }
}
