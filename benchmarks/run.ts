import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadCorpus } from "./corpus.ts"
import { compareReports, metrics, summarize, type BenchmarkReport, type BenchmarkResult } from "./report.ts"
import { normalizeAction } from "../src/action-normalizer.ts"
import { runPreflight } from "../src/preflight.ts"
import { implementationHash } from "./implementation.ts"

const args = process.argv.slice(2)
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const live = args.includes("--live")
const implementation = await implementationHash()
const { cases, corpusHash } = await loadCorpus()
const limit = Number(option("--limit") ?? cases.length)
if (!Number.isInteger(limit) || limit < 1 || limit > cases.length) throw new Error("Invalid benchmark limit")
let directory = "/workspace"
function api(method: string, path: string, body?: unknown): any {
    const parameters = ["api", method, path]
    if (body !== undefined) parameters.push("--data", JSON.stringify(body))
    const output = execFileSync("opencode", parameters, { cwd: directory, encoding: "utf8", timeout: 120_000, maxBuffer: 2_000_000 })
    return output.trim() ? JSON.parse(output) : undefined
}
function rpc(method: string, input: unknown = {}): any {
    const result = api("post", `/api/rpc/guardian-benchmark/${method}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`, { input })
    return result.output ?? result.data?.output
}
let model: string | undefined
if (live) {
    const root = fileURLToPath(new URL("../", import.meta.url))
    const temp = execFileSync("opencode", ["debug", "paths", "tmp"], { encoding: "utf8" }).trim()
    directory = await mkdtemp(resolve(temp, "guardian-benchmark-"))
    await mkdir(resolve(directory, ".opencode/plugins"), { recursive: true })
    await writeFile(resolve(directory, ".opencode/plugins/benchmark.ts"), `export { default } from ${JSON.stringify(resolve(root, "benchmarks/host.ts"))}\n`)
    await writeFile(resolve(directory, "opencode.json"), JSON.stringify({ permissions: [{ action: "*", resource: "*", effect: "deny" }], lsp: false, warming: false, providers: { openai: { settings: { transport: "http" } } } }))
    api("get", `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(directory)}`)
    model = rpc("info").model
    if (!model) throw new Error("No native OpenAI model route")
    const primaryRequests = cases.slice(0, limit).reduce((count, scenario) => count + 1 + (scenario.priorInstructions?.length ?? 0), 0)
    console.log(`Live benchmark: ${primaryRequests} primary requests and ${limit} Guardian requests; no proposed actions will execute. Accounting is unverified.`)
}
const results: BenchmarkResult[] = []
for (const scenario of cases.slice(0, limit)) {
    const started = performance.now()
    let sessionID: string | undefined
    const preflight = runPreflight(await normalizeAction("shell", [scenario.action], "/workspace")).kind
    const result: BenchmarkResult = { id: scenario.id, preflight, latencyMs: 0 }
    try {
        if (live) {
            const created = api("post", "/api/session", { location: { directory }, title: "Guardian model benchmark", model: { providerID: "openai", id: model }, permissions: [{ action: "*", resource: "*", effect: "deny" }] })
            sessionID = created.data?.id ?? created.id
            for (const text of [...(scenario.priorInstructions ?? []), scenario.userIntent]) {
                api("post", `/api/session/${sessionID}/prompt`, { text })
                api("post", `/api/experimental/session/${sessionID}/wait`, {})
            }
            result.assessment = rpc("review", { sessionID, action: scenario.action, ...(scenario.untrustedText ? { untrustedText: scenario.untrustedText } : {}) }).assessment
            result.decision = result.assessment!.outcome
        }
    } catch { result.error = "benchmark_request_failed" } finally {
        if (sessionID) try { api("delete", `/api/session/${sessionID}`) } catch { result.error = "benchmark_cleanup_failed" }
    }
    result.latencyMs = performance.now() - started
    results.push(result)
}
if (implementation !== await implementationHash()) throw new Error("Implementation changed during benchmark; results are invalid")
const report: BenchmarkReport = { mode: live ? "live" : "boundary", corpusHash, implementationHash: implementation, totalCases: cases.length, completedCases: results.length, generatedAt: new Date().toISOString(), results, metrics: metrics(cases, results, live) }
await writeFile(resolve(option("--output") ?? "benchmarks/results.local.json"), JSON.stringify(report, null, 2) + "\n")
console.log(summarize(report))
if (option("--compare")) compareReports(JSON.parse(await readFile(resolve(option("--compare")!), "utf8")), report)
if (report.metrics.failures || report.metrics.boundaryAccuracy < 1) process.exitCode = 1
