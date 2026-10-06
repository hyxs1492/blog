---
title: 'Unity DOTS —— SystemBase与ISystem'
description: '写第一个 DOTS 系统前必须先想清楚的两件事：系统类型选 ISystem 还是 SystemBase，迭代方式选惯用 foreach 还是 Job——附逐条判据。'
pubDate: '2026-01-15'
category: 'Unity DOTS'
tags: ['Unity', 'DOTS', 'ISystem', 'SystemBase', 'Burst', 'SystemAPI']
---

上一篇我们把数据安排明白了：实体按 archetype 分家，住在 16 KiB 的 chunk 里，每个组件是一列连续数组。但数据不会自己动——**谁来读写这些列、按什么顺序、用几个线程**，就是系统（System）要回答的问题。这篇的目标是让你在写下第一行系统代码前，就能说清"我为什么选这个写法"。

## 速览

> - 写一个系统要做**两个互相独立的决定**：**系统类型**（`ISystem` 还是 `SystemBase`）和**迭代方式**（惯用 `foreach`、`IJobEntity`、`IJobChunk`、`IJob`）。两者可以任意组合，别混为一谈。
> - **默认选 `ISystem`**：它是非托管 struct，能被 Burst 编译、零 GC；`SystemBase` 是托管 class，只在"真的需要存 `List`/`Dictionary`/`object`"或"需要继承"时才用。
> - **迭代方式看你的工作粒度**：每个实体做一次 → 惯用 `foreach` 或 `IJobEntity`；每个 chunk 做一次 → `IJobChunk`；跟实体完全无关的一整批计算 → `IJob`。
> - **`SystemAPI.Query` 的 `foreach` 单线程、不能 Burst**，是"写得快"的选择；`IJobEntity` 能多线程 + Burst，是"跑得快"的选择。原型阶段用前者，定型后用后者。
> - 系统的生命周期是 `OnCreate` → `OnStartRunning` → 每帧 `OnUpdate` → `OnStopRunning` → `OnDestroy`。查询为空时 `OnUpdate` 仍会被调用，所以要判空或依赖 `OnStartRunning` 切状态。

## 1. 系统到底是什么

从最朴素的问题出发：你要让所有带 `Velocity` 的实体每帧移动。面向对象的第一反应是"在 `Update()` 里遍历所有对象"：

```csharp
foreach (var obj in allMovableObjects)      // 传统思路
    obj.position += obj.velocity * deltaTime;
```

DOTS 把它拆成两个概念：**数据**（`Position` / `Velocity` 这些组件，躺在 chunk 的列里）和**逻辑**（一个"系统"——它声明"我要读 `Velocity`、要写 `Position`"，然后 ECS 把匹配的数据喂给它）。

系统的本质就是**一个被 World 按固定顺序调用的回调**。不需要手动注册、不需要 `FindObjectsOfType`，只要定义一个 `partial struct` 或 `partial class`，它就自动出现在 World 里：

```csharp
public struct Position : IComponentData { public float x, y, z; }
public struct Velocity : IComponentData { public float x, y, z; }
```

## 2. 决定一：系统类型选 ISystem 还是 SystemBase

这是新手最容易纠结错的地方。先给结论，再讲原因。

```csharp
// ISystem：非托管 struct（值类型），所有回调都带 ref SystemState
public partial struct MoveSystem : ISystem
{
    public void OnCreate(ref SystemState state) { }
    public void OnUpdate(ref SystemState state) { /* ... */ }
    public void OnDestroy(ref SystemState state) { }
}

// SystemBase：托管 class（引用类型），直接 override 无参的 OnUpdate
public partial class MoveSystem : SystemBase
{
    protected override void OnUpdate() { /* ... */ }
}
```

`ISystem` 的方法签名多一个 `ref SystemState state` 参数，因为它是 struct，**自己身上没有地方存运行期数据**，需要一个外部的 `SystemState`（系统状态）来持有查询、组件句柄等状态。

这个"没地方存东西"既是限制也是最大优点：

- **限制**：不能在 `ISystem` 里直接写 `private List<Entity> cache;`——要能被 Burst 编译就不能含托管引用。需要长期保存这类数据，或需要继承（struct 不能继承类）时，才用 `SystemBase`。
- **优点**：整个系统状态活在**非托管内存**里，Burst 能把 `OnCreate` / `OnUpdate` / `OnDestroy` 全部编译成高度优化的原生代码，**一次 GC 分配都不产生**。代价是 `SystemBase` 的 `OnUpdate` 永远**无法 Burst**。

> 折中办法：只是偶尔需要托管数据时，可以让 `ISystem` 通过 `SystemAPI.ManagedAPI` 或 `World.GetExistingSystemManaged<T>()` 去拿托管系统的数据，而不是把整个系统降级成 `SystemBase`。

