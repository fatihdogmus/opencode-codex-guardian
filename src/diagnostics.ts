import type { GuardianAssessment, NativeState } from "./types.ts"
import { safeRenderRationale } from "./utils/safe-render.ts"
import type { Config } from "./config.ts"
import type { ConfigTrust } from "./trusted-config.ts"

export class Diagnostics {
    nativeState: NativeState = "NATIVE_UNAVAILABLE"
    nativeStartupFailure?: string
    oauth = false
    primaryMetadata = false
    parentLinked = false
    guardianHeader = false
    guardianSubagent = false
    protocol?: "sse" | "websocket"
    cleanupFailures = 0
    auditHealthy = true
    config?: Config
    configProvenance: ConfigTrust = "unknown"
    configPath?: string
    configError?: string
    ignoredWeakening = false
    auditPath?: string
    authorizationEventsHealthy = true
    sessionApprovalCount = 0
    breakerEntries = 0
    lastReview?: { decision: string; proposedDecision?: string; transport: string; durationMs: number; assessment?: GuardianAssessment; failure?: string; circuitBreaker?: boolean; preflight?: string; cached?: boolean }
    status(enabled: boolean, mode: string): string {
        return JSON.stringify({
            enabled, mode: this.config?.shadow ? "shadow" : "active", transport: mode, permissionHook: "active", nativeState: this.nativeState, nativeStartupFailure: this.nativeStartupFailure,
            chatgptOAuth: this.oauth, primaryGuardianMetadata: this.primaryMetadata,
            parentLinked: this.parentLinked, guardianHeader: this.guardianHeader, guardianSubagent: this.guardianSubagent,
            freeReviewAccounting: "unverified", protocol: this.protocol, reviewerSessionMode: "ephemeral", cleanupFailures: this.cleanupFailures,
            configProvenance: this.configProvenance, trustedConfigPath: this.configPath, configError: this.configError, optionProvenance: "unknown", ignoredWeakening: this.ignoredWeakening,
            preflight: this.config?.preflight.enabled, selfProtection: this.config?.selfProtection.enabled, shadow: this.config?.shadow,
            audit: { enabled: this.config?.audit.enabled, healthy: this.auditHealthy, path: this.auditPath },
            authorization: { source: "host_permission_reply", humanOriginAttestation: false, eventsHealthy: this.authorizationEventsHealthy },
            sessionApprovals: { enabled: this.config?.sessionApprovals.enabled, entries: this.sessionApprovalCount },
            circuitBreaker: { enabled: this.config?.circuitBreaker.enabled, entries: this.breakerEntries },
            lastReview: this.lastReview,
        }, (_key, value) => typeof value === "string" ? safeRenderRationale(value, 2_048) : value, 2)
    }
}
