# Logical Workspace 远端视图状态

> 适用范围：Workspace catalog、Shell layout、editor working set
>
> 不包含：Terminal 进程、Terminal ownership、Agent Session catalog

## 结论

Logical Workspace 保存的是可覆盖的 Workbench 视图状态，不是资源生命周期 authority。

| 状态 | Authority 与持久化 | 可见性与冲突规则 |
| --- | --- | --- |
| Workspace catalog identity（Workspace 列表与身份） | Remote Logical Workspace state service；SQLite 持久化 | durable 确认后才可激活；其他页面刷新/重连后可见 |
| layout、editor working set（工作台视图快照） | Remote Logical Workspace state service；SQLite 持久化 | 当前页面 optimistic；其他页面刷新/重连后可见；Server 到达顺序 LWW |
| `activeWorkspaceId`（当前页面选择） | 当前页面 selection；`sessionStorage` 持久化 | 仅当前页面 |
| Terminal identity 与 ownership（终端身份与归属） | Terminal/PTY process metadata；随 persistent process 持久化 | Terminal 恢复后立即可用 |
| Agent Session catalog（全局会话目录） | Session provider/history；持久化介质由 provider 决定 | 保持 VS Code 全局语义 |

## 状态说明

### Workspace catalog identity（Workspace 列表与身份）

表示一个 Physical Workspace 内有哪些 Logical Workspace，以及每一项的稳定 ID 和名称。它决定某个 Logical Workspace 是否存在、能否被激活，不表示当前页面选中了哪一项。Remote state service 只有在 SQLite 写入成功后才确认新 identity；其他页面需要刷新、重连或重新打开后才能读到更新。

### Layout 与 editor working set（工作台视图快照）

`layout` 保存 Sidebar、Panel、Auxiliary Bar 的显隐、尺寸和 active composite；`editor working set` 保存 editor group 布局、可恢复的 editor inputs、MRU 和 active selection。两者都是可以重新投影的界面快照，不是文件内容、Terminal process 或 Agent Session 本体。

当前页面可以先应用自己的修改，再等待 Server 结果，这就是 optimistic。其他页面不会实时跟随，只在下次读取时看到 Server 已确认的值；多个页面修改同一字段时，最后到达 Server 的写入生效，即 Last Write Wins（LWW）。

### `activeWorkspaceId`（当前页面选择）

表示当前浏览器页面正在使用哪个 Logical Workspace。每个页面独立选择，并用带 Physical Workspace ID 的 `sessionStorage` key 在本页刷新后恢复；它不写入远端 SQLite，也不会让其他页面同步切换。

### Terminal identity 与 ownership（终端身份与归属）

表示“这是哪个 Terminal”以及“它属于哪个 Logical Workspace”，不表示 Terminal 当前是否可见。identity 与 owner 随 persistent PTY process metadata 保存；Terminal 恢复或 attach 后即可重新取得。进程结束后不由 Logical Workspace snapshot 保留，完整规则见 [Logical Workspace Terminal：identity、投影与持久化](./logical_workspace_terminal.md)。

### Agent Session catalog（全局会话目录）

表示 provider/history 能发现的全局 Agent Session 列表，不是某个 Logical Workspace 当前打开的 Session tabs。它的 authority 和持久化介质仍由原有 provider/history 决定；Logical Workspace 切换不会过滤、迁移或删除这些 Session。

表中的 durable 表示 SQLite 写入成功并由 Server 确认；“可见”表示其他页面何时能读取该状态，不是 Sidebar、Terminal 等界面元素是否显示。

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

Terminal process 与 ownership 不经过 Logical Workspace mutation。旧 `terminalIds` 只提供一次迁移输入，Terminal 关闭或 detach 不修改本协议的远端状态。完整创建、PTY 持久化、前后台投影和退出语义见 [Logical Workspace Terminal：identity、投影与持久化](./logical_workspace_terminal.md)。

## 关键验收

1. SQLite update 失败后 confirmed revision 不推进；关闭并重开只能读到成功落盘的状态。
2. A mutation 已提交但 response 丢失，B 随后更新同一字段；A 不重放，Server 最终保持 B。
3. Workspace create 未提交时 identity 不可激活；已提交但 response 丢失时 read 确认同一 UUID且不重复创建。
4. 另一页面在收到刷新前保持旧值，显式 refresh 后读取最新 Server 状态。
