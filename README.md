# OMP Courier

OMP Courier connects encrypted Matrix threads to isolated [Oh My Pi](https://github.com/can1357/oh-my-pi) RPC workers on a Linux host.

This repository is an OMP-focused fork of [Hi-Barry/pi-courier](https://github.com/Hi-Barry/pi-courier). It is designed to be installed by the starbug host Ansible role, not by the upstream user-systemd installer.

## Runtime model

```text
Matrix thread -> OMP Courier -> omp --mode rpc-ui
                     |             |
                     |             +-- one persisted OMP session
                     +-- one named /srv/threads workspace lease
```

- Matrix room and thread-root event IDs form the conversation key.
- Each thread selects an OMP profile and workspace.
- A workspace can have only one active Matrix or SSH owner.
- Idle workers stop after a configurable timeout; their files and native OMP session remain.
- User and assistant text is mirrored to `.courier/transcript.md` inside each workspace for SSH review.
- `courierctl watch` observes RPC events concurrently.
- `courierctl attach` pauses Matrix ownership and resumes the exact session in OMP's native TUI.

## Matrix commands

```text
!start research nomadmade Research product ideas and write a report
!start development repo:starbug Inspect the cluster repository
!start development nomadbuild --brief nomadchef-ai/development-briefs/nomadbuild.md
!continue nomadmade
!new [profile]
!status
!stop
!abort
!approve <id>
!deny <id>
!choose <id> <number>
!answer <id> <text>
!cancel <id>
!profiles
!workspaces
!help
```

A top-level `!start` or `!continue` message becomes the Matrix thread root. Send later prompts as replies in that thread.

OMP confirmations, selections, short inputs, and editor prompts are bridged into
the originating Matrix thread. Selections use the numbered `!choose` command.
Use `!answer <id> <text>` for short input, or put `!answer <id>` on the first
line and multiline editor content below it. `!cancel` cancels a pending select,
input, or editor request. Interaction IDs are single-use, thread-scoped, and
expire at the shorter of the OMP request timeout and Courier's configured
approval timeout.

The `--brief` form is an explicit, human-approved handoff from research to development. The source must be a Markdown file below `development-briefs/` in a managed Courier workspace. Courier copies the validated file to `BRIEF.md` in a new development workspace, records its source and SHA-256 in `.courier/handoff.json`, and starts the `development` profile. Absolute paths, traversal, symlink escapes, external workspaces, files over 256 KiB, and existing targets are rejected.

## Workspace output and transcripts

OMP runs with the selected workspace as its current directory, so requested reports, code, and other deliverables are written under `/srv/threads/<name>`. Courier also appends a human-readable conversation mirror to `.courier/transcript.md`. The `.courier` directory is excluded from Git, and external Git workspaces use their local `.git/info/exclude` rather than a tracked ignore change.

The mirror contains Matrix user text and OMP assistant text with timestamps. It deliberately excludes hidden reasoning, raw tool results, tool arguments, and interactive-input or approval payloads. Text deliberately pasted into the conversation may still be sensitive. Protected OMP session JSONL under Courier's state directory remains authoritative for resume and native TUI attach.

## Configuration

Set `PI_COURIER_CONFIG` to a root-owned JSON file. Secrets should be referenced by file, not embedded.

```json
{
  "matrix": {
    "homeserverUrl": "https://matrix.example.com",
    "accessTokenFile": "/run/credentials/omp-courier.service/matrix-access-token",
    "encryption": true,
    "allowGroupRooms": false,
    "storageDir": "/var/lib/omp-courier/matrix"
  },
  "auth": {
    "trustedUsers": ["matrix:@operator:example.com"],
    "adminUserId": "matrix:@operator:example.com"
  },
  "workspaceRoot": "/srv/threads",
  "stateDir": "/var/lib/omp-courier",
  "controlSocket": "/run/omp-courier/control.sock",
  "ompCliPath": "/opt/omp-courier/omp/17.2.10/omp",
  "maxWorkers": 4,
  "idleTimeoutSeconds": 1800,
  "approvalTimeoutSeconds": 600,
  "externalWorkspaces": {
    "starbug": { "path": "/root/workspace/starbug" }
  },
  "authBroker": {
    "url": "http://127.0.0.1:8765",
    "tokenFile": "/var/lib/omp-courier/.omp/auth-broker.token"
  }
}
```

Built-in profiles are `research`, `development`, and `autonomous-development`. They can be overridden in configuration. OMP user-level plugins, skills, settings, and MCP servers follow the selected native OMP profile; workspace-level `.omp` configuration is shared by profiles that open the same workspace.

## Operator commands

```bash
courierctl list
courierctl status nomadmade
courierctl watch nomadmade
courierctl watch nomadmade --raw
courierctl attach nomadmade
courierctl attach nomadmade --abort
courierctl adopt existing-directory
```

`watch` is read-only and concurrent, but it is a compact event renderer rather than OMP's exact interactive UI. By default it renders literal `\n` and `\r\n` sequences in assistant text as line breaks, including escapes split across stream frames. Use `--raw` when exact streamed text matters. `attach` provides the exact TUI and therefore takes an exclusive workspace lease until it exits.

## Development

Requires Node 24 and Git.

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build
```

The code uses Node's built-in SQLite API. Node 24 currently prints an experimental-feature warning for that API; the database schema is covered by tests and pinned with the runtime version.

## Security boundary

OMP Courier must run as an unprivileged account. Linux permissions and systemd sandboxing are the security boundary; OMP tool lists and approval modes are policy guardrails, not a sandbox. Do not expose root credentials, kubeconfigs, or broad home-directory access to the service account.

MIT licensed. See [LICENSE](LICENSE).
