import { test } from "node:test"
import assert from "node:assert/strict"
import { gzipSync, zstdCompressSync } from "node:zlib"
import { readRequestJSON, withRequestJSON } from "../src/utils/request-json.ts"

const url = "https://chatgpt.com/backend-api/codex/responses"

test("request JSON decoding supports plain, identity, and stacked case-insensitive encodings without consuming the original", async () => {
    for (const encoding of [undefined, "identity", "Zstd, GZip"]) {
        const json = JSON.stringify({ model: "test", input: "Türkçe" })
        const body = encoding === "Zstd, GZip" ? gzipSync(zstdCompressSync(Buffer.from(json))) : json
        const request = new Request(url, { method: "POST", body, headers: encoding ? { "content-encoding": encoding } : undefined })
        assert.deepEqual(await readRequestJSON(request), JSON.parse(json))
        assert.equal(request.bodyUsed, false)
        assert.equal((await request.arrayBuffer()).byteLength, Buffer.byteLength(body))
    }
})

test("unsupported, corrupt, non-object, and oversized request bodies fail closed with content-free errors", async () => {
    for (const [encoding, body, maxBytes, code] of [
        ["unknown", "SECRET", 1024, "native_request_encoding_unsupported"],
        ["zstd", "SECRET", 1024, "native_request_body_invalid"],
        ["identity", "SECRET", 1024, "native_request_body_invalid"],
        ["identity", "null", 1024, "native_request_body_invalid"],
        ["identity", "[]", 1024, "native_request_body_invalid"],
        ["identity", "{}", 1, "native_request_body_invalid"],
        ["zstd", zstdCompressSync(Buffer.from(JSON.stringify({ text: "SECRET".repeat(1000) }))), 128, "native_request_body_invalid"],
    ] as const) {
        const request = new Request(url, { method: "POST", body, headers: { "content-encoding": encoding } })
        await assert.rejects(() => readRequestJSON(request, maxBytes), (error: Error) => error.message === code && !error.message.includes("SECRET"))
    }
})

test("rewritten JSON preserves routing and auth but removes stale representation headers", async () => {
    const request = new Request(url, { method: "POST", body: "old", headers: { "content-encoding": "zstd", "content-length": "3", authorization: "Bearer test", "x-codex-guardian": "reviewer" } })
    const rewritten = withRequestJSON(request, { model: "codex-auto-review" })
    assert.equal(rewritten.url, url)
    assert.equal(rewritten.method, "POST")
    assert.equal(rewritten.headers.get("content-encoding"), null)
    assert.equal(rewritten.headers.get("content-length"), null)
    assert.equal(rewritten.headers.get("content-type"), "application/json")
    assert.equal(rewritten.headers.get("authorization"), "Bearer test")
    assert.equal(rewritten.headers.get("x-codex-guardian"), "reviewer")
    assert.deepEqual(await rewritten.json(), { model: "codex-auto-review" })
})