### 官方兼容性对照表

| 能力 | `ISystem` | `SystemBase` |
| --- | --- | --- |
| `OnCreate` / `OnUpdate` / `OnDestroy` 可 Burst | ✅ | ❌ |
| 使用非托管内存 / 产生 GC 分配 | ✅ / ❌ | ❌ / ✅ |
| 系统类型里**直接存托管字段** | ❌ | ✅ |
| 惯用 `foreach` + `SystemAPI.Query` | ✅ | ✅ |
| `Entities.ForEach` / `Job.WithCode` | ❌ | ✅ |
| `IJobEntity` / `IJobChunk` | ✅ | ✅ |
| 支持继承 | ❌ | ✅ |
| `OnStartRunning` / `OnStopRunning` | 需实现 `ISystemStartStop` | 直接 `override` |

### 为什么默认应该选 ISystem

同一件事——"每帧把 `Position` 按 `Velocity` 推进"——两种写法只差一个方法签名：

```csharp
// A：ISystem，foreach 体可被 Burst 编译成 SIMD 指令
[BurstCompile] public partial struct MoveSystem : ISystem
{
    [BurstCompile] public void OnUpdate(ref SystemState state)
    {
        float dt = SystemAPI.Time.DeltaTime;
        foreach (var (pos, vel) in SystemAPI.Query<RefRW<Position>, RefRO<Velocity>>())
            Move(ref pos.ValueRW, in vel.ValueRO, dt);
    }
}

// B：SystemBase，逻辑一样，但 OnUpdate 无法 Burst
public partial class MoveSystem : SystemBase
{
    protected override void OnUpdate()
    {
        float dt = SystemAPI.Time.DeltaTime;
        foreach (var (pos, vel) in SystemAPI.Query<RefRW<Position>, RefRO<Velocity>>())
            Move(ref pos.ValueRW, in vel.ValueRO, dt);
    }
}
```

B 就是官方那句"一般来说应优先用 `ISystem`"的全部理由——同样的代码，一个能编译成原生 SIMD，一个不能。

### ISystem 怎么弥补"不能存托管字段"

答案：**把状态存成非托管字段或组件**。

```csharp
public partial struct SpawnSystem : ISystem
{
    private float timer;        // 非托管字段随便存，它们是值类型
    private int   spawnedCount;

    [BurstCompile]
    public void OnCreate(ref SystemState state)
    {
        state.RequireForUpdate<SpawnConfig>();   // 没有这个组件时，系统根本不会被调用
    }

    [BurstCompile]
    public void OnUpdate(ref SystemState state)
    {
        timer += SystemAPI.Time.DeltaTime;
        if (timer < 1f) return;
        timer = 0f;
        spawnedCount++;
        // ... 生成实体
    }
}
```

`state.RequireForUpdate<T>()` 很实用：它让系统在"查询为空"时**完全不执行**，省掉自己写 `if (query.IsEmpty) return;`。想让系统再多实现 `ISystemStartStop`（系统启停接口），就能拿到 `OnStartRunning`（查询从空变非空时一次）与 `OnStopRunning`（查询从非空变回空时一次）这两个回调。

## 3. 决定二：迭代方式

系统类型定了之后，**数据怎么被批量喂给你**是另一个独立问题。三个指标会随选择改变：并行粒度、样板代码量、能不能 Burst。

```text
我要做的事是……
├─ 每个实体各做一次？
│   ├─ 想写得最简单、单线程就够    → 惯用 foreach（SystemAPI.Query）
│   └─ 想多线程 + Burst            → IJobEntity
├─ 每个 chunk 一次（不遍历，或要遍历多次）？ → IJobChunk
└─ 跟实体无关的一整批计算（数组 / 树 / 统计）？ → IJob
```

### 3.1 惯用 foreach：写得最快

```csharp
foreach (var (pos, vel) in SystemAPI.Query<RefRW<Position>, RefRO<Velocity>>())
{
    pos.ValueRW.x += vel.ValueRO.x * SystemAPI.Time.DeltaTime;
    pos.ValueRW.y += vel.ValueRO.y * SystemAPI.Time.DeltaTime;
    pos.ValueRW.z += vel.ValueRO.z * SystemAPI.Time.DeltaTime;
}
```

- **`RefRW<T>` / `RefRO<T>`**：读写引用 / 只读引用，用 `ValueRW` 写、`ValueRO` 读。用 `RefRO` 明确表达"我不改它"，ECS 才敢放行并行。
- **`SystemAPI.Query<T...>()` 的类型列表同时就是查询条件**：写了 `Position` 就表示只匹配带 `Position` 的实体。
- 附加过滤用 `.WithAll<T>()` / `.WithNone<T>()` / `.WithAny<T>()` / `.WithSharedComponentFilter(v)` 链式调用。

