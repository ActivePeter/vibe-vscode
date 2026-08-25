# 远端持久化：最小修改方案

> 目标：Server 只确认已经写入 SQLite 的 Logical Workspace 视图状态。
>
> 总体协议：[Logical Workspace 远端视图状态](./remote_logical_workspace_state.md)

## 修改边界

| 边界 | 决定 |
| --- | --- |
| 新增公共接口 | 0 |
| 修改存储类 | `RemoteLogicalWorkspaceStateStorage` |
| 复用 VS Code | `IStorageDatabase`、`SQLiteStorageDatabase`、`Sequencer` |
| 保持不变 | 通用 `Storage`、`IStorageService` |

当前 `Storage.set()` 先更新 cache；SQLite rejection 不会回滚 cache，重试可能把未落盘 revision 误认为成功。

修复后直接使用数据库：

```text
RemoteLogicalWorkspaceStateStorage → IStorageDatabase → SQLite
                                  ↘ confirmedItems
```

## 唯一正确顺序

```text
await database.updateItems(...)
→ 更新 confirmedItems
→ RPC 返回成功
```

数据库失败时：

- `confirmedItems` 保持旧 revision；
- RPC 不返回成功；
- recovery 只使用 confirmed state。

## 客户端规则

Workspace catalog、layout 和 editor working set 是可覆盖的视图状态。mutation response 丢失时，客户端丢弃该 mutation 并重新 `read`，不自动重放，因此不需要 `operationId`。

Terminal ownership 不属于这套状态；它随 persistent Terminal process 保存。

## 验收

```text
数据库中是 revision 1
→ 写 revision 2 失败
→ read 仍为 revision 1
→ 后续写入成功
→ 关闭并重新打开数据库
→ 读到成功写入的 revision 2
```

另需覆盖：mutation 已提交但 response 丢失，另一页面写入 revision 3；原页面只 refresh、不重放，最终保持 revision 3。
