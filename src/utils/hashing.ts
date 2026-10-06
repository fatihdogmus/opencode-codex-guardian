import { createHash } from "node:crypto"
import { posix } from "node:path"
import type { ReviewInput } from "../types.ts"

export function actionFingerprint(input: ReviewInput): string {
    const raw = `${input.resources.join(" ")} ${JSON.stringify(input.metadata ?? {})}`
    const destructive = /\brm\b|\bunlink\b|\brmtree\b|\bos\.remove\b|-delete\b|\bDELETE\b|\bDROP\b/i.test(raw)
    const paths = [...raw.matchAll(/(?:~\/|\/|\.\/)[\w.@~+/-]+/g)].map((match) => posix.normalize(match[0].replace(/^~\//, "$HOME/")))
    for (const match of raw.matchAll(/\bfind\s+(~|\S+)\s+-(?:name|path)\s+["']?([\w.@+-]+)["']?/g)) {
        paths.push(posix.join(match[1] === "~" ? "$HOME" : match[1], match[2]))
    }
    const hosts = [...raw.matchAll(/https?:\/\/([^/\s"']+)/g)].map((match) => match[1].toLowerCase())
    const targets = [...new Set([...paths, ...hosts])].sort()
    const effect = destructive ? "destroy" : /\bcurl\b|\bwget\b|upload|POST\b/.test(raw) ? "network" : input.action
    return createHash("sha256").update(JSON.stringify([effect, input.cwd, targets.length ? targets : input.resources])).digest("hex")
}
