# OMP Courier

OMP Courier 把加密的 Matrix 线程连接到 Linux 主机上隔离运行的 [Oh My Pi](https://github.com/can1357/oh-my-pi) RPC worker。

本仓库是 [Hi-Barry/pi-courier](https://github.com/Hi-Barry/pi-courier) 的 OMP 专用 fork。它由 starbug 的主机 Ansible role 安装，不使用上游的用户级 systemd 安装流程。

## 运行模型

```text
Matrix 线程 -> OMP Courier -> omp --mode rpc-ui
                    |             |
                    |             +-- 一个持久化 OMP 会话
                    +-- 一个命名 /srv/threads 工作区租约
```

- Matrix room ID 和线程根 event ID 构成会话键。
- 每个线程选择一个 OMP profile 和工作区。
- 每个工作区同一时间只能由一个 Matrix 或 SSH 会话占用。
- 空闲 worker 会停止，但文件和 OMP 原生会话会保留。
- 用户和助手文本会镜像到每个工作区的 `.courier/transcript.md`，便于通过 SSH 查看。
- `courierctl watch` 可并发只读查看 RPC 输出。
- `courierctl attach` 会暂停 Matrix 所有权，并用 OMP 原生 TUI 恢复同一会话。

## Matrix 命令

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

顶层的 `!start` 或 `!continue` 消息会成为 Matrix 线程根。后续提示应在线程中回复。

OMP 的确认、选择、短文本输入和编辑器请求都会桥接到原 Matrix 线程。选择项使用带编号的 `!choose` 命令；短文本使用 `!answer <id> <text>`；多行编辑内容则把 `!answer <id>` 放在第一行，正文放在后续行。`!cancel` 可取消待处理的选择、输入或编辑器请求。交互 ID 只能使用一次、仅属于来源线程，并在 OMP 请求超时与 Courier 配置的审批超时两者中较短的期限到达时失效。

带 `--brief` 的形式是从研究到开发的显式人工审批交接。源文件必须是 Courier 托管工作区中 `development-briefs/` 目录下的 Markdown 文件。Courier 会把验证后的文件复制为新开发工作区中的 `BRIEF.md`，在 `.courier/handoff.json` 中记录来源和 SHA-256，然后启动 `development` profile。绝对路径、目录穿越、符号链接逃逸、外部工作区、超过 256 KiB 的文件以及已存在的目标都会被拒绝。

## 工作区输出与对话镜像

OMP 以所选工作区作为当前目录运行，因此报告、代码和其他交付物会写入 `/srv/threads/<name>`。Courier 同时把便于阅读的对话镜像追加到 `.courier/transcript.md`。`.courier` 目录不会进入 Git；对于外部 Git 工作区，Courier 只更新本地 `.git/info/exclude`，不会修改受版本控制的 ignore 文件。

镜像包含带时间戳的 Matrix 用户文本、OMP 助手文本和 Courier 运行更新，不记录隐藏推理、原始工具结果、工具参数、交互输入或审批 payload。主动粘贴到对话中的文字仍可能包含敏感信息。Courier 状态目录中的受保护 OMP JSONL 会话仍是恢复会话和原生 TUI attach 的权威数据源。

Courier 还可以把 OMP 原生 task 事件转换成简短的 Matrix 阶段更新和按模型统计的 token 报告。运行中的子代理使用 OMP 的实时 token 计数并标记为 `~`；task 结束后，会用精确的输入、输出、缓存读取和缓存写入总数替换估算值。设置 `hideToolCalls` 可避免在普通 Matrix 回复中显示原始工具名称和参数；需要协议级输出的运维人员仍可使用 `courierctl watch --raw`。

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
    "readableProgress": true,
    "finalUsage": true
  },
  "profiles": {
    "development": {
      "tools": ["read", "write", "edit", "bash", "task"],
      "approvalMode": "write",
      "statusFile": ".courier/development/status.md",
      "matrixUpdatesFromStatus": true
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
courierctl attach nomadmade
courierctl attach nomadmade --abort
courierctl adopt existing-directory
```

`watch` 是并发只读的精简事件视图，不是完整的 OMP 交互界面。默认情况下，它会把助手文本中的字面 `\n` 和 `\r\n` 渲染成换行，即使转义序列被拆分到多个流式 frame 中也能处理。需要查看精确原始流时使用 `--raw`。`resume` 会通过原有的 Matrix 所属 worker 重启已停止的工作区，因此可读进度和定期用量仍会发送到线程。`attach` 提供完整原生 TUI，因此会独占工作区直到退出；独占期间 Matrix 进度和用量报告不可用。

当 profile 启用 `matrixUpdatesFromStatus` 时，Courier 会投影工作区内的 `statusFile`，而不是转发 lead agent 的原始回合文本。优先使用 `## Matrix update` 小节；旧文件则退回显示 `Status`、`Current gate` 和 `Updated` 字段。工作区外的文件、非普通文件以及大于 256 KiB 的文件都会被忽略。相同的投影也会显示在定期的按模型用量报告中。

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

OMP Courier 必须使用非特权账号运行。Linux 权限和 systemd sandbox 才是安全边界；OMP 工具列表与审批模式只是策略保护，不是沙箱。不要向服务账号暴露 root 凭据、kubeconfig 或宽泛的主目录权限。

MIT 许可，参见 [LICENSE](LICENSE)。
