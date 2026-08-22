# OMP Courier

OMP Courier 把加密的 Matrix 线程连接到 Linux 主机上隔离运行的 [Oh My Pi](https://github.com/can1357/oh-my-pi) RPC worker。

本仓库是 [Hi-Barry/pi-courier](https://github.com/Hi-Barry/pi-courier) 的 OMP 专用 fork。它由 starbug 的主机 Ansible role 安装，不使用上游的用户级 systemd 安装流程。

## 运行模型

```text
Matrix 线程 -> OMP Courier -> omp --mode rpc-ui
                    |             |
                    |             +-- 一个持久化 OMP 会话
                    +-- 一个命名 /srv/threads 工作区租约
                                  +-- 可选的持久 LXD Bash 虚拟机
```

- Matrix room ID 和线程根 event ID 构成会话键。
- 每个线程选择一个 OMP profile 和工作区。
- 每个工作区同一时间只能由一个 Matrix 或 SSH 会话占用。
- 空闲 worker 会停止，但文件和 OMP 原生会话会保留。
- 用户和助手文本会镜像到每个工作区的 `.courier/transcript.md`，便于通过 SSH 查看。
- `courierctl watch` 可并发只读查看 RPC 输出。
- `courierctl attach` 会暂停 Matrix 所有权，并用 OMP 原生 TUI 恢复同一会话。
- profile 可让 OMP 和文件工具保留在主机，同时把 lead 与子代理的所有 Bash 调用路由到持久、空闲时停止的 LXD 虚拟机。

## Matrix 命令

```text
!start research nomadmade Research product ideas and write a report
!start host-development repo:starbug Inspect the cluster repository
!start development nomadbuild --brief nomadchef-ai/development-briefs/nomadbuild.md
!continue nomadmade
!new [profile]
!migrate
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

顶层的 `!start` 或 `!continue` 消息会成为 Matrix 线程根。后续提示应在线程中回复。

OMP 的确认、选择、短文本输入和编辑器请求都会桥接到原 Matrix 线程。选择项使用带编号的 `!choose` 命令；短文本使用 `!answer <id> <text>`；多行编辑内容则把 `!answer <id>` 放在第一行，正文放在后续行。`!cancel` 可取消待处理的选择、输入或编辑器请求。交互 ID 只能使用一次、仅属于来源线程，并在 OMP 请求超时与 Courier 配置的审批超时两者中较短的期限到达时失效。

带 `--brief` 的形式是从研究到开发的显式人工审批交接。源文件必须是 Courier 托管工作区中 `development-briefs/` 目录下的 Markdown 文件。Courier 会把验证后的文件复制为新开发工作区中的 `BRIEF.md`，在 `.courier/handoff.json` 中记录来源和 SHA-256，然后启动 `development` profile。绝对路径、目录穿越、符号链接逃逸、外部工作区、超过 256 KiB 的文件以及已存在的目标都会被拒绝。

## 工作区输出与对话镜像

OMP 以所选工作区作为当前目录运行，因此报告、代码和其他交付物会写入 `/srv/threads/<name>`。Courier 同时把便于阅读的对话镜像追加到 `.courier/transcript.md`。`.courier` 目录不会进入 Git；对于外部 Git 工作区，Courier 只更新本地 `.git/info/exclude`，不会修改受版本控制的 ignore 文件。

镜像包含带时间戳的 Matrix 用户文本、OMP 助手文本和 Courier 运行更新，不记录隐藏推理、原始工具结果、工具参数、交互输入或审批 payload。主动粘贴到对话中的文字仍可能包含敏感信息。Courier 状态目录中的受保护 OMP JSONL 会话仍是恢复会话和原生 TUI attach 的权威数据源。

Courier 还可以把 OMP 活动转换为精简的运维视图，只显示 Finished、Current、Next 和可选的 Action needed。Operator 模式会在配置的间隔内至少发送一次更新；有意义的即时更新会重置计时，并可从 OMP 认证代理读取订阅容量剩余百分比，而不是根据 token 数量估算。旧的详细 token 视图仍然可用。设置 `hideToolCalls` 可避免在普通 Matrix 回复中显示原始工具名称和参数；需要协议级输出的运维人员仍可使用 `courierctl watch --raw`。

启用 workflow contract 的 profile 会在运行开始时记录确定性的 schema-v2 身份，包括 profile 配置、prompt bundle、精确的角色/模型映射、runtime 镜像和工具链。身份变化会在产品工作开始前阻止恢复；`!migrate` 会启动新的 lead 会话，并只执行 ledger 对账。没有历史 contract 的旧运行仍可恢复。Courier 会机械地持久化 task envelope，并可在已接受任务边界消费原子 rotation packet，从而无需额外的“持久化”模型任务。

## 配置

用 `PI_COURIER_CONFIG` 指向 root 管理的 JSON 配置。秘密值应通过文件引用，不应直接写入配置。

```json
{
  "matrix": {
    "homeserverUrl": "https://matrix.example.com",
    "accessTokenFile": "/run/credentials/omp-courier.service/matrix-access-token",
    "encryption": true,
    "allowGroupRooms": false,
    "storageDir": "/var/lib/omp-courier/matrix"
  },
  "workspaceRoot": "/srv/threads",
  "stateDir": "/var/lib/omp-courier",
  "controlSocket": "/run/omp-courier/control.sock",
  "ompCliPath": "/opt/omp-courier/omp/17.2.10/omp",
  "maxWorkers": 4,
  "idleTimeoutSeconds": 1800,
  "approvalTimeoutSeconds": 600,
  "hideToolCalls": true,
  "runReporting": {
    "intervalSeconds": 600,
    "progressHeartbeatSeconds": 0,
    "readableProgress": true,
    "finalUsage": true,
    "format": "operator",
    "usageMode": "capacity",
    "capacityStaleSeconds": 900,
    "timeZone": "Europe/Berlin"
  },
  "runtimes": {
    "development-vm": {
      "type": "lxd-vm",
      "remote": "omp-development",
      "project": "omp-development",
      "image": "omp-development-20260819-1",
      "profile": "omp-development-vm",
      "guestWorkspace": "/workspace",
      "user": 995,
      "group": 988,
      "maxRunning": 3
    }
  },
  "profiles": {
    "development": {
      "tools": ["read", "write", "edit", "bash", "task"],
      "approvalMode": "write",
      "statusFile": ".courier/development/status.md",
      "matrixUpdatesFromStatus": true,
      "runtime": "development-vm",
      "workspaceKinds": ["managed"],
      "workflowContract": {
        "version": "development-v2",
        "stateDirectory": ".courier/development",
        "promptFiles": ["/etc/omp-courier/prompts/development/AGENTS.md"],
        "expectedModels": { "lead": "provider/model:max" },
        "toolchainIdentity": "omp-17.2.10;runtime-image-generation",
        "rotationRequestFile": ".courier/development/rotate.json"
      },
      "artifactPolicy": {
        "root": ".courier",
        "forbiddenDirectories": [".venv", "node_modules", "target", "cache", "tools"],
        "maxFileBytes": 5242880,
        "forbidExecutables": true
      }
    }
  }
}
```

内置 profile 为 `research`、`development` 和 `autonomous-development`，可在配置中覆盖。OMP 用户级插件、skill、设置和 MCP server 按原生 profile 隔离；工作区中的 `.omp` 配置对打开该工作区的所有 profile 生效。

## 运维命令

```bash
courierctl list
courierctl status nomadmade
courierctl watch nomadmade
courierctl watch nomadmade --raw
courierctl resume nomadmade "Continue from the current recorded gate."
courierctl migrate nomadmade
courierctl artifacts nomadmade
courierctl reference add nomadmade rust-tams-api@58c73d8
courierctl attach nomadmade
courierctl attach nomadmade --abort
courierctl adopt existing-directory
courierctl env list
courierctl env status nomadmade
courierctl env start nomadmade
courierctl env shell nomadmade
courierctl env stop nomadmade
courierctl env rebuild nomadmade --confirm nomadmade
courierctl env destroy nomadmade --confirm nomadmade
courierctl env tunnel-command nomadmade 8080 18080
```

`watch` 是并发只读的精简事件视图，不是完整的 OMP 交互界面。默认情况下，它会把助手文本中的字面 `\n` 和 `\r\n` 渲染成换行，即使转义序列被拆分到多个流式 frame 中也能处理。需要查看精确原始流时使用 `--raw`。`resume` 会通过原有的 Matrix 所属 worker 重启已停止的工作区，因此可读进度和定期用量仍会发送到线程。`attach` 提供完整原生 TUI，因此会独占工作区直到退出；独占期间 Matrix 进度和用量报告不可用。

`migrate` 是 workflow contract 变化后的显式关卡：它启动新的 lead 上下文，并在原 Matrix 线程发送仅用于对账的回合。`artifacts` 会只读审计 profile 的私有产物根目录；发现被禁止的缓存、虚拟环境、依赖树、可执行文件或超大文件时返回非零状态。

`env shell` 会启动工作区虚拟机供运维人员使用，并在 shell 退出后停止它。重建和销毁必须用工作区名称显式确认，两者都会保留主机上的工作区文件。`tunnel-command` 只为正在运行的虚拟机打印 SSH 本地转发命令，不会自行打开监听端口。

当 profile 启用 `matrixUpdatesFromStatus` 时，Courier 会投影工作区内的 `statusFile`，而不是转发 lead agent 的原始回合文本。Operator 格式要求 `## Matrix update` 中包含 `Finished:`、`Current:` 和 `Next:`，仅在需要人工干预时包含 `Action needed:`。工作区外的文件、非普通文件以及大于 256 KiB 的文件都会被忽略。即时状态更新会重置定期计时，既避免连续重复消息，也保证运行静默时间不超过配置间隔。Capacity 模式仅显示认证代理返回的相关提供商/模型窗口；超过 `capacityStaleSeconds` 会标记为过期，绝不会用 token 数推算替代。

可以在启动时用 `--reference <workspace>@<commit>` 声明精确的本地 Git 提交，也可以在目标空闲时运行 `courierctl reference add`。Courier 会把该提交导出到状态缓存，通过 `--add-dir` 提供给主机 OMP，在隔离 VM 的 `/references/...` 路径只读挂载，并把来源记录到工作流的 `references.json`。

## 隔离的 E2E canary

`courier-e2e` 使用独立 Matrix 用户和独立 Courier 实例，通过固定且受版本控制的测试套件进行端到端验证。它创建或复用与 canary bot 的加密私聊，把每个 case 作为顶层 `!start` 发送，通过隔离的控制 socket 观察执行状态，验证工作区中的持久化产物，并生成权限为 `0600` 的 JSON 与 Markdown 报告。

```bash
courier-e2e run --config /etc/omp-courier-canary/suite.json
```

该命令故意不提供任意 prompt 参数。测试 prompt 只能来自 root 管理的 JSON 配置；case 会串行运行，并使用唯一工作区名称。Canary 必须拥有独立的 Matrix 身份、Unix 账号、加密状态、Courier 状态、工作区根目录和控制 socket；不要把自动化凭据加入生产 Courier 的 trusted-user 列表。Matrix token 只能通过 credential 文件传入，且不会写入报告。

## 开发

需要 Node 24 和 Git。

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build
```

代码使用 Node 内置 SQLite API。Node 24 目前会输出实验功能警告；数据库 schema 由测试覆盖，并与运行时版本一起固定。

## 安全边界

OMP Courier 必须使用非特权账号运行。LXD runtime 应只授予 project 范围的细粒度 TLS 身份，绝不能把 Courier 加入 `lxd` 组或主机 Docker 组。project 只允许挂载托管工作区根目录，并阻止虚拟机访问主机、局域网、集群、元数据和其他私有网络。OMP 工具列表与审批模式仍是策略保护；命令隔离由虚拟机、project 和网络边界提供。

MIT 许可，参见 [LICENSE](LICENSE)。
