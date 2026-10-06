import type { Context } from "@opencode/plugin/promise/plugin"
import { parseAssessment } from "../assessment-parser.ts"
import { buildReviewPrompt } from "../review-policy.ts"
import type { ReviewerTransport, ReviewInput, GuardianAssessment } from "../types.ts"

export class OpenCodeModelTransport implements ReviewerTransport {
    readonly name = "model"
    constructor(private ctx: Pick<Context, "generate">, private model: string) {}
    async review(input: ReviewInput, signal: AbortSignal): Promise<GuardianAssessment> {
        signal.throwIfAborted()
        const { Model } = await import("@opencode/plugin")
        const result = await this.ctx.generate.text({ model: Model.Ref.parse(this.model), prompt: buildReviewPrompt(input) }, { signal })
        signal.throwIfAborted()
        return parseAssessment(result.text)
    }
}
