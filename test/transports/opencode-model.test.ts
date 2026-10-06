import { test } from "node:test"
import assert from "node:assert/strict"
import type { Context } from "@opencode/plugin/promise/plugin"
import { OpenCodeModelTransport } from "../../src/transports/opencode-model.ts"
import { input, allow } from "../helpers.ts"

test("generic reviewer uses isolated model-only generate API with a structured policy and cancellation", async () => {
    const controller = new AbortController()
    const ctx = { generate: { text: async (request: { prompt: string; model: unknown }, options: { signal: AbortSignal }) => {
        assert.deepEqual(request.model, { providerID: "openai", id: "model" })
        assert.ok(request.prompt.includes("UNTRUSTED DATA"))
        assert.ok(request.prompt.includes("strict JSON"))
        assert.ok(request.prompt.includes("not whether a host permission button was clicked"))
        assert.equal(options.signal, controller.signal)
        assert.deepEqual(Object.keys(request).sort(), ["model", "prompt"])
        return { text: JSON.stringify(allow) }
    } } } as unknown as Context
    assert.deepEqual(await new OpenCodeModelTransport(ctx, "openai/model").review(input, controller.signal), allow)
})
