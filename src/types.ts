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
    userInstructions: UserInstruction[]
    action: string
    resources: readonly string[]
    metadata?: Record<string, unknown>
    recentContext: ReviewMessage[]
    explicitAuthorizations: ExplicitAuthorization[]
    cwd: string
    source?: { type: "tool"; messageID: string; id: string }
    normalized?: NormalizedAction
    actionHash?: string
    evidence?: Record<string, unknown>
    protocol?: "sse" | "websocket"
    reviewTransport?: string
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

export interface UserInstruction {
    text: string
    turn: number
    timestamp?: number
    isCurrent: boolean
}
export interface ExplicitAuthorization {
    source: "permission_approval"
    sessionID: string
    callID: string
    actionHash: string
    messageID: string
    intentHash: string
    cwd: string
    grantedAt: number
    expiresAt: number
    scope: "once"
}
export type ActionCategory = "filesystem_read" | "filesystem_write" | "filesystem_delete" | "network_request" | "credential_access" | "process_execute" | "package_install" | "git_operation" | "unknown"
export interface ShellCommand {
    executable: string
    args: string[]
    wrappers: string[]
    privileged: boolean
}
export interface NormalizedAction {
    category: ActionCategory
    targets: string[]
    hosts: string[]
    wrappers: string[]
    privileged: boolean
    rawHash: string
    commands: ShellCommand[]
    redirections: { operator: string; target: string }[]
    pipelines: number
    secretReferences?: boolean
    environmentAssignments?: string[]
    ambiguous?: string
    subtype?: string
    fingerprintSafe?: boolean
    cwd: string
}
