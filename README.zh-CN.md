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
- `courierctl watch` 可并发只读查看 RPC 输出。
- `courierctl attach` 会暂停 Matrix 所有权，并用 OMP 原生 TUI 恢复同一会话。

## Matrix 命令

```text
!start research nomadmade Research product ideas and write a report
!start development repo:starbug Inspect the cluster repository
!continue nomadmade
!new [profile]
!status
!stop
!abort
!approve <id>
!deny <id>
!profiles
!workspaces
!help
```

顶层的 `!start` 或 `!continue` 消息会成为 Matrix 线程根。后续提示应在线程中回复。

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
  "approvalTimeoutSeconds": 600
}
```

内置 profile 为 `research`、`development` 和 `autonomous-development`，可在配置中覆盖。OMP 用户级插件、skill、设置和 MCP server 按原生 profile 隔离；工作区中的 `.omp` 配置对打开该工作区的所有 profile 生效。

## 运维命令

```bash
courierctl list
courierctl status nomadmade
courierctl watch nomadmade
courierctl attach nomadmade
courierctl attach nomadmade --abort
courierctl adopt existing-directory
```

`watch` 是并发只读的精简事件视图，不是完整的 OMP 交互界面。`attach` 提供完整原生 TUI，因此会独占工作区直到退出。

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
