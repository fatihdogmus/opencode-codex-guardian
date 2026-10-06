import { realpathSync } from "node:fs"
import { dirname, join, relative, resolve, isAbsolute } from "node:path"
import { homedir } from "node:os"
import type { NormalizedAction } from "./types.ts"

export function canonicalPath(path: string): string {
    let parent = resolve(path)
    const suffix: string[] = []
    while (true) {
        try { return join(realpathSync(parent), ...suffix.reverse()) } catch (error) {
            if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
            if (dirname(parent) === parent) return resolve(path)
            suffix.push(parent.slice(dirname(parent).length + (dirname(parent) === "/" ? 0 : 1)))
            parent = dirname(parent)
        }
    }
}

export function containsPath(parent: string, child: string): boolean {
    const rel = relative(parent, child)
    return !rel || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel))
}

export function defaultProtectedPaths(pluginRoot: string, cwd: string, configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")): string[] {
    const paths = [pluginRoot, join(configHome, "opencode"), join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode/auth.json"), join(homedir(), "Library/Application Support/opencode/auth.json")]
    for (let path = resolve(cwd); ; path = dirname(path)) {
        paths.push(join(path, "opencode.json"), join(path, "opencode.jsonc"), join(path, ".opencode"))
        if (dirname(path) === path) break
    }
    return paths
}

export function targetsProtectedResource(action: NormalizedAction, paths: readonly string[]): boolean {
    if (action.category === "filesystem_read" && !action.redirections.some((redirect) => redirect.operator.includes(">"))) return false
    if (action.commands.some((command) => command.executable === "opencode" && ["plugin", "config", "auth"].includes(command.args[0]) && command.args.some((arg) => ["remove", "set", "logout", "disable"].includes(arg)))) return true
    if (action.ambiguous === "shell_environment_override") return true
    const protectedPaths = paths.map(canonicalPath)
    return action.targets.some((target) => {
        const path = canonicalPath(target.replace(/\/\*$/, ""))
        if (/(?:^|\/)\.opencode(?:\/|$)|(?:^|\/)opencode\.jsonc?$/.test(path)) return true
        return protectedPaths.some((protectedPath) => containsPath(protectedPath, path) || containsPath(path, protectedPath))
    })
}
