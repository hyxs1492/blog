---
title: 'Unity DOTS —— IJobEntity、IJobChunk'
description: '同样是在遍历实体数据，IJobEntity 和 IJobChunk 到底差在哪：从"你的工作以什么为粒度"出发，讲清 IJobChunk.Execute 四个参数和 enableable 掩码的正确读写方式。'
pubDate: '2026-01-15'
category: 'Unity DOTS'
tags: ['Unity', 'DOTS', 'IJobEntity', 'IJobChunk', 'Job', 'Burst']
---

上一篇讲了"系统类型"和"迭代方式"是两个独立决定。这一篇把第二个决定拆开细看。

很多人挑作业类型时的第一反应是问"哪个更快"。这个问题问错了——**`IJobEntity` 内部本来就是生成一个 `IJobChunk`，吞吐是同量级的**。真正该问的是：

> **我的工作，以什么为粒度？**

是每个实体一次？每个 chunk 一次？还是跟实体根本无关的一整批数据？粒度对了，接口自然就选对了。

## 速览

> - **粒度决定接口**：每实体一次 → `IJobEntity`；每 chunk 一次、或不遍历/多次遍历 → `IJobChunk`；跟实体无关的整批计算 → `IJob`。
> - **给 `IJobEntity` 加 `IJobEntityChunkBeginEnd`** 就能免费拿到 chunk 级的前后钩子：`OnChunkBegin` 返回 `false` 可以整块跳过，`OnChunkEnd` 一定会被调用。
> - **`IJobChunk.Execute` 的四个参数**分别是：当前 chunk、`unfilteredChunkIndex`（不保证从 0 连续）、`useEnabledMask`（掩码是否有效）、`chunkEnabledMask`（**查询内所有 enableable 掩码的合成结果**）。
> - **先分清你是"掩码消费者"还是"掩码写入者"**：消费者按掩码过滤，只处理启用的实体；**写入者必须全量遍历 `chunk.Count`**，否则被关掉的实体永远拿不到重新评估的机会。
> - **漏处理 `useEnabledMask` 不会报错**，只会把已禁用的实体当成启用的来算——症状是"行为不对"，不是"崩了"。

## 1. 先问粒度，再选接口

把选择画成一棵树：

```text
我要做的事是……
│
├─ 每个实体各做一次？
│   └─ IJobEntity（默认选择）
│       └─ 还需要"每 chunk 一次"的准备 / 收尾 / 跳过？
│             └─ 再加 IJobEntityChunkBeginEnd
│
├─ 每个 chunk 做一次，不遍历实体（比如统计）？
│   └─ IJobChunk
│
├─ 要多次遍历 chunk 内实体，或按非常规顺序遍历？
│   └─ IJobChunk
│
├─ 要批量读写 enableable 掩码（剔除 / 激活 / 有效性重算）？
│   └─ IJobChunk + chunk.GetEnabledMask<T>()
│
└─ 操作对象是一整批数据（数组 / 树 / 全局统计），"实体"只是输入？
    └─ IJob / IJobParallelFor
```

注意第三条：**只要你需要"绕开自动遍历"这个行为，就该考虑 `IJobChunk`**。不是因为手写更快，而是因为 `IJobEntity` 把遍历方式写死了。

## 2. 四种粒度对照

| 接口 | 粒度 | 特点 |
| --- | --- | --- |
| `IJobEntity` | 实体 | 生成器负责组件映射、chunk 边界、enableable 过滤；**一个 job 只有一个 `Execute` 签名**，这个签名就决定了查询 |
| `IJobEntityChunkBeginEnd` | 实体 + chunk 边界钩子 | 给 `IJobEntity` 补上 `OnChunkBegin`（返回 `false` 可**跳过整块**）与 `OnChunkEnd`（即使被跳过也会调用，用 `chunkWasExecuted` 判断） |
| `IJobChunk` | chunk | 完全控制；需自己声明 `ComponentTypeHandle` 并处理 `useEnabledMask` |
| `IJob` | 无（一整批） | 不涉及 chunk 遍历；并行策略自己定 |

先用最直白的方式看三者的代码骨架差异：

```csharp
// 粒度 = 实体
public partial struct A : IJobEntity
{
    void Execute(ref Position p, in Velocity v) { /* 一个实体一次 */ }
}

// 粒度 = chunk
public partial struct B : IJobChunk
{
    public ComponentTypeHandle<Position> PositionHandle;

    public void Execute(in ArchetypeChunk chunk, int unfilteredChunkIndex,
                        bool useEnabledMask, in v128 chunkEnabledMask)
    {
        var positions = chunk.GetNativeArray(ref PositionHandle);   // 一个 chunk 一次
    }
}

// 粒度 = 一整批数据
public struct C : IJob
{
    public NativeArray<float> Values;
    public void Execute() { /* 与实体无关 */ }
}
```

## 3. 拆开 IJobChunk.Execute 的四个参数

