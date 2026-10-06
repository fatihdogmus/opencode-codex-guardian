import type { Plugin } from "@opencode/plugin/promise/plugin"
import { parseConfig } from "./config.ts"
import { buildReviewInput } from "./review-context.ts"
import { CircuitBreaker } from "./circuit-breaker.ts"
import { Diagnostics } from "./diagnostics.ts"
import { PermissionReviewer } from "./permission-review.ts"
import { CodexAutoReviewTransport } from "./transports/codex-auto-review.ts"
import { OpenCodeModelTransport } from "./transports/opencode-model.ts"
import { SelectingTransport } from "./transports/reviewer.ts"
import { AutoReviewRPC } from "./rpc.ts"

const plugin: Plugin = {
    id: "opencode-auto-review",
    async setup(ctx) {
        const config = parseConfig(ctx.options)
        const diagnostics = new Diagnostics()
        const native = new CodexAutoReviewTransport(ctx, diagnostics)
        const breaker = new CircuitBreaker(config.circuitBreaker)
        const generic = config.fallbackModel ? new OpenCodeModelTransport(ctx, config.fallbackModel) : undefined
        const transport = new SelectingTransport(config, native, generic, diagnostics)
        const pending = new Map<string, unknown>()
        const reviewer = new PermissionReviewer(config, transport, async (event) => {
            const session = await ctx.session.get({ sessionID: event.sessionID })
            const messages = await ctx.session.context({ sessionID: event.sessionID })
            const input = event.source ? pending.get(`${event.sessionID}:${event.source.id}`) : undefined
            return buildReviewInput({ ...event, metadata: { ...event.metadata, ...(input === undefined ? {} : { exactToolInput: input }) } }, messages, session.location.directory, config.contextMaxChars)
        }, breaker, diagnostics, (sessionID) => native.isInternal(sessionID))
        if (config.enabled && config.transport !== "model") await native.installHooks()
        await ctx.permission.hook("evaluate", (event) => reviewer.evaluate(event))
        await ctx.tool.hook("execute.before", (event) => {
            pending.set(`${event.sessionID}:${event.id}`, event.input)
            if (pending.size > 1_000) pending.delete(pending.keys().next().value!)
        })
        await ctx.tool.hook("execute.after", (event) => { pending.delete(`${event.sessionID}:${event.id}`) })
        await ctx.rpc.register(AutoReviewRPC, { status: async () => ({ text: diagnostics.status(config.enabled, config.transport) }) })
        await ctx.command.transform((editor) => {
            editor.add({
                name: "auto-review",
                description: "Auto-review status (no model request)",
                execute: async ({ sessionID }) => {
                    await ctx.session.synthetic({ sessionID, text: diagnostics.status(config.enabled, config.transport), resume: false })
                },
            })
        })
        const timer = setInterval(() => { void native.prune().catch(() => {}) }, 60_000)
        return async () => {
            clearInterval(timer)
            pending.clear()
            breaker.clear()
            await native.close()
        }
    },
}

export default plugin
