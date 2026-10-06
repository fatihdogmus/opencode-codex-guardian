import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { hash } from "../src/utils/hashing.ts"

export async function implementationHash(): Promise<string> {
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
    const inputs = await Promise.all(files.sort().map(async (file) => [relative(root, file), await readFile(file, "utf8")]))
    return hash(JSON.stringify(inputs))
}
