import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const tarball = process.argv[2]
assert.ok(tarball, "Provide the packed .tgz file")
const archive = resolve(tarball)
const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n")
assert.ok(files.includes("package/dist/index.js"))
assert.ok(files.every((file) => file === "package/package.json" || file.startsWith("package/dist/")), "Package must contain only compiled plugin files and its manifest")
const directory = await mkdtemp(join(tmpdir(), "codex-guardian-smoke-"))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"))
try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }))
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], { cwd: directory, env, stdio: "inherit" })
    const manifest = JSON.parse(await readFile(join(directory, "node_modules/opencode-codex-guardian/package.json"), "utf8"))
    assert.equal(manifest.exports["."], "./dist/index.js")
    execFileSync(process.execPath, ["--input-type=module", "-e", 'const { default: plugin } = await import("opencode-codex-guardian"); if (plugin.id !== "opencode-auto-review" || typeof plugin.setup !== "function") throw new Error("Invalid plugin entrypoint");'], { cwd: directory, stdio: "inherit" })
    console.log("Packed plugin installs and imports without TypeScript tooling or install scripts")
} finally {
    await rm(directory, { recursive: true, force: true })
}
