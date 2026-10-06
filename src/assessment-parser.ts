import type { GuardianAssessment } from "./types.ts"

export function parseAssessment(value: unknown): GuardianAssessment {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid assessment object")
    const assessment = parsed as Record<string, unknown>
    if (Object.keys(assessment).sort().join() !== "outcome,rationale,risk_level,user_authorization") throw new Error("Invalid assessment fields")
    if (!["low", "medium", "high", "critical"].includes(String(assessment.risk_level)) ||
        !["unknown", "low", "medium", "high"].includes(String(assessment.user_authorization)) ||
        !["allow", "deny"].includes(String(assessment.outcome)) ||
        typeof assessment.rationale !== "string" || !assessment.rationale.trim() || assessment.rationale.length > 2_000) {
        throw new Error("Invalid assessment schema")
    }
    return assessment as unknown as GuardianAssessment
}
