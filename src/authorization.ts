import { hash } from "./utils/hashing.ts"
import type { ExplicitAuthorization, PermissionEvent, ReviewInput } from "./types.ts"

interface Binding { signature: string; authorization: ExplicitAuthorization }
const signature = (event: Pick<PermissionEvent, "action" | "resources" | "metadata">) => hash(JSON.stringify([event.action, event.resources, event.metadata ?? {}]))

export class Authorizations {
    private pending = new Map<string, Binding>()
    private requests = new Map<string, Binding>()
    private approvals = new Map<string, ExplicitAuthorization>()
    constructor(private now = Date.now, private ttlMs = 60_000) {}
    private key(sessionID: string, callID: string): string { return `${sessionID}:${callID}` }
    track(event: PermissionEvent, input: ReviewInput): void {
        if (!event.source || !input.actionHash) return
        const key = this.key(event.sessionID, event.source.id)
        this.pending.set(key, { signature: signature(event), authorization: { source: "permission_approval", sessionID: event.sessionID, callID: event.source.id, messageID: event.source.messageID, intentHash: hash(JSON.stringify(input.userInstructions)), actionHash: input.actionHash, cwd: input.cwd, grantedAt: this.now(), expiresAt: this.now() + this.ttlMs, scope: "once" } })
        this.prune()
    }
    observe(event: { type: string; data: unknown }): void {
        if (!event.data || typeof event.data !== "object") return
        const data = event.data as Record<string, unknown>
        if (event.type === "permission.asked" && typeof data.id === "string" && typeof data.sessionID === "string" && data.source && typeof data.source === "object") {
            const callID = (data.source as Record<string, unknown>).id
            if (typeof callID !== "string") return
            const binding = this.pending.get(this.key(data.sessionID, callID))
            if (binding && (data.source as Record<string, unknown>).messageID === binding.authorization.messageID && binding.signature === signature(data as unknown as PermissionEvent) && binding.authorization.expiresAt > this.now()) this.requests.set(data.id, binding)
        }
        if (event.type === "permission.replied" && typeof data.requestID === "string") {
            const binding = this.requests.get(data.requestID)
            this.requests.delete(data.requestID)
            if (!binding || data.sessionID !== binding.authorization.sessionID || binding.authorization.expiresAt <= this.now()) return
            const key = this.key(binding.authorization.sessionID, binding.authorization.callID)
            if (data.reply === "once") this.approvals.set(key, { ...binding.authorization, grantedAt: this.now(), expiresAt: this.now() + this.ttlMs })
            else this.approvals.delete(key)
        }
        this.prune()
    }
    get(input: ReviewInput): ExplicitAuthorization[] {
        this.prune()
        const approval = input.source ? this.approvals.get(this.key(input.sessionID, input.source.id)) : undefined
        return approval && approval.actionHash === input.actionHash && approval.cwd === input.cwd && approval.messageID === input.source?.messageID && approval.intentHash === hash(JSON.stringify(input.userInstructions)) ? [{ ...approval }] : []
    }
    consume(input: ReviewInput): boolean {
        if (!this.get(input).length || !input.source) return false
        this.finish(input.sessionID, input.source.id)
        return true
    }
    finish(sessionID: string, callID: string): void {
        const key = this.key(sessionID, callID)
        this.approvals.delete(key)
        this.pending.delete(key)
        for (const [id, binding] of this.requests) if (this.key(binding.authorization.sessionID, binding.authorization.callID) === key) this.requests.delete(id)
    }
    private prune(): void {
        for (const map of [this.pending, this.requests]) for (const [key, binding] of map) if (binding.authorization.expiresAt <= this.now()) map.delete(key)
        for (const [key, approval] of this.approvals) if (approval.expiresAt <= this.now()) this.approvals.delete(key)
        for (const map of [this.pending, this.requests, this.approvals]) while (map.size > 10_000) map.delete(map.keys().next().value!)
    }
    clearSession(sessionID: string): void {
        for (const map of [this.pending, this.requests]) for (const [key, binding] of map) if (binding.authorization.sessionID === sessionID) map.delete(key)
        for (const [key, approval] of this.approvals) if (approval.sessionID === sessionID) this.approvals.delete(key)
    }
    clear(): void { this.pending.clear(); this.requests.clear(); this.approvals.clear() }
}
