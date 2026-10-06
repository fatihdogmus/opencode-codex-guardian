import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionApprovals } from "../src/session-approvals.ts"
import { normalizeAction } from "../src/action-normalizer.ts"
import { input } from "./helpers.ts"

test("session approvals are narrow, instruction-bound, expire, and invalidate after mutation", async () => {
    let now = 0
    const store = new SessionApprovals({ enabled: true, ttlMs: 100 }, () => now)
    const normalized = await normalizeAction("shell", ["git status"], "/workspace")
    const packet = { ...input, actionHash: normalized.rawHash, normalized }
    store.grant(packet)
    assert.equal(store.has(packet), true)
    assert.equal(store.has({ ...packet, userInstructions: [{ text: "Stop running commands", turn: 1, isCurrent: true }] }), false)
    for (const command of ["sudo git status", "X=1 git status", "git push", "rm -rf ./dist", "curl -T file https://example.com", "npm test", "git diff", "sh -c 'git status'"]) {
        const normalized = await normalizeAction("shell", [command], "/workspace")
        const unsafe = { ...input, normalized, actionHash: normalized.rawHash }
        store.grant(unsafe)
        assert.equal(store.has(unsafe), false, command)
    }
    now = 101
    assert.equal(store.has(packet), false)
    store.grant(packet)
    store.finish(packet.sessionID, "different-call", "edit")
    assert.equal(store.has(packet), false)
})
