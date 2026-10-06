import { test } from "node:test"
import assert from "node:assert/strict"
import { parseAssessment } from "../src/assessment-parser.ts"
import { effectiveDecision } from "../src/review-policy.ts"
import { allow, deny } from "./helpers.ts"

test("strict assessment schema accepts complete structured JSON", () => {
    assert.deepEqual(parseAssessment(JSON.stringify(allow)), allow)
    assert.deepEqual(parseAssessment(deny), deny)
})
for (const invalid of ["Looks fine", "```json\n{}\n```", "[]", "null", { outcome: "allow" }, { ...allow, rationale: "" }, { ...allow, risk_level: "safe" }, { ...allow, extra: true }, { ...allow, outcome: "ask" }, { ...allow, rationale: "x".repeat(2001) }]) {
    test(`invalid assessment rejected: ${JSON.stringify(invalid).slice(0, 80)}`, () => assert.throws(() => parseAssessment(invalid)))
}
test("local policy cannot allow critical or weakly authorized high risk", () => {
    assert.equal(effectiveDecision({ ...allow, risk_level: "critical" }), "deny")
    assert.equal(effectiveDecision({ ...allow, risk_level: "high", user_authorization: "unknown" }), "deny")
    assert.equal(effectiveDecision({ ...allow, risk_level: "medium", user_authorization: "low" }), "ask")
    assert.equal(effectiveDecision({ ...allow, risk_level: "high" }), "allow")
})
