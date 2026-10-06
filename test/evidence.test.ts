import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises"
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
