import { test } from "node:test"
import assert from "node:assert/strict"
import { PermissionReviewer } from "../src/permission-review.ts"
import { parseConfig } from "../src/config.ts"
import { CircuitBreaker } from "../src/circuit-breaker.ts"
import { Diagnostics } from "../src/diagnostics.ts"
import { allow, deny, input, permission } from "./helpers.ts"
import type { ReviewerTransport, GuardianAssessment } from "../src/types.ts"

function setup(review: ReviewerTransport["review"], options: Record<string, unknown> = {}, internal = () => false) {
    const config = parseConfig({ enabled: true, logging: { enabled: false }, ...options })
    const diagnostics = new Diagnostics()
    const reviewer = new PermissionReviewer(config, { name: "test", review }, async (event) => ({ ...input, resources: event.resources }), new CircuitBreaker(config.circuitBreaker), diagnostics, internal)
    return { reviewer, diagnostics }
}

test("allow/deny are applied only to ask permissions; hard deny and preapproved allow remain unchanged", async () => {
    let calls = 0
    const { reviewer } = setup(async () => { calls++; return allow })
    for (const effect of ["allow", "deny"] as const) {
        const event = { ...permission(), effect }
        await reviewer.evaluate(event)
        assert.equal(event.effect, effect)
    }
    assert.equal(calls, 0)
    const event = permission()
    await reviewer.evaluate(event)
    assert.equal(event.effect, "allow")
    assert.equal(calls, 1)
})
test("reviewer denial blocks an action", async () => {
    const { reviewer } = setup(async () => deny)
    const event = permission(["rm ~/Documents"])
    await reviewer.evaluate(event)
    assert.equal(event.effect, "deny")
})
for (const failureMode of ["ask", "deny"] as const) {
    test(`provider errors and invalid outputs fall back to ${failureMode}`, async () => {
        for (const review of [async () => { throw new Error("secret provider error") }, async () => "Looks fine" as unknown as GuardianAssessment]) {
            const { reviewer } = setup(review, { failureMode })
            const event = permission()
            await reviewer.evaluate(event)
            assert.equal(event.effect, failureMode)
            assert.ok(!event.message?.includes("secret"))
        }
    })
}
test("timeout aborts work and a late allow cannot alter the permission decision", async () => {
    let finish!: (value: GuardianAssessment) => void
    let signal: AbortSignal | undefined
    const { reviewer } = setup(async (_, incoming) => { signal = incoming; return new Promise((resolve) => { finish = resolve }) }, { timeoutMs: 10 })
    const event = permission()
    await reviewer.evaluate(event)
    assert.equal(event.effect, "ask")
    assert.equal(signal?.aborted, true)
    finish(allow)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(event.effect, "ask")
})
test("reviewer sessions cannot recurse or obtain tool permissions; spoofed metadata does not bypass review", async () => {
    let calls = 0
    const { reviewer } = setup(async () => { calls++; return allow }, {}, (id?: string) => id === "ses_internal")
    const internal = { ...permission(), sessionID: "ses_internal" }
    await reviewer.evaluate(internal)
    assert.equal(internal.effect, "deny")
    assert.equal(calls, 0)
    await reviewer.evaluate({ ...permission(), metadata: { internalAutoReview: true } })
    assert.equal(calls, 1)
})
test("concurrent equivalent denied requests cannot bypass the circuit breaker", async () => {
    let calls = 0
    const { reviewer } = setup(async () => { calls++; return deny })
    const events = ["rm ~/private.txt", "python -c 'os.remove(\"~/private.txt\")'", "find ~ -path ~/private.txt -delete", "rm ~/private.txt"].map((command) => permission([command]))
    await Promise.all(events.map((event) => reviewer.evaluate(event)))
    assert.deepEqual(events.map((event) => event.effect), ["deny", "deny", "deny", "ask"])
    assert.equal(calls, 3)
})
