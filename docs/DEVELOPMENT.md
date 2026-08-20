# Development / 开发说明

## Architecture / 架构

The Matrix transport extracts `m.thread` relations and hands authorized messages to `CourierRouter`. The router maps bridge commands or forwards prompts to `WorkerManager`. The manager owns workspace leases, SQLite state, direct OMP RPC processes, safe workspace transcript mirrors, interactive requests, idle eviction, and event fan-out to Matrix and `courierctl`. `RunReporter` consumes native `message_end` and task progress/result frames to produce readable stage messages and per-model usage without parsing OMP logs or session files.

Matrix transport 提取 `m.thread` 关系并把已授权消息交给 `CourierRouter`。路由器处理 bridge 命令，或把提示转给 `WorkerManager`。Worker manager 管理工作区租约、SQLite 状态、直接 OMP RPC 进程、安全的工作区对话镜像、交互请求、空闲回收，以及 Matrix 与 `courierctl` 的事件分发。`RunReporter` 直接消费原生 `message_end` 与 task 进度/结果 frame，生成易读的阶段消息和按模型 usage；它不解析 OMP 日志或 session 文件。

```text
Matrix -> CourierRouter -> WorkerManager -> OmpRpcProcess -> omp --mode rpc-ui
                              |      |
                              |      +-> Unix socket -> courierctl watch/attach
                              +-> SQLite + /srv/threads
```

The live E2E path is implemented by `courier-e2e`, which connects as a separate
Matrix driver, sends only cases from a validated suite file, and correlates the
returned Matrix event ID with the isolated Courier control record. Completion
requires an observed busy/starting state followed by idle; artifact validators
then check the development ledger or research decision pack before emitting a
secret-free report.

New contracted workflows persist a deterministic contract snapshot with each
thread. Resume fails closed when the effective profile, prompt files, role model
map, runtime image, or toolchain identity changes; an explicit migration starts
a new lead context at a reconciliation-only gate. Task envelopes and accepted
boundary rotation packets are persisted mechanically by Courier. Legacy thread
rows have no contract hash and intentionally retain their old resume behavior.

实时 E2E 路径由 `courier-e2e` 实现。它使用独立 Matrix driver 连接，只发送经过验证的 suite 文件中定义的 case，并把返回的 Matrix event ID 与隔离 Courier 的控制记录关联。完成条件是先观察到 busy/starting，再回到 idle；随后验证开发 ledger 或研究 decision pack，并生成不含秘密值的报告。

新的 contract workflow 会为每个线程保存确定性的 contract 快照。当有效 profile、prompt 文件、角色模型映射、runtime 镜像或工具链身份发生变化时，恢复会默认失败；显式迁移会在仅用于对账的关卡中启动新的 lead 上下文。Task envelope 和已接受边界的 rotation packet 由 Courier 机械持久化。旧线程没有 contract hash，因此有意保留原来的恢复行为。

## Invariants / 不变量

- One active owner per workspace. / 每个工作区只有一个活动所有者。
- One serialized OMP process per live Matrix thread. / 每个活动 Matrix 线程只有一个串行 OMP 进程。
- Exact session paths are persisted; `--continue` is never used globally. / 持久化精确 session 路径，不使用全局 `--continue`。
- Matrix interaction IDs are single-use, scoped to their originating thread, and fail closed. / Matrix 交互 ID 只能使用一次、只在来源线程有效，并在超时时默认拒绝或取消。
- Periodic usage is grouped by the resolved provider/model. Active task totals are explicitly approximate until OMP publishes settled cache usage. / 定期 usage 按实际 provider/model 分组；在 OMP 发布最终缓存 usage 前，运行中 task 的总数会明确标为估算值。
- A contracted run cannot resume under a different effective workflow without explicit migration. / 已记录 contract 的运行不能在未显式迁移时使用不同的有效 workflow 恢复。
- Unmanaged existing directories are never adopted implicitly. / 不会隐式接管已有未管理目录。
- Canary automation never shares a trusted Matrix identity, writable state, or workspace root with production Courier. / Canary 自动化不与生产 Courier 共用受信任 Matrix 身份、可写状态或工作区根目录。

## Validation / 验证

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm pack --dry-run
```

An integration smoke test should spawn the pinned real OMP binary, wait for `ready`, call `get_state`, create a temporary managed workspace, and stop without invoking an LLM. / 集成冒烟测试应启动固定版本的真实 OMP，等待 `ready`，调用 `get_state`，创建临时受管工作区，并在不调用 LLM 的情况下停止。
