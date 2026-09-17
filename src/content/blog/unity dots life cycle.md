---
title: 'Unity DOTS —— 生命周期技术文档'
description: 'DOTS与MonoBehaviour的生命周期'
pubDate: '2026-01-15'
---

> 主题：**World / SystemGroup / System** 三级结构的生命周期，以及与 **MonoBehaviour** 生命周期的统一时间线
> 适用版本：Unity Entities 1.0+（本文按 Entities 1.0.16 编写）
> 阅读方式：先看「速览」；要查"某个回调什么时候触发"直接跳到 §4；要查"谁先谁后"看 §5；文末有「速查表」。

---

## 速览

**三级结构各自的"生老病死"**

| 层级 | 创建 | 运行 | 销毁 |
|---|---|---|---|
| **World** | Bootstrap 自动建默认 World，或 `new World(name)` | PlayerLoop 每帧驱动；或手动 `world.Update()` | `world.Dispose()` → 销毁所有系统 + 释放 EntityManager |
| **SystemGroup** | 随 World 创建（三个 root group 自动建，自定义组在 `OnCreate` 里组装子系统） | `OnUpdate` = 遍历子列表逐个 `Update()` | Group 的 `OnDestroy`（通常在这里销毁子级） |
| **System** | `OnCreate`（`[DisableAutoCreation]` 的是首次 `GetOrCreateSystem` 时） | `OnStartRunning` → `OnUpdate`×N → `OnStopRunning` | `OnDestroy`（`OnStopRunning` 必先调用） |

**一帧的顺序（默认 World）**

```
InitializationSystemGroup → Mono.FixedUpdate →（FixedStepSimulationSystemGroup）
→ Mono.Update → SimulationSystemGroup → Mono.LateUpdate → PresentationSystemGroup → 渲染
```

**三条最该记住的结论**

1. **`MonoBehaviour.Update` 跑在 `SimulationSystemGroup` 之前**，所以在 `Update` 里读 ECS 数据拿到的是**上一帧**的结果。
2. **`[DisableAutoCreation]` 只阻止自动创建**；系统被创建后如果不手动加入组的更新列表，`OnUpdate` 永远不会被调用。
3. **`OnUpdate` 被双重门控**：`Enabled` **且** `ShouldRunSystem()`。任一为假时不执行 `OnUpdate`，并（在之前是运行状态时）触发一次 `OnStopRunning`。

---

## 1. 三级结构

```
World（容器：EntityManager + Time + 全部 System）
 ├── InitializationSystemGroup   ─┐
 ├── SimulationSystemGroup        ├─ 三个 root group（默认自动创建、自动挂进 PlayerLoop）
 └── PresentationSystemGroup     ─┘
        └── 自定义 Group（可嵌套）
              └── System（ISystem / SystemBase）
```

| 层级 | 职责 | 关键 API |
|---|---|---|
| **World** | 拥有 `EntityManager`、`Time` 和所有系统；一个进程可有多个 World | `CreateSystem` / `GetOrCreateSystem(Managed)` / `DestroySystem(Managed)` / `Dispose` / `Unmanaged` / `Time` |
| **SystemGroup** | 一个**有序的系统列表**；它的 `OnUpdate` 就是逐个调用子系统的 `Update()` | `AddSystemToUpdateList` / `RemoveSystemFromUpdateList` / `SortSystems` / `Enabled` |
| **System** | 逻辑单元，唯一执行入口是 `OnUpdate` | `OnCreate` / `OnUpdate` / `OnDestroy`（+ `OnStartRunning` / `OnStopRunning`） |

**没有 `[UpdateInGroup]` 时，系统默认进入 `SimulationSystemGroup`。**

---

## 2. World 的生命周期

