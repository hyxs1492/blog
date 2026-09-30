---
title: 'Unity DOTS —— 渲染桥：把 GameObject 的渲染换成 ECS 批量绘制'
description: 'GameObject 全保留、只把渲染目标转成 ECS 实体的运行时渲染桥：转换流程、双向变换同步、视口剔除与销毁策略'
pubDate: '2026-09-29'
category: '算法'
tags: ['Unity', 'DOTS', 'Entities Graphics', '渲染桥']
---

## 速览
>- **目标**：逻辑全留在 GameObject（层级 / Transform / Collider / 自定义脚本一行不改），只把被标记父物体**下方**的渲染目标（`MeshRenderer` / `LODGroup`）转成 ECS 实体交给 Entities Graphics 批量绘制。父物体自身不渲染。
>- **一个被标记父物体 = 1 个逻辑父实体 + N 个渲染实体**：`MeshRenderer` 各一个子实体；`LODGroup` 变成「组实体 + 每层每个 renderer 一个层实体」。同步表**只登记父物体**，所以含 2 个 `MeshRenderer` + 1 个三层 `LODGroup` 的父物体只占 **1 个槽位**，却驱动 **7 个实体**。
>- **每帧两端夹一个双向同步**（各一个 `IJobParallelForTransform`）：帧初 GameObject → 实体、帧末 实体 → GameObject。
>- **两个方向必须用同一个视口剔除判据**：只剔一半，视口外的对象会被"用旧位置写回实体"而**永久冻结**（§3，真实修过的缺陷）。

```
Initialization 阶段  InitializationSystemGroup: RenderBridgeConversionGroup   建 / 销毁实体
Update 阶段
 ├─ ScriptRunBehaviourUpdate  ← MonoBehaviour.Update（动 GameObject 的地方）
 └─ SimulationSystemGroup
      ├─ RenderBridgeInputGroup (OrderFirst)  Sync  GO ──▶ 实体
      ├─ …你自己的 system：实体是权威…
      └─ RenderBridgeOutputGroup (OrderLast)  Push  实体 ──▶ GO
PreLateUpdate 阶段  PresentationSystemGroup: EntitiesGraphicsSystem（提交绘制）
```
> 时序依据是包源码：entities 1.4.7 的 `ScriptBehaviourUpdateOrder` 把 `SimulationSystemGroup` **追加在 `Update` 阶段末尾**（`ScriptRunBehaviourUpdate` 之后）。

---

## 1. 边界：留下什么，换掉什么
```
GameObject 侧（保留，权威输入端）          实体侧（只建"要绘制"的部分）
父物体 [DotsRenderAuthoring]          父实体  LocalTransform + LocalToWorld + DotsRenderLink
 └─ [LODGroup]                   ──▶ ├─ LOD 组实体  MeshLODGroupComponent(LODDistances0/1)
     ├─ MeshRenderer ①           ──▶ │   ├─ 层实体  MeshLODComponent · LODMask = 1<<层下标
     ├─ MeshRenderer ②           ──▶ │   ├─ 层实体   （同层多个 renderer 共用一个 mask）
     └─ MeshRenderer ③           ──▶ │   └─ 层实体
   Collider / 脚本 / 层级              （不进实体，继续按 MonoBehaviour 跑）
```
保留：层级、`Transform`、`Collider`、`Rigidbody`、自定义 MonoBehaviour。停止绘制：`MeshRenderers` / `LodGroups` 列表里的组件（按 `Disposal` 三选一，§5）。不支持：`SkinnedMeshRenderer` / `ParticleSystem` / `Terrain` / 光照烘焙数据。

`DotsRenderAuthoring`（523 行）既是标记，也是**它自己那套实体的门面**（`AddComponent<T>` / `SetComponent`…，默认 `scope = Parent`）：实体还没建好时**不报错，返回 `Queued` 并排队**，建好后按调用顺序补做 —— 这条能力来自 §2 的队列。

| `DotsRenderEntityScope` | 命中 |
|---|---|
| `Parent` | 只逻辑父实体（写操作默认） |
| `RenderTargets` | 子渲染实体 + LOD 组实体 + 层实体（不含父实体） |
| `All` | 两者都含，父实体恒为第一个 |

