---
title: 'Unity DOTS —— 生命周期技术文档'
description: '用一个问题当主线：一帧里 DOTS 到底按什么顺序发生了什么，为什么是这个顺序。'
pubDate: '2026-01-15'
category: 'Unity DOTS'
tags: ['Unity', 'DOTS', 'ECS', '生命周期', 'PlayerLoop']
---

> 主题：把 **World / SystemGroup / System** 三级生命周期讲成**一条时间线**——一帧里谁先谁后、每个回调为什么存在。
> 适用版本：Unity Entities 1.0+（本文按 Entities 1.0.16 的行为描述）。
> 阅读方式：先看「速览」建立骨架；想按时间顺序理解就从 §1 顺着读；只查"某个回调什么时候触发"跳 §5；查顺序对照跳 §6；文末有速查表。

---

## 速览

- **DOTS 的代码不挂在对象上，而挂在"系统"（System）上。** 你写的是"每帧对某一批数据做同一件事"，而不是"每个对象自己动一下"。
- **系统不会自己跑。** 它必须被放进一个分组（SystemGroup）的更新列表，分组才有资格每帧被游戏主循环（PlayerLoop）喊一次。
- **一个系统从生到死依次经过**：`OnCreate` → `OnStartRunning` → `OnUpdate`（每帧一次）→ `OnStopRunning` → `OnDestroy`。中间的启停钩子可能反复来回。
- **一帧默认顺序是**：ECS 的 Initialization → 你的 `MonoBehaviour.Update` → ECS 的 Simulation → 你的 `MonoBehaviour.LateUpdate` → ECS 的 Presentation。所以"在 `Update` 里读 ECS 数据"读到的是上一帧结果。
- **`OnUpdate` 被两道闸门把守**：系统自己的 `Enabled`，以及"这个系统现在有没有数据可处理"。搞不清这一点，最常见的现象就是"代码没报错、但什么都没发生"。

---

## 1. 先解决"代码往哪写"

假设你要让场上 1000 个方块每帧往前移动一点。

**天真做法**：写一个 `Mover : MonoBehaviour` 挂在每个方块上，`Update()` 里改 `transform.position`。这能跑，但它把代码和对象绑死——1000 个对象就是 1000 次 `Update()` 调用，而且每个方块的位置散落在堆上不同地方（这带来的访存代价属于性能原理那一篇的话题）。

**DOTS 的做法**：把"位置""速度"抽成纯数据，再写**一段**代码套用到所有带这份数据的实体上。

```csharp
// 数据：没有方法，只有字段
public struct Position : IComponentData { public float3 Value; }
public struct Velocity : IComponentData { public float3 Value; }

// 行为：一段代码，处理所有符合条件的实体
[BurstCompile]
public partial struct MoveSystem : ISystem
{
    [BurstCompile]
    public void OnUpdate(ref SystemState state)
    {
        float dt = SystemAPI.Time.DeltaTime;
        foreach (var (pos, vel) in SystemAPI.Query<RefRW<Position>, RefRO<Velocity>>())
            pos.ValueRW.Value += vel.ValueRO.Value * dt;
    }
}
```

`IComponentData` 是"组件"的标记接口。别被名字骗了：它不是挂在 GameObject 上的组件，而是**一段跟着实体走的数据**。而 `ISystem` 是"非托管系统"，能被 Burst 编译成机器码；另一个选择 `SystemBase` 是托管类，写起来更像 MonoBehaviour，但性能上限低一些。忘掉其余语法，先记住：`OnUpdate` 对应 MonoBehaviour 的 `Update`，**每帧被调一次**——**但谁来调它？** 这就是本文的全部内容。

---

## 2. 三级结构：World 装 Group，Group 装 System

组织关系只有三层，像俄罗斯套娃：

```text
World（容器：EntityManager + Time + 全部 System）
 ├── InitializationSystemGroup    ─┐
 ├── SimulationSystemGroup         ├─ 三个 root group
 └── PresentationSystemGroup      ─┘   （默认自动创建、自动挂进 PlayerLoop）
        └── 自定义 Group（可再嵌套 Group）
              └── System（ISystem / SystemBase）
```

