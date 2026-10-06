import type { Plugin } from "@opencode/plugin/promise/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { Model } from "@opencode/plugin"
import plugin from "../src/index.ts"
import { SSEObserver } from "../src/guardian-protocol.ts"
import { OpenCodeModelTransport } from "../src/transports/opencode-model.ts"
import { effectiveDecision } from "../src/review-policy.ts"
import type { ReviewInput } from "../src/types.ts"

const VerificationRPC = Rpc.define({
    id: "auto-review-verification",
    events: {},
    methods: {
        snapshot: { input: { type: "object", additionalProperties: false }, output: { type: "object" } },
        baseline: { input: { type: "object", additionalProperties: false }, output: { type: "object" } },
        traffic: { input: { type: "object", additionalProperties: false }, output: { type: "object" } },
        generic: { input: { type: "object" }, output: { type: "object" } },
    },
})

const verification: Plugin = {
    id: "auto-review-verification",
    async setup(ctx) {
        const cleanup = await plugin.setup({ ...ctx, options: { enabled: true, transport: "codex-auto-review", nativeFreeOnly: true, timeoutMs: 60_000, logging: { enabled: false } } })
        const traffic: { kind: string; model: unknown; parentLinked: boolean; creditsRequested: boolean; guardian: boolean; status?: number }[] = []
        let probeExecuted = 0
        const evaluations: unknown[] = []
        const codeMode = ctx.options.codeMode === true
        await ctx.tool.transform((editor) => {
            editor.update("shell", (tool) => { tool.options = { namespace: tool.options?.namespace, permission: tool.options?.permission, codemode: codeMode } })
            if (codeMode) for (const tool of editor.list()) if (tool.id !== "shell") editor.remove(tool.id)
        })
        await ctx.shell.hook("create.before", (event) => {
            if (event.command !== "printf AUTO_REVIEW_VERIFIED") throw new Error("Verification host only permits the inert printf command")
            probeExecuted++
        })
        await ctx.permission.hook("evaluate", (event) => {
            evaluations.push({ source: event.source, action: event.action, effect: event.effect })
        })
        await ctx.session.hook("context", (event) => {
            const probe = JSON.stringify(event.messages).includes("Run exactly printf AUTO_REVIEW_VERIFIED")
            event.tools = probe ? (codeMode ? event.tools : Object.fromEntries(Object.entries(event.tools).filter(([name]) => name === "shell"))) : {}
            if (!probe) event.system.push({ type: "text", text: "This host is a model-only protocol test. Acknowledge the user request with READY and stop. The host will separately assess the proposed action without executing it." })
        })
        await ctx.session.hook("http.request", async (event) => {
            const body = await event.request.clone().json()
            traffic.push({ kind: event.kind, model: body.model, parentLinked: !!body.client_metadata?.parent_response_id, creditsRequested: body.client_metadata?.guardian_credits_requested === "true", guardian: event.request.headers.get("x-codex-guardian") === "reviewer" })
        }, { providerID: "openai" })
        const completions: unknown[] = []
        const capture = (frame: any) => {
            if (frame.type === "response.completed") completions.push({ model: frame.response?.model, usage: { input_tokens: frame.response?.usage?.input_tokens, output_tokens: frame.response?.usage?.output_tokens, total_tokens: frame.response?.usage?.total_tokens } })
        }
        await ctx.session.hook("http.response", (event) => {
            const latest = traffic.at(-1)
            if (latest) latest.status = event.response.status
            if (event.response.body) {
                const observer = new SSEObserver(capture)
                event.response = new Response(event.response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                    transform(chunk, controller) { observer.push(chunk); controller.enqueue(chunk) },
                })), { status: event.response.status, headers: event.response.headers })
            }
        }, { providerID: "openai" })
        await ctx.session.hook("experimental.ws.send", (event) => {
            const body = JSON.parse(event.frame)
            if (body.type !== "response.create") return
            traffic.push({ kind: event.kind, model: body.model, parentLinked: !!body.client_metadata?.parent_response_id, creditsRequested: body.client_metadata?.guardian_credits_requested === "true", guardian: body.client_metadata?.["x-openai-subagent"] === "guardian" })
        }, { providerID: "openai" })
        await ctx.session.hook("experimental.ws.receive", (event) => capture(JSON.parse(event.frame)), { providerID: "openai" })
        await ctx.rpc.register(VerificationRPC, {
            snapshot: async () => {
                const { data: provider } = await ctx.provider.get({ providerID: "openai" })
                const connection = await ctx.integration.connection.active(provider.integrationID ?? "openai")
                if (!connection) return { available: false }
                const credential = await ctx.integration.connection.resolve(connection)
                if (credential?.type !== "oauth") return { available: false }
                const headers = new Headers({ authorization: `Bearer ${credential.access}` })
                const account = provider.headers?.["chatgpt-account-id"]
                if (account) headers.set("chatgpt-account-id", account)
                const response = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers, signal: AbortSignal.timeout(15_000) })
                if (!response.ok) return { available: false, status: response.status }
                const usage = await response.json() as Record<string, unknown>
                return { available: true, capturedAt: new Date().toISOString(), ...Object.fromEntries(["plan_type", "rate_limit", "code_review_rate_limit", "credits", "additional_rate_limits"].filter((key) => key in usage).map((key) => [key, usage[key]])) }
            },
            baseline: async (_, context) => {
                const result = await ctx.generate.text({ model: Model.Ref.parse("openai/gpt-6-luna"), prompt: "Reply only with READY. This is a short baseline usage-accounting test." }, { signal: context.signal })
                return { completed: result.text.trim().length > 0 }
            },
            traffic: async () => JSON.parse(JSON.stringify({ requests: traffic, completions, probeExecuted, evaluations })),
            generic: async (input, context) => {
                const assessment = await new OpenCodeModelTransport(ctx, "openai/gpt-6-luna").review(input as ReviewInput, context.signal)
                return { assessment, decision: effectiveDecision(assessment) }
            },
        })
        return cleanup
    },
}

export default verification