| 阶段 | 触发方式 | 说明 |
|---|---|---|
| **创建** | 自动：Entities 的 Bootstrap 在**场景加载后**（`AfterSceneLoad`）建立 `World.DefaultGameObjectInjectionWorld`（名字 "Default World"）：创建三个 root group → 创建所有未被 `[DisableAutoCreation]` 标记的系统（触发它们的 `OnCreate`）→ 把三个 group 注入 PlayerLoop<br>手动：`new World("name")` + `DefaultWorldInitialization.AddSystemsToRootLevelSystemGroups(world, ...)` | 也可以自定义 Bootstrap（`ICustomBootstrap`）完全接管 |
| **运行** | 自动：PlayerLoop 各阶段调用对应 group<br>手动：`world.Update()` —— 依序执行 Initialization → Simulation → Presentation | 未加入 PlayerLoop 的自定义 World **必须**手动 `Update()` |
| **销毁** | `world.Dispose()` | 销毁全部系统（触发每个系统的 `OnDestroy`）+ 释放 `EntityManager`（销毁所有实体与 chunk） |

**两条容易踩的语义**

- **`World.Dispose()` 不会把 World 从 PlayerLoop 移除**（官方说明该操作较昂贵）。手动 Dispose 的 World 要自己配对 `ScriptBehaviourUpdateOrder.RemoveWorldFromCurrentPlayerLoop(world)`，否则会在 PlayerLoop 里留下空条目。
- **PlayerLoop 的修改下一帧才生效**。

### World 与 PlayerLoop 的桥

| API（`Unity.Entities.ScriptBehaviourUpdateOrder`） | 作用 |
|---|---|
| `AppendWorldToCurrentPlayerLoop(world)` | 把 World 的三个 root group 追加进当前 PlayerLoop |
| `AppendWorldToPlayerLoop(world, ref playerLoop)` | 同上，但操作传入的 `PlayerLoopSystem`（不调用 `SetPlayerLoop`） |
| `RemoveWorldFromCurrentPlayerLoop(world)` | 把该 World 的系统全部从当前 PlayerLoop 移除 |
| `RemoveWorldFromPlayerLoop(world, ref playerLoop)` | 同上，操作传入对象 |
| `IsWorldInCurrentPlayerLoop(world)` | 检查是否已注入 |
| `AppendSystemToPlayerLoop(system, ref playerLoop, phase)` | 把**单个系统**摆到任意 PlayerLoop 阶段（自定义顺序的主力 API） |

---

## 3. SystemGroup 的生命周期

| 回调 | 时机 | 典型用途 |
|---|---|---|
| `OnCreate` | group 创建时一次 | **组装子系统**：`world.GetOrCreateSystem<T>()` + `AddSystemToUpdateList(...)` |
| `OnUpdate` | 每帧被父级调用 | 默认实现：必要时 `SortSystems()`，然后遍历子列表逐个 `Update()` |
| `OnDestroy` | group 被销毁 | 销毁子级（托管/非托管各一套 API） |

**排序规则**

| 机制 | 作用范围 | 说明 |
|---|---|---|
| `[UpdateInGroup(typeof(G))]` | 决定归属 | 系统进哪个组（可嵌套） |
| `[UpdateInGroup(typeof(G), OrderFirst = true)]` | 组内位置 | 在本组最前 |
| `[UpdateInGroup(typeof(G), OrderLast = true)]` | 组内位置 | 在本组最后 |
| `[UpdateBefore(typeof(X))]` / `[UpdateAfter(typeof(X))]` | **同一父组内** | 声明相对约束；**跨组无效** |
| 无约束的系统 | 组内 | 按**加入顺序** |

**两个要点**

1. **`Enabled` 会向下级联**：把 Group 的 `Enabled` 设为 `false`，其下所有子系统都不再 `OnUpdate`（常用于整体暂停某一类逻辑）。
2. **`AddSystemToUpdateList` 之后若需要严格顺序**，可显式调用 `SortSystems()`；只靠加入顺序时由框架在下次更新前排序。

**销毁子系统的常规写法**

```csharp
protected override void OnDestroy()
{
    base.OnDestroy();
    foreach (var sys in this.GetAllSystems())    World.DestroySystem(sys);        // 非托管 ISystem
    foreach (var sys in this.ManagedSystems)     World.DestroySystemManaged(sys); // 托管 SystemBase
}
```

---

## 4. System 的生命周期

### 4.1 回调顺序

```
OnCreate → [OnStartRunning] → OnUpdate → OnUpdate → … → [OnStopRunning] → OnDestroy
                ↑________________________________|
              "运行/停止"状态来回切换时反复触发
```

### 4.2 每个回调的触发条件

