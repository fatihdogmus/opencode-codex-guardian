import { test } from "node:test"
import assert from "node:assert/strict"
import type { Context } from "@opencode/plugin/promise/plugin"
import { CodexAutoReviewTransport } from "../../src/transports/codex-auto-review.ts"
import { Diagnostics } from "../../src/diagnostics.ts"
import { input, allow } from "../helpers.ts"

async function fixture(oauth = true, websocket = false, messages: unknown[] = []) {
    const hooks = new Map<string, (event: any) => Promise<void>>()
    const created: any[] = []
    const removed: string[] = []
    const requests: any[] = []
    const ctx = {
        provider: { get: async () => ({ data: { integrationID: "openai" } }) },
        integration: { connection: { active: async () => ({ type: "credential", method: oauth ? "oauth" : "key" }) } },
        model: { list: async () => ({ data: [{ providerID: "openai", enabled: true, id: "gpt-6-luna" }] }) },
        session: {
            context: async () => messages,
            hook: async (name: string, callback: (event: any) => Promise<void>) => { hooks.set(name, callback) },
            create: async (options: any) => { created.push(options); return { id: `ses_reviewer${created.length}` } },
            remove: async ({ sessionID }: any) => { removed.push(sessionID) },
            generate: async ({ sessionID, prompt }: any) => {
                assert.ok(prompt.includes("strict JSON"))
                const event = { sessionID, kind: "generate", model: { providerID: "openai", id: "gpt-6-luna" } }
                if (websocket) {
                    const handshake = { ...event, url: "wss://chatgpt.com/backend-api/codex/responses", headers: {} as Record<string, string> }
                    await hooks.get("experimental.ws.handshake")!(handshake)
                    assert.equal(handshake.headers["x-codex-guardian"], "reviewer")
                    const send = { ...event, frame: JSON.stringify({ type: "response.create", model: "gpt-6-luna" }) }
                    await hooks.get("experimental.ws.send")!(send)
                    requests.push(JSON.parse(send.frame))
                } else {
                    const request = { ...event, request: new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: JSON.stringify({ model: "gpt-6-luna" }) }) }
                    await hooks.get("http.request")!(request)
                    assert.equal(request.request.headers.get("x-codex-guardian"), "reviewer")
                    requests.push(await request.request.json())
                }
                return { text: JSON.stringify(allow) }
            },
        },
    } as unknown as Context
    const diagnostics = new Diagnostics()
    const transport = new CodexAutoReviewTransport(ctx, diagnostics)
    await transport.installHooks()
    transport.parents.observe(input.sessionID, { type: "response.created", response: { id: "resp_parent" } })
    return { transport, diagnostics, hooks, created, removed, requests }
}

for (const websocket of [false, true]) {
    test(`native ${websocket ? "WebSocket" : "HTTP"} uses existing authenticated provider, linked model rewrite and reusable isolated session`, async () => {
        const f = await fixture(true, websocket)
        assert.deepEqual(await f.transport.review(input, new AbortController().signal), allow)
        assert.deepEqual(await f.transport.review(input, new AbortController().signal), allow)
        assert.equal(f.created.length, 1)
        assert.deepEqual(f.created[0].location, { directory: input.cwd })
        assert.deepEqual(f.created[0].permissions, [{ action: "*", resource: "*", effect: "deny" }])
        assert.equal(f.requests.length, 2)
        assert.ok(f.requests.every((request) => request.model === "codex-auto-review" && request.client_metadata.parent_response_id === "resp_parent"))
        assert.equal(f.diagnostics.nativeState, "NATIVE_WORKS_ACCOUNTING_UNKNOWN")
        assert.equal(f.transport.isInternal("ses_reviewer1"), true)
        const generate = { sessionID: "ses_reviewer1", system: [{ text: "main" }], tools: { shell: {} }, options: {} }
        await f.hooks.get("generate")!(generate)
        assert.deepEqual(generate.tools, {})
        assert.deepEqual(generate.system, [])
        const retry = { sessionID: "ses_reviewer1", decision: { retry: true } }
        await f.hooks.get("retry")!(retry)
        assert.deepEqual(retry.decision, { retry: false })
        await f.transport.close()
        assert.deepEqual(f.removed, ["ses_reviewer1"])
    })
}

