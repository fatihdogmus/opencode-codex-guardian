import { homedir } from "node:os"
import { resolve, normalize } from "node:path"
import { analyzeShell } from "./shell-analysis.ts"
import { hash } from "./utils/hashing.ts"
import { canonicalPath, containsPath } from "./self-protection.ts"
import type { ActionCategory, NormalizedAction, ShellCommand } from "./types.ts"

export function resolveTarget(target: string, cwd: string): string {
    return normalize(resolve(cwd, target.replace(/^~(?=\/|$)|^\$HOME(?=\/|$)/, homedir())))
}

function category(command: ShellCommand): ActionCategory {
    if (["rm", "rmdir", "unlink"].includes(command.executable) || (command.executable === "find" && command.args.includes("-delete"))) return "filesystem_delete"
    if (/^python[\d.]*$/.test(command.executable) && command.args[0] === "-c" && /^(?:import os;\s*)?os\.(?:remove|unlink)\(["'][^"']+["']\)\s*;?$/.test(command.args[1] ?? "")) return "filesystem_delete"
    if (["curl", "wget", "nc", "ncat", "scp", "sftp", "ssh"].includes(command.executable)) return "network_request"
    if (["cat", "less", "stat", "ls", "pwd", "rg", "grep"].includes(command.executable)) return "filesystem_read"
    if (["cp", "mv", "touch", "mkdir", "tee", "chmod", "chown", "dd"].includes(command.executable)) return "filesystem_write"
    if (command.executable === "git") return "git_operation"
    if (["npm", "pnpm", "yarn", "pip", "pip3", "uv", "brew", "apt", "apt-get"].includes(command.executable) && command.args.some((arg) => ["install", "add"].includes(arg))) return "package_install"
    return "process_execute"
}

export function isSimpleDeletion(command: ShellCommand): boolean {
    return ["rm", "rmdir", "unlink"].includes(command.executable) || (/^python[\d.]*$/.test(command.executable) && category(command) === "filesystem_delete" && command.args.length === 2) || (command.executable === "find" && ((command.args.length === 4 && command.args[1] === "-maxdepth" && command.args[2] === "0" && command.args[3] === "-delete") || (command.args.length === 4 && command.args[1] === "-path" && command.args[3] === "-delete")))
}

