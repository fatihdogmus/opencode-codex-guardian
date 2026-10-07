import { test } from "node:test"
import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"

const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")

test("one manual release publishes npm and GitHub without drafts or a second workflow", async () => {
    assert.match(workflow, /^name: Release$/m)
    assert.match(workflow, /workflow_dispatch:/)
    assert.match(workflow, /default: patch/)
    for (const bump of ["patch", "minor", "major"]) assert.match(workflow, new RegExp(`^          - ${bump}$`, "m"))
    assert.doesNotMatch(workflow, /--draft|types: \[published\]/)
    assert.match(workflow, /id-token: write/)
    assert.match(workflow, /npm publish \.\/artifacts\/\*\.tgz .*--provenance/)
    assert.match(workflow, /gh release create .*--verify-tag/)
    await assert.rejects(access(new URL("../.github/workflows/publish.yml", import.meta.url)), { code: "ENOENT" })
})

test("release checks credentials and tests before pushing, then publishes npm before GitHub", () => {
    const steps = [
        "Require the current main commit",
        "Check npm credentials before changing the version",
        "Bump package and lockfile versions",
        "npm run check",
        "npm run smoke",
        "Validate tested package",
        "Save tested package for recovery",
        "Commit version and push matching tag",
        "Publish tested tarball to npm",
        "Publish GitHub release",
    ].map((step) => workflow.indexOf(step))
    assert.ok(steps.every((position, index) => position >= 0 && (index === 0 || position > steps[index - 1])))
    assert.match(workflow, /git push --atomic/)
    assert.doesNotMatch(workflow, /git push[^\n]*--force/)
})
