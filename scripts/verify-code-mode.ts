import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const temp = execFileSync("opencode", ["debug", "paths", "tmp"], { encoding: "utf8" }).trim()
const directory = await mkdtemp(resolve(temp, "auto-review-code-mode-"))
await mkdir(resolve(directory, ".opencode/plugins"), { recursive: true })
await writeFile(resolve(directory, ".opencode/plugins/verify.ts"), `import plugin from ${JSON.stringify(resolve(root, "scripts/verification-plugin.ts"))}\nexport default { ...plugin, setup(ctx) { return plugin.setup({ ...ctx, options: { codeMode: true } }) } }\n`)
await writeFile(resolve(directory, "opencode.json"), JSON.stringify({
    model: "openai/gpt-6-luna", permissions: [{ action: "*", resource: "*", effect: "ask" }],
    providers: { openai: { settings: { transport: "http" } } }, lsp: false, warming: false,
}))
function api(method: string, path: string, data?: unknown): any {
    const args = ["api", method, path]
    if (data !== undefined) args.push("--data", JSON.stringify(data))
    const result = execFileSync("opencode", args, { cwd: directory, encoding: "utf8", timeout: 90_000 })
    return result.trim() ? JSON.parse(result) : undefined
}
const session = api("post", "/api/session", { location: { directory }, title: "Code Mode review verification", model: { providerID: "openai", id: "gpt-6-luna" } }).data.id
try {
    api("post", `/api/session/${session}/prompt`, { text: "Run exactly printf AUTO_REVIEW_VERIFIED using the shell tool once to verify the permission-review integration, then report its result. It has no filesystem or network side effects." })
    api("post", `/api/experimental/session/${session}/wait`, {})
    const query = `?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
    const result = api("post", `/api/rpc/auto-review-verification/traffic${query}`, { input: {} }).output
    const status = api("post", `/api/rpc/auto-review/status${query}`, { input: {} }).output
    const passed = result.probeExecuted === 1 && result.evaluations.some((event: any) => event.source && event.effect === "allow") && JSON.parse(status.text).nativeState === "NATIVE_WORKS_ACCOUNTING_UNKNOWN"
    const report = { passed, directory, ...result, status: JSON.parse(status.text) }
    await writeFile(resolve(root, "verification.code-mode.local.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    if (!passed) process.exitCode = 1
} finally { api("delete", `/api/session/${session}`) }
