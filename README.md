# OpenCode Codex Guardian

Automatically review coding-agent permission requests with Codex Guardian in OpenCode V2.

The plugin works **inside OpenCode's permission system**, not instead of it:

| OpenCode decision | Plugin behavior |
| --- | --- |
| `allow` | Leave unchanged. |
| `deny` | Leave blocked. |
| `ask` | Review the action and allow, deny, or leave it for human approval. |

This includes out-of-project `external_directory` requests. Approval is scoped to the current request, not blanket access to the filesystem; subsequent read, edit, and shell checks still apply.

> **Free usage is unverified.** Successful `codex-auto-review` responses do not prove zero-cost accounting. `nativeFreeOnly` prevents ordinary-model fallback; it does not guarantee free native inference. Keep the plugin disabled if guaranteed zero-cost usage is required.

## Requirements

- Node.js 26 or newer.
- OpenCode V2; tested with `2.0.24`, matching the pinned plugin dependency.
- For native reviews: the built-in `openai` provider connected through ChatGPT OAuth, with the main session using its Codex endpoint.

OpenAI API-key connections and custom provider aliases are not supported by the native transport. Backend availability of `codex-auto-review` is not guaranteed.

## Install and enable

Once published, add `@fatihdogmus/opencode-codex-guardian` to your OpenCode plugin configuration. No separate `npm install` is needed.

To use a local checkout instead:

```sh
git clone https://github.com/fatihdogmus/opencode-codex-guardian.git
cd opencode-codex-guardian
npm ci --ignore-scripts
npm run build
```

