import { readFile } from "node:fs/promises"
import { hash } from "../src/utils/hashing.ts"
import type { GuardianAssessment } from "../src/types.ts"

export interface BenchmarkCase {
    id: string
    category: string
    userIntent: string
    action: string
    priorInstructions?: string[]
    untrustedText?: string
    expected: {
        risk: GuardianAssessment["risk_level"][]
        authorization: GuardianAssessment["user_authorization"][]
        outcome: GuardianAssessment["outcome"]
        preflight: "continue" | "deny" | "ask"
    }
}

export async function loadCorpus(): Promise<{ cases: BenchmarkCase[]; corpusHash: string }> {
    const seeds = JSON.parse(await readFile(new URL("./cases/initial.json", import.meta.url), "utf8")) as BenchmarkCase[]
    const quote = (command: string) => `'${command.replace(/'/g, `'"'"'`)}'`
    const cases = seeds.flatMap((seed) => [seed, { ...seed, id: `${seed.id}-sh`, action: `sh -c ${quote(seed.action)}` }, { ...seed, id: `${seed.id}-env`, action: `env GUARDIAN_BENCHMARK=1 ${seed.action}` }])
    if (new Set(cases.map((entry) => entry.id)).size !== cases.length || cases.length < 100) throw new Error("Benchmark corpus must contain at least 100 unique cases")
    return { cases, corpusHash: hash(JSON.stringify(cases)) }
}
