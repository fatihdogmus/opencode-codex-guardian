import { redact, redactValue } from "./utils/redaction.ts"
import { ReviewError } from "./review-error.ts"
import type { PermissionEvent, ReviewInput, ReviewMessage } from "./types.ts"

export function buildReviewInput(event: PermissionEvent, messages: readonly unknown[], cwd: string, maxChars: number, completeHistory = false): ReviewInput {
    const entries = messages.filter((message): message is Record<string, unknown> => !!message && typeof message === "object")
    const users = entries.filter((message) => message.type === "user" && typeof message.text === "string")
    const latest = users.at(-1)
    if (!completeHistory && entries.some((message) => message.type === "compaction")) throw new ReviewError("context_compacted")
    if (!latest || !String(latest.text).trim()) throw new ReviewError("context_missing_user_intent")
    const input: ReviewInput = {
        sessionID: event.sessionID,
        userIntent: redact(String(latest.text)),
        userInstructions: users.map((message, turn) => {
            const timestamp = (message.time as { created?: unknown } | undefined)?.created
            return { text: redact(String(message.text)), turn, isCurrent: turn === users.length - 1, ...(typeof timestamp === "number" && Number.isFinite(timestamp) ? { timestamp } : {}) }
        }),
        action: event.action,
        resources: event.resources.map(redact),
        metadata: event.metadata ? redactValue(event.metadata) : undefined,
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

// Run after normalization, host evidence and local metadata have been added.
// Only optional, untrusted context/evidence may be removed; intent, restrictions,
// exact action, source binding and normalized side effects must remain intact.
export function fitReviewInput(input: ReviewInput, maxChars: number): void {
    while (JSON.stringify(input).length > maxChars && input.recentContext.length) input.recentContext.shift()
    if (JSON.stringify(input).length > maxChars && input.evidence) input.evidence = { unavailable: "context_budget" }
    if (JSON.stringify(input).length > maxChars) throw new ReviewError("context_oversized")
}