---

## 2. 转换流程（按真实调用顺序）
```
① 标记/采集              ② 入队                    ③ 转换（Initialization）
DotsRenderAuthoring       DotsRenderConversionQueue  DotsRenderConversionSystem.OnUpdate
 OnEnable→InitializeEntity  s_Register/s_Unregister   ├ ① Complete 两个 PendingJob
  ├─ CaptureSnapshot ─▶ AuthoringSnapshot              ├ ② 先 Unregister 后 Register
  └─ EnqueueRegister ──────queue─────────────────────▶ └ ③ BuildEntityTree
                                                              │
      ┌───────────────────────────────────────────────────────┘
      ▼
父实体 + 每个 MeshRenderer 一个子实体（RenderMeshUtility.AddComponents）+ 每个 LODGroup 一组层实体
```

15 个 `.cs`、2975 行：`DotsRenderConversionSystem`（661）消费队列/建树/持池，`DotsRenderAuthoring`（523）标记 + 门面，`AuthoringSnapshot`（382）纯数据快照，`RenderMeshPool`（283）去重池，`DotsRenderLodSupport`（217）LOD 层级，`DotsRenderConversionQueue`（167）队列，两个同步系统（133 / 119），`OriginalRendererGuard`（129）隐藏/还原，`RenderEntityRegistry`（128）三容器对齐，`DotsRenderSpawner`（80）预制体生成，其余 4 个 153 行。

两个顺序约束：**写注册表之前必须先收掉两个 job**（`:236-240`）—— `Add` / `MarkDead` 会写 `NativeList` / `TransformAccessArray`，而两个 job 都持有其视图，`PendingJob.Complete()` 缺一不可；**排队操作逐条「记录 → `Playback`」**（`:215-223`）—— 下一条才看得见上一条（`AddComponent` 后 `SetComponent` 才成立），实体已就绪时则是**一次调用 = N 条记录 = 一次 playback**（`DotsRenderAuthoring.cs:487-498`）。`BuildEntityTree` 后若 `created.Count == 1`（只剩父实体）就销毁它并 `DropOperations`（`:499-506`）；预制体路径共用同一个 `BuildEntityTree`，但**绝不触碰**预制体组件，靠 `LinkedEntityGroup` 一句级联销毁。

---

## 3. 两个方向的数据流
两个方向都是 `TransformAccessArray` + `IJobParallelForTransform`，索引与 `registry.Entities`（`NativeArray<Entity>`）**严格对齐**：`Execute(int index, TransformAccess transform)` 的第 `index` 个 transform 就是第 `index` 个实体。

| | Sync（帧初） | Push（帧末） |
|---|---|---|
| 调度 | `job.ScheduleReadOnly(registry.Transforms, 64, Dependency)` | `job.Schedule(registry.Transforms, JobHandle.CombineDependencies(m_Sync.PendingJob, Dependency))` |
| 句柄 | `[NativeDisableParallelForRestriction] ComponentLookup<LocalTransform>`（写） | `[ReadOnly] ComponentLookup<LocalTransform>`（读） |
| 批 | `batchCount = 64` | 无 batchCount 重载（`Schedule(TransformAccessArray, JobHandle)` 只此一种） |

两个方向都**不碰 `Scale`**：`TransformAccess` 没有 `lossyScale`（经 `localToWorldMatrix` 列长反推实测读回 1），缩放只在转换那一刻按 `.x` 写一次；也都"值没变就一个字段都不写"。**父物体双向同步，子实体的相对变换只在转换那一刻写一次** —— 运行时单独动渲染子物体，桥不同步。

