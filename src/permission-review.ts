import type { Config } from "./config.ts"
import { parseAssessment } from "./assessment-parser.ts"
import { CircuitBreaker } from "./circuit-breaker.ts"
import { Diagnostics } from "./diagnostics.ts"
import { effectiveDecision } from "./review-policy.ts"
import { safeRenderRationale } from "./utils/safe-render.ts"
import { normalizeAction } from "./action-normalizer.ts"
import { runPreflight } from "./preflight.ts"
import { targetsProtectedResource } from "./self-protection.ts"
import { ReviewError, failureDetails, type FailureDetails, type ReviewStage } from "./review-error.ts"
import { fitReviewInput } from "./review-context.ts"
import { hash } from "./utils/hashing.ts"
import { redactValue } from "./utils/redaction.ts"
import { enrichEvidence } from "./evidence.ts"
import { AuditLog, type ReviewAuditRecord } from "./audit.ts"
import { Authorizations } from "./authorization.ts"
import { SessionApprovals } from "./session-approvals.ts"
import type { PermissionEvent, ReviewerTransport, ReviewInput, EffectiveDecision, GuardianAssessment } from "./types.ts"

interface ReviewResult {
    decision: EffectiveDecision
    assessment?: GuardianAssessment
    preflight?: string
    reason?: string
    circuitBreaker?: boolean
    cached?: boolean
    failure?: string
    failureDetails?: FailureDetails
}
export interface ReviewServices {
    configurationInvalid?: boolean
    audit?: AuditLog
    authorizations?: Authorizations
    approvals?: SessionApprovals
    actionContext?: (event: PermissionEvent, signal: AbortSignal) => Promise<{ cwd: string; metadata?: Record<string, unknown> }>
}

export class PermissionReviewer {
    private queues = new Map<string, Promise<void>>()
    constructor(
        private config: Config,
        private transport: ReviewerTransport,
        private context: (event: PermissionEvent, signal: AbortSignal) => Promise<ReviewInput>,
        private breaker: CircuitBreaker,
        private diagnostics: Diagnostics,
        private isInternal: (sessionID: string) => boolean = () => false,
        private protectedPaths: readonly string[] = [],
        private services: ReviewServices = {},
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
        let input: ReviewInput | undefined
        let action: ReviewInput["normalized"]
        let result: ReviewResult
        let stage: ReviewStage = "configuration"
        try {
            const work = async (): Promise<ReviewResult> => {
                if (this.services.configurationInvalid) return { decision: "deny", failure: "configuration_invalid", reason: "Trusted Guardian configuration is invalid" }
                stage = "action_context"
                const actionContext = this.services.actionContext ? await this.services.actionContext(event, controller.signal) : (input = await this.context(event, controller.signal))
                controller.signal.throwIfAborted()
                stage = "normalization"
                action = await normalizeAction(event.action, event.resources, actionContext.cwd, actionContext.metadata)
                controller.signal.throwIfAborted()
                if (this.config.preflight.enabled) {
                    stage = "preflight"
                    const preflight = runPreflight(action)
                    if (preflight.kind !== "continue") return { decision: preflight.kind, preflight: preflight.rule, reason: preflight.reason }
                }
                stage = "self_protection"
                if (this.config.selfProtection.enabled && targetsProtectedResource(action, [...this.protectedPaths, ...this.config.selfProtection.protectedPaths])) return { decision: "ask", reason: "Protected Guardian or OpenCode configuration requires human approval", preflight: "self_protection" }
                stage = "context"
                input ??= await this.context(event, controller.signal)
                input.cwd = action.cwd
                input.normalized = redactValue(action)
                input.actionHash = action.rawHash
                input.protocol = undefined
                stage = "authorization"
                input.explicitAuthorizations = this.services.authorizations?.get(input) ?? []
                controller.signal.throwIfAborted()
                if (!this.config.shadow && this.services.authorizations?.consume(input)) return { decision: "allow", cached: true, reason: "Exact host-approved retry" }
                if (this.breaker.tripped(input)) return { decision: this.config.circuitBreaker.effect, circuitBreaker: true }
                if (!this.config.shadow && this.services.approvals?.has(input)) return { decision: "allow", cached: true }
                stage = "evidence"
                if (this.services.actionContext) input.evidence = await enrichEvidence(input, this.config.evidence, controller.signal)
                stage = "packet_budget"
                fitReviewInput(input, this.config.contextMaxChars)
                controller.signal.throwIfAborted()
                stage = "reviewer"
                const response = await this.transport.review(input, controller.signal)
                stage = "assessment"
                const assessment = parseAssessment(response)
                controller.signal.throwIfAborted()
                const decision = effectiveDecision(assessment)
                return { decision, assessment }
            }
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new ReviewError("timeout")) }, this.config.timeoutMs)
            })
            result = await Promise.race([work(), timeout])
        } catch (error) {
            result = { decision: this.config.failureMode, failure: error instanceof ReviewError ? error.code : "review_boundary_failure", failureDetails: failureDetails(error, stage), reason: "Auto-review unavailable or invalid; manual approval required" }
        } finally {
            clearTimeout(timer)
        }
        const decision = this.config.shadow ? "ask" : result.decision
        const record: ReviewAuditRecord = { timestamp: new Date().toISOString(), sessionHash: hash(event.sessionID), actionType: action?.category ?? "unknown", resourceHash: action?.rawHash ?? hash(JSON.stringify([event.action, event.resources])), transport: input?.reviewTransport ?? (result.assessment ? this.transport.name : "none"), mode: this.config.shadow ? "shadow" : "active", guardianDecision: result.assessment?.outcome, proposedDecision: result.decision, effectiveDecision: decision, riskLevel: result.assessment?.risk_level, authorizationLevel: result.assessment?.user_authorization, latencyMs: Date.now() - started, parentLinked: !!input?.protocol, protocol: input?.protocol, preflight: result.preflight, failure: result.failure, failureDetails: result.failureDetails, cached: result.cached }
        event.effect = decision
        try { await this.services.audit?.write(record); if (this.services.audit && this.config.audit.enabled) this.diagnostics.auditHealthy = true } catch (error) {
            this.diagnostics.auditHealthy = false
            result.failure = "audit_write_failed"
            result.failureDetails = failureDetails(error, "audit")
            event.effect = this.config.shadow ? "ask" : event.effect === "deny" ? "deny" : this.config.failureMode
        }
        if (input && !this.config.shadow) {
            if (event.effect === "deny") this.breaker.deny(input)
            if (event.effect === "allow" && result.assessment?.risk_level === "low") this.services.approvals?.grant(input)
        }
        if (event.effect === "ask" && input) this.services.authorizations?.track(event, input)
        event.message = event.effect === "allow" ? undefined : this.config.shadow ? "Guardian shadow mode: human approval required" : "Auto-review: " + safeRenderRationale(result.failure ? "Review could not be safely completed; human approval required" : result.assessment?.rationale ?? result.reason ?? "Repeated denied action requires human approval")
        this.diagnostics.lastReview = { ...result, decision: event.effect, proposedDecision: result.decision, assessment: result.assessment ? { ...result.assessment, rationale: safeRenderRationale(result.assessment.rationale) } : undefined, transport: record.transport, durationMs: record.latencyMs }
        if (this.config.logging.enabled) console.info("auto-review", JSON.stringify({ ...record, effectiveDecision: event.effect, failure: result.failure, failureDetails: result.failureDetails }))
    }
}
