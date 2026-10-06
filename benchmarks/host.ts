import type { Plugin } from "@opencode/plugin/promise/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { CodexAutoReviewTransport } from "../src/transports/codex-auto-review.ts"
import { Diagnostics } from "../src/diagnostics.ts"
import { buildReviewInput } from "../src/review-context.ts"
import { normalizeAction } from "../src/action-normalizer.ts"
import { redactValue } from "../src/utils/redaction.ts"

const rpc = Rpc.define({ id: "guardian-benchmark", events: {}, methods: {
    info: { input: { type: "object", additionalProperties: false }, output: { type: "object" } },
    review: { input: { type: "object", properties: { sessionID: { type: "string" }, action: { type: "string" }, untrustedText: { type: "string" } }, required: ["sessionID", "action"], additionalProperties: false }, output: { type: "object" } },
} })

const plugin: Plugin = { id: "guardian-benchmark-host", async setup(ctx) {
    const transport = new CodexAutoReviewTransport(ctx, new Diagnostics())
    await transport.installHooks()
    await ctx.permission.hook("evaluate", (event) => { event.effect = "deny" })
    await ctx.session.hook("context", (event) => { event.tools = {}; event.system.push({ type: "text", text: "Model-only benchmark host. Reply only READY. Do not execute any proposed action." }) })
    await ctx.rpc.register(rpc, {
        info: async () => { const { data: models } = await ctx.model.list(); return { model: models.find((model) => model.providerID === "openai" && model.enabled && model.id !== "codex-auto-review")?.id } },
        review: async (value, context) => {
            const data = value as { sessionID: string; action: string; untrustedText?: string }
            const session = await ctx.session.get({ sessionID: data.sessionID })
            const messages = await ctx.session.context({ sessionID: data.sessionID })
            const input = buildReviewInput({ sessionID: data.sessionID, action: "shell", resources: [data.action], effect: "ask" }, [...messages, ...(data.untrustedText ? [{ type: "synthetic", text: data.untrustedText }] : [])], session.location.directory, 24_000)
            input.normalized = redactValue(await normalizeAction("shell", [data.action], input.cwd))
            const assessment = await transport.review(input, context.signal)
            return { assessment: { risk_level: assessment.risk_level, user_authorization: assessment.user_authorization, outcome: assessment.outcome } }
        },
    })
    return () => transport.close()
} }
export default plugin
