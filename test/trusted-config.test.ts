import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseConfig } from "../src/config.ts"
import { loadSecurityConfig, mergeSecurityConfig } from "../src/trusted-config.ts"

test("unknown and project options cannot weaken trusted security", () => {
    const base = parseConfig({ enabled: true, failureMode: "deny", shadow: true })
    for (const trust of ["project-untrusted", "unknown"] as const) {
        const config = mergeSecurityConfig(base, { enabled: false, failureMode: "ask", shadow: false, nativeFreeOnly: false, transport: "model", fallbackModel: "evil/model", preflight: { enabled: false }, selfProtection: { enabled: false }, audit: { enabled: false }, circuitBreaker: { enabled: false, maxEquivalentDenials: 99 }, sessionApprovals: { enabled: true } }, trust)
        assert.equal(config.enabled, true)
        assert.equal(config.failureMode, "deny")
        assert.equal(config.shadow, true)
        assert.equal(config.nativeFreeOnly, true)
        assert.equal(config.fallbackModel, undefined)
        assert.equal(config.preflight.enabled, true)
        assert.equal(config.selfProtection.enabled, true)
        assert.equal(config.audit.enabled, true)
        assert.equal(config.circuitBreaker.enabled, true)
        assert.equal(config.circuitBreaker.maxEquivalentDenials, 3)
        assert.equal(config.sessionApprovals.enabled, false)
    }
})
test("untrusted options may tighten budgets, deny behavior and protected paths", () => {
    const config = mergeSecurityConfig(parseConfig({ enabled: true }), { failureMode: "deny", timeoutMs: 1_000, contextMaxChars: 2_000, selfProtection: { protectedPaths: ["/extra"] }, circuitBreaker: { maxEquivalentDenials: 1 } }, "project-untrusted")
    assert.equal(config.failureMode, "deny")
    assert.equal(config.timeoutMs, 1_000)
    assert.equal(config.contextMaxChars, 2_000)
    assert.deepEqual(config.selfProtection.protectedPaths, ["/extra"])
    assert.equal(config.circuitBreaker.maxEquivalentDenials, 1)
})
test("trusted user config can disable or select an ordinary reviewer", () => {
    const config = mergeSecurityConfig(parseConfig({ enabled: true }), { enabled: false, nativeFreeOnly: false, transport: "model", fallbackModel: "openai/model", shadow: true, audit: { enabled: false } }, "user-trusted")
    assert.equal(config.enabled, false)
    assert.equal(config.transport, "model")
    assert.equal(config.shadow, true)
    assert.equal(config.audit.enabled, false)
})
test("trusted files require ownership, safe permissions, no symlink and non-project provenance", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "guardian-config-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, "policy.json")
    await writeFile(path, JSON.stringify({ failureMode: "deny" }), { mode: 0o600 })
    const loaded = await loadSecurityConfig({ enabled: false, failureMode: "ask" }, "/workspace", path)
    assert.equal(loaded.provenance, "user-trusted")
    assert.equal(loaded.config.enabled, true)
    assert.equal(loaded.config.failureMode, "deny")
    assert.equal(loaded.ignoredWeakening, true)
    await assert.rejects(() => loadSecurityConfig({}, directory, path))
    await symlink(path, join(directory, "alias"))
    await assert.rejects(() => loadSecurityConfig({}, "/workspace", join(directory, "alias")))
    await chmod(path, 0o666)
    await assert.rejects(() => loadSecurityConfig({}, "/workspace", path))
})
test("unknown nested options and ephemeral-session weakening fail validation", () => {
    for (const options of [{ audit: { mystery: true } }, { reviewer: { ephemeralSession: false } }, { selfProtection: { protectedPaths: ["relative"] } }, { audit: { redactSecrets: false } }]) assert.throws(() => parseConfig(options))
})
test("trusted mode alias works and malformed nested overrides are not silently ignored", () => {
    assert.equal(mergeSecurityConfig(parseConfig({ enabled: true }), { mode: "shadow" }, "user-trusted").shadow, true)
    for (const value of [null, false, [], "disabled"]) assert.throws(() => mergeSecurityConfig(parseConfig({ enabled: true }), { audit: value }, "unknown"))
})