| 层级 | 一句话职责 | 你会用到的 API |
|---|---|---|
| **World** | 一个"游戏世界"：拥有实体管理器、时间、全部系统。一个进程可以同时存在多个 World | `CreateSystem` / `GetOrCreateSystem` / `DestroySystem` / `Dispose` / `Time` |
| **SystemGroup** | 一个**有序的系统列表**。它自己的 `OnUpdate` 就是"按顺序挨个调用子系统的 `Update()`" | `AddSystemToUpdateList` / `RemoveSystemFromUpdateList` / `SortSystems` / `Enabled` |
| **System** | 逻辑单元，唯一执行入口是 `OnUpdate` | `OnCreate` / `OnUpdate` / `OnDestroy`（+ 启停钩子） |

**没写 `[UpdateInGroup]` 时，系统默认进 `SimulationSystemGroup`。**

为什么要有 Group 这一层？因为**顺序**。游戏逻辑天然有先后：先读输入、再算移动、再算碰撞、最后画。DOTS 不用"脚本执行顺序"那套手填数字的办法，而是让你把系统塞进分组、再用特性声明相对顺序——分组就是"一批要一起发生的事"。

---

## 3. World 的生命周期

**创建**：默认什么都不用做。Entities 的引导流程（Bootstrap）会在**场景加载完成之后**建立 `World.DefaultGameObjectInjectionWorld`：创建 World → 创建三个 root group → 创建所有没被 `[DisableAutoCreation]` 标记的系统（触发它们的 `OnCreate`）→ 把三个 group 注入 PlayerLoop（下一帧生效）。

也可以手动来（想完全接管就用 `ICustomBootstrap`）：

```csharp
var world = new World("My World");
DefaultWorldInitialization.AddSystemsToRootLevelSystemGroups(
    world, DefaultWorldInitialization.DefaultWorldSystems);
ScriptBehaviourUpdateOrder.AppendWorldToCurrentPlayerLoop(world);
```

最后一句不能省：**手动建的 World 默认不在游戏主循环里**，不挂上去永远不会自己跑。

**运行**：自动时由 PlayerLoop 走到对应阶段调用对应 group；手动则是 `world.Update()`，它按 Initialization → Simulation → Presentation 走一遍。注意：**已经在 PlayerLoop 里的 World 再手动 `Update()` 就会跑两遍**，手动驱动只适用于没挂进 PlayerLoop 的 World。

**销毁**：`world.Dispose()` 触发所有系统的 `OnDestroy`，并释放实体管理器（销毁所有实体与 chunk）。两条容易栽的语义：

- **`Dispose()` 不会把 World 从 PlayerLoop 里摘掉。** 手动销毁的 World 要自己配一句 `ScriptBehaviourUpdateOrder.RemoveWorldFromCurrentPlayerLoop(world)`，否则 PlayerLoop 里会留下指向空 World 的条目。
- **对 PlayerLoop 的修改下一帧才生效。** 在 `OnCreate` 里挂的东西，本帧看不到效果。

负责"把 World 接到 PlayerLoop 上"的类叫 `ScriptBehaviourUpdateOrder`：`AppendWorldToCurrentPlayerLoop(world)` 把三个 root group 追加进当前 PlayerLoop，`AppendWorldToPlayerLoop(world, ref playerLoop)` 改成操作你传入的 `PlayerLoopSystem`，`RemoveWorldFromCurrentPlayerLoop` 做反向操作，`IsWorldInCurrentPlayerLoop` 用来查询。最灵活的是 `AppendSystemToPlayerLoop(system, ref playerLoop, phase)`——它能把**单个系统**摆到任意 PlayerLoop 阶段，是精确控制顺序的主力 API。

---

## 4. SystemGroup 的生命周期

分组的回调只有三个，但每个都有用：

