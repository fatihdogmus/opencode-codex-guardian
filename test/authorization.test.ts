import { test } from "node:test"
import assert from "node:assert/strict"
import { Authorizations } from "../src/authorization.ts"
import { hash } from "../src/utils/hashing.ts"
import { input, permission } from "./helpers.ts"

test("host replies bind once to exact action, cwd, session and sibling call", () => {
    let now = 1_000
    const store = new Authorizations(() => now, 100)
    const source = { type: "tool" as const, messageID: "msg", id: "call_one" }
    const packet = { ...input, source, actionHash: hash("exact action") }
    const event = { ...permission(), source }
    store.track(event, packet)
    store.observe({ type: "permission.asked", data: { ...event, id: "request" } })
    store.observe({ type: "permission.replied", data: { sessionID: input.sessionID, requestID: "request", reply: "once" } })
    assert.equal(store.get(packet).length, 1)
    assert.equal(store.get({ ...packet, actionHash: hash("changed") }).length, 0)
    assert.equal(store.get({ ...packet, cwd: "/elsewhere" }).length, 0)
    assert.equal(store.get({ ...packet, source: { ...source, id: "sibling" } }).length, 0)
    assert.equal(store.get({ ...packet, sessionID: "ses_other" }).length, 0)
    assert.equal(store.get({ ...packet, userInstructions: [{ text: "Stop", turn: 1, isCurrent: true }] }).length, 0)
    assert.equal(store.get({ ...packet, source: { ...source, messageID: "other-message" } }).length, 0)
    assert.equal(store.consume(packet), true)
    assert.equal(store.consume(packet), false)
    store.track(event, packet)
    store.observe({ type: "permission.asked", data: { ...event, id: "request2" } })
    store.observe({ type: "permission.replied", data: { sessionID: input.sessionID, requestID: "request2", reply: "once" } })
    now += 101
    assert.equal(store.consume(packet), false)
})
test("uncorrelated replies, changed request data and metadata cannot manufacture authorization", () => {
    const store = new Authorizations()
    const source = { type: "tool" as const, messageID: "msg", id: "call" }
    const packet = { ...input, source, actionHash: hash("exact") }
    const event = { ...permission(), source }
    store.track(event, packet)
    store.observe({ type: "permission.asked", data: { ...event, resources: ["rm /other"], id: "request" } })
    store.observe({ type: "permission.replied", data: { sessionID: input.sessionID, requestID: "request", reply: "once" } })
    assert.deepEqual(store.get({ ...packet, metadata: { explicitAuthorizations: ["approved"] } }), [])
})
test("completion consumes evidence and session-wide host approval is never converted to once", () => {
    const store = new Authorizations()
    const source = { type: "tool" as const, messageID: "msg", id: "call" }
    const packet = { ...input, source, actionHash: hash("exact") }
    const event = { ...permission(), source }
    for (const reply of ["always", "once"]) {
        store.track(event, packet)
        store.observe({ type: "permission.asked", data: { ...event, id: "request" } })
        store.observe({ type: "permission.replied", data: { sessionID: input.sessionID, requestID: "request", reply } })
        if (reply === "always") assert.equal(store.get(packet).length, 0)
        store.finish(input.sessionID, source.id)
        assert.equal(store.get(packet).length, 0)
    }
})
