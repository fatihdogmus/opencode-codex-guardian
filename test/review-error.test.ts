import { test } from "node:test"
import assert from "node:assert/strict"
import { failureDetails } from "../src/review-error.ts"

test("failure details preserve safe stage/type/OS status while excluding secrets and arbitrary labels", () => {
    const error = Object.assign(new TypeError("Bearer secret-value at /private/file"), { code: "EPERM", status: 403, path: "/private/file", response: { body: "SECRET" } })
    assert.deepEqual(failureDetails(error, "self_protection"), { stage: "self_protection", name: "TypeError", code: "EPERM", status: 403 })
    assert.deepEqual(failureDetails({ name: "secret-value", code: "API_KEY=secret-value", status: 999, stack: "secret" }, "reviewer"), { stage: "reviewer", name: "Error" })
})