| 回调 | 什么时候执行 | 通常拿它做什么 |
|---|---|---|
| `OnCreate` | 分组被创建时，一次 | **组装子系统**：`world.GetOrCreateSystem<T>()` + `AddSystemToUpdateList(...)` |
| `OnUpdate` | 每帧被父级调用 | 默认实现：必要时 `SortSystems()`，然后遍历子列表逐个 `Update()` |
| `OnDestroy` | 分组被销毁时 | 销毁子级（非托管 / 托管各一套 API） |

### 4.1 顺序是怎么排出来的

系统进哪个组、组内站哪个位置，靠**特性声明**和**加入顺序**两种方式表达：

- `[UpdateInGroup(typeof(G))]` 决定归属（可以嵌套）；加上 `OrderFirst = true` / `OrderLast = true` 就排到本组最前 / 最后。
- `[UpdateBefore(typeof(X))]` / `[UpdateAfter(typeof(X))]` 声明相对约束，**只在同一个父组内生效，跨组无效**。
- 什么都没写就按**加入顺序**。

```csharp
[UpdateInGroup(typeof(SimulationSystemGroup))]
[UpdateBefore(typeof(MoveSystem))]
public partial struct ReadInputSystem : ISystem { /* … */ }
```

要控制跨组顺序，就把约束写在**组与组之间**，或者调整嵌套结构——`UpdateBefore` 只在自己所属的那一层生效。

### 4.2 两个实用要点

1. **`Enabled` 向下级联。** 把某个 Group 的 `Enabled` 设成 `false`，它下面所有子系统都不再 `OnUpdate`。这是"整体暂停一类逻辑"最省事的开关。
2. **手工加完系统若要求严格顺序，显式调一次 `SortSystems()`**；否则框架会在下次更新前替你排。

### 4.3 分组的销毁写法

自定义分组如果自己创建了子系统，就得自己收拾：

```csharp
protected override void OnDestroy()
{
    base.OnDestroy();
    foreach (var sys in this.GetAllSystems())  World.DestroySystem(sys);        // 非托管 ISystem
    foreach (var sys in this.ManagedSystems)   World.DestroySystemManaged(sys); // 托管 SystemBase
}
```

漏掉这一步的典型后果是：重建 World 之后旧系统还活着，对着已经释放的数据乱写。

---

## 5. System 的生命周期

### 5.1 一条线看清楚

```text
OnCreate ─→ [OnStartRunning] ─→ OnUpdate ×N ─→ [OnStopRunning] ─→ OnDestroy
   一次        进入运行状态       每帧一次        退出运行状态        一次
          ↑______________ 停/跑切换时反复 ____________|
```

方括号里两个回调是**成对、可反复**的：系统每次从"停"变"跑"就 `OnStartRunning`，每次从"跑"变"停"就 `OnStopRunning`。中间的 `OnUpdate` 可能一次都没跑过。

### 5.2 每个回调的触发条件与用途

| 回调 | 什么时候被调用 | 为什么需要它 |
|---|---|---|
| **`OnCreate`** | 创建时**一次**；带 `[DisableAutoCreation]` 的在**首次 `GetOrCreateSystem`** 时 | 建 `EntityQuery`、调 `RequireForUpdate`、分配长期存活的 Native 资源 |
| **`OnStartRunning`** | 首次 `OnUpdate` **之前**，以及每次"重新开始运行"（`Enabled` false→true，或从"没数据"变"有数据"） | "要开始干活了"的准备：采样初值、重置累计量 |
| **`OnUpdate`** | 每帧一次，前提是 `Enabled == true` **且** `ShouldRunSystem() == true` | 唯一执行入口。正确姿势是"调度 Job 然后返回"，别在这层做重活 |
| **`OnStopRunning`** | 停止运行时（`Enabled` true→false，或 `ShouldRunSystem()` 变假）；**`OnDestroy` 之前必定先调一次** | 收尾：把还在跑的 Job 同步掉、清空临时状态 |
| **`OnDestroy`** | 被销毁时（`DestroySystem` / `World.Dispose`） | 释放 `NativeArray`、`BlobAssetReference` 这类要手动回收的资源 |

