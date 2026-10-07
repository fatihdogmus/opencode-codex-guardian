import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PACKAGE_NAME, validateRelease } from "./validate-release.mjs"

const tarball = process.argv[2]
assert.ok(tarball, "Provide the packed .tgz file")
const archive = resolve(tarball)
const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n")
assert.ok(files.includes("package/dist/index.js"))
assert.ok(files.includes("package/LICENSE"))
assert.ok(files.every((file) => ["package/package.json", "package/README.md", "package/LICENSE"].includes(file) || file.startsWith("package/dist/")), "Package must contain only compiled plugin files, its manifest, README, and license")
const directory = await mkdtemp(join(tmpdir(), "codex-guardian-smoke-"))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"))
try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }))
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], { cwd: directory, env, stdio: "inherit" })
    const manifest = JSON.parse(await readFile(join(directory, "node_modules", PACKAGE_NAME, "package.json"), "utf8"))
    validateRelease(manifest, `v${manifest.version}`)
    assert.equal(manifest.exports["."], "./dist/index.js")
    assert.equal(manifest.license, "MIT")
    execFileSync(process.execPath, ["--input-type=module", "-e", `const { default: plugin } = await import(${JSON.stringify(PACKAGE_NAME)}); if (plugin.id !== "opencode-auto-review" || typeof plugin.setup !== "function") throw new Error("Invalid plugin entrypoint");`], { cwd: directory, stdio: "inherit" })
    execFileSync(process.execPath, ["--input-type=module", "-e", `const { normalizeAction } = await import(new URL("./src/action-normalizer.js", import.meta.resolve(${JSON.stringify(PACKAGE_NAME)}))); const action = await normalizeAction("shell", ["echo smoke"], "/workspace"); if (action.ambiguous || action.commands[0]?.executable !== "echo") throw new Error("Packaged Bash WASM parser failed");`], { cwd: directory, stdio: "inherit" })
    console.log("Packed plugin installs and imports without TypeScript tooling or install scripts")
} finally {
    await rm(directory, { recursive: true, force: true })
}
