import type { ReviewInput } from "./types.ts"

export function isCodexURL(url: string): boolean {
    const parsed = new URL(url)
    return ["https:", "wss:"].includes(parsed.protocol) && parsed.hostname === "chatgpt.com" && parsed.pathname === "/backend-api/codex/responses"
}

export function guardianBody(body: Record<string, unknown>, parentID: string, threadID: string): Record<string, unknown> {
    const metadata = { ...(body.client_metadata as Record<string, unknown> ?? {}) }
    delete metadata.guardian_credits_requested
    delete metadata.ws_request_header_x_codex_routing_hint
    return {
        ...body,
        model: "codex-auto-review",
        store: false,
        tools: [],
        tool_choice: "none",
        service_tier: undefined,
        max_output_tokens: undefined,
        client_metadata: {
            ...metadata,
            "x-openai-subagent": "guardian",
            parent_response_id: parentID,
            thread_id: threadID,
            "x-codex-turn-metadata": JSON.stringify({ thread_source: "guardian_review" }),
        },
    }
}

export function primaryBody(body: Record<string, unknown>): Record<string, unknown> {
    return { ...body, client_metadata: { ...(body.client_metadata as object ?? {}), guardian_credits_requested: "true" } }
}

interface ParentResponse {
    responseID: string
    createdAt: number
    calls: Set<string>
}

export class ParentResponses {
    private sessions = new Map<string, ParentResponse[]>()
    constructor(private now = Date.now, private ttlMs = 300_000) {}
    reset(sessionID: string): void { this.sessions.delete(sessionID) }
    observe(sessionID: string, event: unknown, currentID?: string): string | undefined {
        if (!event || typeof event !== "object") return currentID
        const frame = event as { type?: string; response?: { id?: string }; item?: { call_id?: string }; response_id?: string }
        const entries = (this.sessions.get(sessionID) ?? []).filter((entry) => this.now() - entry.createdAt < this.ttlMs)
        if (frame.type === "response.created" && typeof frame.response?.id === "string") {
            currentID = frame.response.id
            if (!entries.some((entry) => entry.responseID === currentID)) entries.push({ responseID: currentID, createdAt: this.now(), calls: new Set() })
        }
        const parent = entries.find((entry) => entry.responseID === (frame.response_id ?? currentID))
        if (parent && typeof frame.item?.call_id === "string") parent.calls.add(frame.item.call_id)
        this.sessions.set(sessionID, entries.slice(-20))
        if (this.sessions.size > 2_000) this.sessions.delete(this.sessions.keys().next().value!)
        return currentID
    }
    get(input: Pick<ReviewInput, "sessionID" | "source">): string | undefined {
        const entries = (this.sessions.get(input.sessionID) ?? []).filter((entry) => this.now() - entry.createdAt < this.ttlMs)
        if (input.source) return entries.find((entry) => entry.calls.has(input.source!.id))?.responseID
        return entries.at(-1)?.responseID
    }
    clear(): void { this.sessions.clear() }
}

export class SSEObserver {
    private buffer = ""
    private decoder = new TextDecoder()
    constructor(private receive: (event: unknown) => void) {}
    push(chunk: Uint8Array): void {
        this.buffer += this.decoder.decode(chunk, { stream: true })
        let boundary: RegExpExecArray | null
        while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
            const block = this.buffer.slice(0, boundary.index)
            this.buffer = this.buffer.slice(boundary.index + boundary[0].length)
            const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
            if (data && data !== "[DONE]") {
                try { this.receive(JSON.parse(data)) } catch {}
            }
        }
        if (this.buffer.length > 1_000_000) throw new Error("Oversized provider event")
    }
}