所有生命周期回调都跑在**主线程**上。"在 `OnUpdate` 里写一个 20 万次的 `for` 循环"等于把主线程按住不放，正确做法是丢进 Job。

```csharp
public partial struct Score : IComponentData { public float Value; }

[BurstCompile]
public partial struct AddScoreSystem : ISystem
{
    private NativeArray<float> _weights;   // 需要手动释放的资源

    [BurstCompile]
    public void OnCreate(ref SystemState state)
    {
        _weights = new NativeArray<float>(8, Allocator.Persistent);
        state.RequireForUpdate<Score>();   // 场上没有 Score 就没必要跑
    }

    [BurstCompile]
    public void OnUpdate(ref SystemState state)
    {
        foreach (var s in SystemAPI.Query<RefRW<Score>>())
            s.ValueRW.Value += 1f;
    }

    public void OnDestroy(ref SystemState state) => _weights.Dispose();
}
```

### 5.3 `ShouldRunSystem()`：第二道闸门

第一道闸门是人为开关 `Enabled`；第二道是"这个系统现在到底有没有事可做"：什么都不加时每帧都跑；在 `OnCreate` 里调了 `RequireForUpdate<T>()` 或 `RequireForUpdate(query)` 之后，只有**全部**必需查询都非空时才跑；`[RequireMatchingQueriesForUpdate]` 是"自身任一查询匹配到 chunk 才跑"；`[AlwaysUpdateSystem]` 则忽略以上所有判断，恒为 true。最后，**`Enabled == false` 时即使 `ShouldRunSystem()` 为 true，`OnUpdate` 也不执行**。

第二道闸门的意义是又省事又省性能：数据还没生成、场上一个敌人都没有时，系统干脆别进去空转。

### 5.4 `ISystem` 与 `SystemBase` 的钩子差异

两者的主要差别：`ISystem` 的三个主回调签名带 `ref SystemState`，而且从 Entities 1.0 起它们是 default interface method（用不到的可以不写），`SystemBase` 则是 `protected override void OnCreate/OnUpdate/OnDestroy()`。启停钩子上，`SystemBase` 直接 `override` 就有，而 `ISystem` 必须**额外实现 `ISystemStartStop`**。取引用和销毁也是两套：`GetOrCreateSystem<T>()` + `DestroySystem(handle)` 对非托管，`GetOrCreateSystemManaged<T>()` + `DestroySystemManaged(sys)` 对托管；要拿非托管系统的引用，还得走 `World.Unmanaged.GetUnsafeSystemRef<T>(handle)`。

初学者按这条规则选就行：**性能敏感、逻辑简单 → `ISystem`；要拿托管对象、图省事 → `SystemBase`。**

### 5.5 三个最容易卡住的点

1. **`[DisableAutoCreation]` 只阻止"自动创建"，不负责"加入更新列表"。**
   系统被 `GetOrCreateSystem` 创建后会正常执行 `OnCreate`，但你不手动 `AddSystemToUpdateList`，`OnUpdate` **永远不会被调用**——不报错、不警告，就是安静地不执行。手动装配的替代路径是 `DefaultWorldInitialization.AddSystemsToRootLevelSystemGroups`。

2. **`RequireForUpdate` 不看可启用组件的启用状态。**
   它只判断组件**是否存在**（内部用 `IsEmptyIgnoreFilter`）。拿 `IEnableableComponent` 当开关去门控系统时，系统依然每帧 `OnUpdate`，只是进去空跑。三种应对：改用**普通 tag 组件**当开关；或在 `OnUpdate` 开头早退 `if (query.IsEmpty) return;`（这个会尊重启用状态）；或直接切 `state.Enabled = false`，由别处再打开。

