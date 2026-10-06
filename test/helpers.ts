import type { GuardianAssessment, PermissionEvent, ReviewInput } from "../src/types.ts"

export const allow: GuardianAssessment = { risk_level: "low", user_authorization: "high", outcome: "allow", rationale: "Authorized scoped action" }
export const deny: GuardianAssessment = { risk_level: "high", user_authorization: "low", outcome: "deny", rationale: "Not authorized" }
export const input: ReviewInput = {
    sessionID: "ses_test", userIntent: "Install the dependencies", userInstructions: [{ text: "Install the dependencies", turn: 0, isCurrent: true }], action: "shell",
    resources: ["npm install"], recentContext: [], explicitAuthorizations: [], cwd: "/workspace",
}
export function permission(resources = ["npm install"]): PermissionEvent {
    return { sessionID: "ses_test", action: "shell", resources, effect: "ask" }
}