export async function normalizeAction(action: string, resources: readonly string[], cwd: string, metadata?: Record<string, unknown>): Promise<NormalizedAction> {
    const rawHash = hash(JSON.stringify([action, resources, cwd, metadata ?? {}]))
    const result: NormalizedAction = { category: "unknown", targets: [], hosts: [], wrappers: [], privileged: false, rawHash, commands: [], redirections: [], pipelines: 0, cwd }
    if (!resources.length || resources.length > 32 || resources.reduce((size, resource) => size + Buffer.byteLength(resource), 0) > 32_768) return { ...result, ambiguous: "action_limit" }
    if (!["shell", "bash"].includes(action)) {
        result.category = action === "read" ? "filesystem_read" : ["edit", "write", "patch"].includes(action) ? "filesystem_write" : "unknown"
        result.targets = resources.map((resource) => resolveTarget(resource, cwd))
        if (action === "external_directory" && typeof metadata?.exactToolName === "string" && ["read", "glob", "grep"].includes(metadata.exactToolName)) {
            const input = metadata.exactToolInput as Record<string, unknown> | undefined
            const path = input && (input.path ?? input.filePath)
            // A name or metadata claim alone is not enough: the captured path must
            // lie within every canonical directory boundary being requested.
            const target = typeof path === "string" ? canonicalPath(resolveTarget(path, cwd)) : undefined
            if (target && resources.every((resource) => resource.startsWith("/") && resource.endsWith("/*") && containsPath(canonicalPath(resource.slice(0, -2)), target))) {
                result.category = "filesystem_read"
                result.subtype = metadata.exactToolName === "glob" ? "directory_listing" : metadata.exactToolName === "grep" ? "content_search" : "file_read"
                result.targets = [target]
            }
        }
        return result
    }
    const exactInput = metadata?.exactToolInput
    const exactCommand = exactInput && typeof exactInput === "object" ? (exactInput as Record<string, unknown>).command : undefined
    const commands = [...resources]
    if (typeof exactCommand === "string" && !resources.includes(exactCommand)) { commands.push(exactCommand); result.ambiguous = "action_resource_mismatch" }
    for (const resource of commands) {
        const parsed = await analyzeShell(resource)
        result.commands.push(...parsed.commands)
        result.redirections.push(...parsed.redirections)
        result.pipelines += parsed.pipelines
        result.secretReferences ||= parsed.secretReferences
        if (parsed.environmentAssignments) (result.environmentAssignments ??= []).push(...parsed.environmentAssignments)
        result.ambiguous ??= parsed.ambiguous
    }
    const categories = result.commands.map(category)
    result.category = categories.includes("filesystem_delete") ? "filesystem_delete" : categories.includes("network_request") ? "network_request" : categories.length === 1 ? categories[0] : "unknown"
    const targets: string[] = result.redirections.map((redirect) => redirect.target)
    for (const command of result.commands) {
        const commandTargets: string[] = []
        result.privileged ||= command.privileged
        result.wrappers.push(...command.wrappers)
        for (const arg of command.args) {
            try { const url = new URL(arg); if (["https:", "http:"].includes(url.protocol)) { result.hosts.push(url.hostname.toLowerCase()); continue } } catch {}
            if (/^(?:~\/|\$HOME\/|\/|\.\.?\/)/.test(arg) || (!arg.startsWith("-") && !/[\s"'();{}=]/.test(arg) && arg.includes("/"))) commandTargets.push(arg)
            if (/^(?:if|of)=/.test(arg)) commandTargets.push(arg.slice(3))
            if (/^@/.test(arg)) commandTargets.push(arg.slice(1))
            if (/^--(?:upload-file|data-binary|data|data-urlencode)=/.test(arg)) {
                const value = arg.slice(arg.indexOf("=") + 1)
                if (arg.startsWith("--upload-file=") || value.startsWith("@")) commandTargets.push(value.replace(/^@/, ""))
            }
            for (const match of arg.matchAll(/["']((?:\/|~\/|\.\/)[^"']+)["']/g)) commandTargets.push(/^python[\d.]*$/.test(command.executable) && !match[1].startsWith("/") ? resolve(cwd, match[1]) : match[1])
        }
        if (["curl", "wget", "scp", "sftp"].includes(command.executable)) {
            for (let index = 0; index < command.args.length; index++) if (["-T", "--upload-file", "--post-file"].includes(command.args[index]) && command.args[index + 1]) commandTargets.push(command.args[index + 1])
            if (["scp", "sftp"].includes(command.executable)) commandTargets.push(...command.args.filter((arg) => !arg.startsWith("-") && !arg.includes(":")))
        }
        if (["nc", "ncat", "ssh", "scp", "sftp"].includes(command.executable)) {
            const destination = command.args.find((arg) => !arg.startsWith("-") && /^(?:[^@\s]+@)?[\w.-]+(?::[^\s]*)?$/.test(arg))
            if (destination) result.hosts.push(destination.replace(/^.*@/, "").split(":")[0].toLowerCase())
        }
        if (category(command) === "filesystem_delete") {
            if (command.executable === "find") {
                const pathIndex = command.args.indexOf("-path")
                if (pathIndex === 1 && command.args.length === 4 && command.args[3] === "-delete" && !/[\*?\[]/.test(command.args[2])) { commandTargets.length = 0; commandTargets.push(command.args[2]); result.subtype = "delete-entry" }
                else if (command.args.length === 4 && command.args[1] === "-maxdepth" && command.args[2] === "0" && command.args[3] === "-delete") { commandTargets.length = 0; commandTargets.push(command.args[0]); result.subtype = "delete-entry" }
                else { commandTargets.push(command.args[0]); result.subtype = "delete-tree" }
            } else {
                commandTargets.push(...command.args.filter((arg) => !arg.startsWith("-") && !/^python/.test(command.executable)))
                result.subtype = command.args.some((arg) => arg === "--recursive" || /^-[a-zA-Z]*[rR]/.test(arg)) ? "delete-tree" : "delete-entry"
            }
        }
        if (["filesystem_read", "filesystem_write"].includes(category(command))) commandTargets.push(...command.args.filter((arg) => !arg.startsWith("-") && !arg.includes("=") && !/\s/.test(arg)))
        if (["sed", "perl", "ruby", "python", "python3", "node", "awk"].includes(command.executable)) {
            for (const arg of command.args) {
                for (const match of arg.matchAll(/["']([^"']+)["']/g)) if (!/[\s\n]/.test(match[1])) commandTargets.push(match[1])
                if (!arg.startsWith("-") && !/[\s;()"'{}=]/.test(arg)) commandTargets.push(arg)
            }
        }
        if (/^python[\d.]*$/.test(command.executable) && isSimpleDeletion(command)) {
            const literal = command.args[1].match(/os\.(?:remove|unlink)\(["']([^"']+)["']\)/)?.[1]
            if (literal) { commandTargets.length = 0; commandTargets.push(resolve(cwd, literal)) }
        }
        if (["python", "python3", "perl", "ruby", "node", "awk"].includes(command.executable) && !isSimpleDeletion(command)) result.ambiguous ??= "shell_indirect_code"
        targets.push(...commandTargets)
    }
    if (result.redirections.some((redirect) => /[>]/.test(redirect.operator)) && result.category === "filesystem_read") result.category = "filesystem_write"
    result.targets = [...new Set(targets.filter(Boolean).map((target) => resolveTarget(target, cwd)))].sort()
    result.hosts = [...new Set(result.hosts)].sort()
    result.fingerprintSafe = result.commands.length === 1 && !result.redirections.length && !result.pipelines && isSimpleDeletion(result.commands[0])
    return result
}