代价：**这个 `foreach` 单线程执行，且整段不能 Burst 编译。** 它适合原型验证和每帧只处理几十个实体的场合。

### 3.2 IJobEntity：默认的"性能版"

`IJobEntity`（实体作业接口）让你只写"每个实体做一次"的逻辑，由代码生成器展开成 chunk 遍历：

```csharp
[BurstCompile]
public partial struct MoveJob : IJobEntity
{
    public float DeltaTime;

    // 方法名必须是 Execute；参数列表就是查询条件
    void Execute(ref Position position, in Velocity velocity)
    {
        position.x += velocity.x * DeltaTime;
        position.y += velocity.y * DeltaTime;
        position.z += velocity.z * DeltaTime;
    }
}

[BurstCompile]
public partial struct MoveSystem : ISystem
{
    [BurstCompile]
    public void OnUpdate(ref SystemState state)
    {
        new MoveJob { DeltaTime = SystemAPI.Time.DeltaTime }.ScheduleParallel();
    }
}
```

几个必须知道的点：

1. **`Execute` 的参数列表决定查询**：`ref Position` 表示"要有它且我会写"，`in Velocity` 表示"要有它且只读"，不需要额外写查询；
2. **一个 job 只能有一个 `Execute` 签名**，想要两套查询就写两个 job；
3. **`ScheduleParallel()` 按 chunk 分发**，并行度取决于 chunk 数量而不是实体数量；
4. `[BurstCompile]` 要同时标在 job 和系统的 `OnUpdate` 上，job 的字段必须是非托管的。

补充过滤用特性写法：`[WithAll(typeof(MoveEnabled))]`、`[WithNone(typeof(DeadTag))]`。

**`IJobEntity` 本质上就是生成了一个 `IJobChunk`**，吞吐同量级。区别只在控制粒度：它把"怎么遍历 chunk 内实体"交给生成器了。想要下面这两件事时才需要手写 `IJobChunk`：**根本不遍历 chunk 内实体**（比如只为每块统计一个数字）、**要对同一批实体遍历多次或按非常规顺序遍历**。

### 3.3 IJobEntityChunkBeginEnd：给 IJobEntity 补两把钩子

想既享受自动遍历、又需要在**每个 chunk 开始/结束**做点事（跳过整块以免触发下游 change filter、每 chunk 复用一个 scratch 容器、chunk 级只读数据只读一次），就再实现 `IJobEntityChunkBeginEnd`（实体作业块前后钩子接口）。它只要求两个方法：

```csharp
public bool OnChunkBegin(in ArchetypeChunk chunk, int unfilteredChunkIndex,
                         bool useEnabledMask, in v128 chunkEnabledMask);   // 返回 false → 整块跳过

public void OnChunkEnd(in ArchetypeChunk chunk, int unfilteredChunkIndex,
                       bool useEnabledMask, in v128 chunkEnabledMask, bool chunkWasExecuted);
```

`OnChunkEnd` **即使整块被跳过也会被调用**，所以要靠 `chunkWasExecuted` 判断这块到底跑没跑。

### 3.4 IJobChunk：完全控制

需要自己声明 `ComponentTypeHandle`——也就是下面这些句柄字段，再用与 `IJobEntity` 相同的 `Execute` 签名（`chunk` / `unfilteredChunkIndex` / `useEnabledMask` / `chunkEnabledMask`）手写遍历：

```csharp
[BurstCompile]
public partial struct MoveChunkJob : IJobChunk
{
    public float DeltaTime;
    public ComponentTypeHandle<Position> PositionHandle;
    [ReadOnly] public ComponentTypeHandle<Velocity> VelocityHandle;

    public void Execute(in ArchetypeChunk chunk, int unfilteredChunkIndex,
                        bool useEnabledMask, in v128 chunkEnabledMask)
    {
        var positions  = chunk.GetNativeArray(ref PositionHandle);
        var velocities = chunk.GetNativeArray(ref VelocityHandle);
        for (int i = 0; i < chunk.Count; i++)
        {
            var v = velocities[i];
            var p = positions[i];
            p.x += v.x * DeltaTime; p.y += v.y * DeltaTime; p.z += v.z * DeltaTime;
            positions[i] = p;
        }
    }
}
```

调度时显式取句柄填进 job，再 `job.ScheduleParallel(query, state.Dependency)` 并把返回值赋回 `state.Dependency`。这些样板代码只在上面那两类场合才值得付；其它情况优先用 `IJobEntity`——生成器以后的优化你能自动白拿，手写的 `IJobChunk` 不会。