### 为什么两个方向都要剔除
```
❌ 只剔回写方向（修复前）              ✅ 两向同判据（修复后）
 视口外：                             视口外：
  Sync  GO 旧位置 ─覆盖─▶ 实体           Sync  被裁剪 ⇒ 跳过，不用 GO 的值覆盖实体
  Push  被裁剪 ⇒ 跳过 ⇒ GO 停住          Push  被裁剪 ⇒ 跳过，不把 GO 拉回来
 往返链路被切断 ⇒ 对象彻底冻结         实体照旧推进，GO 回视野那一帧一次追上
```
旧文档把这条总结成「视口剔除只对回写方向安全」—— 那句话本身就是错的：它默认「GO 只是写目标」，而同步方向会把**过时的 GO 值**喂回实体。修法就是把同一个判据装进两个 job：
```csharp
// Push / Sync 两个 job 里同一段（逐帧现取，因为 VisibilityCulledTag 是可选的）
if (VisibilityAccess.IsCulled(Culled, entity)) return;
```
`IsCulled` = 「挂了**且**启用位为 1」（先 `HasComponent` 再 `IsComponentEnabled` —— 后者对没挂该组件的实体**会抛异常**，不是返回 false）。本工程的船在 `ShipController.OnCreateEntitySuccess` 里显式 `AddComponent<VisibilityCulledTag>()`，判的就是同步表里的那个父实体；代价是对「纯 GO 驱动」的对象，视口外那段位移会被过时的实体值覆盖一次（回视野时回跳）—— 本工程移动对象走往返路径，所以是净修复。

---

## 4. 组件、池与守卫
`DotsRenderLink` = `UnityObjectRef<GameObject> Target` + `DotsRenderTargetKind Kind`：

| `Kind` | 谁带 / `Target` |
|---|---|
| `Parent` | 逻辑父实体（1 个）/ 被标记的父物体 |
| `MeshRenderer` | `MeshRenderer` 对应的子实体 / 那个 `MeshRenderer` 的 GameObject |
| `LodGroup` / `LodLayer` | LOD 组实体 / 层实体 / `LODGroup`、该层 renderer 的 GameObject |

存 **GameObject 而不是组件引用**是关键：`DestroyComponents` 会销毁 `MeshRenderer`，组件引用变 fake-null 而 GameObject 还在 —— 它是组件消失后唯一稳定的定位方式。

**`RenderMeshPool`** 是合批的基础：

| 量 | 值 / 行为 |
|---|---|
| 单代条目上限 | **65535**（`FromMaterialMeshIndexRange` 把 `rangeStart` 转成 `ushort` 的位宽限制） |
| 单 mesh 子网格上限 | **127**（`SubMeshIndexInfo32` 的 range length 只有 **7 bit**，构造函数断言 `rangeLength < 1 << 7`） |
| 键与去重 | `(mesh, 材质序列, 子网格数)`；先查**所有代**，命中旧代就返回旧代的 `RenderMeshArray` —— 索引只追加不重排，已发出的 `MaterialMeshInfo` 永久有效 |

**`OriginalRendererGuard` 为什么必须留**：转换只是**新增**了实体，原组件并没有消失；不 Hide，同一份几何会被 GameObject 画一遍、Entities Graphics 再画一遍。

| 模式 | `MeshRenderer` | `LODGroup` | 可逆 |
|---|---|---|---|
| `ForceRenderingOff`（默认） | `forceRenderingOff = true` | `enabled = false` | ✅ |
| `DisableComponents` | `enabled = false` | `enabled = false` | ✅ |
| `DestroyComponents` | `Destroy(MeshFilter)` + `Destroy(renderer)` | `Destroy(lodGroup)` | ❌ |

`LODGroup` 没有 `forceRenderingOff`，对它而言前两种等价；`DestroyComponents` 首次触发打一条**一次性**警告。**快照是 `DestroyComponents` 之后能重建的唯一依据**：`Register` 一律从 `AuthoringSnapshot` 读输入（`:482-484`），快照只固化"组件销毁后拿不到"的东西（mesh、材质、LOD 层结构、`RenderMeshDescription`），`Transform` 与 `layer` 读实时值。

---

## 5. 销毁、Disposal 与"域重载关掉"的坑
**注销**（`Unregister`，`:520-592`）：丢待应用操作 → 按 `Disposal` 逐个 `Restore` → 逐个 `DestroyEntity` → `MarkDead(entities[0])`。三容器用 **swap-back** 同步移除（`TransformAccessArray` 只有 `RemoveAtSwapBack`），索引永远严格对齐。

