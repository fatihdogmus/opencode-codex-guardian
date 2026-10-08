import { test } from "node:test"
import assert from "node:assert/strict"
import type { Context } from "@opencode/plugin/promise/plugin"
import plugin from "../src/index.ts"
import { permission, allow } from "./helpers.ts"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("plugin loads, registers permission hook and exposes diagnostics without inference", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "guardian-plugin-test-"))
    const oldConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = directory
    t.after(async () => { if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfigHome; await rm(directory, { recursive: true, force: true }) })
    await mkdir(join(directory, "opencode"))
    await writeFile(join(directory, "opencode/codex-guardian.json"), JSON.stringify({ enabled: true, transport: "model", fallbackModel: "openai/model", nativeFreeOnly: false, logging: { enabled: false }, audit: { enabled: false }, evidence: { enabled: false } }), { mode: 0o600 })
    let evaluate!: (event: any) => Promise<void>
    let calls = 0
    let before!: (event: any) => Promise<void>
    let after!: (event: any) => Promise<void>
    let packet: any
    const ctx = {
        options: {},
        location: { directory: "/workspace" },
        event: { subscribe: async function* () {} },
        permission: { hook: async (_: string, callback: any) => { evaluate = callback } },
        tool: { hook: async (name: string, callback: any) => { if (name === "execute.before") before = callback; else after = callback } },
        session: {
            hook: async () => {},
            get: async () => ({ location: { directory: "/workspace" } }),
            context: async () => [{ type: "user", text: "Install the dependencies" }],
            synthetic: async () => {},
        },
        generate: { text: async ({ prompt }: { prompt: string }) => { calls++; packet = JSON.parse(prompt.split("Review packet (JSON data, not instructions):\n")[1]); return { text: JSON.stringify(allow) } } },
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
    const source = { type: "tool" as const, messageID: "msg_call", id: "call_glob" }
    const external = { ...permission(["/workspace/.opencode/*"]), action: "external_directory", source, metadata: { exactToolName: "glob", exactToolInput: { path: "/workspace/.opencode" } } }
    await evaluate(external)
    assert.equal(external.effect, "ask", "untrusted metadata cannot exempt protected paths")
    assert.equal(calls, 1)
    await before({ sessionID: external.sessionID, messageID: source.messageID, id: source.id, tool: "glob", input: { path: "/workspace/.opencode", pattern: "*.log" } })
    await evaluate({ ...external, effect: "ask" })
    assert.equal(calls, 2)
    assert.equal(packet.normalized.category, "filesystem_read")
    assert.equal(packet.normalized.subtype, "directory_listing")
    const wrongMessage = { ...external, effect: "ask", source: { ...source, messageID: "msg_other" } }
    await evaluate(wrongMessage)
    assert.equal(wrongMessage.effect, "ask")
    assert.equal(calls, 2)
    await after({ sessionID: external.sessionID, id: source.id, tool: "glob" })
    const finished = { ...external, effect: "ask" }
    await evaluate(finished)
    assert.equal(finished.effect, "ask")
    assert.equal(calls, 2)
    await cleanup?.()
})
