import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, symlink, rm, mkdir, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enrichEvidence } from "../src/evidence.ts"
import { normalizeAction } from "../src/action-normalizer.ts"
import { parseConfig } from "../src/config.ts"
import { input } from "./helpers.ts"

test("filesystem evidence reads metadata, not content, and excludes external symlinks", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "guardian-evidence-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    await writeFile(join(directory, "file"), "SECRET_CONTENT_NEVER_READ")
    await symlink("/etc", join(directory, "outside"))
    const packet = { ...input, cwd: directory, normalized: await normalizeAction("read", [join(directory, "file"), join(directory, "outside/passwd")], directory) }
    const evidence = await enrichEvidence(packet, { ...parseConfig({}).evidence, git: false }, new AbortController().signal)
    const data = JSON.stringify(evidence)
    assert.ok(!data.includes("SECRET_CONTENT_NEVER_READ"))
    assert.ok(data.includes('"exists":true'))
    assert.ok(data.includes('"inspected":false'))
    await assert.rejects(() => enrichEvidence(packet, parseConfig({}).evidence, AbortSignal.abort()))
})

test("optional evidence limits are reported as unavailable, not an authorization failure", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "guardian-evidence-budget-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, "a".repeat(160))
    await writeFile(path, "NOT_READ")
    const normalized = await normalizeAction("read", [path], directory)
    const packet = { ...input, cwd: directory, normalized: { ...normalized, targets: Array(8).fill(path) } }
    const evidence = await enrichEvidence(packet, { ...parseConfig({}).evidence, git: false, maxBytes: 512 }, new AbortController().signal)
    assert.deepEqual(evidence, { unavailable: "output_limit" })
})

test("unreadable optional metadata does not disable review, while caller cancellation still fails closed", async (t) => {
    if (process.getuid?.() === 0 || process.platform === "win32") { t.skip("requires ordinary POSIX permissions"); return }
    const directory = await mkdtemp(join(tmpdir(), "guardian-evidence-denied-"))
    const locked = join(directory, "locked")
    await mkdir(locked)
    await writeFile(join(locked, "file"), "NOT_READ")
    t.after(async () => { await chmod(locked, 0o700); await rm(directory, { recursive: true, force: true }) })
    const normalized = await normalizeAction("read", [join(locked, "file")], directory)
    await chmod(locked, 0)
    const packet = { ...input, cwd: directory, normalized }
    assert.deepEqual(await enrichEvidence(packet, { ...parseConfig({}).evidence, git: false }, new AbortController().signal), { unavailable: "access_denied" })
    await assert.rejects(() => enrichEvidence(packet, parseConfig({}).evidence, AbortSignal.abort()))
})
