---
title: 'Unity DOTS —— IJobEntity、IJobChunk'
description: 'IJobEntity、IJobChunk 基本概念'
pubDate: '2026-01-15'
---

## 速览
关键不是"性能"（`IJobEntity` 本身就是生成 `IJobChunk`，吞吐同量级），而是**你的工作以什么为粒度**：
```
我要做的事是……
├─ 每个实体各做一次？
│   └─ IJobEntity（默认）
│       └─ 还需要"每 chunk 一次"的准备/收尾/跳过？ → 再加 IJobEntityChunkBeginEnd
├─ 每个 chunk 一次，且不遍历 / 多次遍历 chunk 内实体？
│   └─ IJobChunk
├─ 要批量读写 enableable 掩码（剔除 / 激活 / 有效性重算）？
│   └─ IJobChunk + chunk.GetEnabledMask<T>()
└─ 操作对象是一整批数据（数组 / 树 / 全局统计），"实体"只是输入？
    └─ IJob（不需要 chunk 遍历）
```

## 1. 对比

| 接口 | 粒度 | 特点 |
|---|---|---|
| `IJobEntity` | 实体 | 生成器负责组件映射、chunk 边界、enableable 过滤；**一个 job 只有一个 `Execute` 签名**决定查询 |
| `IJobEntityChunkBeginEnd` | 实体 + chunk 边界钩子 | 给 `IJobEntity` 补 `OnChunkBegin`（返回 `false` 可**跳过整块**）与 `OnChunkEnd`（即使被跳过也会调用，用 `chunkWasExecuted` 判断）。典型用途：跳过 chunk 避免触发下游 change filter、每 chunk/每线程复用 scratch 容器、chunk 级数据只读一次、在 Begin/Execute/End 间传递数据 |
| `IJobChunk` | chunk | 完全控制；需自己声明 `ComponentTypeHandle` 并处理 `useEnabledMask` |

**`IJobChunk.Execute` 的四个参数**
```csharp
void Execute(in ArchetypeChunk chunk, int unfilteredChunkIndex,
             bool useEnabledMask, in v128 chunkEnabledMask)
```

| 参数 | 说明 |
|---|---|
| `chunk` | 当前 chunk：可取组件数组、`Count` / `Capacity`、shared component 值 |
| `unfilteredChunkIndex` | 该 chunk 在查询匹配到的全部 chunk 中的索引，**不保证 0 连续**（有过滤时会跳号） |
| `useEnabledMask` | `true` 时掩码有效；`false` 表示整块都匹配 |
| `chunkEnabledMask` | 位 N 置位 = 实体 N 匹配；**是查询内所有 enableable 组件掩码的合成结果** |

## 2. 处理 enableable 掩码：先分清你是写入者还是消费者
```csharp
// 消费者（只处理启用的实体）：按掩码过滤
if (!useEnabledMask)
{
    for (int i = 0; i < chunk.Count; i++) { /* 全块实体都匹配 */ }
    return;
}
var e = new ChunkEntityEnumerator(useEnabledMask, chunkEnabledMask, chunk.Count);
while (e.NextEntityIndex(out int i)) { /* 只处理启用的实体 */ }
```
```csharp
// 写入者（剔除 / 激活 / 有效性重算）：必须全量遍历 chunk.Count
var elements = chunk.GetNativeArray(ref handle);
var mask     = chunk.GetEnabledMask(ref handle);
for (int i = 0; i < chunk.Count; i++)      // ← 不能用掩码过滤！
    mask[i] = IsVisible(elements[i].Position);
```
**为什么写入者必须全量遍历**：一旦某个实体被判定为不可见/失效，如果后续重算时按掩码过滤，它就**永远不会被再次评估**，永久停留在这个状态。写入者必须评估 chunk 内所有实体。
其它注意点：
- `chunk.Has<T>()` 判断的是"**结构上是否存在**"，不是"是否启用"；判断启用要用 `chunk.IsComponentEnabled<T>(i)` 或 `GetEnabledMask<T>()`。
- 漏处理 `useEnabledMask` 会把**已禁用**的实体当成启用的处理——**不报错**，只表现为行为异常。
- 需要"绕过启用状态、处理全部实体"的查询，用 `EntityQueryOptions.IgnoreComponentEnabledState`。
---