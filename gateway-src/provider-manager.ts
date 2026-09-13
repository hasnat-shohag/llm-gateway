import type { ProviderCompatibility, ProviderConfig, StrategyName } from './types.js'
import type { HealthTracker } from './health.js'

export class ProviderManager {
  private providers: ProviderConfig[]
  private health: HealthTracker
  private strategy: StrategyName
  private roundRobinIndex = 0

  constructor(providers: ProviderConfig[], health: HealthTracker, strategy: StrategyName) {
    this.providers = providers
    this.health = health
    this.strategy = strategy
  }

  updateProviders(providers: ProviderConfig[]) {
    this.providers = providers
  }

  updateStrategy(strategy: StrategyName) {
    this.strategy = strategy
  }

  getStrategy(): StrategyName {
    return this.strategy
  }

  /** All providers, including disabled ones — for config/reporting, not selection. */
  getAllProviders(): ProviderConfig[] {
    return this.providers
  }

  getProviderNames(): { name: string }[] {
    return this.providers.filter((p) => p.enabled).map((p) => ({ name: p.name }))
  }

  providerCount(compatibility?: Exclude<ProviderCompatibility, 'both'>): number {
    return this.countMatching((p) =>
      compatibility === undefined || this.supportsCompatibility(p, compatibility))
  }

  /**
   * Enabled providers satisfying an arbitrary predicate — how the proxy expresses
   * the ordered attempt phases (relay-capable `both` first, then translated
   * `openai`, then the Claude pool).
   */
  countMatching(match: (provider: ProviderConfig) => boolean): number {
    return this.providers.filter((p) => p.enabled && match(p)).length
  }

  select(): ProviderConfig | null {
    const available = this.health.getProviders(this.providers.filter((p) => p.enabled))
    if (available.length === 0) return null
    return this.selectFrom(available)
  }

  /** Select a provider that is not in the `exclude` set. */
  selectExcluding(
    exclude: Set<string>,
    compatibility?: Exclude<ProviderCompatibility, 'both'>
  ): ProviderConfig | null {
    return this.selectMatching(exclude, (p) =>
      compatibility === undefined || this.supportsCompatibility(p, compatibility))
  }

  /** Select a provider satisfying `match`, skipping the `exclude` set and any
   *  provider the health tracker is holding in cooldown. */
  selectMatching(
    exclude: Set<string>,
    match: (provider: ProviderConfig) => boolean
  ): ProviderConfig | null {
    const available = this.health
      .getProviders(this.providers.filter((p) => p.enabled && match(p)))
      .filter((p) => !exclude.has(p.name))
    if (available.length === 0) return null
    return this.selectFrom(available)
  }

  private supportsCompatibility(
    provider: ProviderConfig,
    compatibility: Exclude<ProviderCompatibility, 'both'>
  ): boolean {
    const providerCompatibility = provider.compatibility ?? 'claude'
    return providerCompatibility === 'both' || providerCompatibility === compatibility
  }

  private selectFrom(available: ProviderConfig[]): ProviderConfig {
    switch (this.strategy) {
      case 'random':
        return available[Math.floor(Math.random() * available.length)]
      case 'round-robin': {
        const index = this.roundRobinIndex % available.length
        this.roundRobinIndex++
        return available[index]
      }
      case 'weighted': {
        const totalWeight = available.reduce((sum, p) => sum + p.weight, 0)
        let random = Math.random() * totalWeight
        for (const p of available) {
          random -= p.weight
          if (random <= 0) return p
        }
        return available[available.length - 1]
      }
      default:
        return available[Math.floor(Math.random() * available.length)]
    }
  }
}
