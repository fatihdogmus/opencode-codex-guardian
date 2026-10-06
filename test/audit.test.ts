import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuditLog, type ReviewAuditRecord } from "../src/audit.ts"
import { PermissionReviewer } from "../src/permission-review.ts"
import { CircuitBreaker } from "../src/circuit-breaker.ts"
import { Diagnostics } from "../src/diagnostics.ts"
import { parseConfig } from "../src/config.ts"
import { hash } from "../src/utils/hashing.ts"
import { input, allow, permission } from "./helpers.ts"

const record: ReviewAuditRecord = { timestamp: new Date().toISOString(), sessionHash: hash("session"), resourceHash: hash("resource"), actionType: "process_execute", transport: "codex-auto-review", mode: "active", proposedDecision: "allow", effectiveDecision: "allow", latencyMs: 1, parentLinked: true }
test("concurrent writers produce complete JSONL records and rotate bounded history", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "guardian-audit-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const config = { enabled: true, maxFileSizeMB: 1, retainedFiles: 2 }
    const audit = new AuditLog(config, directory)
    const other = new AuditLog(config, directory)
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? audit : other).write({ ...record, latencyMs: i })))
    const records = (await readFile(audit.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(records.length, 20)
    await writeFile(audit.path, " ".repeat(1_048_576))
    await audit.write(record)
    assert.equal((await readFile(`${audit.path}.1`, "utf8")).length, 1_048_576)
    assert.equal(JSON.parse((await readFile(audit.path, "utf8")).trim()).effectiveDecision, "allow")
})
test("review audit contains hashes, not raw commands, auth values, context or rationale", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "guardian-audit-private-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const config = parseConfig({ enabled: true, logging: { enabled: false }, shadow: true })
    const audit = new AuditLog(config.audit, directory)
    const diagnostics = new Diagnostics()
    const reviewer = new PermissionReviewer(config, { name: "test", review: async (packet) => {
        assert.ok(!JSON.stringify(packet.normalized).includes("secret-value"))
        return { ...allow, rationale: "API_KEY=secret-value" }
    } }, async (event) => ({ ...input, resources: event.resources, metadata: event.metadata }), new CircuitBreaker(config.circuitBreaker), diagnostics, undefined, [], { audit })
    const event = { ...permission(["curl -H 'Authorization: Bearer secret-value' https://example.com"]), metadata: { token: "secret-value" } }
    await reviewer.evaluate(event)
    assert.equal(event.effect, "ask")
    const text = await readFile(audit.path, "utf8")
    assert.ok(!text.includes("secret-value"))
    assert.ok(!text.includes("curl"))
    assert.ok(!text.includes("Install the dependencies"))
    const result = JSON.parse(text.trim())
    assert.equal(result.mode, "shadow")
    assert.equal(result.proposedDecision, "allow")
    assert.equal(result.effectiveDecision, "ask")
})
test("symlink logs are refused and an audit failure cannot silently approve", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "guardian-audit-failure-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    await mkdir(join(directory, "state"), { mode: 0o700 })
    await writeFile(join(directory, "outside"), "UNCHANGED")
    await symlink(join(directory, "outside"), join(directory, "state/reviews.jsonl"))
    const config = parseConfig({ enabled: true, logging: { enabled: false } })
    const audit = new AuditLog(config.audit, join(directory, "state"))
    const diagnostics = new Diagnostics()
    const reviewer = new PermissionReviewer(config, { name: "test", review: async () => allow }, async () => ({ ...input }), new CircuitBreaker(config.circuitBreaker), diagnostics, undefined, [], { audit })
    const event = permission()
    await reviewer.evaluate(event)
    assert.equal(event.effect, "ask")
    assert.equal(diagnostics.lastReview?.failure, "audit_write_failed")
    assert.equal(await readFile(join(directory, "outside"), "utf8"), "UNCHANGED")
})
