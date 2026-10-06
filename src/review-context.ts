import { redact } from "./utils/redaction.ts"
import { ReviewError } from "./review-error.ts"
import type { PermissionEvent, ReviewInput, ReviewMessage } from "./types.ts"

export function buildReviewInput(event: PermissionEvent, messages: readonly unknown[], cwd: string, maxChars: number): ReviewInput {
    const entries = messages.filter((message): message is Record<string, unknown> => !!message && typeof message === "object")
    const users = entries.filter((message) => message.type === "user" && typeof message.text === "string")
    const latest = users.at(-1)
    if (!latest || !String(latest.text).trim()) throw new ReviewError("context_missing_user_intent")
    const input: ReviewInput = {
        sessionID: event.sessionID,
        userIntent: redact(String(latest.text)),
        priorUserInstructions: users.slice(0, -1).map((message) => redact(String(message.text))),
        action: event.action,
        resources: event.resources.map(redact),
        metadata: event.metadata ? JSON.parse(redact(JSON.stringify(event.metadata))) : undefined,
        recentContext: [],
        explicitAuthorizations: [],
        cwd,
        source: event.source,
    }
    if (!event.action || !event.resources.length) throw new ReviewError("context_missing_action")
    if (JSON.stringify(input).length > maxChars) throw new ReviewError("context_oversized")
    for (const message of entries.slice(-12).reverse()) {
        if (message.type === "user") continue
        const item: ReviewMessage = {
            role: String(message.type ?? "unknown"),
            trust: "untrusted",
            text: redact(JSON.stringify(message)).slice(0, 3_000),
        }
        input.recentContext.unshift(item)
        if (JSON.stringify(input).length > maxChars) {
            input.recentContext.shift()
            break
        }
    }
    return input
}
