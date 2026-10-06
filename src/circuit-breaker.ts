import type { Config } from "./config.ts"
import { actionFingerprint } from "./utils/hashing.ts"
import type { ReviewInput } from "./types.ts"

export class CircuitBreaker {
    private records = new Map<string, { timestamp: number; count: number }>()
    constructor(private config: Config["circuitBreaker"], private now = Date.now) {}
    private key(input: ReviewInput): string { return `${input.sessionID}:${actionFingerprint(input)}` }
    private prune(): void {
        for (const [key, value] of this.records) if (this.now() - value.timestamp >= this.config.ttlMs) this.records.delete(key)
    }
    tripped(input: ReviewInput): boolean {
        this.prune()
        return this.config.enabled && (this.records.get(this.key(input))?.count ?? 0) >= this.config.maxEquivalentDenials
    }
    deny(input: ReviewInput): void {
        if (!this.config.enabled) return
        this.prune()
        const key = this.key(input)
        this.records.set(key, { timestamp: this.now(), count: (this.records.get(key)?.count ?? 0) + 1 })
        if (this.records.size > 10_000) this.records.delete(this.records.keys().next().value!)
    }
    clear(): void { this.records.clear() }
}
