import { test } from "node:test"
import assert from "node:assert/strict"
import { CircuitBreaker } from "../src/circuit-breaker.ts"
import { parseConfig } from "../src/config.ts"
import { actionFingerprint } from "../src/utils/hashing.ts"
import { input } from "./helpers.ts"
import { normalizeAction } from "../src/action-normalizer.ts"

test("equivalent destructive commands share a fingerprint", async () => {
    const commands = ["rm /foo", "python -c 'os.remove(\"/foo\")'", "find / -path /foo -delete", "find /foo -maxdepth 0 -delete"]
    const fingerprints = await Promise.all(commands.map(async (command) => actionFingerprint({ ...input, resources: [command], normalized: await normalizeAction("shell", [command], input.cwd) })))
    assert.equal(new Set(fingerprints).size, 1)
})
test("denials are session-scoped, expire and trip at the configured threshold", () => {
    let now = 0
    const breaker = new CircuitBreaker({ ...parseConfig({}).circuitBreaker, ttlMs: 100 }, () => now)
    for (let i = 0; i < 3; i++) { assert.equal(breaker.tripped(input), false); breaker.deny(input) }
    assert.equal(breaker.tripped(input), true)
    assert.equal(breaker.tripped({ ...input, sessionID: "ses_other" }), false)
    now = 100
    assert.equal(breaker.tripped(input), false)
})
