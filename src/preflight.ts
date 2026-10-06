import type { NormalizedAction } from "./types.ts"
import { resolveTarget } from "./action-normalizer.ts"

export type PreflightDecision = { kind: "continue" } | { kind: "deny" | "ask"; reason: string; rule: string }
const roots = new Set(["/", "/bin", "/sbin", "/usr", "/etc", "/System", "/Library", "/Windows", "/boot", "/dev", "/proc", "/sys", "/home", "/Users", "/root", "/var", "/opt", "/Applications"])
const credential = (path: string) => /\/(?:\.ssh\/(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.pem)|\.aws\/credentials|\.azure\/accessTokens\.json|\.config\/gcloud\/[^/]*credentials[^/]*|\.env(?:\.(?:local|production))?)$/.test(path)
const block = (path: string) => /^\/dev\/(?:sd[a-z]\d*|vd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|(?:r?disk)\d+(?:s\d+)?)$/.test(path)

export function runPreflight(action: NormalizedAction): PreflightDecision {
    if (action.commands.some((command) => command.executable === "rm" && command.args.some((arg) => arg === "--recursive" || /^-[a-zA-Z]*[rR]/.test(arg)) && command.args.filter((arg) => !arg.startsWith("-")).some((arg) => roots.has(resolveTarget(arg, action.cwd).replace(/\/\*$/, "") || "/")))) return { kind: "deny", rule: "system_root_delete", reason: "Recursive deletion of a filesystem or system root is blocked" }
    if (action.commands.some((command) => /^(?:mkfs(?:\..+)?|format|diskutil)$/.test(command.executable) && command.args.some((arg) => block(arg))) || (action.commands.some((command) => command.executable === "dd" && command.args.some((arg) => /^of=/.test(arg) && block(arg.slice(3))))) || action.redirections.some((redirect) => /[>]/.test(redirect.operator) && block(redirect.target))) return { kind: "deny", rule: "block_device_write", reason: "Destructive writes or formatting of block devices are blocked" }
    if (action.commands.some((command) => ["curl", "wget", "nc", "ncat", "scp", "sftp"].includes(command.executable)) && action.targets.some(credential)) return { kind: "deny", rule: "credential_export", reason: "Exporting private keys or cloud credentials is blocked" }
    if (action.pipelines && action.secretReferences && action.commands.some((command) => ["curl", "wget", "nc", "ncat"].includes(command.executable))) return { kind: "deny", rule: "secret_pipeline_export", reason: "Piping secret variables to outbound network commands is blocked" }
    if (action.category === "filesystem_delete" && action.targets.some((target) => /^\/etc\/(?:sudoers(?:\.d)?|security|apparmor(?:\.d)?|selinux)$/.test(target))) return { kind: "deny", rule: "security_policy_delete", reason: "Destroying system security policy is blocked" }
    if (action.ambiguous) return { kind: "ask", rule: action.ambiguous, reason: "Shell structure or targets require human approval" }
    return { kind: "continue" }
}
