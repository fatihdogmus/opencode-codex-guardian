import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { normalizeAction } from "../src/action-normalizer.ts"
import { targetsProtectedResource } from "../src/self-protection.ts"

test("protected mutations require approval through direct, shell and interpreter paths", async () => {
    const paths = ["/workspace/.opencode", "/guardian", "/workspace/opencode.json"]
    for (const command of ["rm -rf .opencode", "cp payload opencode.json", "sudo sh -c 'printf disabled > /guardian/policy.json'", 'python -c \'open("/guardian/policy.json", "w").write("disabled")\'', "opencode plugin remove opencode-auto-review"]) assert.equal(targetsProtectedResource(await normalizeAction("shell", [command], "/workspace"), paths), true, command)
    assert.equal(targetsProtectedResource(await normalizeAction("edit", ["/guardian/src/index.ts"], "/workspace"), paths), true)
    assert.equal(targetsProtectedResource(await normalizeAction("read", ["/guardian/src/index.ts"], "/workspace"), paths), false)
    assert.equal(targetsProtectedResource(await normalizeAction("shell", ["rm -rf ./dist"], "/workspace"), paths), false)
})
test("canonicalization follows existing symlink parents of new files", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "guardian-protection-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    await mkdir(join(directory, "private"))
    await symlink(join(directory, "private"), join(directory, "alias"))
    const action = await normalizeAction("write", [join(directory, "alias/new.json")], directory)
    assert.equal(targetsProtectedResource(action, [join(directory, "private")]), true)
})

test("captured read-only log access can reach review without exempting mutations or unknown callers", async () => {
    const resources = ["/guardian/*"]
    for (const tool of ["read", "glob", "grep", "edit", "shell", undefined]) {
        const metadata = tool ? { exactToolName: tool, exactToolInput: { path: "/guardian/logs" } } : undefined
        const action = await normalizeAction("external_directory", resources, "/workspace", metadata)
        assert.equal(targetsProtectedResource(action, ["/guardian"]), !["read", "glob", "grep"].includes(tool ?? ""))
    }
    assert.equal(targetsProtectedResource(await normalizeAction("edit", ["/guardian/logs"], "/workspace"), ["/guardian"]), true)
})
