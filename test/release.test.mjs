import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { PACKAGE_NAME, validateRelease } from "../scripts/validate-release.mjs"

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

test("npm release metadata uses the public scoped package and a matching stable tag", () => {
    assert.equal(manifest.name, PACKAGE_NAME)
    validateRelease(manifest, `v${manifest.version}`)
})

for (const [name, override, tag] of [
    ["wrong scope", { name: "@someone-else/opencode-codex-guardian" }],
    ["private package", { private: true }],
    ["restricted access", { publishConfig: { ...manifest.publishConfig, access: "restricted" } }],
    ["other registry", { publishConfig: { ...manifest.publishConfig, registry: "https://example.com/" } }],
    ["other repository", { repository: { url: "git+https://github.com/someone-else/repo.git" } }],
    ["prerelease", { version: "0.1.0-beta.1" }, "v0.1.0-beta.1"],
    ["noncanonical version", { version: "00.1.0" }, "v00.1.0"],
    ["newline in version", { version: "0.1.0\n" }, "v0.1.0\n"],
    ["mismatched tag", {}, "v99.0.0"],
    ["missing tag", {}, undefined],
]) test(`npm release rejects ${name}`, () => {
    const releaseTag = name === "missing tag" ? undefined : tag ?? `v${manifest.version}`
    assert.throws(() => validateRelease({ ...manifest, ...override }, releaseTag))
})