3. **`Enabled` 不是"数据门控"。**
   它是"把整个系统关掉"，切换会连带触发 `OnStartRunning` / `OnStopRunning`（正好用来做一次性初始化 / 清理）。想按数据决定跑不跑，用 `RequireForUpdate` 或查询判断。

---

## 6. 统一时间线：World 与 MonoBehaviour 混在一起看

### 6.1 三个 root group 挂在 PlayerLoop 的哪一站

| PlayerLoop 阶段 | Entities 分组 | 阶段内位置 |
|---|---|---|
| Initialization | `InitializationSystemGroup` | 该阶段**末尾** |
| Update | `SimulationSystemGroup` | 该阶段**末尾**（在 `ScriptRunBehaviourUpdate` 之后） |
| PreLateUpdate | `PresentationSystemGroup` | 该阶段**末尾**（在 `ScriptRunBehaviourLateUpdate` 之后） |

关键就在"末尾"三个字：`MonoBehaviour.Update` 由阶段内部的 `ScriptRunBehaviourUpdate` 触发，而 ECS 分组被追加在它后面。**这就是"Mono 先、ECS 后"的根本成因**，不是随手能改的配置。

### 6.2 一帧完整时间线

```text
【启动（只发生一次）】
  Mono : Awake → OnEnable → Start
  ECS  : World 创建 → 各系统 OnCreate → 首次 OnUpdate 之前的 OnStartRunning
         （Bootstrap 在"场景加载后"建 World；PlayerLoop 注入下一帧才生效）

【每帧 PlayerLoop】
  Initialization  │ Mono : （无对应回调）
                  │ ECS  : InitializationSystemGroup
                  │        └─ UpdateWorldTimeSystem 刷新 World.Time / SystemAPI.Time
  EarlyUpdate     │ （无）
  FixedUpdate     │ Mono : FixedUpdate
                  │ ECS  : FixedStepSimulationSystemGroup（需显式启用）
  PreUpdate       │ （无）
  Update          │ Mono : Update
                  │ ECS  : SimulationSystemGroup          ← 绝大多数系统在这里
  PreLateUpdate   │ Mono : LateUpdate
                  │ ECS  : PresentationSystemGroup
  PostLateUpdate  │ 渲染 / EndOfFrame

【销毁（只发生一次）】
  Mono : OnDisable → OnDestroy
  ECS  : 各系统 OnStopRunning → OnDestroy；World.Dispose 释放实体管理器与 chunk
```

### 6.3 回调对照与由此推出的可见性

| MonoBehaviour | ECS 等价物 | 差别 |
|---|---|---|
| `Awake` / `OnEnable` | 系统 `OnCreate` | World 创建时执行 |
| `Start` | 系统首次 `OnStartRunning` | 第一次真正运行之前 |
| `Update` | 系统 `OnUpdate`（在 `SimulationSystemGroup`） | **跑在 `MonoBehaviour.Update` 之后** |
| `FixedUpdate` | `FixedStepSimulationSystemGroup` | 需要显式启用 |
| `LateUpdate` | `PresentationSystemGroup` | **跑在 `MonoBehaviour.LateUpdate` 之后** |
| `OnDisable` / `OnDestroy` | `OnStopRunning` → `OnDestroy` | `OnStopRunning` 必定先被调用 |

从上面的顺序能直接推出三条结论：

1. **在 `MonoBehaviour.Update` 里读实体数据 → 拿到上一帧的模拟结果**（本帧的 Simulation 还没跑）。
2. **在 `MonoBehaviour.Update` 里写实体数据 → 同一帧的 Simulation 看得到**（它跑在后面）。
3. **Simulation 的结果，同一帧的 `LateUpdate` 就能读**。"ECS 算完 → 批量回写 Transform 给表现层"就依赖这个时间差；反过来写在 `Update` 里，画面就慢一帧。

> ⚠️ 以上都是**默认 World + 默认 Bootstrap** 的行为。一旦用了自定义 `ICustomBootstrap`、多个 World，或用 `AppendSystemToPlayerLoop` 手动摆系统，顺序就可能完全不同——那时以 Profiler 的 PlayerLoop 视图为准。

