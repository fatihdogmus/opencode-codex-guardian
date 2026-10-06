import { lstat } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import type { Config } from "./config.ts"
import { canonicalPath, containsPath } from "./self-protection.ts"
import { safeRenderRationale } from "./utils/safe-render.ts"
import type { ReviewInput } from "./types.ts"

const exec = promisify(execFile)
export async function enrichEvidence(input: ReviewInput, config: Config["evidence"], signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!config.enabled) return {}
    const result: Record<string, unknown> = {}
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
    const bounded = <T>(work: Promise<T>): Promise<T> => {
        timeout.throwIfAborted()
        return new Promise((resolve, reject) => {
            const abort = () => reject(timeout.reason)
            timeout.addEventListener("abort", abort, { once: true })
            work.then(resolve, reject).finally(() => timeout.removeEventListener("abort", abort))
        })
    }
    const root = canonicalPath(input.cwd)
    if (config.filesystem) {
        const paths = input.normalized?.targets.slice(0, 8) ?? []
        const files: Record<string, unknown>[] = []
        for (const path of paths) {
            timeout.throwIfAborted()
            const withinWorkspace = containsPath(root, canonicalPath(path))
            if (!withinWorkspace || /[\*?\[]/.test(path)) { files.push({ withinWorkspace, inspected: false }); continue }
            try { const info = await bounded(lstat(path)); timeout.throwIfAborted(); files.push({ path: safeRenderRationale(path, 256), withinWorkspace, exists: true, isDirectory: info.isDirectory(), isSymbolicLink: info.isSymbolicLink() }) } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
                files.push({ path: safeRenderRationale(path, 256), withinWorkspace, exists: false })
            }
        }
        result.filesystem = files
        const lockfiles = []
        for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
            try { await bounded(lstat(join(root, name))); lockfiles.push(name) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
            timeout.throwIfAborted()
        }
        result.lockfiles = lockfiles
    }
    if (config.git) {
        try {
            // Do not execute a repository's PATH shim or inherit Git trace/config variables (which can write files).
            const git = ["/usr/bin/git", "/bin/git"].find((path) => existsSync(path))
            if (!git) { result.git = { available: false }; return result }
            const run = async (...args: string[]) => bounded(exec(git, ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd: input.cwd, signal: timeout, timeout: config.timeoutMs, maxBuffer: 1_024, env: { HOME: homedir(), PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" } }))
            const { stdout } = await run("rev-parse", "--abbrev-ref", "HEAD")
            result.git = { branch: safeRenderRationale(stdout, 128) }
            try {
                const remote = (await run("config", "--get", "remote.origin.url")).stdout.trim()
                const host = remote.match(/^(?:[^@\s]+@)?([\w.-]+):[^/]/)?.[1] ?? (() => { try { return new URL(remote).hostname } catch { return undefined } })()
                if (host) (result.git as Record<string, unknown>).remoteHost = safeRenderRationale(host, 128)
            } catch (error) { timeout.throwIfAborted(); if ((error as { code?: number }).code !== 1) throw error }
        } catch (error) {
            timeout.throwIfAborted()
            if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as { code?: number }).code === 128) result.git = { available: false }
            else throw error
        }
    }
    timeout.throwIfAborted()
    if (Buffer.byteLength(JSON.stringify(result)) > config.maxBytes) throw new Error("evidence_oversized")
    return result
}
