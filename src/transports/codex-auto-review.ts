import type { Context } from "@opencode/plugin/promise/plugin"
import { Model } from "@opencode/plugin"
import { parseAssessment } from "../assessment-parser.ts"
import { AUTHORIZATION_GUIDANCE, buildReviewPrompt } from "../review-policy.ts"
import { guardianBody, isCodexURL, primaryBody, ParentResponses, SSEObserver } from "../guardian-protocol.ts"
import { Diagnostics } from "../diagnostics.ts"
import { ReviewError } from "../review-error.ts"
import type { GuardianAssessment, ReviewerTransport, ReviewInput } from "../types.ts"

interface ReviewSession {
    sessionID: string
    parentID: string
    sent: boolean
    protocol?: "sse" | "websocket"
    cleanup?: Promise<void>
}

export class CodexAutoReviewTransport implements ReviewerTransport {
    readonly name = "codex-auto-review"
    readonly parents = new ParentResponses()
    private reviewers = new Map<string, ReviewSession>()
    private internalSessions = new Set<string>()
    private creating = new Set<Promise<unknown>>()
    private wsResponses = new Map<string, string>()
    private wsEligible = new Set<string>()
    private closed = false
    private hooksReady = false
    constructor(private ctx: Context, private diagnostics: Diagnostics) {}

    isInternal(sessionID: string): boolean {
        return this.internalSessions.has(sessionID)
    }

    async oauthAvailable(): Promise<boolean> {
        const { data: provider } = await this.ctx.provider.get({ providerID: "openai" })
        const connection = await this.ctx.integration.connection.active(provider.integrationID ?? "openai")
        this.diagnostics.oauth = !!connection && connection.type === "credential" && connection.method === "oauth" && !connection.status
        return this.diagnostics.oauth
    }

