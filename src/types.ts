export type EffectiveDecision = "allow" | "deny" | "ask"
export interface GuardianAssessment {
    risk_level: "low" | "medium" | "high" | "critical"
    user_authorization: "unknown" | "low" | "medium" | "high"
    outcome: "allow" | "deny"
    rationale: string
}
export interface ReviewMessage {
    role: string
    trust: "user" | "untrusted"
    text: string
}
export interface ReviewInput {
    sessionID: string
    userIntent: string
    priorUserInstructions: string[]
    action: string
    resources: readonly string[]
    metadata?: Record<string, unknown>
    recentContext: ReviewMessage[]
    explicitAuthorizations: string[]
    cwd: string
    source?: { type: "tool"; messageID: string; id: string }
}
export interface ReviewerTransport {
    readonly name: string
    review(input: ReviewInput, signal: AbortSignal): Promise<GuardianAssessment>
}
export interface PermissionEvent {
    sessionID: string
    action: string
    resources: readonly string[]
    metadata?: Record<string, unknown>
    source?: ReviewInput["source"]
    effect: EffectiveDecision
    message?: string
}
export type NativeState = "NATIVE_UNAVAILABLE" | "NATIVE_WORKS_ACCOUNTING_UNKNOWN" | "FALLBACK_MODEL"
