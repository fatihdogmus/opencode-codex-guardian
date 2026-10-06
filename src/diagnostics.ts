import type { GuardianAssessment, NativeState } from "./types.ts"
import { redact } from "./utils/redaction.ts"

export class Diagnostics {
    nativeState: NativeState = "NATIVE_UNAVAILABLE"
    oauth = false
    primaryMetadata = false
    parentLinked = false
    guardianHeader = false
    guardianSubagent = false
    lastReview?: { decision: string; transport: string; durationMs: number; assessment?: GuardianAssessment; failure?: string; circuitBreaker?: boolean }
    status(enabled: boolean, mode: string): string {
        return redact(JSON.stringify({
            enabled, mode, permissionHook: "active", nativeState: this.nativeState,
            chatgptOAuth: this.oauth, primaryGuardianMetadata: this.primaryMetadata,
            parentLinked: this.parentLinked, guardianHeader: this.guardianHeader, guardianSubagent: this.guardianSubagent,
            freeReviewAccounting: "unverified", lastReview: this.lastReview,
        }, null, 2))
    }
}
