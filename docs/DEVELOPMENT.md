# Development / 开发说明

## Architecture / 架构

The Matrix transport extracts `m.thread` relations and hands authorized messages to `CourierRouter`. The router maps bridge commands or forwards prompts to `WorkerManager`. The manager owns workspace leases, SQLite state, direct OMP RPC processes, approvals, idle eviction, and event fan-out to Matrix and `courierctl`.

Matrix transport 提取 `m.thread` 关系并把已授权消息交给 `CourierRouter`。路由器处理 bridge 命令，或把提示转给 `WorkerManager`。Worker manager 管理工作区租约、SQLite 状态、直接 OMP RPC 进程、审批、空闲回收，以及 Matrix 与 `courierctl` 的事件分发。

```text
Matrix -> CourierRouter -> WorkerManager -> OmpRpcProcess -> omp --mode rpc-ui
                              |      |
                              |      +-> Unix socket -> courierctl watch/attach
                              +-> SQLite + /srv/threads
```

## Invariants / 不变量

- One active owner per workspace. / 每个工作区只有一个活动所有者。
- One serialized OMP process per live Matrix thread. / 每个活动 Matrix 线程只有一个串行 OMP 进程。
- Exact session paths are persisted; `--continue` is never used globally. / 持久化精确 session 路径，不使用全局 `--continue`。
- Matrix approval IDs are scoped to their originating thread and fail closed. / Matrix 审批 ID 只在来源线程有效，超时默认拒绝。
- Unmanaged existing directories are never adopted implicitly. / 不会隐式接管已有未管理目录。

## Validation / 验证

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
```

An integration smoke test should spawn the pinned real OMP binary, wait for `ready`, call `get_state`, create a temporary managed workspace, and stop without invoking an LLM. / 集成冒烟测试应启动固定版本的真实 OMP，等待 `ready`，调用 `get_state`，创建临时受管工作区，并在不调用 LLM 的情况下停止。