| 回调 | 什么时候调用 |
|---|---|
| **`OnCreate`** | 系统被创建时**一次**。自动创建的系统随 World 初始化；带 `[DisableAutoCreation]` 的系统在**首次 `GetOrCreateSystem`** 时创建 |
| **`OnStartRunning`** | 第一次 `OnUpdate` **之前**；以及之后每次"重新开始运行"（`Enabled` false→true，或从"不满足运行条件"变为"满足"） |
| **`OnUpdate`** | 每帧 —— **前提是 `Enabled == true` 且 `ShouldRunSystem() == true`** |
| **`OnStopRunning`** | 停止运行时（`Enabled` true→false，或 `ShouldRunSystem()` 变为 false）；**`OnDestroy` 之前必定调用一次** |
| **`OnDestroy`** | 系统被销毁时（`DestroySystem` / `World.Dispose`）。在这里释放 `NativeArray`、`BlobAssetReference` 等 |

> 所有生命周期回调都跑在**主线程**；`OnUpdate` 的正确用法是"调度 Job"，而不是在里面做重活。

### 4.3 `ShouldRunSystem()` 由什么决定

| 条件 | 效果 |
|---|---|
| （什么都不加） | 每帧都跑 |
| `RequireForUpdate<T>()` / `RequireForUpdate(query)`（在 `OnCreate` 中调用） | 只有**全部**必需查询都非空时才跑 |
| `[RequireMatchingQueriesForUpdate]` | 该系统用到的任一查询匹配到 chunk 才跑 |
| `[AlwaysUpdateSystem]` | 忽略上述判断，恒为 true |
| `Enabled == false` | **即使 `ShouldRunSystem()` 为 true，也不执行 `OnUpdate`** |

### 4.4 两种系统类型的钩子差异

| | `ISystem`（非托管 struct） | `SystemBase`（托管 class） |
|---|---|---|
| 三个主回调 | `OnCreate/OnUpdate/OnDestroy(ref SystemState)`；**1.0 起为 default interface method，可以不实现用不到的那个** | `protected override void OnCreate/OnUpdate/OnDestroy()` |
| 启停钩子 | 需**额外实现 `ISystemStartStop`** 才有 `OnStartRunning` / `OnStopRunning` | 直接 `override` |
| 获取引用 | `GetOrCreateSystem<T>()` / `GetExistingUnmanagedSystem<T>()` + `World.Unmanaged.GetUnsafeSystemRef<T>(handle)` | `GetOrCreateSystemManaged<T>()` / `GetExistingSystemManaged<T>()` |
| 销毁 | `DestroySystem(handle)` | `DestroySystemManaged(system)` |

### 4.5 三个高频坑

1. **`[DisableAutoCreation]` 只阻止"自动创建"，不负责"加入更新列表"。**
   系统被 `GetOrCreateSystem` 创建后会执行 `OnCreate`，但**如果不手动 `AddSystemToUpdateList`，`OnUpdate` 永远不会触发**。
   手动创建的替代路径：`DefaultWorldInitialization.AddSystemsToRootLevelSystemGroups`。

2. **`RequireForUpdate` 不看 enableable 的启用状态。**
   它只检查组件**是否存在**（内部用 `IsEmptyIgnoreFilter`）。用 `IEnableableComponent` 当"开关"去 gate 系统时，系统仍会每帧 `OnUpdate`（然后空跑）。三种应对：
   - 改用**普通 tag**（增删组件 = 结构性变更）来 gate；
   - 或在 `OnUpdate` 开头早退：`if (query.IsEmpty) return;`（这个会尊重启用状态）；
   - 或直接切 `state.Enabled = false` 由别处再打开。

3. **`Enabled` 不是"数据门控"。**
   它是"关掉整个系统"，切换会触发 `OnStartRunning` / `OnStopRunning`（可用来做一次性初始化/清理）。**按数据决定跑不跑，应该用 `RequireForUpdate` 或查询判断。**

---

## 5. 统一生命周期：World 与 MonoBehaviour

### 5.1 三个 root group 被注入的 PlayerLoop 阶段

