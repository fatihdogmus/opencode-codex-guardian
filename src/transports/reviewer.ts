import type { Config } from "../config.ts"
import { Diagnostics } from "../diagnostics.ts"
import type { GuardianAssessment, ReviewerTransport, ReviewInput } from "../types.ts"

export class SelectingTransport implements ReviewerTransport {
    name = "unselected"
    constructor(private config: Config, private native: ReviewerTransport, private generic: ReviewerTransport | undefined, private diagnostics: Diagnostics) {}
    async review(input: ReviewInput, signal: AbortSignal): Promise<GuardianAssessment> {
        if (this.config.transport !== "model") {
            this.name = this.native.name
            input.reviewTransport = this.native.name
            try { return await this.native.review(input, signal) } catch (error) {
                if (signal.aborted || this.config.nativeFreeOnly || this.config.transport === "codex-auto-review") throw error
            }
        }
        if (this.config.nativeFreeOnly || !this.generic) throw new Error("No permitted fallback reviewer")
        this.name = this.generic.name
        input.reviewTransport = this.generic.name
        input.protocol = undefined
        const result = await this.generic.review(input, signal)
        this.diagnostics.nativeState = "FALLBACK_MODEL"
        return result
    }
}