这是全篇的核心。四个参数每一个都有坑：

```csharp
void Execute(in ArchetypeChunk chunk, int unfilteredChunkIndex,
             bool useEnabledMask, in v128 chunkEnabledMask)
```

### 3.1 `chunk`：当前这一块

它就是上一篇讲的那个 16 KiB 抽屉。你可以从它身上拿到：

```csharp
chunk.Count                              // 这块里现在有几个实体
chunk.Capacity                           // 这块最多能装几个
chunk.GetNativeArray(ref handle)         // 某个组件的数据列
chunk.GetSharedComponent<T>()            // 这块的 shared component 值（每块一个）
chunk.Has<T>()                           // 结构上是否包含该组件
chunk.IsComponentEnabled<T>(i)           // 第 i 个实体的该组件是否启用
chunk.GetEnabledMask(ref handle)         // 该组件类型专属的掩码（可读可写）
```

⚠️ **`chunk.Has<T>()` 判断的是"结构上存不存在"，不是"启不启用"。** 一个被 `SetComponentEnabled(false)` 关掉的组件，`Has<T>()` 依然返回 `true`。判断启用状态必须用 `IsComponentEnabled<T>(i)` 或 `GetEnabledMask<T>()`。

### 3.2 `unfilteredChunkIndex`：一个不连续的编号

名字里的 "unfiltered" 是关键词：它是**该 chunk 在"查询匹配到的全部 chunk"中的下标**。

天真做法为什么不行：很多人想"我按 chunk 下标往一个 `NativeArray` 里写结果，第 N 块写第 N 位"。但**这个索引不保证从 0 连续**——当查询带有过滤条件（比如 shared component filter、或者某些 chunk 因为 enableable 全部禁用而被排除）时，索引会**跳号**。

```text
查询实际匹配到的 chunk：   [chunk A] [chunk D] [chunk G]
传给 Execute 的索引：          0         3         6      ← 跳号！
```

所以：

- **不要**拿它当数组下标去索引固定长度的容器（会越界或错位）；
- **不要**拿它当业务 ID（chunk 每次结构性变更都可能重新组织）；
- 它唯一的正经用途是：**在并行 job 里需要一个"每 chunk 唯一且稳定"的小整数**，例如用来索引 `NativeHashMap` 的键、或者写日志区分不同块。

真需要"紧凑下标"，自己在 job 外部维护一个计数器。

### 3.3 `useEnabledMask`：掩码到底有没有用

- 返回 `true`：下面的 `chunkEnabledMask` **有效**，里面有实体被禁用，你需要按它过滤。
- 返回 `false`：**整块实体全部匹配**，直接当成"整块都启用"处理即可（这也是最常见的快速路径）。

⚠️ **漏处理这个参数不会报错**。你不会收到异常、不会看到日志，只会把已禁用的实体当成启用来算——表现为"数值慢慢飘了""某个单位明明关掉了还在动"这类**行为异常**。排查这类问题时，第一个该检查的就是"我有没有读 `useEnabledMask`"。

### 3.4 `chunkEnabledMask`：合成掩码，不是某一个人的掩码

这是最容易误解的一个。**`chunkEnabledMask` 是查询里所有 enableable 组件掩码合并后的结果**——它只回答一个问题：

> "这个实体是不是**所有相关开关都打开了**？"

它**不告诉你哪一个组件被关了**。位 N 置位只表示"实体 N 通过了全部启用检查"。

```text
查询：<MoveEnabled, Visible, Position>
实体 2：MoveEnabled=开, Visible=关  →  chunkEnabledMask 的第 2 位 = 0
实体 5：MoveEnabled=开, Visible=开  →  chunkEnabledMask 的第 5 位 = 1
```

如果你需要"单独问某个组件"：

```csharp
// 逐实体问单个组件
bool on = chunk.IsComponentEnabled<MoveEnabled>(i);

// 拿到该类型专属的掩码（可读可写）
var moveHandle = state.GetComponentTypeHandle<MoveEnabled>();
EnabledMask moveMask = chunk.GetEnabledMask(ref moveHandle);
moveMask[i] = false;      // 只改 MoveEnabled，不影响别的开关
```

`EnabledMask` 是一个结构体包装，`[i]` 读写对应实体的那一位。

## 4. 消费者 vs 写入者：两种完全不同的写法

处理 enableable 掩码之前，先问自己一句话：

> **我是在"读别人的开关"，还是在"决定别人的开关"？**

### 4.1 消费者：只处理启用的实体

消费者是"我只想处理现在生效的那些实体"，所以按掩码过滤：