| Entities group | PlayerLoop 阶段 | 阶段内位置 |
|---|---|---|
| `InitializationSystemGroup` | **Initialization** | 该阶段**末尾** |
| `SimulationSystemGroup` | **Update** | 该阶段**末尾**（在 `ScriptRunBehaviourUpdate` 之后） |
| `PresentationSystemGroup` | **PreLateUpdate** | 该阶段**末尾**（在 `ScriptRunBehaviourLateUpdate` 之后） |

系统组在阶段末尾追加，而 `MonoBehaviour.Update` 由阶段内部的 `ScriptRunBehaviourUpdate` 触发——**这就是"Mono 先、ECS 后"的成因**。

### 5.2 一帧完整时间线

```
【启动（一次）】
  Mono:  Awake → OnEnable → Start
  ECS :  World 创建 → 各系统 OnCreate → 首次 OnUpdate 前的 OnStartRunning
         （Bootstrap 在"场景加载后"建 World；PlayerLoop 注入下一帧生效）

【每帧 PlayerLoop】
  Initialization    │ Mono: （无对应回调）
                    │ ECS : InitializationSystemGroup
                    │        └─ UpdateWorldTimeSystem 刷新 World.Time / SystemAPI.Time
  EarlyUpdate       │ （无）
  FixedUpdate       │ Mono: FixedUpdate
                    │ ECS : FixedStepSimulationSystemGroup（若显式启用）
  PreUpdate         │ （无）
  Update            │ Mono: Update
                    │ ECS : SimulationSystemGroup          ← 绝大多数系统在这里
  PreLateUpdate     │ Mono: LateUpdate
                    │ ECS : PresentationSystemGroup
  PostLateUpdate    │ 渲染 / EndOfFrame

【销毁（一次）】
  Mono:  OnDisable → OnDestroy
  ECS :  各系统 OnStopRunning → OnDestroy；World.Dispose 释放 EntityManager 与 chunk
```

### 5.3 Mono 与 ECS 的回调对照

| MonoBehaviour | ECS 等价物 | 说明 |
|---|---|---|
| `Awake` / `OnEnable` | 系统 `OnCreate` | World 创建时 |
| `Start` | 系统首次 `OnStartRunning` | 第一次真正运行前 |
| `Update` | 系统 `OnUpdate`（在 `SimulationSystemGroup`） | **但跑在 `MonoBehaviour.Update` 之后** |
| `FixedUpdate` | `FixedStepSimulationSystemGroup` | 需显式启用 |
| `LateUpdate` | `PresentationSystemGroup` | **跑在 `MonoBehaviour.LateUpdate` 之后** |
| `OnDisable` / `OnDestroy` | `OnStopRunning` → `OnDestroy` | `OnStopRunning` 必先调用 |

### 5.4 由此推出的数据可见性结论

1. **在 `MonoBehaviour.Update` 里读 Entity 数据 → 拿到的是上一帧的模拟结果**（本帧 Simulation 还没跑）。
2. **在 `MonoBehaviour.Update` 里写 Entity → 同一帧的 Simulation 能看到**（它跑在后面）。
3. **Simulation 的结果，同帧的 `LateUpdate` 可读**——"ECS 算完 → 回写 Transform 给表现层"就依赖这个时间差；反过来在 `Update` 里读就会慢一帧。

> ⚠️ 以上是**默认 World + 默认 Bootstrap** 的行为。使用自定义 `ICustomBootstrap`、多 World、或 `AppendSystemToPlayerLoop` 手动摆放系统时顺序会改变。

---

## 6. 常见误解

**Q1：`MonoBehaviour.Update` 和 `SimulationSystemGroup` 谁先？**
`MonoBehaviour.Update` 先。`SimulationSystemGroup` 被追加在 Update 阶段末尾，位于 `ScriptRunBehaviourUpdate` 之后。

**Q2：系统创建后就会自动 `OnUpdate` 吗？**
只会自动 `OnCreate`。**必须进入某个 Group 的更新列表**才会被 `Update()` 调用；`[DisableAutoCreation]` 的系统要手动 `AddSystemToUpdateList`。

**Q3：`OnCreate` 什么时候执行？**
自动创建的系统随 World 初始化执行；`[DisableAutoCreation]` 的系统在首次 `GetOrCreateSystem` 时执行。

