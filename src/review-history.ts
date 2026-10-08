import { ReviewError } from "./review-error.ts"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

interface Message { id?: string; type: string; text?: string }
interface HistoryReader {
    context(input: { sessionID: string }, options: { signal: AbortSignal }): Promise<readonly Message[]>
}
type ArchiveReader = (sessionID: string, signal: AbortSignal) => Promise<{ info: { id: string }; messages: readonly Message[] }>

async function localArchive(sessionID: string, signal: AbortSignal) {
    // V2's plugin facade omits export. Discover (never start) the authenticated
    // local service; the checks below must bind its archive to this host context.
    // Private/remote hosts without a matching archive keep manual approval.
    const endpoint = await Service.discover()
    signal.throwIfAborted()
    if (!endpoint) throw new ReviewError("context_history_unavailable")
    return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }).session.export({ sessionID }, { signal })
}

// Compaction summaries cannot replace original user instructions. The export API
// returns the persisted history, including messages omitted from active context.
export async function loadReviewHistory(reader: HistoryReader, sessionID: string, signal: AbortSignal, exportHistory: ArchiveReader = localArchive): Promise<{ messages: readonly Message[]; complete: boolean }> {
    const context = await reader.context({ sessionID }, { signal })
    signal.throwIfAborted()
    if (!context.some((message) => message.type === "compaction")) return { messages: context, complete: false }
    const archived = await exportHistory(sessionID, signal)
    signal.throwIfAborted()
    if (archived.info.id !== sessionID) throw new ReviewError("context_history_mismatch")
    const byID = new Map(archived.messages.map((message) => [message.id, message]))
    for (const message of context.filter((message) => ["user", "compaction"].includes(message.type))) {
        const original = message.id ? byID.get(message.id) : undefined
        if (!original || original.type !== message.type || (message.type === "user" && original.text !== message.text)) throw new ReviewError("context_history_mismatch")
    }
    const firstCompaction = archived.messages.findIndex((message) => message.type === "compaction")
    if (!archived.messages.slice(0, firstCompaction).some((message) => message.type === "user")) throw new ReviewError("context_compacted")
    const latest = context.filter((message) => message.type === "user").at(-1)
    if (latest && archived.messages.filter((message) => message.type === "user").at(-1)?.id !== latest.id) throw new ReviewError("context_history_mismatch")
    return { messages: archived.messages, complete: true }
}
