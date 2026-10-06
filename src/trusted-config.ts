import { constants } from "node:fs"
import { open, stat } from "node:fs/promises"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { parseConfig, type Config } from "./config.ts"
import { canonicalPath, containsPath } from "./self-protection.ts"

export type ConfigTrust = "global-trusted" | "user-trusted" | "project-untrusted" | "unknown"
export const trustedConfigPath = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode/codex-guardian.json")

function overlay(base: Config, incoming: Record<string, unknown>): Config {
    const input = (incoming.autoReview ?? incoming) as Record<string, unknown>
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Guardian configuration")
    const merged: Record<string, unknown> = { ...base, ...input }
    if (input.mode !== undefined && input.shadow === undefined) delete merged.shadow
    if (input.model !== undefined && input.fallbackModel === undefined) delete merged.fallbackModel
    for (const key of ["logging", "circuitBreaker", "preflight", "selfProtection", "audit", "evidence", "sessionApprovals"] as const) if (input[key] !== undefined) {
        if (!input[key] || typeof input[key] !== "object" || Array.isArray(input[key])) throw new Error("Invalid Guardian configuration section")
        merged[key] = { ...base[key], ...(input[key] as Record<string, unknown>) }
    }
    return parseConfig(merged)
}

export function mergeSecurityConfig(base: Config, incoming: Record<string, unknown>, trust: ConfigTrust): Config {
    const next = overlay(base, incoming)
    if (trust === "global-trusted" || trust === "user-trusted") return next
    return {
        ...base,
        enabled: base.enabled || next.enabled,
        nativeFreeOnly: base.nativeFreeOnly || next.nativeFreeOnly,
        transport: base.transport === "auto" && next.transport === "codex-auto-review" ? next.transport : base.transport,
        failureMode: base.failureMode === "deny" || next.failureMode === "deny" ? "deny" : "ask",
        timeoutMs: Math.min(base.timeoutMs, next.timeoutMs),
        contextMaxChars: Math.min(base.contextMaxChars, next.contextMaxChars),
        logging: { enabled: base.logging.enabled || next.logging.enabled },
        preflight: { enabled: base.preflight.enabled || next.preflight.enabled },
        selfProtection: { enabled: base.selfProtection.enabled || next.selfProtection.enabled, protectedPaths: [...new Set([...base.selfProtection.protectedPaths, ...next.selfProtection.protectedPaths])] },
        audit: { ...base.audit, enabled: base.audit.enabled || next.audit.enabled },
        evidence: { ...base.evidence, enabled: base.evidence.enabled && next.evidence.enabled, filesystem: base.evidence.filesystem && next.evidence.filesystem, git: base.evidence.git && next.evidence.git, timeoutMs: Math.min(base.evidence.timeoutMs, next.evidence.timeoutMs), maxBytes: Math.min(base.evidence.maxBytes, next.evidence.maxBytes) },
        sessionApprovals: { enabled: base.sessionApprovals.enabled && next.sessionApprovals.enabled, ttlMs: Math.min(base.sessionApprovals.ttlMs, next.sessionApprovals.ttlMs) },
        circuitBreaker: { enabled: base.circuitBreaker.enabled || next.circuitBreaker.enabled, maxEquivalentDenials: Math.min(base.circuitBreaker.maxEquivalentDenials, next.circuitBreaker.maxEquivalentDenials), ttlMs: Math.max(base.circuitBreaker.ttlMs, next.circuitBreaker.ttlMs), effect: base.circuitBreaker.effect === "deny" || next.circuitBreaker.effect === "deny" ? "deny" : "ask" },
    }
}

export async function loadSecurityConfig(options: Record<string, unknown>, cwd: string, path = trustedConfigPath()): Promise<{ config: Config; provenance: ConfigTrust; path: string; ignoredWeakening: boolean }> {
    let base = parseConfig({ enabled: true })
    let provenance: ConfigTrust = "unknown"
    if (containsPath(canonicalPath(cwd), canonicalPath(path))) throw new Error("Trusted Guardian configuration must be outside the project")
    try {
        for (let parent = dirname(canonicalPath(path)); ; parent = dirname(parent)) {
            const info = await stat(parent)
            if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) throw new Error("Trusted configuration has a writable-by-others ancestor")
            if (process.getuid && info.uid !== 0 && info.uid !== process.getuid()) throw new Error("Trusted configuration has an untrusted owner ancestor")
            if (dirname(parent) === parent) break
        }
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
            const stat = await file.stat()
            if (!stat.isFile() || stat.size > 65_536 || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) throw new Error("Guardian configuration must be a bounded, user-owned, non-writable-by-others regular file")
            const buffer = Buffer.alloc(65_537)
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
            if (bytesRead > 65_536) throw new Error("Trusted configuration exceeds the size limit")
            base = mergeSecurityConfig(base, JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")), "user-trusted")
            provenance = "user-trusted"
        } finally { await file.close() }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const config = mergeSecurityConfig(base, options, "unknown")
    return { config, provenance, path, ignoredWeakening: JSON.stringify(config) !== JSON.stringify(overlay(base, options)) }
}
