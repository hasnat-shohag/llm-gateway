import type { ProviderConfig, StrategyName } from './types.js'
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

  providerCount(): number {
    return this.providers.filter((p) => p.enabled).length
  }

  select(): ProviderConfig | null {
    const available = this.health.getProviders(this.providers.filter((p) => p.enabled))
    if (available.length === 0) return null
    return this.selectFrom(available)
  }

  /** Select a provider that is not in the `exclude` set. */
  selectExcluding(exclude: Set<string>): ProviderConfig | null {
    const available = this.health
      .getProviders(this.providers.filter((p) => p.enabled))
      .filter((p) => !exclude.has(p.name))
    if (available.length === 0) return null
    return this.selectFrom(available)
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