---

## 7. 把顺序亲手验一遍

```csharp
// ① MonoBehaviour 侧
public class MonoOrderProbe : MonoBehaviour
{
    void Awake()      => Debug.Log($"f{Time.frameCount}  Mono.Awake");
    void Start()      => Debug.Log($"f{Time.frameCount}  Mono.Start");
    void Update()     => Debug.Log($"f{Time.frameCount}  Mono.Update");
    void LateUpdate() => Debug.Log($"f{Time.frameCount}  Mono.LateUpdate");
}
```

```csharp
// ② ECS 侧：三个分组各放一个探针，把 typeof(...) 依次换成三个 group
// 注意：用了 UnityEngine.Time，所以这几个系统不要标 [BurstCompile]
[UpdateInGroup(typeof(SimulationSystemGroup))]
public partial struct SimProbeSystem : ISystem
{
    public void OnUpdate(ref SystemState state)
        => Debug.Log($"f{Time.frameCount}  SimulationSystemGroup");
}
```

同一帧号里的预期输出：

```text
f100  Mono.Update
f100  SimulationSystemGroup
f100  Mono.LateUpdate
f100  PresentationSystemGroup
```

其它验证工具：`Window > Entities > Systems` 看系统树与 `Enabled` 状态；Profiler 的 PlayerLoop 视图确认 `SimulationSystemGroup` 排在 `ScriptRunBehaviourUpdate` 之后；Systems 窗口的 Time 列找每帧最耗时的系统。

---

## 8. 常见误解

**Q1：`MonoBehaviour.Update` 和 `SimulationSystemGroup` 谁先？**
`MonoBehaviour.Update` 先。`SimulationSystemGroup` 被追加在 Update 阶段末尾，位于 `ScriptRunBehaviourUpdate` 之后。

**Q2：系统创建后就会自动 `OnUpdate` 吗？**
只会自动 `OnCreate`。**必须进入某个 Group 的更新列表**才会被 `Update()` 调用；带 `[DisableAutoCreation]` 的系统要手动 `AddSystemToUpdateList`。

**Q3：`OnCreate` 什么时候执行？**
自动创建的系统随 World 初始化执行；带 `[DisableAutoCreation]` 的系统在首次 `GetOrCreateSystem` 时执行。

**Q4：`OnStopRunning` 和 `OnDestroy` 什么关系？**
`OnDestroy` 之前**必定**先调用一次 `OnStopRunning`。所以资源释放放 `OnDestroy`，与启停相关的准备和收尾放 `OnStartRunning` / `OnStopRunning`。

**Q5：`Enabled = false` 和 `RequireForUpdate` 有什么区别？**
`Enabled` 是"人为关掉系统"，切换会触发启停回调；`RequireForUpdate` 是"按数据存在性自动门控"。两者都能阻止 `OnUpdate`，但语义与副作用不同。另外把 Group 的 `Enabled` 设为 false 时，子系统的 `OnStopRunning` 也会被调用。

**Q6：`[UpdateBefore]` / `[UpdateAfter]` 能跨组用吗？**
不能跨父组生效。要控制跨组顺序，应该把约束写在组之间，或调整嵌套结构。

**Q7：`RequireForUpdate` 能感知"组件被禁用"吗？**
不能，它只判断组件是否存在。要尊重启用状态，在 `OnUpdate` 里用 `query.IsEmpty` 早退。

**Q8：`UpdateWorldTimeSystem` 在哪，为什么重要？**
它在 `InitializationSystemGroup` 里，负责刷新 `World.Time` / `SystemAPI.Time`。所以 `SystemAPI.Time.DeltaTime` 反映的是**当前帧**的帧时间，而不是"上一次这个系统运行以来过了多久"。

---

## 9. 速查表

**回调时机与门控**

