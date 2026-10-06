export function redact(text: string): string {
    return text
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
        .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED TOKEN]")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]")
        .replace(/(\bauthorization["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^\s"',}]+/gi, "$1[REDACTED]")
        .replace(/(\bbearer\s+)["']?[^\s"',}]+/gi, "$1[REDACTED]")
        .replace(/((?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|[A-Z0-9_]+_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|DATABASE_URL|COOKIE|TOKEN)\s*["']?\s*[:=]\s*)["']?[^\s"',}\n]+/gi, "$1[REDACTED]")
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
}

export function redactValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, (key, item) => /^(?:authorization|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|[A-Z0-9_]+_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|DATABASE_URL|COOKIE|TOKEN)$/i.test(key) ? "[REDACTED]" : typeof item === "string" ? redact(item) : item)) as T
}
