import type { Config } from "./config.ts"
import { parseAssessment } from "./assessment-parser.ts"
import { CircuitBreaker } from "./circuit-breaker.ts"
import { Diagnostics } from "./diagnostics.ts"
import { effectiveDecision } from "./review-policy.ts"
import { redact } from "./utils/redaction.ts"
import { ReviewError } from "./review-error.ts"
import type { PermissionEvent, ReviewerTransport, ReviewInput } from "./types.ts"

export class PermissionReviewer {
    private queues = new Map<string, Promise<void>>()
    constructor(
        private config: Config,
        private transport: ReviewerTransport,
        private context: (event: PermissionEvent) => Promise<ReviewInput>,
        private breaker: CircuitBreaker,
        private diagnostics: Diagnostics,
        private isInternal: (sessionID: string) => boolean = () => false,
    ) {}
    async evaluate(event: PermissionEvent): Promise<void> {
        if (this.isInternal(event.sessionID)) { event.effect = "deny"; event.message = "Reviewer has no tool permissions"; return }
        if (!this.config.enabled || event.effect !== "ask") return
        const key = event.sessionID
        const previous = this.queues.get(key) ?? Promise.resolve()
        const work = previous.catch(() => {}).then(() => this.run(event))
        this.queues.set(key, work)
        try { await work } finally { if (this.queues.get(key) === work) this.queues.delete(key) }
    }
    private async run(event: PermissionEvent): Promise<void> {
        const started = Date.now()
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            const work = async () => {
                const input = await this.context(event)
                controller.signal.throwIfAborted()
                if (this.breaker.tripped(input)) return { decision: this.config.circuitBreaker.effect, circuitBreaker: true } as const
                const assessment = parseAssessment(await this.transport.review(input, controller.signal))
                controller.signal.throwIfAborted()
                const decision = effectiveDecision(assessment)
                if (decision === "deny") this.breaker.deny(input)
                return { decision, assessment }
            }
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new ReviewError("timeout")) }, this.config.timeoutMs)
            })
            const result = await Promise.race([work(), timeout])
            event.effect = result.decision
            event.message = "Auto-review: " + (result.assessment ? redact(result.assessment.rationale) : "Repeated denied action requires human approval")
            this.diagnostics.lastReview = { ...result, transport: this.transport.name, durationMs: Date.now() - started }
        } catch (error) {
            event.effect = this.config.failureMode
            event.message = this.config.failureMode === "ask" ? "Auto-review unavailable or invalid; manual approval required" : "Auto-review unavailable or invalid; action denied"
            this.diagnostics.lastReview = { decision: event.effect, transport: this.transport.name, durationMs: Date.now() - started, failure: error instanceof ReviewError ? error.code : "provider_or_schema_failure" }
        } finally {
            clearTimeout(timer)
            if (this.config.logging.enabled) console.info("auto-review", JSON.stringify({ action: redact(event.action).slice(0, 100), transport: this.transport.name, decision: event.effect, risk: this.diagnostics.lastReview?.assessment?.risk_level, authorization: this.diagnostics.lastReview?.assessment?.user_authorization, failure: this.diagnostics.lastReview?.failure, circuitBreaker: this.diagnostics.lastReview?.circuitBreaker, durationMs: Date.now() - started }))
        }
    }
}