### 3.5 IJob：当"实体"只是输入

主体是一整批数据（一个 `NativeArray`、一棵空间树、一次全局统计）而实体只是输入之一时，不需要 chunk 遍历，用普通 `IJob` 即可——它的 `Execute()` 没有参数，job 字段就是全部输入输出：

```csharp
[BurstCompile]
public struct SumJob : IJob
{
    [ReadOnly] public NativeArray<float> Values;
    public NativeReference<float> Total;

    public void Execute()
    {
        float sum = 0f;
        for (int i = 0; i < Values.Length; i++) sum += Values[i];
        Total.Value = sum;
    }
}
```

想按数据切片并行用 `IJobParallelFor`；在 Entity 系统里调度就 `state.Dependency = job.Schedule(state.Dependency);`。

## 4. 完整骨架：一个能跑的系统

把上面的选择拼起来，一个典型 DOTS 系统的全貌是：

```csharp
public struct MoveEnabled : IComponentData, IEnableableComponent { }

[BurstCompile] public partial struct MoveJob : IJobEntity
{
    public float DeltaTime;
    void Execute(ref Position position, in Velocity velocity)
    {
        position.x += velocity.x * DeltaTime;
        position.y += velocity.y * DeltaTime;
        position.z += velocity.z * DeltaTime;
    }
}

[BurstCompile]
[WithAll(typeof(MoveEnabled))]     // 只处理开关为 true 的实体
public partial struct MoveSystem : ISystem
{
    [BurstCompile]
    public void OnCreate(ref SystemState state)
        => state.RequireForUpdate<MoveEnabled>();      // 场上没有可移动实体时，系统不执行

    [BurstCompile]
    public void OnUpdate(ref SystemState state)
        => new MoveJob { DeltaTime = SystemAPI.Time.DeltaTime }.ScheduleParallel();

    [BurstCompile]
    public void OnDestroy(ref SystemState state) { }
}
```

这里就是"开关"的用法：实体只要把 `MoveEnabled` 置为 `false`，就自动从这次查询里消失，**不需要增删组件、不需要搬 chunk**（回顾上一篇的代价表）。

## 5. 生命周期与顺序

World 的调用顺序是固定的：

```text
OnCreate → OnStartRunning → OnUpdate（每帧） → OnStopRunning → OnDestroy
创建时一次   查询从空变非空    只要查询非空      查询变回空       World 销毁
```

三个容易踩的点：

1. **`OnUpdate` 在查询为空时仍会被调用**（`SystemBase` 也一样）。直接假设"一定有实体"会拿到空循环甚至除零，要么用 `state.RequireForUpdate<T>()`，要么自己判空。
2. **系统执行顺序默认不确定**。A 写的数据 B 要读，就得标注 `[UpdateBefore(typeof(BSystem))]` / `[UpdateAfter(typeof(ASystem))]`，或用 `[UpdateInGroup(typeof(SomeSystemGroup))]` 放进同一个系统组管理。
3. **结构性变更的位置很重要**。在 `OnUpdate` 里增删组件会让 `EntityManager` 产生同步点，打断 Job 流水线；批量生成/销毁请用 `EntityCommandBuffer`（实体命令缓冲区）。

## 6. 小结

| 你的处境 | 推荐写法 | 代价 |
| --- | --- | --- |
| 第一次验证玩法 | `ISystem` + 惯用 `foreach` | 单线程、不 Burst，但几行就能跑 |
| 定型后追求性能 | `ISystem` + `IJobEntity` | 需要把逻辑拆成 job 的 `Execute` |
| 需要 chunk 级准备/收尾 | `IJobEntity` + `IJobEntityChunkBeginEnd` | 多两个回调，注意 `chunkWasExecuted` |
| 每 chunk 统计 / 多次遍历 / 跟实体无关的批处理 | `IJobChunk` / `IJob` | 样板代码最多，但控制最细 |
| 必须在系统里存托管数据 | `SystemBase` | 有 GC，`OnUpdate` 不能 Burst |

一句话收束：**先按"有没有托管数据 / 要不要继承"定系统类型（默认 `ISystem`），再按"工作粒度"定迭代方式。** 下一篇我们把镜头拉近到**作业（Job）本身**：同样是遍历数据，`IJobEntity` / `IJobChunk` 的粒度差别会在什么场合真正咬人，以及 enableable 掩码该怎么正确读写。

## 参考资料

- [Systems comparison](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/systems-comparison.html)
- [ISystem overview](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/systems-isystem.html)
- [SystemBase overview](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/systems-systembase.html)
- [System lifecycle](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/systems-lifecycle.html)
