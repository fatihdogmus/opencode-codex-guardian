import { hash } from "./utils/hashing.ts"
import type { Config } from "./config.ts"
import type { ReviewInput } from "./types.ts"

export class SessionApprovals {
    private entries = new Map<string, number>()
    private safeCalls = new Set<string>()
    constructor(private config: Config["sessionApprovals"], private now = Date.now) {}
    private eligible(input: ReviewInput): boolean {
        const action = input.normalized
        if (!action || action.ambiguous || action.privileged || action.commands.length !== 1 || action.wrappers.length || action.pipelines || action.redirections.length || action.environmentAssignments?.length) return false
        const { executable, args } = action.commands[0]
        return executable === "git" && args[0] === "status" && args.length === 1
    }
    private key(input: ReviewInput): string { return `${input.sessionID}:${input.actionHash}:${hash(JSON.stringify(input.userInstructions))}` }
    has(input: ReviewInput): boolean {
        for (const [key, expiry] of this.entries) if (expiry <= this.now()) this.entries.delete(key)
        const found = this.config.enabled && this.eligible(input) && this.entries.has(this.key(input))
        if (found && input.source) this.safeCalls.add(`${input.sessionID}:${input.source.id}`)
        return found
    }
    grant(input: ReviewInput): void {
        if (!this.config.enabled || !this.eligible(input)) return
        this.entries.set(this.key(input), this.now() + this.config.ttlMs)
        if (input.source) this.safeCalls.add(`${input.sessionID}:${input.source.id}`)
        if (this.entries.size > 1_000) this.entries.delete(this.entries.keys().next().value!)
    }
    clearSession(sessionID: string): void {
        for (const key of this.entries.keys()) if (key.startsWith(`${sessionID}:`)) this.entries.delete(key)
        for (const key of this.safeCalls) if (key.startsWith(`${sessionID}:`)) this.safeCalls.delete(key)
    }
    finish(sessionID: string, callID: string, tool: string): void {
        const key = `${sessionID}:${callID}`
        const safe = this.safeCalls.delete(key)
        if (tool !== "read" && !safe) this.clearSession(sessionID)
    }
    clear(): void { this.entries.clear(); this.safeCalls.clear() }
    get size(): number { return this.entries.size }
}
