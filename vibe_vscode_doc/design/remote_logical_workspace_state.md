# Logical Workspace 远端视图状态

> 适用范围：Workspace catalog、Shell layout、editor working set
>
> 不包含：Terminal 进程、Terminal ownership、Agent Session catalog

## 结论

Logical Workspace 保存的是可覆盖的 Workbench 视图状态，不是资源生命周期 authority。

| 状态 | Authority | 可见性与冲突规则 |
| --- | --- | --- |
| Workspace catalog identity | Remote SQLite | durable 确认后才可激活；其他页面刷新/重连后可见 |
| layout、editor working set | Remote SQLite | 当前页面 optimistic；其他页面刷新/重连后可见；Server 到达顺序 LWW |
| `activeWorkspaceId` | 页面 `sessionStorage` | 仅当前页面 |
| Terminal identity 与 ownership | Terminal/PTY process metadata | Terminal 恢复后立即可用 |
| Agent Session catalog | Session provider/history | 保持 VS Code 全局语义 |

## 远端状态

```ts
interface LogicalWorkspaceSharedState {
  schemaVersion: 2;
  workspaces: Array<{
    id: string;
    name: string;
    terminalIds: string[]; // 只用于迁移旧 Terminal owner
    shellLayout?: ShellLayout;
    editorWorkingSet?: string;
  }>;
}
```

新代码不再向 `terminalIds` 增删 ownership；新 Terminal 保持该数组为空。旧记录仅用于把 owner 迁移到 Terminal process 的 `logicalWorkspaceId`。

这里复用 VS Code workspace storage 按 Workspace ID 分区的原则，但存储拓扑不同：VS Code 桌面端通常为每个 Workspace ID 使用独立的 `state.vscdb`，Web 端使用按 Workspace ID 命名的 IndexedDB；Vibe 则新增一个共享的 Logical Workspace 专用 SQLite，并以 `workspace.<physicalWorkspaceId>` record 分区。

必须保证的是不同 Physical Workspace 不混写，共用数据库文件不是产品要求。单库让 Remote Server 只需管理一个数据库实例，避免动态维护文件路径、连接和释放生命周期；代价是它只提供命名空间隔离，不提供独立文件、故障域或权限隔离。未来需要按 Workspace 备份、恢复或隔离故障时，可以拆库而不改变 RPC 与状态模型。底层数据库接口仍复用 VS Code；共享数据库、record key、revision 与 mutation 协议均为 Vibe 新增。

## 写入协议

Server 保留三个 command：

- `initialize`：记录不存在时原子创建；
- `read`：读取当前 durable snapshot；
- `mutate`：串行应用 catalog/layout/editor mutation。

每次 `mutate` 必须先成功写入 SQLite，再推进 confirmed revision 并返回。远端不广播 committed event；其他页面在刷新、重新打开或 Remote Agent 重连后执行 `read`。

## 失败与 LWW

Logical Workspace SQLite 使用严格打开策略。数据库目录、文件或 schema 无法打开时，Server 返回终止性的 `storageUnavailable`；浏览器停止重试并提示用户。该路径不得删除或替换原数据库、恢复 `.backup`、创建空库或回退 `:memory:`。修复或恢复数据库以及何时 reload 均由用户决定。

定期一致性备份与 30 天保留策略由 [#10](https://github.com/ActivePeter/vibe-vscode/issues/10) 在独立 PR 实现；备份存在也不得改变上述显式恢复边界。

每个 layout/editor view-state mutation 只发送一次。

如果 response 丢失，客户端无法判断 Server 是否已提交，因此：

```text
丢弃该 pending mutation
→ read Server truth
→ 用读取结果重建页面 projection
```

禁止自动重放结果未知的旧 mutation。这样 A 的旧写不会在 B 的更新之后再次执行，也不需要 operation ID 或服务端去重表。代价是写入可能在传输失败时丢失；layout/editor 等视图状态允许这一取舍。

`createWorkspace` 不属于可丢弃的覆盖型视图写。客户端不 optimistic 发布新 UUID；response 丢失时先 `read`：snapshot 已包含该 UUID 就完成创建，否则才重试同一个 additive、idempotent create。调用方只能在创建 Promise 完成后激活它，因此 Terminal 等 durable resource 不会获得不可达 owner。

同一字段的多个已到达写入按 Server 到达顺序生效，即 Last Write Wins。

## Terminal 边界

Terminal 归属不经过 Logical Workspace mutation：

1. Terminal 创建开始时捕获 `logicalWorkspaceId`；
2. `logicalWorkspaceId` 与 `logicalTerminalId` 写入 Shell launch config；
3. PTY host 将两者随 persistent process 保存并在 attach target 中返回；
4. Terminal Adapter 根据实例元数据执行 foreground/background projection；
5. 老进程缺少 `logicalWorkspaceId` 时，使用旧 `terminalIds` 查找一次 owner，并把结果写回 PTY metadata。

Terminal 关闭或 detach 不再修改 Workspace 远端视图状态。

## 关键验收

1. SQLite update 失败后 confirmed revision 不推进；关闭并重开只能读到成功落盘的状态。
2. A mutation 已提交但 response 丢失，B 随后更新同一字段；A 不重放，Server 最终保持 B。
3. Workspace create 未提交时 identity 不可激活；已提交但 response 丢失时 read 确认同一 UUID且不重复创建。
4. 另一页面在收到刷新前保持旧值，显式 refresh 后读取最新 Server 状态。
5. 新建 Terminal 的 `logicalWorkspaceId` 在异步 profile 创建期间不随 active Workspace 改变。
6. Persistent Terminal 重连后从 PTY metadata 恢复 owner；旧 `terminalIds` 可迁移并写回 process metadata。
