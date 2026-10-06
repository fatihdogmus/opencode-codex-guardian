import type { GuardianAssessment } from "./types.ts"

export function parseAssessment(value: unknown): GuardianAssessment {
    if (typeof value === "string" && Buffer.byteLength(value) > 16_384) throw new Error("Oversized assessment")
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid assessment object")
    const assessment = parsed as Record<string, unknown>
    if (Object.keys(assessment).sort().join() !== "outcome,rationale,risk_level,user_authorization") throw new Error("Invalid assessment fields")
    if (typeof assessment.risk_level !== "string" || !["low", "medium", "high", "critical"].includes(assessment.risk_level) ||
        typeof assessment.user_authorization !== "string" || !["unknown", "low", "medium", "high"].includes(assessment.user_authorization) ||
        typeof assessment.outcome !== "string" || !["allow", "deny"].includes(assessment.outcome) ||
        typeof assessment.rationale !== "string" || !assessment.rationale.trim() || assessment.rationale.length > 2_000) {
        throw new Error("Invalid assessment schema")
    }
    return assessment as unknown as GuardianAssessment
}
