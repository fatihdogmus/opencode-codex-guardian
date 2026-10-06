import { stripVTControlCharacters } from "node:util"
import { redact } from "./redaction.ts"

export function safeRenderRationale(input: string, maxBytes = 512): string {
    const text = redact(stripVTControlCharacters(input.toWellFormed()).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")).replace(/\s+/g, " ").trim()
    let output = ""
    for (const char of text) { if (Buffer.byteLength(output + char) > maxBytes) break; output += char }
    return output
}