**Q4：`OnStopRunning` 和 `OnDestroy` 的关系？**
`OnDestroy` 之前**必定**先调用一次 `OnStopRunning`。所以清理资源放 `OnDestroy`、启停相关的准备/收尾放 `OnStartRunning`/`OnStopRunning`。

**Q5：`Enabled = false` 和 `RequireForUpdate` 有什么区别？**
`Enabled` 是"人为开关系统"，切换会触发启停回调；`RequireForUpdate` 是"按数据存在性自动门控"。**两者都会阻止 `OnUpdate`**，但语义与副作用不同。

**Q6：把 Group 的 `Enabled` 设为 false，子系统的 `OnStopRunning` 会调用吗？**
会——子系统的"有效运行状态"随父组一起变化，组停跑时子系统会经历停止（触发 `OnStopRunning`）。

**Q7：`world.Update()` 手动调用会让系统跑两遍吗？**
如果该 World 仍在 PlayerLoop 中，会——PlayerLoop 已驱动过一次，你又手动调一次。手动驱动只适用于**未加入 PlayerLoop** 的 World。

**Q8：`[UpdateBefore]`/`[UpdateAfter]` 能跨组使用吗？**
不能跨父组生效。要控制跨组顺序，应该用组之间的 `[UpdateBefore]/[UpdateAfter]`，或调整嵌套结构。

**Q9：`RequireForUpdate` 能感知"组件被禁用"吗？**
不能。它只判断组件是否存在（`IsEmptyIgnoreFilter`）。要尊重启用状态，请在 `OnUpdate` 里用 `query.IsEmpty` 早退。

**Q10：`UpdateWorldTimeSystem` 在哪？**
在 `InitializationSystemGroup` 中，负责刷新 `World.Time` / `SystemAPI.Time`——所以 `SystemAPI.Time.DeltaTime` 反映的是**当前帧**帧时间，而不是"上一次系统运行以来的时间"。

---

## 7. 调试与验证

**这套顺序是"实测性"知识，务必自己验一次：**

```csharp
// ① Mono 侧
public class MonoOrderProbe : MonoBehaviour
{
    void Awake()      => Debug.Log($"f{Time.frameCount}  Mono.Awake");
    void Start()      => Debug.Log($"f{Time.frameCount}  Mono.Start");
    void Update()     => Debug.Log($"f{Time.frameCount}  Mono.Update");
    void LateUpdate() => Debug.Log($"f{Time.frameCount}  Mono.LateUpdate");
}
```

```csharp
// ② ECS 侧（不要标 [BurstCompile]，因为用了 UnityEngine.Time）
[UpdateInGroup(typeof(InitializationSystemGroup))]
public partial struct InitProbeSystem : ISystem
{
    public void OnUpdate(ref SystemState state) => Debug.Log($"f{Time.frameCount}  InitializationSystemGroup");
}

[UpdateInGroup(typeof(SimulationSystemGroup))]
public partial struct SimProbeSystem : ISystem
{
    public void OnUpdate(ref SystemState state) => Debug.Log($"f{Time.frameCount}  SimulationSystemGroup");
}

[UpdateInGroup(typeof(PresentationSystemGroup))]
public partial struct PresProbeSystem : ISystem
{
    public void OnUpdate(ref SystemState state) => Debug.Log($"f{Time.frameCount}  PresentationSystemGroup");
}
```

预期（同一帧号内）：

```
f100  Mono.Update
f100  SimulationSystemGroup
f100  Mono.LateUpdate
f100  PresentationSystemGroup
```

**其它工具**

| 工具 | 用途 |
|---|---|
| `Window > Entities > Systems`（Hierarchy 视图） | 看系统树、所属 Group、是否 Enabled |
| Profiler 的 PlayerLoop 视图 | 直接看到 `SimulationSystemGroup` 位于 `ScriptRunBehaviourUpdate` 之后 |
| Entities 的 Systems 窗口（Time 列） | 找出每帧耗时最高的系统 |

---

## 8. 速查表

**回调时机**