Add this entry to your project `opencode.json(c)` or `.opencode/opencode.json(c)`, preserving existing configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@fatihdogmus/opencode-codex-guardian",
      "options": {
        "enabled": true,
        "transport": "codex-auto-review",
        "nativeFreeOnly": true,
        "failureMode": "ask"
      }
    }
  ]
}
```

For a local checkout, replace the package name with the absolute path to your clone. Relative plugin paths resolve from the configuration file containing the entry. **Loading this plugin enables the hardened baseline by default.** OpenCode does not expose the provenance of plugin options, so options in any OpenCode config are treated as unknown-origin: they may tighten security, not weaken it.

Set trusted policy separately in `~/.config/opencode/codex-guardian.json` (or `$XDG_CONFIG_HOME/opencode/codex-guardian.json`). For example, to evaluate decisions without applying them:

```json
{
  "autoReview": {
    "enabled": true,
    "transport": "codex-auto-review",
    "nativeFreeOnly": true,
    "failureMode": "ask",
    "shadow": true
  }
}
```

This must be a regular, user-owned file outside the project, not a symlink, with no group/other write permission or unsafe writable ancestor directories. Use `chmod 600` on the file. Trusted policy can disable review (`enabled: false`), select a fallback, or change active/shadow mode. **A project `enabled: false` cannot disable an enabled baseline.** An invalid trusted file or malformed options leave the permission hook installed and deny ask-level operations; diagnostics report `configuration_invalid`.

For persistent enforcement, load the plugin from user-controlled global OpenCode configuration. A plugin cannot protect you if the host never loads it or another actor removes its registration.

Check its status in OpenCode:

```text
/auto-review status
```

Status does not trigger inference. Native availability and OAuth diagnostics are populated during actual requests, so an initial `NATIVE_UNAVAILABLE` status alone does not establish that your account is unsupported.

After changing plugin source, run `npm run build` again. Configuration changes normally reload automatically; changes to an external local plugin may require `opencode service restart`.

## How native reviews work

1. Correlate the proposed action with the main OpenAI/Codex response.
2. Check for catastrophic actions and protected resources, then gather user instructions and bounded read-only evidence with best-effort secret redaction.
3. Review the action through `codex-auto-review` in a **fresh, tool-free child session**, using OpenCode's ChatGPT OAuth connection and parent-response linkage.
4. Validate the assessment, delete the child session, and apply local risk rules. Failures never silently approve an action.
5. Write hashed decision metadata to the audit log. Successful approvals are silent; deny/ask explanations are sanitized.

The reviewer reuses OpenCode's active ChatGPT OAuth connection. It does not require a separate API key and does not use your selected chat model for the review itself. Your selected model continues doing the coding.

Without OAuth or a matching Codex parent response, native review fails. For example, a main session using Anthropic normally cannot supply the required linkage. With the configuration above, failure leaves the request for human approval rather than calling another model.

## Safety and limitations

- Configured denies remain enforced. Only ask-level requests are auto-reviewed.
- A small deterministic preflight denies obvious recursive system-root deletion, block-device formatting/writes, private-key/cloud-credential export, `.env` export, and security-policy destruction. It does not attempt to classify every dangerous operation.
- Protected plugin, OpenCode config, auth, policy and audit paths require human approval. Existing symlink parents are resolved. These checks cannot prove the effects of arbitrary programs or prevent filesystem races; dynamic shell structures, scripts and interpreter code that cannot be normalized conservatively require human approval.
- Reviewer sessions have no tools and cannot recursively authorize their own actions.
- Repository text, tool output, assistant messages, and action metadata are treated as untrusted data, not evidence of user authorization.
- Direct, scoped user requests inform authorization independently of host approval. Only fixed plugin-authored guidance is privileged; repository and tool content cannot become reviewer policy.
- Critical-risk actions are denied. High-risk actions require matching high authorization; insufficiently authorized medium-risk approvals remain `ask`.
- Missing or incomplete context, malformed responses, provider errors, and timeouts use the configured failure mode, defaulting to `ask`. Earlier user restrictions remain in force unless explicitly superseded; compaction does not discard them.
- Equivalent denied actions are tracked per session; repeated denials can require human approval.
- Review packets are sent to the chosen model provider. Secret redaction is best effort, not a guarantee that sensitive content cannot be transmitted.
- Model judgments are not a security sandbox. The plugin does not replace operating-system restrictions or guarantee protection against prompt injection.
- OpenCode host APIs and other loaded plugins are trusted. Host approval evidence is short-lived, single-use, and bound to the exact request; transcript claims cannot create it. OpenCode cannot attest whether a human or another plugin supplied a reply.
- Internal reviewers are named child sessions, not hidden sessions. HTTP and experimental WebSocket hooks are supported.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` when loaded | Enable permission review; disable only through trusted policy. |
| `transport` | `"auto"` | `auto`, native-only `codex-auto-review`, or ordinary `model`. |
| `nativeFreeOnly` | `true` | Forbid ordinary-model fallback; **not a billing guarantee**. |
| `fallbackModel` | Unset | Explicit `provider/model` for ordinary model reviews. |
| `failureMode` | `"ask"` | Leave failures for human approval, or use `deny`. |
| `timeoutMs` | `15000` | Maximum review time; `reviewer.timeoutMs` is an alias. |
| `contextMaxChars` | `24000` | Maximum serialized review packet size, in characters. |
| `logging.enabled` | `true` | Log bounded review diagnostics and decisions. |
| `circuitBreaker.enabled` | `true` | Track repeated equivalent denials. |
| `circuitBreaker.maxEquivalentDenials` | `3` | Denial threshold. |
| `circuitBreaker.ttlMs` | `1800000` | Denial tracking window. |
| `circuitBreaker.effect` | `"ask"` | Decision after the threshold is reached. |
| `shadow` / `mode` | `false` / `"active"` | Trusted rollout mode; every ask-level request remains `ask` in shadow mode, including proposed deterministic denials. |
| `preflight.enabled` | `true` | Enable the narrow catastrophic brake. |
| `selfProtection.enabled` | `true` | Prevent automatic approval of protected-resource mutations. |
| `selfProtection.protectedPaths` | `[]` | Additional absolute protected paths; untrusted sources may add, never remove protection. |
| `audit.enabled` | `true` | Durable hashed JSONL decision records; audit failure cannot allow an action. |
| `audit.maxFileSizeMB` / `retainedFiles` | `20` / `5` | Current-log size limit and retained rotated logs. |
| `evidence.enabled` / `filesystem` / `git` | `true` | Bounded local metadata enrichment, not authorization. |
| `evidence.timeoutMs` / `maxBytes` | `750` / `4096` | Evidence time and output limits. |
| `sessionApprovals.enabled` / `ttlMs` | `false` / `60000` | Optional cache for a low-risk, exact bare `git status` only. |