test("API key or missing exact parent never sends native inference", async () => {
    const noOAuth = await fixture(false)
    await assert.rejects(() => noOAuth.transport.review(input, new AbortController().signal))
    assert.equal(noOAuth.created.length, 0)
    const noParent = await fixture()
    await assert.rejects(() => noParent.transport.review({ ...input, source: { type: "tool", messageID: "msg", id: "unmatched" } }, new AbortController().signal))
    assert.equal(noParent.created.length, 0)
})

test("nested Code Mode calls correlate through their exact source assistant message", async () => {
    const f = await fixture(true, false, [{ type: "assistant", id: "msg_origin", content: [{ type: "tool", id: "call_outer" }] }])
    f.transport.parents.observe(input.sessionID, { type: "response.output_item.added", item: { call_id: "call_outer" } }, "resp_parent")
    await f.transport.review({ ...input, source: { type: "tool", messageID: "msg_origin", id: "call_nested" } }, new AbortController().signal)
    assert.equal(f.requests[0].client_metadata.parent_response_id, "resp_parent")
    await f.transport.close()
})

test("ambiguous source messages spanning multiple responses defer instead of guessing", async () => {
    const f = await fixture(true, false, [{ type: "assistant", id: "msg_origin", content: [{ type: "tool", id: "call_outer" }, { type: "tool", id: "call_other" }] }])
    f.transport.parents.observe(input.sessionID, { type: "response.output_item.added", item: { call_id: "call_outer" } }, "resp_parent")
    f.transport.parents.observe(input.sessionID, { type: "response.created", response: { id: "resp_other" } })
    f.transport.parents.observe(input.sessionID, { type: "response.output_item.added", item: { call_id: "call_other" } }, "resp_other")
    await assert.rejects(() => f.transport.review({ ...input, source: { type: "tool", messageID: "msg_origin", id: "call_nested" } }, new AbortController().signal))
    assert.equal(f.created.length, 0)
})

test("retired reviewer sessions cannot dispatch ordinary-model requests or retry after cleanup", async () => {
    const f = await fixture()
    await f.transport.review(input, new AbortController().signal)
    await f.transport.close()
    assert.equal(f.transport.isInternal("ses_reviewer1"), true)
    assert.throws(() => f.hooks.get("generate")!({ sessionID: "ses_reviewer1", tools: {}, system: [], options: {} }), /native_session_inactive/)
    await assert.rejects(() => f.hooks.get("http.request")!({ sessionID: "ses_reviewer1", kind: "generate", request: new Request("https://chatgpt.com/backend-api/codex/responses") }), /native_session_inactive/)
    await assert.rejects(() => f.hooks.get("experimental.ws.handshake")!({ sessionID: "ses_reviewer1", kind: "generate", url: "wss://chatgpt.com/backend-api/codex/responses", headers: {} }), /native_session_inactive/)
    await assert.rejects(() => f.hooks.get("experimental.ws.send")!({ sessionID: "ses_reviewer1", kind: "generate", frame: JSON.stringify({ type: "response.create", model: "gpt-6-luna" }) }), /native_session_inactive/)
    const retry = { sessionID: "ses_reviewer1", decision: { retry: true } }
    await f.hooks.get("retry")!(retry)
    assert.deepEqual(retry.decision, { retry: false })
    assert.equal(f.requests.length, 1)
})

test("only primary ChatGPT OAuth requests receive credit metadata; response observer preserves bytes", async () => {
    const f = await fixture()
    for (const kind of ["primary", "title", "generate", "compaction"]) {
        const event = { sessionID: "ses_main", kind, request: new Request("https://chatgpt.com/backend-api/codex/responses", { method: "POST", body: "{}" }) }
        await f.hooks.get("http.request")!(event)
        const body = await event.request.json()
        assert.equal(body.client_metadata?.guardian_credits_requested, kind === "primary" ? "true" : undefined)
    }
    const text = 'data: {"type":"response.created","response":{"id":"resp_actual"}}\n\ndata: {"type":"response.output_item.added","item":{"call_id":"call_actual"}}\n\n'
    const event = { sessionID: "ses_main", kind: "primary", request: new Request("https://chatgpt.com/backend-api/codex/responses"), response: new Response(text) }
    await f.hooks.get("http.response")!(event)
    assert.equal(await event.response.text(), text)
    assert.equal(f.transport.parents.get({ sessionID: "ses_main", source: { type: "tool", messageID: "msg", id: "call_actual" } }), "resp_actual")
    await f.hooks.get("prompt")!({ sessionID: "ses_main" })
    assert.equal(f.transport.parents.get({ sessionID: "ses_main" }), undefined)
})
