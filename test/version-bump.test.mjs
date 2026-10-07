import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { bumpRelease } from "../scripts/bump-release.mjs"

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

for (const [bump, expected] of [["patch", "1.2.4"], ["minor", "1.3.0"], ["major", "2.0.0"]]) {
    test(`${bump} bumps both package files without hooks, commits or tags`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "guardian-version-test-"))
        try {
            const fixture = { ...manifest, version: "1.2.3", scripts: { preversion: 'node -e "process.exit(99)"', version: 'node -e "process.exit(99)"', postversion: 'node -e "process.exit(99)"' }, dependencies: {}, devDependencies: {} }
            const lock = { name: fixture.name, version: fixture.version, lockfileVersion: 3, requires: true, packages: { "": { name: fixture.name, version: fixture.version, license: fixture.license, engines: fixture.engines } } }
            await writeFile(join(directory, "package.json"), JSON.stringify(fixture, null, 2) + "\n")
            await writeFile(join(directory, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n")
            assert.deepEqual(await bumpRelease(bump, directory), { version: expected, tag: `v${expected}` })
            const changed = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
            const lockChanged = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"))
            assert.deepEqual(changed, { ...fixture, version: expected })
            assert.equal(lockChanged.version, expected)
            assert.equal(lockChanged.packages[""].version, expected)
        } finally { await rm(directory, { recursive: true, force: true }) }
    })
}

test("version bump rejects unsupported inputs before writing files", async () => {
    for (const bump of [undefined, "", "premajor", "1.2.3", "patch\nmajor"]) await assert.rejects(bumpRelease(bump, "/not-a-project"), /Choose patch, minor, or major/)
})
