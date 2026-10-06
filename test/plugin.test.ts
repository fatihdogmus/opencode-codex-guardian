import { test } from "node:test"
import assert from "node:assert/strict"
import type { Context } from "@opencode/plugin/promise/plugin"
import plugin from "../src/index.ts"
import { permission, allow } from "./helpers.ts"

test("plugin loads, registers permission hook and exposes diagnostics without inference", async () => {
    let evaluate!: (event: any) => Promise<void>
    let calls = 0
    const ctx = {
        options: { enabled: true, transport: "model", fallbackModel: "openai/model", nativeFreeOnly: false, logging: { enabled: false } },
        permission: { hook: async (_: string, callback: any) => { evaluate = callback } },
        tool: { hook: async () => {} },
        session: {
            get: async () => ({ location: { directory: "/workspace" } }),
            context: async () => [{ type: "user", text: "Install the dependencies" }],
            synthetic: async () => {},
        },
        generate: { text: async () => { calls++; return { text: JSON.stringify(allow) } } },
        rpc: { register: async (definition: any, handlers: any) => {
            assert.equal(definition.id, "auto-review")
            assert.equal(JSON.parse((await handlers.status()).text).freeReviewAccounting, "unverified")
        } },
        command: { transform: async (callback: any) => callback({ add: (definition: any) => assert.equal(definition.name, "auto-review") }) },
    } as unknown as Context
    const cleanup = await plugin.setup(ctx)
    const event = permission()
    await evaluate(event)
    assert.equal(event.effect, "allow")
    assert.equal(calls, 1)
    await cleanup?.()
})
