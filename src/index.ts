import type { Plugin } from "@opencode/plugin/promise/plugin"
import { loadSecurityConfig, trustedConfigPath } from "./trusted-config.ts"
import { parseConfig } from "./config.ts"
import { defaultProtectedPaths } from "./self-protection.ts"
import { fileURLToPath } from "node:url"
import { basename, dirname, isAbsolute } from "node:path"
import { AuditLog } from "./audit.ts"
import { Authorizations } from "./authorization.ts"
import { SessionApprovals } from "./session-approvals.ts"
import { buildReviewInput } from "./review-context.ts"
import { loadReviewHistory } from "./review-history.ts"
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
        const loaded = await loadSecurityConfig(ctx.options, ctx.location.directory).then((value) => ({ ...value, invalid: false })).catch(() => ({ config: parseConfig({ enabled: true, failureMode: "deny" }), provenance: "unknown" as const, path: trustedConfigPath(), ignoredWeakening: true, invalid: true }))
        const config = loaded.config
        const diagnostics = new Diagnostics()
        diagnostics.config = config
        diagnostics.configProvenance = loaded.provenance
        diagnostics.configPath = loaded.path
        diagnostics.ignoredWeakening = loaded.ignoredWeakening
        diagnostics.configError = loaded.invalid ? "configuration_invalid" : undefined
        const audit = new AuditLog(config.audit)
        diagnostics.auditPath = audit.path
        const authorizations = new Authorizations()
        const approvals = new SessionApprovals(config.sessionApprovals)
        const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)))
        const pluginRoot = basename(moduleRoot) === "dist" ? dirname(moduleRoot) : moduleRoot
        const native = new CodexAutoReviewTransport(ctx, diagnostics)
        const breaker = new CircuitBreaker(config.circuitBreaker)
        const generic = config.fallbackModel ? new OpenCodeModelTransport(ctx, config.fallbackModel) : undefined
        const transport = new SelectingTransport(config, native, generic, diagnostics)
        const pending = new Map<string, { tool: string; input: unknown; messageID: string }>()
        const actionContext = async (event: Parameters<PermissionReviewer["evaluate"]>[0], signal: AbortSignal) => {
            const session = await ctx.session.get({ sessionID: event.sessionID }, { signal })
            const candidate = event.source ? pending.get(`${event.sessionID}:${event.source.id}`) : undefined
            const captured = candidate?.messageID === event.source?.messageID ? candidate : undefined
            const input = captured?.input
            const metadata = { ...event.metadata }
            delete metadata.exactToolInput
            delete metadata.exactToolName
            if (input !== undefined) metadata.exactToolInput = input
            if (captured) metadata.exactToolName = captured.tool
            let cwd = session.location.directory as string
            if (["shell", "bash"].includes(event.action) && input && typeof input === "object") {
                const values = input as Record<string, unknown>
                const directory = values.workdir ?? values.cwd
                if (directory !== undefined) {
                    if (typeof directory !== "string" || !isAbsolute(directory)) throw new Error("Ambiguous tool working directory")
                    cwd = directory
                }
            }
            return { cwd, metadata }
        }
        const reviewer = new PermissionReviewer(config, transport, async (event, signal) => {
            const context = await actionContext(event, signal)
            const history = await loadReviewHistory(ctx.session, event.sessionID, signal)
            return buildReviewInput({ ...event, metadata: context.metadata }, history.messages, context.cwd, config.contextMaxChars, history.complete)
        }, breaker, diagnostics, (sessionID) => native.isInternal(sessionID), [...defaultProtectedPaths(pluginRoot, ctx.location.directory), loaded.path, dirname(audit.path)], {
            audit, authorizations, approvals, configurationInvalid: loaded.invalid,
            actionContext,
        })
        await ctx.permission.hook("evaluate", (event) => reviewer.evaluate(event))
        if (config.enabled && config.transport !== "model" && !loaded.invalid) {
            try { await native.installHooks() } catch { diagnostics.nativeStartupFailure = "native_hooks_unavailable" }
        }
        await ctx.tool.hook("execute.before", (event) => {
            pending.set(`${event.sessionID}:${event.id}`, { tool: event.tool, input: event.input, messageID: event.messageID })
            if (pending.size > 1_000) pending.delete(pending.keys().next().value!)
        })
        await ctx.tool.hook("execute.after", (event) => { pending.delete(`${event.sessionID}:${event.id}`); authorizations.finish(event.sessionID, event.id); approvals.finish(event.sessionID, event.id, event.tool) })
        await ctx.session.hook("prompt", (event) => { authorizations.clearSession(event.sessionID); approvals.clearSession(event.sessionID) })
        const status = () => { diagnostics.sessionApprovalCount = approvals.size; diagnostics.breakerEntries = breaker.size; return diagnostics.status(config.enabled, config.transport) }
        await ctx.rpc.register(AutoReviewRPC, { status: async () => ({ text: status() }) })
        await ctx.command.transform((editor) => {
            editor.add({
                name: "auto-review",
                description: "Auto-review status (no model request)",
                execute: async ({ sessionID }) => {
                    await ctx.session.synthetic({ sessionID, text: status(), resume: false })
                },
            })
        })
        const timer = setInterval(() => { void native.prune().catch(() => {}) }, 60_000)
        const events = new AbortController()
        const subscription = (async () => {
            try {
                for await (const event of ctx.event.subscribe({ signal: events.signal })) {
                    authorizations.observe(event)
                    if (event.type === "session.deleted") { const sessionID = (event.data as { sessionID?: string; id?: string }).sessionID ?? (event.data as { id?: string }).id; if (sessionID) { authorizations.clearSession(sessionID); approvals.clearSession(sessionID); breaker.clearSession(sessionID) } }
                }
                if (!events.signal.aborted) { diagnostics.authorizationEventsHealthy = false; authorizations.clear() }
            } catch { if (!events.signal.aborted) { diagnostics.authorizationEventsHealthy = false; authorizations.clear() } }
        })()
        return async () => {
            clearInterval(timer)
            pending.clear()
            breaker.clear()
            events.abort()
            authorizations.clear()
            approvals.clear()
            await native.close()
            await subscription
            await audit.flush().catch(() => {})
        }
    },
}

export default plugin
