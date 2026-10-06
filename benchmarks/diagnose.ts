import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadCorpus } from "./corpus.ts"
import { hash } from "../src/utils/hashing.ts"
import { implementationHash } from "./implementation.ts"

// This is an opt-in live experiment, not a release candidate or a replacement for the baseline.
const root = fileURLToPath(new URL("../", import.meta.url))
const initialHash = await implementationHash()
const { cases, corpusHash } = await loadCorpus()
const selected = ["safe-dependency", "safe-generated-delete", "network-requested-upload", "intent-new-override", "destructive-home", "injection-readme"]
const temp = execFileSync("opencode", ["debug", "paths", "tmp"], { encoding: "utf8" }).trim()
const results: Record<string, unknown>[] = []
const guidance = process.argv.includes("--guidance")
for (const primaryContext of guidance ? ["baseline"] : ["baseline", "neutral"]) {
    const directory = await mkdtemp(resolve(temp, "guardian-diagnosis-"))
    // Local discovery loads exactly one experimental host with location-scoped options.
    await mkdir(resolve(directory, ".opencode/plugins"), { recursive: true })
    await writeFile(resolve(directory, ".opencode/plugins/diagnostic.ts"), `import host from ${JSON.stringify(resolve(root, "benchmarks/diagnostic-host.ts"))}; export default { ...host, setup: ctx => host.setup(Object.create(ctx, { options: { value: { primaryContext: ${JSON.stringify(primaryContext)}, authorizationGuidance: ${guidance} } } })) };\n`)
    await writeFile(resolve(directory, "opencode.json"), JSON.stringify({ permissions: [{ action: "*", resource: "*", effect: "deny" }], lsp: false, warming: false, providers: { openai: { settings: { transport: "http" } } } }))
    const api = (method: string, path: string, body?: unknown): any => {
        const args = ["api", method, path]
        if (body !== undefined) args.push("--data", JSON.stringify(body))
        const output = execFileSync("opencode", args, { cwd: directory, encoding: "utf8", timeout: 120_000, maxBuffer: 2_000_000 })
        return output.trim() ? JSON.parse(output) : undefined
    }
    const rpc = (method: string, input: unknown = {}) => { const result = api("post", `/api/rpc/guardian-diagnostics/${method}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`, { input }); return result.output ?? result.data?.output }
    api("get", `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(directory)}`)
    const model = rpc("info").model
    if (!model) throw new Error("Native model route unavailable")
    for (const id of selected) {
        const scenario = cases.find((entry) => entry.id === id)!
        let sessionID: string | undefined
        const result: Record<string, unknown> = { id, primaryContext, authorizationGuidance: guidance, expected: scenario.expected }
        try {
            const session = api("post", "/api/session", { location: { directory }, title: "Guardian diagnostic experiment", model: { providerID: "openai", id: model }, permissions: [{ action: "*", resource: "*", effect: "deny" }] })
            sessionID = session.data?.id ?? session.id
            for (const text of [...(scenario.priorInstructions ?? []), scenario.userIntent]) {
                api("post", `/api/session/${sessionID}/prompt`, { text })
                api("post", `/api/experimental/session/${sessionID}/wait`, {})
            }
            Object.assign(result, rpc("review", { sessionID, action: scenario.action, intentHash: hash(scenario.userIntent), ...(scenario.untrustedText ? { untrustedText: scenario.untrustedText } : {}) }))
        } catch { result.error = "diagnostic_request_failed"; process.exitCode = 1 } finally {
            if (sessionID) try { api("delete", `/api/session/${sessionID}`) } catch { result.error = "diagnostic_cleanup_failed"; process.exitCode = 1 }
        }
        results.push(result)
        console.log(JSON.stringify(result))
    }
}
if (initialHash !== await implementationHash()) throw new Error("Implementation changed during diagnostic experiment")
await writeFile(resolve(root, guidance ? "benchmarks/results.guidance.local.json" : "benchmarks/results.diagnosis.local.json"), JSON.stringify({ generatedAt: new Date().toISOString(), implementationHash: initialHash, corpusHash, accounting: "unverified", results }, null, 2) + "\n")
