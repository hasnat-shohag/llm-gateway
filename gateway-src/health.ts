import type { ProviderConfig, ProviderHealth, ProviderHealthSnapshot } from './types.js'

export class HealthTracker {
  private state: Map<string, ProviderHealth> = new Map()
  private threshold: number
  private cooldownMs: number

  constructor(threshold: number, cooldownMs: number) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
  }

  getProviders(providers: ProviderConfig[]): ProviderConfig[] {
    const now = Date.now()
    return providers.filter((p) => {
      const h = this.state.get(p.name)
      if (!h || !h.unhealthy) return p.enabled
      if (h.cooldownUntil !== null && now >= h.cooldownUntil) {
        h.unhealthy = false
        h.consecutiveFailures = 0
        h.cooldownUntil = null
        return p.enabled
      }
      return false
    })
  }

  recordSuccess(providerName: string) {
    this.state.set(providerName, {
      consecutiveFailures: 0,
      unhealthy: false,
      cooldownUntil: null,
    })
  }

  recordFailure(providerName: string) {
    const h = this.state.get(providerName) ?? {
      consecutiveFailures: 0,
      unhealthy: false,
      cooldownUntil: null,
    }
    h.consecutiveFailures++
    if (h.consecutiveFailures >= this.threshold) {
      h.unhealthy = true
      h.cooldownUntil = Date.now() + this.cooldownMs
    }
    this.state.set(providerName, h)
  }

  getUnhealthy(): string[] {
    const now = Date.now()
    const result: string[] = []
    for (const [name, h] of this.state) {
      if (h.unhealthy && h.cooldownUntil !== null && now < h.cooldownUntil) {
        result.push(name)
      }
    }
    return result
  }

  /**
   * Non-mutating view of every named provider's effective health, for reporting.
   *
   * `getProviders()` clears an expired cooldown as a *side effect*, so raw state
   * can say `unhealthy: true` long after the cooldown lapsed. This applies the
   * same effective-state logic without writing to the map, and synthesizes a
   * clean entry for providers that have no state yet (which is most of them).
   */
  snapshot(providerNames: string[]): Record<string, ProviderHealthSnapshot> {
    const now = Date.now()
    const out: Record<string, ProviderHealthSnapshot> = {}
    for (const name of providerNames) {
      const h = this.state.get(name)
      if (!h) {
        out[name] = { consecutiveFailures: 0, unhealthy: false, cooldownUntil: null, cooldownRemainingMs: 0 }
        continue
      }
      const cooldownExpired = h.cooldownUntil !== null && now >= h.cooldownUntil
      const unhealthy = h.unhealthy && !cooldownExpired
      out[name] = {
        consecutiveFailures: cooldownExpired ? 0 : h.consecutiveFailures,
        unhealthy,
        cooldownUntil: unhealthy ? h.cooldownUntil : null,
        cooldownRemainingMs: unhealthy && h.cooldownUntil !== null ? h.cooldownUntil - now : 0,
      }
    }
    return out
  }

  /** Clear health state — one provider, or all of them. Powers a "clear cooldown" action. */
  reset(providerName?: string) {
    if (providerName === undefined) {
      this.state.clear()
    } else {
      this.state.delete(providerName)
    }
  }
}
