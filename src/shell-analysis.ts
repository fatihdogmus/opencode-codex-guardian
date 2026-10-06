import { Parser, Language, type Node } from "web-tree-sitter"
import { createRequire } from "node:module"
import { basename } from "node:path"
import type { ShellCommand } from "./types.ts"

const require = createRequire(import.meta.url)
const language = Parser.init().then(() => Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")))

export interface ShellAnalysis {
    commands: ShellCommand[]
    redirections: { operator: string; target: string }[]
    pipelines: number
    secretReferences?: boolean
    environmentAssignments?: string[]
    ambiguous?: string
}

function word(node: Node): string | undefined {
    if (node.type === "raw_string") return node.text.slice(1, -1)
    if (node.type === "simple_expansion" || node.type === "expansion") return /^\$\{?HOME\}?$/.test(node.text) ? "$HOME" : undefined
    if (["word", "string_content", "number"].includes(node.type)) return node.text.replace(/\\([^\n])/g, "$1").replace(/\\\n/g, "")
    if (["string", "concatenation", "command_name"].includes(node.type)) {
        const values = node.namedChildren.map(word)
        return values.some((part) => part === undefined) ? undefined : values.join("")
    }
    return undefined
}

export async function analyzeShell(text: string, depth = 0): Promise<ShellAnalysis> {
    const result: ShellAnalysis = { commands: [], redirections: [], pipelines: 0 }
    if (Buffer.byteLength(text) > 16_384 || depth > 4) return { ...result, ambiguous: "shell_limit" }
    const grammar = await language
    const parser = new Parser()
    parser.setLanguage(grammar)
    const tree = parser.parse(text)
    try {
        if (!tree || tree.rootNode.hasError) return { ...result, ambiguous: "shell_parse_error" }
        let nodes = 0
        const walk = async (node: Node): Promise<void> => {
            if (++nodes > 2_000) { result.ambiguous = "shell_limit"; return }
            if (["command_substitution", "process_substitution", "heredoc_redirect", "function_definition", "for_statement", "while_statement", "if_statement", "case_statement"].includes(node.type)) result.ambiguous = "shell_dynamic_structure"
            if (node.type === "pipeline") result.pipelines++
            if (node.type === "file_redirect") {
                const targetNode = node.childForFieldName("destination")
                const target = targetNode ? word(targetNode) : undefined
                if (target === undefined) result.ambiguous = "shell_dynamic_redirect"
                else result.redirections.push({ operator: node.children.find((child) => !child.isNamed && /[<>]/.test(child.text))?.text ?? ">", target })
            }
            if (node.type === "variable_assignment") {
                const assignments = result.environmentAssignments ??= []
                assignments.push(node.text)
                if (/^(?:HOME|PATH|IFS|BASH_ENV|ENV|OPENCODE_\w+)\s*=/.test(node.text)) result.ambiguous = "shell_environment_override"
                for (const substitution of node.descendantsOfType(["command_substitution", "process_substitution"])) {
                    result.ambiguous ??= "shell_dynamic_structure"
                    for (const child of substitution.namedChildren) await walk(child)
                }
                return
            }
            if (node.type === "command") {
                for (const assignment of node.namedChildren.filter((child) => child.type === "variable_assignment")) await walk(assignment)
                const parts = node.namedChildren.filter((child) => child.type !== "variable_assignment")
                const values = parts.map(word)
                // Quoted home-like text is literal, not a shell expansion. Do not merge it with expanded paths.
                if (parts.some((part, index) => (part.type === "raw_string" && /^(?:~(?:\/|$)|\$HOME(?:\/|$))/.test(values[index] ?? "")) || (part.type === "string" && /^~(?:\/|$)/.test(values[index] ?? "")))) result.ambiguous ??= "shell_literal_home"
                if (parts.some((part) => part.descendantsOfType(["simple_expansion", "expansion"]).some((expansion) => /\$(?:\{)?(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|[A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET))(?:\}|\b)/.test(expansion.text)))) result.secretReferences = true
                if (parts.some((part) => part.type === "word" && /[*?\[]/.test(part.text))) result.ambiguous ??= "shell_glob_targets"
                if (values.some((value) => value === undefined)) {
                    result.ambiguous = "shell_dynamic_word"
                    for (const part of parts) for (const substitution of part.descendantsOfType(["command_substitution", "process_substitution"])) for (const child of substitution.namedChildren) await walk(child)
                    return
                }
                const args = values as string[]
                const wrappers: string[] = []
                let privileged = false
                while (args.length && ["sudo", "env", "command", "exec", "nohup"].includes(basename(args[0]))) {
                    const wrapper = basename(args.shift()!)
                    wrappers.push(wrapper)
                    if (wrapper === "sudo") privileged = true
                    while (args[0]?.startsWith("-") || (wrapper === "env" && /^[A-Za-z_]\w*=/.test(args[0] ?? ""))) {
                        const option = args.shift()!
                        if (wrapper === "env" && /^[A-Za-z_]\w*=/.test(option)) (result.environmentAssignments ??= []).push(option)
                        if (wrapper === "sudo" && ["-u", "-g", "--user", "--group"].includes(option)) { if (!args.shift()) result.ambiguous = "shell_wrapper_option"; continue }
                        if (["-C", "--chdir", "--unset", "-S", "--split-string"].includes(option)) { result.ambiguous = "shell_wrapper_option"; return }
                        if (/^(HOME|PATH|IFS|BASH_ENV|ENV|OPENCODE_\w+)=/.test(option)) result.ambiguous = "shell_environment_override"
                    }
                }
                if (!args.length) { result.ambiguous = "shell_empty_command"; return }
                const executable = basename(args.shift()!)
                if (["sh", "bash", "dash", "zsh"].includes(executable)) {
                    const index = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg))
                    if (index < 0 || args.length !== index + 2 || args.slice(0, index).some((arg) => !arg.startsWith("-"))) { result.ambiguous = "shell_indirect_script"; return }
                    const nested = await analyzeShell(args[index + 1], depth + 1)
                    result.commands.push(...nested.commands.map((command) => ({ ...command, privileged: privileged || command.privileged, wrappers: [...wrappers, executable, ...command.wrappers] })))
                    result.redirections.push(...nested.redirections)
                    result.pipelines += nested.pipelines
                    result.secretReferences ||= nested.secretReferences
                    if (nested.environmentAssignments) (result.environmentAssignments ??= []).push(...nested.environmentAssignments)
                    result.ambiguous ??= nested.ambiguous
                    return
                }
                if (["eval", "source", ".", "cd"].includes(executable)) result.ambiguous = "shell_indirect_execution"
                result.commands.push({ executable, args, wrappers, privileged })
                return
            }
            for (const child of node.namedChildren) await walk(child)
        }
        await walk(tree.rootNode)
        if (!result.commands.length) result.ambiguous ??= "shell_missing_command"
        return result
    } finally {
        tree?.delete()
        parser.delete()
    }
}
