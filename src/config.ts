import { isAbsolute } from "node:path"

export interface Config {
    enabled: boolean
    transport: "auto" | "model" | "codex-auto-review"
    fallbackModel?: string
    nativeFreeOnly: boolean
    failureMode: "ask" | "deny"
    timeoutMs: number
    contextMaxChars: number
    logging: { enabled: boolean }
    circuitBreaker: { enabled: boolean; maxEquivalentDenials: number; ttlMs: number; effect: "ask" | "deny" }
    shadow: boolean
    preflight: { enabled: boolean }
    selfProtection: { enabled: boolean; protectedPaths: string[] }
    audit: { enabled: boolean; maxFileSizeMB: number; retainedFiles: number }
    evidence: { enabled: boolean; filesystem: boolean; git: boolean; timeoutMs: number; maxBytes: number }
    sessionApprovals: { enabled: boolean; ttlMs: number }
}

export function parseConfig(value: Record<string, unknown>): Config {
    const input = (value.autoReview ?? value) as Record<string, unknown>
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid autoReview options")
    const known = ["enabled", "transport", "model", "fallbackModel", "nativeFreeOnly", "failureMode", "timeoutMs", "contextMaxChars", "logging", "circuitBreaker", "reviewOnlyAskPermissions", "mode", "shadow", "preflight", "selfProtection", "audit", "evidence", "sessionApprovals", "reviewer"]
    for (const key of Object.keys(input)) if (!known.includes(key)) throw new Error(`Unknown autoReview option: ${key}`)
    if (input.reviewOnlyAskPermissions === false) throw new Error("Only ask-level permissions may be auto-reviewed")
    const boolean = (value: unknown, fallback: boolean): boolean => {
        if (value === undefined) return fallback
        if (typeof value !== "boolean") throw new Error("Expected boolean option")
        return value
    }
    const choice = <T extends string>(value: unknown, choices: T[], fallback: T): T => {
        if (value === undefined) return fallback
        if (!choices.includes(value as T)) throw new Error("Invalid enum option")
        return value as T
    }
    const integer = (value: unknown, fallback: number, min: number, max: number): number => {
        if (value === undefined) return fallback
        if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error("Invalid numeric option")
        return Number(value)
    }
    const object = (value: unknown): Record<string, unknown> => {
        if (value === undefined) return {}
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object option")
        return value as Record<string, unknown>
    }
    const breaker = object(input.circuitBreaker)
    const logging = object(input.logging)
    if (logging.redactSecrets === false) throw new Error("Secret redaction cannot be disabled")
    const model = input.fallbackModel ?? input.model
    const preflight = object(input.preflight)
    const selfProtection = object(input.selfProtection)
    const audit = object(input.audit)
    const evidence = object(input.evidence)
    const sessionApprovals = object(input.sessionApprovals)
    const reviewer = object(input.reviewer)
    for (const [name, values, keys] of [
        ["logging", logging, ["enabled", "redactSecrets"]],
        ["circuitBreaker", breaker, ["enabled", "maxEquivalentDenials", "ttlMs", "effect"]],
        ["preflight", preflight, ["enabled"]],
        ["selfProtection", selfProtection, ["enabled", "protectedPaths"]],
        ["audit", audit, ["enabled", "redactSecrets", "maxFileSizeMB", "retainedFiles"]],
        ["evidence", evidence, ["enabled", "filesystem", "git", "timeoutMs", "maxBytes"]],
        ["sessionApprovals", sessionApprovals, ["enabled", "ttlMs"]],
        ["reviewer", reviewer, ["ephemeralSession", "timeoutMs"]],
    ] as [string, Record<string, unknown>, string[]][]) {
        for (const key of Object.keys(values)) if (!keys.includes(key)) throw new Error(`Unknown ${name} option: ${key}`)
    }
    if (audit.redactSecrets === false) throw new Error("Audit secret redaction cannot be disabled")
    if (reviewer.ephemeralSession === false) throw new Error("Reviewer sessions must be ephemeral")
    if (selfProtection.protectedPaths !== undefined && (!Array.isArray(selfProtection.protectedPaths) || selfProtection.protectedPaths.some((path) => typeof path !== "string" || !isAbsolute(path)))) throw new Error("Protected paths must be absolute paths")
    const mode = choice(input.mode, ["active", "shadow"], "active")
    if (model !== undefined && (typeof model !== "string" || !/^[^/]+\/.+$/.test(model))) throw new Error("Use provider/model for fallbackModel")
    const config: Config = {
        enabled: boolean(input.enabled, false),
        transport: choice(input.transport, ["auto", "model", "codex-auto-review"], "auto"),
        fallbackModel: model as string | undefined,
        nativeFreeOnly: boolean(input.nativeFreeOnly, true),
        failureMode: choice(input.failureMode, ["ask", "deny"], "ask"),
        timeoutMs: integer(reviewer.timeoutMs ?? input.timeoutMs, 15_000, 10, 120_000),
        contextMaxChars: integer(input.contextMaxChars, 100_000, 2_000, 100_000),
        logging: { enabled: boolean(logging.enabled, true) },
        circuitBreaker: {
            enabled: boolean(breaker.enabled, true),
            maxEquivalentDenials: integer(breaker.maxEquivalentDenials, 3, 1, 100),
            ttlMs: integer(breaker.ttlMs, 1_800_000, 100, 86_400_000),
            effect: choice(breaker.effect, ["ask", "deny"], "ask"),
        },
        shadow: boolean(input.shadow, mode === "shadow"),
        preflight: { enabled: boolean(preflight.enabled, true) },
        selfProtection: { enabled: boolean(selfProtection.enabled, true), protectedPaths: selfProtection.protectedPaths as string[] ?? [] },
        audit: { enabled: boolean(audit.enabled, true), maxFileSizeMB: integer(audit.maxFileSizeMB, 20, 1, 100), retainedFiles: integer(audit.retainedFiles, 5, 1, 20) },
        evidence: { enabled: boolean(evidence.enabled, true), filesystem: boolean(evidence.filesystem, true), git: boolean(evidence.git, true), timeoutMs: integer(evidence.timeoutMs, 750, 10, 2_000), maxBytes: integer(evidence.maxBytes, 4_096, 512, 16_384) },
        sessionApprovals: { enabled: boolean(sessionApprovals.enabled, false), ttlMs: integer(sessionApprovals.ttlMs, 60_000, 100, 300_000) },
    }
    if (config.transport === "model" && (config.nativeFreeOnly || !config.fallbackModel)) throw new Error("Model mode requires fallbackModel and nativeFreeOnly=false")
    return config
}
