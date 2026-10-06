import { constants } from "node:fs"
import { mkdir, open, rename, rm, lstat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { Config } from "./config.ts"
import type { EffectiveDecision, GuardianAssessment } from "./types.ts"

export interface ReviewAuditRecord {
    timestamp: string
    sessionHash: string
    actionType: string
    resourceHash: string
    transport: string
    mode: "active" | "shadow"
    guardianDecision?: GuardianAssessment["outcome"]
    proposedDecision: EffectiveDecision
    effectiveDecision: EffectiveDecision
    riskLevel?: GuardianAssessment["risk_level"]
    authorizationLevel?: GuardianAssessment["user_authorization"]
    latencyMs: number
    parentLinked: boolean
    protocol?: "sse" | "websocket"
    preflight?: string
    failure?: string
    cached?: boolean
}

export function auditDirectory(): string {
    if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? homedir(), "opencode/codex-guardian")
    if (process.platform === "darwin") return join(homedir(), "Library/Application Support/opencode/codex-guardian")
    return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "opencode/codex-guardian")
}

export class AuditLog {
    readonly path: string
    private queue: Promise<void> = Promise.resolve()
    constructor(private config: Config["audit"], private directory = auditDirectory()) { this.path = join(directory, "reviews.jsonl") }
    write(record: ReviewAuditRecord): Promise<void> {
        if (!this.config.enabled) return Promise.resolve()
        const work = this.queue.catch(() => {}).then(() => this.append(record))
        this.queue = work
        return work
    }
    async flush(): Promise<void> { await this.queue }
    private async append(record: ReviewAuditRecord): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        const directoryInfo = await lstat(this.directory)
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (process.getuid && (directoryInfo.uid !== process.getuid() || (directoryInfo.mode & 0o077) !== 0))) throw new Error("audit_directory_untrusted")
        const lockPath = join(this.directory, ".audit.lock")
        let lock
        for (let attempt = 0; attempt < 50; attempt++) {
            try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); break } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
                await delay(10)
            }
        }
        if (!lock) throw new Error("audit_lock_unavailable")
        try {
            let size = 0
            try { const info = await lstat(this.path); if (!info.isFile() || info.isSymbolicLink()) throw new Error("audit_file_untrusted"); size = info.size } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
            const line = JSON.stringify(record) + "\n"
            if (Buffer.byteLength(line) > 4_096) throw new Error("audit_record_oversized")
            if (size + Buffer.byteLength(line) > this.config.maxFileSizeMB * 1_048_576) {
                await rm(`${this.path}.${this.config.retainedFiles}`, { force: true })
                for (let i = this.config.retainedFiles - 1; i >= 1; i--) await rename(`${this.path}.${i}`, `${this.path}.${i + 1}`).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
                await rename(this.path, `${this.path}.1`)
            }
            const file = await open(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
            try {
                const info = await file.stat()
                if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) throw new Error("audit_file_untrusted")
                await file.chmod(0o600)
                await file.write(line)
                await file.sync()
            } finally { await file.close() }
        } finally {
            await lock.close()
            await rm(lockPath)
        }
    }
}
