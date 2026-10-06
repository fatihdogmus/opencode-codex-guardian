import { createHash } from "node:crypto"
import type { ReviewInput } from "../types.ts"

export function hash(value: string): string { return createHash("sha256").update(value).digest("hex") }

export function actionFingerprint(input: ReviewInput): string {
    const action = input.normalized
    if (action && action.fingerprintSafe && !action.ambiguous && action.category === "filesystem_delete" && action.targets.length && !action.targets.some((target) => /[\*?\[]/.test(target))) return hash(JSON.stringify([action.category, action.subtype, action.targets, action.hosts, action.privileged, input.cwd]))
    return action?.rawHash ?? hash(JSON.stringify([input.action, input.resources, input.cwd, input.metadata ?? {}]))
}
