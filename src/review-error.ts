export class ReviewError extends Error {
    constructor(readonly code: string) { super(code) }
}

export type ReviewStage = "configuration" | "action_context" | "normalization" | "preflight" | "self_protection" | "context" | "authorization" | "evidence" | "packet_budget" | "reviewer" | "assessment" | "audit"
export interface FailureDetails { stage: ReviewStage; name: string; code?: string | number; status?: number }

// Never persist messages, stacks, response bodies, paths or arbitrary error labels.
export function failureDetails(error: unknown, stage: ReviewStage): FailureDetails {
    const value = error && typeof error === "object" ? error as Record<string, unknown> : {}
    const names = ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError"]
    const codes = ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "EIO", "ENOSPC", "EMFILE", "ENFILE", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]
    return {
        stage,
        name: error instanceof ReviewError ? "ReviewError" : typeof value.name === "string" && names.includes(value.name) ? value.name : "Error",
        ...(typeof value.code === "string" && codes.includes(value.code) ? { code: value.code } : typeof value.code === "number" && Number.isInteger(value.code) && value.code >= 0 && value.code <= 255 ? { code: value.code } : {}),
        ...(typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 400 && value.status <= 599 ? { status: value.status } : {}),
    }
}
