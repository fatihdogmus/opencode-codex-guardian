import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { hash } from "../src/utils/hashing.ts"

// A recorded benchmark version may differ from a release-only version bump.
// Keep package identity, dependency versions/integrities and all code in the hash.
export function lockfileAtVersion(content: string, version: string): string {
    if (typeof version !== "string" || version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Invalid benchmark package version")
    const lock = JSON.parse(content)
    if (typeof lock.version !== "string" || lock.packages?.[""]?.version !== lock.version) throw new Error("Inconsistent lockfile root versions")
    if (lock.version === version) return content
    lock.version = version
    lock.packages[""].version = version
    return JSON.stringify(lock, null, 2) + "\n"
}

export async function implementationHash(packageVersion?: string): Promise<string> {
    const root = fileURLToPath(new URL("../", import.meta.url))
    const files: string[] = []
    const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name)
            if (entry.isDirectory()) await walk(path)
            else if (entry.name.endsWith(".ts")) files.push(path)
        }
    }
    await walk(join(root, "src"))
    files.push(join(root, "package-lock.json"), join(root, "benchmarks/host.ts"))
    const inputs = await Promise.all(files.sort().map(async (file) => {
        const name = relative(root, file)
        const content = await readFile(file, "utf8")
        return [name, name === "package-lock.json" && packageVersion !== undefined ? lockfileAtVersion(content, packageVersion) : content]
    }))
    return hash(JSON.stringify(inputs))
}