| 回调 | 时机 | 备注 |
|---|---|---|
| `OnCreate` | 系统创建时一次 | `[DisableAutoCreation]` → 首次 `GetOrCreateSystem` 时 |
| `OnStartRunning` | 首次 `OnUpdate` 前，及每次恢复运行 | `ISystem` 需实现 `ISystemStartStop` |
| `OnUpdate` | 每帧（`Enabled` && `ShouldRunSystem()`） | 唯一执行入口 |
| `OnStopRunning` | 停止运行时 | `OnDestroy` 前必调一次 |
| `OnDestroy` | 销毁时 | 释放 Native 资源 |

**门控条件**

| 写法 | 效果 |
|---|---|
| 无 | 每帧跑 |
| `RequireForUpdate<T>()` | 组件**存在**才跑（不看 enableable 启用状态） |
| `RequireForUpdate(query)` | 查询非空才跑（同上，忽略过滤与启用状态） |
| `[RequireMatchingQueriesForUpdate]` | 任一自身查询非空才跑 |
| `[AlwaysUpdateSystem]` | 恒为 true |
| `Enabled = false` | 不跑（并触发 `OnStopRunning`） |
| `if (query.IsEmpty) return;` | 在 `OnUpdate` 内早退（**尊重** enableable 与 filter） |

**阶段映射**

| ECS group | PlayerLoop 阶段 | 相对 Mono |
|---|---|---|
| `InitializationSystemGroup` | Initialization | 早于 `FixedUpdate` / `Update` |
| `FixedStepSimulationSystemGroup` | FixedUpdate | 与 `FixedUpdate` 同阶段 |
| `SimulationSystemGroup` | Update | **晚于** `Update` |
| `PresentationSystemGroup` | PreLateUpdate | **晚于** `LateUpdate` |

**装配与生命周期 API**

| 用途 | API |
|---|---|
| 创建/获取系统 | `GetOrCreateSystem<T>()` / `GetOrCreateSystemManaged<T>()` |
| 加入/移出更新列表 | `group.AddSystemToUpdateList(sys)` / `group.RemoveSystemFromUpdateList(sys)` |
| 强制排序 | `group.SortSystems()` |
| 启停 | `sys.Enabled = true/false`（或 `SystemState.Enabled`） |
| 销毁系统 | `World.DestroySystem(handle)` / `World.DestroySystemManaged(sys)` |
| 销毁 World | `world.Dispose()`（+ 手动 `RemoveWorldFromCurrentPlayerLoop`） |
| 注入 PlayerLoop | `ScriptBehaviourUpdateOrder.AppendWorldToCurrentPlayerLoop(world)` / `AppendSystemToPlayerLoop(...)` |

---

## 附录：官方文档链接

| 主题 | 链接 |
|---|---|
| System concepts（三级结构、SystemGroup） | https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/concepts-systems.html |
| ISystem overview（生命周期、ISystemStartStop） | https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-isystem.html |
| SystemBase overview | https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-systembase.html |
| Systems comparison（ISystem vs SystemBase 对照表） | https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/systems-comparison.html |
| `World.Update` | https://docs.unity3d.com/Packages/com.unity.entities@1.3/api/Unity.Entities.World.Update.html |
| `ScriptBehaviourUpdateOrder`（PlayerLoop 注入/移除） | https://docs.unity3d.com/Packages/com.unity.entities@0.16/api/Unity.Entities.ScriptBehaviourUpdateOrder.html |
| `SystemState.ShouldRunSystem` | https://docs.unity3d.com/Packages/com.unity.entities@1.1/api/Unity.Entities.SystemState.ShouldRunSystem.html |
| `RequireForUpdate`（含"忽略启用状态"说明） | https://docs.unity3d.com/Packages/com.unity.entities@1.2/api/Unity.Entities.SystemState.RequireForUpdate.html |
| `DisableAutoCreationAttribute` | https://docs.unity3d.com/Packages/com.unity.entities@1.1/api/Unity.Entities.DisableAutoCreationAttribute.html |
| System group allocator（`RateManager` / 固定步长） | https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/allocators-system-group.html |
| Unity PlayerLoop 阶段（`ScriptRunBehaviourUpdate`） | https://docs.unity3d.com/ScriptReference/PlayerLoop.Update.ScriptRunBehaviourUpdate.html |

> 中文镜像：把 `docs.unity3d.com` 换成 `docs.unity.cn` 即可。