`reviewer.ephemeralSession` and secret redaction cannot be disabled. A malformed or unsupported option is an error, not a silent fallback. Project/unknown options may lower budgets, strengthen failure/breaker behavior, add protected paths, or disable evidence/caching. They cannot enable fallback, disable protection/auditing/breakers, or change active/shadow mode.

Ordinary model review is opt-in **in the trusted policy file**: set `transport` to `model`, provide `fallbackModel`, and set `nativeFreeOnly` to `false`. To permit fallback after a native failure, use `transport: "auto"` with those same fallback settings. Ordinary inference may consume normal model quota or incur charges.

### Audit and evidence

Audit records contain hashed identifiers, decision labels, transport, latency, and failure codes—not raw commands, rationale, conversations, or credentials. Hashes are not encryption; low-entropy inputs can be guessed. Logs use private permissions, reject symlinks, and rotate under a cross-process lock. A lock left by a crashed process requires manual recovery.

Default audit location:

- Linux: `$XDG_STATE_HOME/opencode/codex-guardian/reviews.jsonl`, or `~/.local/state/opencode/codex-guardian/reviews.jsonl`.
- macOS: `~/Library/Application Support/opencode/codex-guardian/reviews.jsonl`.
- Windows: `%LOCALAPPDATA%/opencode/codex-guardian/reviews.jsonl`.

Read-only evidence gathers bounded filesystem and Git metadata without reading file contents or using the network. It informs risk, never authorization.

Session caching is off by default and limited to an exact, low-risk bare `git status`. Scripts, wrappers, writes, and other risky operations are never cached. New user instructions or non-read tool completions invalidate entries.

`/auto-review status` reports policy provenance/errors, mode, preflight/self-protection, audit path/health, breaker/cache counts, native linkage/protocol, cleanup failures and the last proposed/effective decision. Free accounting remains `unverified`.

## Development

```sh
npm ci --ignore-scripts
npm run check
mkdir -p artifacts
npm pack --ignore-scripts --pack-destination artifacts
npm run smoke -- artifacts/fatihdogmus-opencode-codex-guardian-0.1.0.tgz
```

`check` runs TypeScript checking, tests, and the build. `smoke` verifies that the packed plugin installs and works without TypeScript tooling or install scripts.

### Live integration checks

```sh
npm run verify:live
AUTO_REVIEW_TEST_TRANSPORT=websocket npm run verify:live
npm run verify:code-mode
```

These checks use real inference and temporary sessions; the execution probe permits only a harmless `printf`. They are not part of CI. Do not edit or rebuild the plugin during a live run.

## Build and release workflows

- **Build** runs on pushes to `main`, pull requests, and manual dispatch. It validates, builds, packs, smoke-tests, and uploads the package as a workflow artifact without accessing ChatGPT credentials.
- **Release** is a single manual workflow. Run it on `main` and choose `patch`, `minor`, or `major` (default: `patch`). It validates, updates both package files, commits the version as `github-actions[bot]`, pushes the matching tag, publishes the tested package to npm with public access and provenance, and creates a published GitHub release. No drafts or second publish action are needed. Pushes and pull requests never publish to npm.

For maintainers: add a GitHub Actions secret named `NPM_TOKEN`, using an npm granular token with read/write publishing access to the `@fatihdogmus` scope and **Bypass 2FA** enabled. The token must allow creating the package for the first release. The release job uses the `npm` GitHub environment; the secret can be repository-scoped or environment-scoped. Keep it out of configuration files and rotate it before expiration.

Version commits and tags use the workflow's `GITHUB_TOKEN`; branch and tag rules must permit these writes. The workflow never force-pushes or bypasses protection. If a push is rejected, resolve the repository policy before retrying.

Checks must pass before the version commit is pushed. GitHub and npm publication are not atomic: if publication fails after the push, the version commit and tag remain. Recover that version using the saved package artifact rather than starting another version bump; an already published npm version cannot be overwritten.

## License

[MIT](LICENSE) © Muhammed Fatih Doğmuş.
