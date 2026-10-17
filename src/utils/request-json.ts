import { brotliDecompress, gunzip, inflate, zstdDecompress } from "node:zlib"
import { promisify } from "node:util"
import { ReviewError } from "../review-error.ts"

const decoders = { br: promisify(brotliDecompress), gzip: promisify(gunzip), deflate: promisify(inflate), zstd: promisify(zstdDecompress) }
const maxBodyBytes = 64 * 1024 * 1024

// Request.json() does not decode Content-Encoding. OpenCode's native HTTP hooks
// can receive already-compressed bodies, including zstd on newer hosts.
export async function readRequestJSON(request: Request, maxBytes = maxBodyBytes): Promise<Record<string, unknown>> {
    const encodings = (request.headers.get("content-encoding") ?? "identity").split(",").map((encoding) => encoding.trim().toLowerCase())
    if (encodings.length > 4 || encodings.some((encoding) => encoding !== "identity" && !Object.hasOwn(decoders, encoding))) throw new ReviewError("native_request_encoding_unsupported")
    try {
        let bytes = Buffer.from(await request.clone().arrayBuffer())
        if (bytes.length > maxBytes) throw new Error("Body limit")
        for (const encoding of encodings.reverse()) {
            if (encoding !== "identity") bytes = await decoders[encoding as keyof typeof decoders](bytes, { maxOutputLength: maxBytes })
            if (bytes.length > maxBytes) throw new Error("Body limit")
        }
        const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected JSON object")
        return body as Record<string, unknown>
    } catch {
        // Never expose compressed bytes or request contents in diagnostics.
        throw new ReviewError("native_request_body_invalid")
    }
}

export function withRequestJSON(request: Request, body: Record<string, unknown>, headers = new Headers(request.headers)): Request {
    // The replacement is plain JSON, not the original compressed representation.
    headers.delete("content-encoding")
    headers.delete("content-length")
    headers.set("content-type", "application/json")
    return new Request(request, { headers, body: JSON.stringify(body) })
}
