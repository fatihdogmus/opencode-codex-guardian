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
}

export function parseConfig(value: Record<string, unknown>): Config {
    const input = (value.autoReview ?? value) as Record<string, unknown>
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid autoReview options")
    const known = ["enabled", "transport", "model", "fallbackModel", "nativeFreeOnly", "failureMode", "timeoutMs", "contextMaxChars", "logging", "circuitBreaker", "reviewOnlyAskPermissions"]
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
    if (model !== undefined && (typeof model !== "string" || !/^[^/]+\/.+$/.test(model))) throw new Error("Use provider/model for fallbackModel")
    const config: Config = {
        enabled: boolean(input.enabled, false),
        transport: choice(input.transport, ["auto", "model", "codex-auto-review"], "auto"),
        fallbackModel: model as string | undefined,
        nativeFreeOnly: boolean(input.nativeFreeOnly, true),
        failureMode: choice(input.failureMode, ["ask", "deny"], "ask"),
        timeoutMs: integer(input.timeoutMs, 30_000, 10, 120_000),
        contextMaxChars: integer(input.contextMaxChars, 24_000, 2_000, 100_000),
        logging: { enabled: boolean(logging.enabled, true) },
        circuitBreaker: {
            enabled: boolean(breaker.enabled, true),
            maxEquivalentDenials: integer(breaker.maxEquivalentDenials, 3, 1, 100),
            ttlMs: integer(breaker.ttlMs, 1_800_000, 100, 86_400_000),
            effect: choice(breaker.effect, ["ask", "deny"], "ask"),
        },
    }
    if (config.transport === "model" && (config.nativeFreeOnly || !config.fallbackModel)) throw new Error("Model mode requires fallbackModel and nativeFreeOnly=false")
    return config
}