```csharp
public void Execute(in ArchetypeChunk chunk, int unfilteredChunkIndex,
                    bool useEnabledMask, in v128 chunkEnabledMask)
{
    var positions = chunk.GetNativeArray(ref PositionHandle);

    // 快速路径：整块都启用，直接全量循环
    if (!useEnabledMask)
    {
        for (int i = 0; i < chunk.Count; i++)
            Step(ref positions, i);
        return;
    }

    // 慢路径：逐位检查，只处理启用的
    var e = new ChunkEntityEnumerator(useEnabledMask, chunkEnabledMask, chunk.Count);
    while (e.NextEntityIndex(out int i))
        Step(ref positions, i);
}
```

`ChunkEntityEnumerator`（块内实体枚举器）帮你把"掩码 + `Count`"摊平成一个个实体下标，比手写位运算可靠。

用 `IJobEntity` 时，这套逻辑由生成器代劳，你通常不用管——**这也正是 `IJobEntity` 的价值所在**。

### 4.2 写入者：必须全量遍历 `chunk.Count`

写入者是"我要重算谁该启用、谁该禁用"的角色。写法只有一个版本：

```csharp
public void Execute(in ArchetypeChunk chunk, int unfilteredChunkIndex,
                    bool useEnabledMask, in v128 chunkEnabledMask)
{
    var positions = chunk.GetNativeArray(ref PositionHandle);
    var mask      = chunk.GetEnabledMask(ref VisibleHandle);

    for (int i = 0; i < chunk.Count; i++)      // ← 不能用掩码过滤！
        mask[i] = IsVisible(positions[i]);
}
```

**为什么写入者绝不能按掩码过滤**——这是本篇最需要想通的一步推导：

```text
假设某实体这一帧被判定为"不可见" → mask[i] = false

如果下一次重算时按掩码过滤（只遍历启用的实体）：
  → 这个实体的位是 0 → 它不在遍历范围内
  → 它永远不会被再次评估
  → 于是它永久停留在"不可见"状态，即使条件早就恢复了
```

**结论：写入者必须评估 chunk 内所有实体，一个都不能跳过。** 这跟"掩码是上一轮的结论"有关——用上一轮的结论去筛本轮要重新计算的输入，逻辑上就是循环依赖。

（顺带一提：这套推理对"剔除/激活/有效性重算"这类系统都成立，是通用工程注意事项，不是某个项目的特例。）

### 4.3 消费者和写入者能合到一起吗

能，但要小心：如果你在同一个 job 里边读边写掩码，**读取必须发生在写入之前**，否则同一块内后面的实体看到的就是被改过的掩码。稳妥做法是拆成两个 job（先算、后消费）并让它们有依赖关系，或者在循环里先把状态收集到临时数组再统一写。

## 5. 其它容易踩的点

**只想处理启用的实体**，`IJobEntity` 的查询默认就会做 enableable 过滤，不用额外配置。**想绕过启用状态、处理全部实体**（比如"给所有实体重置开关"），给查询加：

```csharp
var query = SystemAPI.QueryBuilder()
    .WithAll<Position>()
    .WithOptions(EntityQueryOptions.IgnoreComponentEnabledState)
    .Build();
```

`EntityQueryOptions.IgnoreComponentEnabledState`（忽略组件启用状态）会让查询**不看掩码**，把禁用实体也返回给你。这类查询通常配合 §4.2 的写入者写法。

用 `IJobEntity` 时也可以按块传递参数，注意 `OnChunkBegin` 的 `chunkEnabledMask` 同样是**合成掩码**，语义与 `IJobChunk` 完全一致。

## 6. 小结

| 你的工作粒度 | 接口 | 掩码怎么处理 |
| --- | --- | --- |
| 每个实体一次 | `IJobEntity` | 生成器自动处理，基本不用操心 |
| 每个实体一次 + 需要 chunk 级前后处理 | `IJobEntity` + `IJobEntityChunkBeginEnd` | Begin/End 收到的是合成掩码，`chunkWasExecuted` 判断是否真的跑了 |
| 每个 chunk 一次 / 多次遍历 | `IJobChunk` | 自己处理 `useEnabledMask` |
| 读启用状态（消费者） | `IJobChunk` | `!useEnabledMask` 快速路径；否则用 `ChunkEntityEnumerator` |
| 写启用状态（写入者） | `IJobChunk` | `GetEnabledMask<T>()` + **全量** `for (i < chunk.Count)` |
| 跟实体无关的批处理 | `IJob` / `IJobParallelFor` | 不涉及 |

三句话带走：

1. **先定粒度**（实体 / chunk / 一批数据），接口自然浮现。
2. **四个参数里，`unfilteredChunkIndex` 不是下标、`chunkEnabledMask` 不是单个组件的掩码**。
3. **写入者必须全量遍历**，否则被关掉的实体永远醒不过来。

## 参考资料

- [Iterate over chunks of data with IJobChunk](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/iterating-data-ijobchunk.html)
- [Implementing IJobChunk](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/iterating-data-ijobchunk-implement.html)
- [Iterate over data with IJobEntity](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/iterating-data-ijobentity.html)
- [Enableable components](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/components-enableable.html)
