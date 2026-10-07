import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFile, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { validateRelease } from "./validate-release.mjs"

export async function bumpRelease(bump, directory = fileURLToPath(new URL("../", import.meta.url))) {
    assert.ok(["patch", "minor", "major"].includes(bump), "Choose patch, minor, or major")
    const readJSON = async (file) => JSON.parse(await readFile(join(directory, file), "utf8"))
    const before = await readJSON("package.json")
    const lockBefore = await readJSON("package-lock.json")
    validateRelease(before, `v${before.version}`)
    assert.equal(lockBefore.name, before.name, "Lockfile package name must match")
    assert.equal(lockBefore.version, before.version, "Lockfile version must match")
    assert.equal(lockBefore.packages?.[""]?.name, before.name, "Lockfile root name must match")
    assert.equal(lockBefore.packages[""].version, before.version, "Lockfile root version must match")

    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"))
    execFileSync("npm", ["version", bump, "--no-git-tag-version", "--ignore-scripts"], { cwd: directory, env, stdio: "pipe" })
    const after = await readJSON("package.json")
    const lockAfter = await readJSON("package-lock.json")
    const tag = `v${after.version}`
    validateRelease(after, tag)
    assert.notEqual(after.version, before.version, "Version must increase")
    assert.deepEqual(after, { ...before, version: after.version }, "Bump may only change the manifest version")
    assert.deepEqual(lockAfter, { ...lockBefore, version: after.version, packages: { ...lockBefore.packages, "": { ...lockBefore.packages[""], version: after.version } } }, "Bump may only change lockfile root versions")
    return { version: after.version, tag }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = await bumpRelease(process.argv[2])
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\ntag=${result.tag}\n`)
    console.log(`Prepared ${result.tag}; commit only after release checks pass`)
}
