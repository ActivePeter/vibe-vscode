# 远端持久化状态：最小修改方案

> 目标：修复 Logical Workspace 在 SQLite 写入失败后仍可能被误认为已提交的问题。
>
> 总体协议：[Logical Workspace 远程权威状态](./remote_logical_workspace_state.md)

## 结论

不新增公共接口，不修改 VS Code 通用 Storage。

只修改 Vibe 的 `RemoteLogicalWorkspaceStateStorage`：绕过 cache-first 的 `Storage`，直接使用 `IStorageDatabase`，并且只在 SQLite 写入成功后推进内存中的 confirmed state。

| 边界 | 决定 |
| --- | --- |
| 新增公共接口 | 0 |
| 修改 Vibe 类 | `RemoteLogicalWorkspaceStateStorage` |
| 复用 VS Code 能力 | `IStorageDatabase`、`SQLiteStorageDatabase`、`Sequencer` |
| 保持不变 | RPC、客户端 optimistic queue、reducer、通用 `Storage`、`IStorageService` |

## 为什么要改

当前链路：

```text
RemoteLogicalWorkspaceStateStorage → Storage cache → SQLite
```

`Storage.set()` 先更新 cache。SQLite 随后写入失败时，cache 不会回滚：本次请求虽然报错，重试却可能从 cache 读到未落盘的新 revision，并错误地返回成功。

修改后：

```text
RemoteLogicalWorkspaceStateStorage → IStorageDatabase → SQLite
                                  ↘ confirmedItems（仅记录成功写入）
```

## 正确性规则

写入顺序必须是：

```text
await database.updateItems(...)
→ 更新 confirmedItems
→ 发布 committed event
→ RPC 返回成功
```

如果数据库写入失败：

- `confirmedItems` 保持旧 revision；
- 不发布 event；
- RPC 不返回成功；
- 客户端重试时再次写 SQLite。

关闭数据库时，recovery 只能使用 `confirmedItems`。

## 实现范围

在 [`RemoteLogicalWorkspaceStateStorage`](../../src/vs/server/node/logicalWorkspaceStateChannel.ts) 中：

1. 将 `Storage` 替换为 `IStorageDatabase`；
2. 初始化时用 `getItems()` 填充 `confirmedItems`；
3. 读取只访问 `confirmedItems`；
4. 写入等待 `updateItems()` 成功后再更新 `confirmedItems`；
5. 增加一个 database factory，供测试注入一次写入失败。

## 验收

唯一关键失败测试：

```text
数据库中是 revision 1
→ 写 revision 2 失败
→ read 仍返回 revision 1，且没有 revision 2 event
→ 重试成功
→ 关闭并用新实例重新打开数据库
→ read 返回 revision 2
```

## 不在本次范围

“数据库已提交，但 RPC 响应丢失”是另一个 exactly-once 问题，需要稳定的 `operationId` 和服务端持久化去重；不与本次 durable write 修复混在一起。
