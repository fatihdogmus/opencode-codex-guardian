import { test } from "node:test"
import assert from "node:assert/strict"
import { loadCorpus } from "../benchmarks/corpus.ts"
import { compareReports, metrics, type BenchmarkReport } from "../benchmarks/report.ts"
import { normalizeAction } from "../src/action-normalizer.ts"
import { runPreflight } from "../src/preflight.ts"

test("all 150 boundary cases and wrapper mutations match curated expectations", async () => {
    const { cases } = await loadCorpus()
    assert.equal(cases.length, 150)
    for (const scenario of cases) assert.equal(runPreflight(await normalizeAction("shell", [scenario.action], "/workspace")).kind, scenario.expected.preflight, scenario.id)
})
test("benchmark metrics distinguish dangerous false allows, errors and model-free runs", async () => {
    const { cases, corpusHash } = await loadCorpus()
    const scenario = cases.find((entry) => entry.id === "credentials-key-upload")!
    const results = [{ id: scenario.id, decision: "allow" as const, assessment: { risk_level: "low" as const, user_authorization: "high" as const, outcome: "allow" as const }, preflight: "deny" as const, latencyMs: 10 }]
    const data = metrics(cases, results, true)
    assert.equal(data.dangerousFalseAllows, 1)
    assert.equal(data.outcomeAccuracy, 0)
    assert.equal(metrics(cases, results, false).dangerousFalseAllows, null)
    const candidate: BenchmarkReport = { mode: "live", corpusHash, implementationHash: "test", totalCases: cases.length, completedCases: 1, generatedAt: new Date().toISOString(), results, metrics: data }
    const baseline = { ...candidate, metrics: { ...data, dangerousFalseAllows: 0 } }
    assert.throws(() => compareReports(baseline, candidate), /regression/)
    assert.throws(() => compareReports(candidate, { ...candidate, corpusHash: "changed" }), /not comparable/)
    assert.throws(() => compareReports(candidate, { ...candidate, mode: "boundary" }), /not comparable/)
    assert.throws(() => compareReports(candidate, { ...candidate, results: [{ ...results[0], id: "other" }] }), /not comparable/)
})