| 回调 / 写法 | 时机 / 效果 | 备注 |
|---|---|---|
| `OnCreate` | 系统创建时一次 | 带 `[DisableAutoCreation]` → 首次 `GetOrCreateSystem` 时 |
| `OnStartRunning` | 首次 `OnUpdate` 前，及每次恢复运行 | `ISystem` 需实现 `ISystemStartStop` |
| `OnUpdate` | 每帧（`Enabled` && `ShouldRunSystem()`） | 唯一执行入口 |
| `OnStopRunning` | 停止运行时 | `OnDestroy` 前必调一次 |
| `OnDestroy` | 销毁时 | 释放 Native 资源 |
| `RequireForUpdate<T>()` | 组件**存在**才跑 | 不看可启用组件的启用状态 |
| `[RequireMatchingQueriesForUpdate]` / `[AlwaysUpdateSystem]` | 自身查询非空才跑 / 恒为 true | — |
| `Enabled = false` | 不跑，并触发 `OnStopRunning` | 向下级联到子级 |
| `if (query.IsEmpty) return;` | 在 `OnUpdate` 内早退 | **尊重**启用状态与过滤 |

**阶段映射与装配 API**

| ECS 分组 | PlayerLoop 阶段 | 相对 Mono |
|---|---|---|
| `InitializationSystemGroup` | Initialization | 早于 `FixedUpdate` / `Update` |
| `FixedStepSimulationSystemGroup` | FixedUpdate | 与 `FixedUpdate` 同阶段 |
| `SimulationSystemGroup` | Update | **晚于** `Update` |
| `PresentationSystemGroup` | PreLateUpdate | **晚于** `LateUpdate` |

| 用途 | API |
|---|---|
| 创建 / 获取系统 | `GetOrCreateSystem<T>()` / `GetOrCreateSystemManaged<T>()` |
| 加入 / 移出更新列表 | `group.AddSystemToUpdateList(sys)` / `group.RemoveSystemFromUpdateList(sys)` |
| 强制排序 | `group.SortSystems()` |
| 启停 | `sys.Enabled = true/false`（或 `SystemState.Enabled`） |
| 销毁 | `World.DestroySystem(handle)` / `World.DestroySystemManaged(sys)` / `world.Dispose()` |
| 注入 PlayerLoop | `ScriptBehaviourUpdateOrder.AppendWorldToCurrentPlayerLoop(world)` / `AppendSystemToPlayerLoop(...)` |

---

## 附录：官方文档链接

- [System concepts（三级结构、SystemGroup）](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/concepts-systems.html)
- [ISystem overview（生命周期、ISystemStartStop）](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-isystem.html) · [SystemBase overview](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-systembase.html) · [Systems comparison](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/systems-comparison.html)
- [`World.Update`](https://docs.unity3d.com/Packages/com.unity.entities@1.3/api/Unity.Entities.World.Update.html) · [`ScriptBehaviourUpdateOrder`（PlayerLoop 注入 / 移除）](https://docs.unity3d.com/Packages/com.unity.entities@0.16/api/Unity.Entities.ScriptBehaviourUpdateOrder.html)
- [`SystemState.ShouldRunSystem`](https://docs.unity3d.com/Packages/com.unity.entities@1.1/api/Unity.Entities.SystemState.ShouldRunSystem.html) · [`RequireForUpdate`（含"忽略启用状态"的说明）](https://docs.unity3d.com/Packages/com.unity.entities@1.2/api/Unity.Entities.SystemState.RequireForUpdate.html) · [`DisableAutoCreationAttribute`](https://docs.unity3d.com/Packages/com.unity.entities@1.1/api/Unity.Entities.DisableAutoCreationAttribute.html)
- [System group allocator（`RateManager` / 固定步长）](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/allocators-system-group.html) · [Unity PlayerLoop 阶段（`ScriptRunBehaviourUpdate`）](https://docs.unity3d.com/ScriptReference/PlayerLoop.Update.ScriptRunBehaviourUpdate.html)

> 中文镜像：把 `docs.unity3d.com` 换成 `docs.unity.cn` 即可。
