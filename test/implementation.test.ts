import { test } from "node:test"
import assert from "node:assert/strict"
import { lockfileAtVersion } from "../benchmarks/implementation.ts"
import { hash } from "../src/utils/hashing.ts"

const lock = { name: "@fatihdogmus/opencode-codex-guardian", version: "0.1.0", lockfileVersion: 3, packages: { "": { name: "@fatihdogmus/opencode-codex-guardian", version: "0.1.0" }, "node_modules/example": { version: "1.0.0", integrity: "sha512-original" } } }
const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n"

test("release fingerprints accept only root version metadata differences", () => {
    const original = encode(lock)
    assert.equal(lockfileAtVersion(original, "0.1.0"), original)
    const bumped = { ...lock, version: "1.0.0", packages: { ...lock.packages, "": { ...lock.packages[""], version: "1.0.0" } } }
    assert.equal(hash(lockfileAtVersion(encode(bumped), "0.1.0")), hash(original))
    for (const changed of [
        { ...bumped, name: "other-package" },
        { ...bumped, packages: { ...bumped.packages, "": { ...bumped.packages[""], name: "other-package" } } },
        { ...bumped, packages: { ...bumped.packages, "node_modules/example": { version: "2.0.0", integrity: "sha512-original" } } },
        { ...bumped, packages: { ...bumped.packages, "node_modules/example": { version: "1.0.0", integrity: "sha512-changed" } } },
    ]) assert.notEqual(hash(lockfileAtVersion(encode(changed), "0.1.0")), hash(original))
})

test("release fingerprints reject malformed benchmark versions and inconsistent locks", () => {
    for (const version of ["", "00.1.0", "0.1.0-beta.1", "v0.1.0", "0.1.0\n"]) assert.throws(() => lockfileAtVersion(encode(lock), version))
    assert.throws(() => lockfileAtVersion(encode({ ...lock, version: "0.2.0" }), "0.1.0"))
})
