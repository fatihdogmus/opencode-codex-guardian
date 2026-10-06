import { test } from "node:test"
import assert from "node:assert/strict"
import { safeRenderRationale } from "../src/utils/safe-render.ts"

test("rationale strips ANSI, terminal and bidi controls", () => {
    const text = safeRenderRationale("\u001b[31mdeny\u001b[0m\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007\u202e\u2066\u0000\r\n")
    assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(text))
    assert.ok(text.includes("deny"))
})
test("rendering is Unicode-safe, byte-bounded and redacts secrets", () => {
    assert.ok(Buffer.byteLength(safeRenderRationale("😀".repeat(500), 31)) <= 31)
    assert.equal(safeRenderRationale("\ud800").isWellFormed(), true)
    assert.ok(!safeRenderRationale("API_KEY=secret-value Authorization: Bearer another-secret").includes("secret-value"))
    assert.ok(!safeRenderRationale("API_KEY=secret-value Authorization: Bearer another-secret").includes("another-secret"))
})
