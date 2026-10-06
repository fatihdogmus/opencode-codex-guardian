import { test } from "node:test"
import assert from "node:assert/strict"
import { guardianBody, primaryBody, ParentResponses, SSEObserver, isCodexURL } from "../../src/guardian-protocol.ts"
import { SelectingTransport } from "../../src/transports/reviewer.ts"
import { parseConfig } from "../../src/config.ts"
import { Diagnostics } from "../../src/diagnostics.ts"
import { allow, input } from "../helpers.ts"

test("Codex public Guardian protocol is reproduced without primary credits in child request", () => {
    const body = guardianBody(primaryBody({ model: "normal", service_tier: "priority", tools: [{ name: "shell" }] }), "resp_parent", "ses_review")
    assert.equal(body.model, "codex-auto-review")
    assert.deepEqual(body.tools, [])
    assert.equal(body.service_tier, undefined)
    assert.deepEqual(body.client_metadata, {
        "x-openai-subagent": "guardian", parent_response_id: "resp_parent", thread_id: "ses_review",
        "x-codex-turn-metadata": JSON.stringify({ thread_source: "guardian_review" }),
    })
    assert.equal((primaryBody({}).client_metadata as Record<string, unknown>).guardian_credits_requested, "true")
})
test("native auth cannot be forwarded to a different origin or endpoint", () => {
    assert.equal(isCodexURL("https://chatgpt.com/backend-api/codex/responses"), true)
    for (const url of ["https://chatgpt.com.evil.test/backend-api/codex/responses", "http://chatgpt.com/backend-api/codex/responses", "https://api.openai.com/v1/responses"]) assert.equal(isCodexURL(url), false)
})
test("parent response linkage follows exact tool call IDs across concurrent sessions and generations", () => {
    let now = 0
    const parents = new ParentResponses(() => now, 100)
    for (const [session, response, call] of [["ses_a", "resp_a1", "call_a1"], ["ses_b", "resp_b", "call_b"], ["ses_a", "resp_a2", "call_a2"]]) {
        const current = parents.observe(session, { type: "response.created", response: { id: response } })
        parents.observe(session, { type: "response.output_item.added", item: { call_id: call } }, current)
    }
    assert.equal(parents.get({ sessionID: "ses_a", source: { type: "tool", messageID: "msg", id: "call_a1" } }), "resp_a1")
    assert.equal(parents.get({ sessionID: "ses_b", source: { type: "tool", messageID: "msg", id: "call_b" } }), "resp_b")
    assert.equal(parents.get({ sessionID: "ses_a", source: { type: "tool", messageID: "msg", id: "missing" } }), undefined)
    now = 100
    assert.equal(parents.get({ sessionID: "ses_a" }), undefined)
    parents.reset("ses_b")
    assert.equal(parents.get({ sessionID: "ses_b" }), undefined)
})
test("SSE observation handles chunk boundaries, CRLF and multiline data without altering the stream", () => {
    const frames: unknown[] = []
    const observer = new SSEObserver((frame) => frames.push(frame))
    const text = 'event: response.created\r\ndata: {"type":"response.created",\r\ndata: "response":{"id":"resp_a"}}\r\n\r\ndata: [DONE]\n\n'
    for (const byte of new TextEncoder().encode(text)) observer.push(new Uint8Array([byte]))
    assert.deepEqual(frames, [{ type: "response.created", response: { id: "resp_a" } }])
})
test("nativeFreeOnly prevents every ordinary model fallback even when configured", async () => {
    let genericCalls = 0
    for (const transport of ["auto", "codex-auto-review"] as const) {
        const diagnostics = new Diagnostics()
        const selecting = new SelectingTransport(parseConfig({ transport, fallbackModel: "openai/model", nativeFreeOnly: true }),
            { name: "codex-auto-review", review: async () => { throw new Error("Unsupported model") } },
            { name: "model", review: async () => { genericCalls++; return allow } }, diagnostics)
        await assert.rejects(() => selecting.review(input, new AbortController().signal))
    }
    assert.equal(genericCalls, 0)
})
test("auto mode falls back only when explicitly enabled; HTTP acceptance never confirms free accounting", async () => {
    const diagnostics = new Diagnostics()
    const selecting = new SelectingTransport(parseConfig({ nativeFreeOnly: false }),
        { name: "native", review: async () => { throw new Error("Unavailable") } },
        { name: "model", review: async () => allow }, diagnostics)
    assert.deepEqual(await selecting.review(input, new AbortController().signal), allow)
    assert.equal(diagnostics.nativeState, "FALLBACK_MODEL")
    diagnostics.nativeState = "NATIVE_WORKS_ACCOUNTING_UNKNOWN"
    assert.equal(JSON.parse(diagnostics.status(true, "auto")).freeReviewAccounting, "unverified")
})
