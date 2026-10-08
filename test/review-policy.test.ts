import { test } from "node:test"
import assert from "node:assert/strict"
import { AUTHORIZATION_GUIDANCE, REVIEW_POLICY, effectiveDecision } from "../src/review-policy.ts"
import { allow } from "./helpers.ts"

test("troubleshooting guidance separates bounded name listing from sensitive contents and host approval", () => {
    assert.match(AUTHORIZATION_GUIDANCE, /Do not demand a separate permission-button click/)
    assert.match(AUTHORIZATION_GUIDANCE, /listing \(glob\) exposes names, not file contents/)
    assert.match(REVIEW_POLICY, /does not bypass subsequent read\/edit\/shell permissions/)
    assert.equal(effectiveDecision({ ...allow, risk_level: "medium", user_authorization: "medium" }), "allow")
    assert.equal(effectiveDecision({ ...allow, risk_level: "high", user_authorization: "medium" }), "deny")
    assert.equal(effectiveDecision({ ...allow, risk_level: "critical", user_authorization: "high" }), "deny")
})
