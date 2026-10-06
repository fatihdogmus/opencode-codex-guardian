import { test } from "node:test"
import assert from "node:assert/strict"
import { CircuitBreaker } from "../src/circuit-breaker.ts"
import { parseConfig } from "../src/config.ts"
import { actionFingerprint } from "../src/utils/hashing.ts"
import { input } from "./helpers.ts"

test("equivalent destructive commands share a fingerprint", () => {
    const commands = ["rm ~/private.txt", "python -c 'os.remove(\"~/private.txt\")'", "find ~ -path ~/private.txt -delete", "find ~ -name private.txt -delete"]
    assert.equal(new Set(commands.map((command) => actionFingerprint({ ...input, resources: [command] }))).size, 1)
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