    async installHooks(): Promise<void> {
        this.hooksReady = false
        const reviewer = (sessionID: string) => this.reviewers.get(sessionID)
        const requireActive = (entry: ReviewSession) => { if (this.closed || reviewer(entry.sessionID) !== entry) throw new ReviewError("native_session_inactive") }
        await this.ctx.session.hook("prompt", (event) => {
            this.parents.reset(event.sessionID)
            this.wsResponses.delete(event.sessionID)
        })
        await this.ctx.session.hook("generate", (event) => {
            if (!this.isInternal(event.sessionID)) return
            if (this.closed || !reviewer(event.sessionID)) throw new ReviewError("native_session_inactive")
            event.tools = {}
            // Only plugin-authored guidance is privileged; never promote review data.
            event.system = [{ type: "text", text: AUTHORIZATION_GUIDANCE }]
            event.options.reasoningEffort = "low"
        })
        await this.ctx.session.hook("retry", (event) => {
            if (this.isInternal(event.sessionID)) event.decision = { retry: false }
        })
        await this.ctx.session.hook("http.request", async (event) => {
            const entry = reviewer(event.sessionID)
            if (this.isInternal(event.sessionID) && (this.closed || !entry)) throw new ReviewError("native_session_inactive")
            if (entry) {
                if (event.kind !== "generate" || !isCodexURL(event.request.url) || !await this.oauthAvailable()) throw new ReviewError("native_route_unavailable")
                const body = guardianBody(await event.request.clone().json(), entry.parentID, entry.sessionID)
                requireActive(entry)
                const headers = new Headers(event.request.headers)
                headers.set("x-codex-guardian", "reviewer")
                headers.set("x-openai-subagent", "guardian")
                headers.delete("x-codex-routing-hint")
                event.request = new Request(event.request, { headers, body: JSON.stringify(body) })
                entry.sent = true
                entry.protocol = "sse"
                this.recordProtocol()
                return
            }
            if (event.kind !== "primary" || !isCodexURL(event.request.url) || !await this.oauthAvailable()) return
            event.request = new Request(event.request, { body: JSON.stringify(primaryBody(await event.request.clone().json())) })
            this.diagnostics.primaryMetadata = true
        }, { providerID: "openai" })
        await this.ctx.session.hook("http.response", (event) => {
            if (reviewer(event.sessionID) || event.kind !== "primary" || !isCodexURL(event.request.url) || !event.response.body) return
            let currentID: string | undefined
            const observer = new SSEObserver((frame) => { currentID = this.parents.observe(event.sessionID, frame, currentID) })
            event.response = new Response(event.response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) { observer.push(chunk); controller.enqueue(chunk) },
            })), { status: event.response.status, statusText: event.response.statusText, headers: event.response.headers })
        }, { providerID: "openai" })
        await this.ctx.session.hook("experimental.ws.handshake", async (event) => {
            const entry = reviewer(event.sessionID)
            if (this.isInternal(event.sessionID) && (this.closed || !entry)) throw new ReviewError("native_session_inactive")
            this.wsEligible.delete(event.sessionID)
            if (!isCodexURL(event.url) || !await this.oauthAvailable()) {
                if (entry) throw new ReviewError("native_route_unavailable")
                return
            }
            this.wsEligible.add(event.sessionID)
            if (!entry) return
            requireActive(entry)
            if (event.kind !== "generate") throw new ReviewError("native_request_kind_invalid")
            event.headers["x-codex-guardian"] = "reviewer"
            event.headers["x-openai-subagent"] = "guardian"
            delete event.headers["x-codex-routing-hint"]
        }, { providerID: "openai" })
        await this.ctx.session.hook("experimental.ws.send", async (event) => {
            const entry = reviewer(event.sessionID)
            if (this.isInternal(event.sessionID) && (this.closed || !entry)) throw new ReviewError("native_session_inactive")
            if (!entry && (event.kind !== "primary" || !this.wsEligible.has(event.sessionID) || !await this.oauthAvailable())) return
            if (entry && !this.wsEligible.has(event.sessionID)) throw new ReviewError("native_handshake_missing")
            if (entry) requireActive(entry)
            const body = JSON.parse(event.frame)
            if (body.type !== "response.create") return
            if (entry) {
                event.frame = JSON.stringify(guardianBody(body, entry.parentID, entry.sessionID))
                entry.sent = true
                entry.protocol = "websocket"
                this.recordProtocol()
            } else {
                event.frame = JSON.stringify(primaryBody(body))
                this.diagnostics.primaryMetadata = true
            }
        }, { providerID: "openai" })
        await this.ctx.session.hook("experimental.ws.receive", (event) => {
            if (reviewer(event.sessionID) || event.kind !== "primary") return
            const id = this.parents.observe(event.sessionID, JSON.parse(event.frame), this.wsResponses.get(event.sessionID))
            if (id) this.wsResponses.set(event.sessionID, id)
        }, { providerID: "openai" })
        this.hooksReady = true
    }

    private recordProtocol(): void {
        this.diagnostics.parentLinked = true
        this.diagnostics.guardianHeader = true
        this.diagnostics.guardianSubagent = true
    }

    private retire(entry: ReviewSession): Promise<void> {
        this.reviewers.delete(entry.sessionID)
        this.wsEligible.delete(entry.sessionID)
        this.wsResponses.delete(entry.sessionID)
        return entry.cleanup ??= this.ctx.session.remove({ sessionID: entry.sessionID }, { signal: AbortSignal.timeout(5_000) }).catch(() => {
            this.diagnostics.cleanupFailures++
            throw new ReviewError("native_cleanup_failed")
        })
    }

    async review(input: ReviewInput, signal: AbortSignal): Promise<GuardianAssessment> {
        signal.throwIfAborted()
        if (!this.hooksReady) throw new ReviewError("native_hooks_unavailable")
        if (this.closed || !await this.oauthAvailable()) throw new ReviewError("native_oauth_unavailable")
        const parentID = await this.parentResponse(input)
        if (!parentID) throw new ReviewError("parent_response_missing")
        let entry: ReviewSession | undefined
        const retire = () => entry ? this.retire(entry) : Promise.resolve()
        const abort = () => { void retire().catch(() => {}) }
        try {
            const { data: models } = await this.ctx.model.list()
            const model = models.find((candidate) => candidate.providerID === "openai" && candidate.enabled && candidate.id !== "codex-auto-review")
            if (!model) throw new ReviewError("native_model_route_missing")
            signal.throwIfAborted()
            if (this.closed) throw new ReviewError("native_session_inactive")
            const pending = this.ctx.session.create({
                parentID: input.sessionID,
                location: { directory: input.cwd },
                title: "Auto-review (internal)",
                model: Model.Ref.parse(`openai/${model.id}`),
                permissions: [{ action: "*", resource: "*", effect: "deny" }],
            })
            this.creating.add(pending)
            let created
            try { created = await pending } finally { this.creating.delete(pending) }
            entry = { sessionID: created.id, parentID, sent: false }
            this.internalSessions.add(created.id)
            this.reviewers.set(created.id, entry)
            signal.addEventListener("abort", abort, { once: true })
            signal.throwIfAborted()
            if (this.closed) throw new ReviewError("native_session_inactive")
            const result = await this.ctx.session.generate({ sessionID: entry.sessionID, prompt: buildReviewPrompt(input) }, { signal })
            signal.throwIfAborted()
            if (!entry.sent) throw new ReviewError("native_hook_missing")
            const assessment = parseAssessment(result.text)
            this.diagnostics.nativeState = "NATIVE_WORKS_ACCOUNTING_UNKNOWN"
            this.diagnostics.protocol = entry.protocol
            input.protocol = entry.protocol
            return assessment
        } catch (error) {
            this.diagnostics.nativeState = "NATIVE_UNAVAILABLE"
            throw error
        } finally {
            signal.removeEventListener("abort", abort)
            await retire()
        }
    }

    private async parentResponse(input: ReviewInput): Promise<string | undefined> {
        const direct = this.parents.get(input)
        if (direct || !input.source) return direct
        const messages = await this.ctx.session.context({ sessionID: input.sessionID })
        const message = messages.find((message) => message.id === input.source!.messageID && message.type === "assistant")
        if (message?.type !== "assistant") return undefined
        const candidates = new Set(message.content
            .filter((part) => part.type === "tool")
            .map((part) => this.parents.get({ sessionID: input.sessionID, source: { ...input.source!, id: part.id } }))
            .filter((id): id is string => id !== undefined))
        return candidates.size === 1 ? candidates.values().next().value : undefined
    }

    async prune(): Promise<void> {
        for (const sessionID of this.wsResponses.keys()) {
            if (this.parents.get({ sessionID })) continue
            this.wsResponses.delete(sessionID)
            this.wsEligible.delete(sessionID)
        }
    }

    async close(): Promise<void> {
        this.closed = true
        await Promise.allSettled(this.creating)
        await Promise.allSettled([...this.reviewers.values()].map((entry) => this.retire(entry)))
        this.reviewers.clear()
        this.parents.clear()
        this.wsResponses.clear()
        this.wsEligible.clear()
    }
}
