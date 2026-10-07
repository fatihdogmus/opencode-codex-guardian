import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const PACKAGE_NAME = "@fatihdogmus/opencode-codex-guardian"

export function validateRelease(manifest, tag) {
    assert.equal(manifest.name, PACKAGE_NAME, "Unexpected npm package name")
    assert.ok(!manifest.private, "Release package must not be private")
    assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Only stable versions may publish as latest")
    assert.equal(manifest.version.trim(), manifest.version, "Version must not contain whitespace")
    assert.equal(tag, `v${manifest.version}`, "Release tag must match package.json version")
    assert.equal(manifest.publishConfig?.access, "public", "Scoped package must publish publicly")
    assert.equal(manifest.publishConfig?.registry, "https://registry.npmjs.org/", "Unexpected npm registry")
    assert.equal(manifest.repository?.url, "git+https://github.com/fatihdogmus/opencode-codex-guardian.git", "Unexpected provenance repository")
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [, , tag, archive, ...extra] = process.argv
    assert.equal(extra.length, 0, "Provide at most one tarball")
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    validateRelease(manifest, tag)
    if (archive) {
        const packed = JSON.parse(execFileSync("tar", ["-xOf", resolve(archive), "package/package.json"], { encoding: "utf8" }))
        validateRelease(packed, tag)
        assert.deepEqual(packed, manifest, "Packed manifest must match the release checkout")
    }
    console.log(`Release validated: ${manifest.name}@${manifest.version}`)
}
