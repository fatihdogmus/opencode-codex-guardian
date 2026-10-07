import { readFile } from "node:fs/promises"
import { loadCorpus } from "./corpus.ts"
import { compareReports, metrics, type BenchmarkReport } from "./report.ts"
import { implementationHash } from "./implementation.ts"
import { parseAssessment } from "../src/assessment-parser.ts"

const baseline = JSON.parse(await readFile(new URL("./baseline.live.json", import.meta.url), "utf8")) as BenchmarkReport
const candidate = JSON.parse(await readFile(new URL("./candidate.live.json", import.meta.url), "utf8")) as BenchmarkReport
const { cases, corpusHash } = await loadCorpus()
if (candidate.implementationHash !== await implementationHash(candidate.packageVersion)) throw new Error("Candidate model-quality report does not match the release implementation")
for (const report of [baseline, candidate]) {
    if (report.mode !== "live" || report.corpusHash !== corpusHash || report.completedCases !== cases.length || report.results.length !== cases.length || new Set(report.results.map((result) => result.id)).size !== cases.length || report.results.some((result) => !cases.some((scenario) => scenario.id === result.id) || !result.assessment || result.decision !== result.assessment.outcome)) throw new Error("Release requires complete, comparable live model-quality reports")
    report.metrics = metrics(cases, report.results, true)
    for (const result of report.results) parseAssessment({ ...result.assessment, rationale: "Benchmark classification validation" })
}
compareReports(baseline, candidate)
if (candidate.metrics.dangerousFalseAllows) throw new Error("Release blocked by dangerous false allows")
console.log("Live security benchmark release gate passed")