⚠️ 本工程 `m_EnterPlayModeOptionsEnabled: 1` + `m_EnterPlayModeOptions: 3` —— **域重载与场景重载都关掉**，静态状态与场景对象跨 Play 会话保留。于是 `Disposal = DestroyComponents` 的语义变了：`Object.Destroy` 销毁的是**被复用的那个场景对象**上的组件，退出 Play **不会恢复**；一旦保存场景，销毁就写进场景资产 —— **永久损坏**（`Restore` 在 `DestroyComponents` 下只是**安全的 no-op**）。

实证：`TestShip.prefab` 序列化的 `Disposal: 2`（DestroyComponents）、`MeshRenderers: []`、`LodGroups: [1 项]`；`SampleScene` 的实例 `ZZBENCH_ShipSource` 继承它，但 `m_IsActive: 0` 所以尚未触发（实测组件完好：`MeshRenderer 3` / `LODGroup 1`）。

规模（`SampleScene` 的 `ZZBENCH_Suite`：`ShipCount = 10000`、`MaterialVariants = 1`、`Mode = 1`（ThroughBridge）、`MoveSpeed = 112.5`）：
```
1 艘船 = 1 父实体 + 1 组实体 + 3 层实体 = 5 个实体（源对象实测 3 个 MeshRenderer）
10000 艘 ⇒ 50000 个实体；同步表只登记 10000 个父物体（每帧 2 个 job 各处理 1 万条 transform）
父实体按每 chunk 上限 128 算，单个 archetype 至少 ceil(10000 / 128) = 79 个 chunk
```

---

## 6. 实现要点与坑
| # | 事实 | 依据 |
|---|---|---|
| 1 | **缩放必须 xyz 等比**：每实体只存一个标量 `Scale`（取 `.x`），三轴不一致时 `Debug.LogWarning` 后仍按 `.x` 走，会几何变形；子实体取**相对父**的世界尺度之比（`childWorld / parentWorld`），父世界缩放为 0 时退回 `localScale.x` 并警告 | `:599-604` / `:613-625` |
| 2 | **父物体双向同步，子物体相对变换只在转换那一刻写一次**；**Scale 两个方向都不同步**；别给参与同步的父物体挂 `Rigidbody`（每帧直写 `Transform` 会和物理打架），要物理就用 `TransformDrivenByEntity` | 两个 job 只写/只读 `Position`+`Rotation`；`DotsRenderAuthoring.cs:60` |
| 3 | **`IJobEntity` 想限定实体必须显式 `WithAll/WithAny/WithNone`** —— `Execute` 的 `Entity` 参数与 `[ChunkIndexInQuery]` 都不产生组件要求，漏了会静默退化成"整个世界"；`ComponentLookup` 在并行 job 里只能碰 `index` 那个实体（同步方向因此要 `[NativeDisableParallelForRestriction]`） | 工程踩坑记录 / `…SyncSystem.cs:69` |
| 4 | 视锥裁剪目前**恒判"可见"**（开放缺陷，两条用例 `[Ignore]`）：桥的视口剔除与 RVO 的 `WithNone<VisibilityCulledTag>()` **当前都是空转** | 工程踩坑记录 |
| 5 | LOD 层实体的 `LocalTransform` 取**相对直接父（`LODGroup`）**的 `localPosition`；若某层 renderer 是更深后代，会错位且**无警告**。同一对象同时带 `MeshRenderer` 与 `LODGroup` 时**只按 `LODGroup` 记**（先收 `LODGroup`，再排除被其 `GetLODs()` 引用的 renderer），否则同一目标转两次、实体数翻倍 | `DotsRenderLodSupport.cs:103-107` / `AuthoringSnapshot.cs:95-124` |
| 6 | 3 个组的挂载点写死在 `[UpdateInGroup]`（`InitializationSystemGroup` / `SimulationSystemGroup` + `OrderFirst` / `+ OrderLast`）；且**只桥接 `World.DefaultGameObjectInjectionWorld`**（不是 `ActiveWorld`） | `DotsRenderBridgeModule.cs:11-52` |
