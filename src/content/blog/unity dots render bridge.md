---
title: 'Unity DOTS —— 手写一套 GameObject → ECS 渲染桥'
description: '从零搭一座运行时渲染桥：逻辑留在 GameObject，只把绘制换成 ECS 批量提交，并把双向变换同步、剔除判据与销毁策略讲清楚'
pubDate: '2026-09-29'
category: '算法'
tags: ['Unity', 'DOTS', 'Entities Graphics', '渲染桥', 'GameObject']
---

## 速览

>- **要解决的问题**：你有一套跑得好好的 GameObject 逻辑（层级、`Transform`、`Collider`、自定义 `MonoBehaviour`），只想把**绘制**换成 Entities Graphics 的批量提交。
>- **做法**：被标记的父物体下方，每个 `MeshRenderer` 变成一个渲染实体，每个 `LODGroup` 变成「组实体 + 每层一个层实体」；父物体自己只留一个**逻辑父实体**负责搬运变换。
>- **两个方向各一个 `IJobParallelForTransform`**：帧初 GameObject → 实体，帧末 实体 → GameObject，且两者必须用**同一份**剔除判据，否则往返链路会被切断。
>- **原渲染器必须停止绘制**：转换只是"新增了实体"，不会让原来的 `MeshRenderer` 闭嘴，不处理就是同一份几何画两遍。
>- **可逆性要提前想清楚**：关掉域重载（Enter Play Mode Options）时，不可逆地销毁组件会**写坏场景资产**。

---

## 0. 成品长什么样

整座桥在系统更新顺序里只占三个位置：

```text
Initialization 阶段  InitializationSystemGroup
  └─ BridgeConversionGroup          建实体 / 销毁实体（消费队列）
Update 阶段
  ├─ ScriptRunBehaviourUpdate       ← MonoBehaviour.Update（逻辑侧改 Transform）
  └─ SimulationSystemGroup
       ├─ BridgeInputGroup  (OrderFirst)   Sync：GO ──▶ 实体
       ├─ …你自己的 system：这段时间"实体是权威"…
       └─ BridgeOutputGroup (OrderLast)    Push：实体 ──▶ GO
PreLateUpdate / PresentationSystemGroup
  └─ EntitiesGraphicsSystem         把这一帧的实体提交给渲染
```

读法：**帧初把 GO 的变换灌进实体，帧中让逻辑系统推进实体，帧末再把实体写回 GO**。这样外部的 `MonoBehaviour`、物理、相机跟随读到的 `Transform` 永远是最新值，而画面是实体画的。

不能只做单向 GO → 实体：实体侧算出的新位置就传不回去，碰撞体、UI 指示、其它脚本都会和画面对不上。另外 `SimulationSystemGroup` 是被追加在 `Update` 阶段末尾的（`MonoBehaviour.Update` 先跑、仿真后跑），这个先后由 `ScriptBehaviourUpdateOrder` 决定，**不同 Entities 版本可能微调**——需要严格顺序就用 `[UpdateAfter]` 显式声明，别默认"我一定在 Update 之前"。

---

## 1. 先划边界：留下什么，换掉什么

第一步不是写代码，是画一张"哪些东西还归 GameObject 管"的表。边界糊了，后面所有问题都是它引起的。

```text
GameObject 侧（保留，权威输入端）              实体侧（只建"要绘制"的部分）
父物体 [BridgeAuthoring]                  父实体  LocalTransform + LocalToWorld + BridgeLink
 └─ [LODGroup]                       ──▶ ├─ LOD 组实体   MeshLODGroupComponent
     ├─ MeshRenderer ①               ──▶ │   ├─ 层实体   MeshLODComponent · LODMask = 1<<层下标
     ├─ MeshRenderer ②               ──▶ │   ├─ 层实体（同层多个 renderer 共用一个 mask）
     └─ MeshRenderer ③               ──▶ │   └─ 层实体
   Collider / 脚本 / 层级                  （不进实体，继续按 MonoBehaviour 跑）
```

层级、`Transform`、`Collider`、`Rigidbody`、你自己的 `MonoBehaviour` **原样保留**（这是现有工程的价值所在）；`MeshRenderer` / `LODGroup` 转换后**停止绘制**（见下文）；`SkinnedMeshRenderer` / `ParticleSystem` / `Terrain` / 光照贴图数据**不支持**——蒙皮与粒子有自己的数据流，桥不过去比桥错了强。Unity 还有 SubScene / Baker 的烘焙式转换，它很好，但那是**构建期、不可逆**的。运行时桥的取舍正好相反：转换发生在运行时、可撤销、粒度是"一个被标记的父物体"。

### 1.1 标记组件顺便是"门面"

标记组件不只是个 Tag，它同时充当"这座桥的实体句柄"：外部想给某个实体写组件时，不需要知道实体是哪个、建好了没有。

```csharp
public enum BridgeScope
{
    Parent,         // 只逻辑父实体（写操作默认）
    RenderTargets,  // 子渲染实体 + LOD 组实体 + 层实体（不含父实体）
    All,            // 两者都含，父实体恒为第一个
}

public sealed class BridgeAuthoring : MonoBehaviour
{
    public DisposalMode Disposal = DisposalMode.ForceRenderingOff;
    [Min(0f)] public float CullMargin = 1f;
    internal BridgeSnapshot Snapshot;   // 采集到的渲染描述（见第 2 节）
    internal BridgeRegistry Registry;   // 全局同步表
}
```

门面的价值在**时序**上。如果 `go` 是这一帧刚 `Instantiate` 的，转换还没发生、实体根本不存在，天真的实现会抛 `NullReferenceException` 或静默失败。正确做法：**没建好 → 返回 `Queued` 并记进待应用队列；建好后按调用顺序补做**。

```csharp
public BridgeOpResult AddComponent<T>(T component, BridgeScope scope = BridgeScope.Parent)
    where T : unmanaged, IComponentData
{
    if (!Registry.IsAlive(this))                            // 实体还没建好
    {
        pendingOps.Add(BridgeOp.Add<T>(component, scope));  // 排队，不是报错
        return BridgeOpResult.Queued;
    }
    ApplyToOne(component, scope);
    return BridgeOpResult.Applied;
}
```

`BridgeScope` 的三种取值决定"一次调用改几个实体"：`Parent` 只改逻辑父实体（默认值，因为绝大多数游戏逻辑针对的是"这个物件"）；`RenderTargets` 改子渲染实体 + LOD 组实体 + 层实体；`All` 两者都含，父实体恒为第一个。

---

## 2. 转换流程：标记 → 快照 → 入队 → 建实体

天真的做法是在 `OnEnable` 里直接建实体，它会同时踩三个坑：① 在 GameObject 生命周期回调里碰 `EntityManager` 是个**同步点**，打断了正在进行的批量创建，性能与行为都不可预测；② 一次 `Instantiate` 触发一批 `OnEnable`，你无法保证父先于子、也无法保证读到的 `Transform` 已是最终值；③ 预制体路径下你既不能随便改资产，也不想让它进队列。

```text
① 标记 / 采集                  ② 入队                     ③ 转换（Initialization）
[BridgeAuthoring]              BridgeConversionQueue      BridgeConversionSystem.OnUpdate
 OnEnable → InitializeEntity    Register / Unregister      ├ ① 先 Complete 两个 PendingJob
  ├─ CaptureSnapshot ─▶ Snapshot                            ├ ② 先 Unregister 再 Register
  └─ EnqueueRegister ──queue───────────────────────────────▶ └ ③ BuildEntityTree
                                                                     │
     ┌───────────────────────────────────────────────────────────────┘
     ▼
父实体 + 每个 MeshRenderer 一个子实体（RenderMeshUtility.AddComponents）
      + 每个 LODGroup 一组层实体
```

**快照只固化"之后再也拿不到"的东西**——判断标准一句话：这个值在我停止绘制 / 销毁组件之后还拿得到吗？**必须固化**的是 `Mesh`、材质数组、子网格数、`RenderMeshDescription`，以及描述 LOD 层结构的 blob（层与 renderer 的对应关系）；**不要固化**的是 `Transform` 的位置 / 旋转、`layer`、`name` 这类实时值，每次转换时现读。反面例子：把 `transform.position` 也塞进快照，看着无害，实际会在"标记后隔两帧才轮到转换"时用两帧前的位置建实体——第一帧就抖一下。

**两个必须遵守的顺序约束**。约束一：**写注册表之前必须先收掉两个 job**。注册表里有 `NativeList<Entity>` 和 `TransformAccessArray`，两个同步 job 都持有它们的视图，在这里 `Add` / `MarkDead` 就是改 job 正在读的容器。

```csharp
m_Sync.PendingJob.Complete();      // 建实体之前，先把两个 job 收干净
m_Push.PendingJob.Complete();

if (created.Count == 1)            // 只剩父实体 ⇒ 没有任何东西要画
{
    em.DestroyEntity(created[0]);
    DropOperations(operations);    // 别把这些操作泄漏到下一条
}
```

顺手解释 `created.Count == 1`：一个被标记的父物体如果下面一个 `MeshRenderer` 都没有，它就只有一个空父实体——不画任何东西，却要占同步表一个槽位、每帧被两个 job 各处理一次。**建完立刻销毁它**，并把这一批待应用操作丢掉（否则操作会应用到下一批实体上，那是最难查的一类 bug）。

约束二：**排队操作逐条「记录 → Playback」**。因为操作之间可能有依赖：先 `AddComponent<CulledTag>()`，再 `SetComponent(new CulledTag { ... })`；全记成一批最后统一 Playback 的话，第二条在记录时实体上还没有那个组件，就静默丢了。

```csharp
foreach (var op in pendingOps) { op.RecordTo(ecb); ecb.Playback(em); }
//                              ↑ 少了 Playback，下一条 op 看不到上一条的结果
```

反过来，**实体已经就绪时**（直接应用、不是排队），一次调用 = N 条记录 = 一次 Playback 是对的：这些记录之间没有依赖，合并提交更快。

**建树：一个父物体产出多少实体**。骨架如下（LOD 分支里，层实体的 `LocalTransform` 取"相对直接父（`LODGroup`）"的值）：

```csharp
void BuildEntityTree(in BridgeRegistration reg, EntityCommandBuffer ecb)
{
    Entity parent = ecb.CreateEntity();
    ecb.AddComponent(parent, LocalTransform.FromPositionRotationScale(
        reg.Position, reg.Rotation, reg.UniformScale));   // 见第 6 节的缩放限制
    ecb.AddComponent(parent, new BridgeLink
    {
        Target = reg.Source,            // 存 GameObject，不是组件引用（原因见第 4 节）
        Kind   = BridgeLinkKind.Parent,
    });

    foreach (var mr in reg.Snapshot.MeshRenderers)
    {
        Entity child = ecb.CreateEntity();
        ecb.AddComponent(child, LocalTransform.FromPositionRotationScale(
            reg.RelativePosition(mr.Transform), reg.RelativeRotation(mr.Transform), 1f));
        ecb.AddComponent(child, new BridgeLink { Target = mr.Source, Kind = BridgeLinkKind.MeshRenderer });
        RenderMeshUtility.AddComponents(child, EntityManager, reg.Snapshot.RenderDescription,
                                        reg.Pool.Register(mr.Mesh, mr.Materials, mr.SubMeshCount),
                                        new MaterialMeshInfo());
    }

    foreach (var lod in reg.Snapshot.LodGroups)
    {
        Entity group = ecb.CreateEntity();
        ecb.AddComponent(group, new MeshLODGroupComponent { /* LODDistances0/1 来自 LODGroup */ });
        ecb.AddComponent(group, new BridgeLink { Target = lod.Source, Kind = BridgeLinkKind.LodGroup });
        for (int level = 0; level < lod.LevelCount; level++)
        {
            Entity layer = ecb.CreateEntity();
            // 层实体的 LocalTransform 取"相对直接父（LODGroup）"的值
            ecb.AddComponent(layer, new MeshLODComponent
            {
                Group   = group,
                LODMask = 1 << level,   // 同层的多个 renderer 共用一个 mask
            });
        }
    }
}
```

数一下规模：**一个被标记父物体 = 1 个逻辑父实体 + N 个渲染实体**。若父物体下有 2 个 `MeshRenderer` 和 1 个三层 `LODGroup`，最终是 1 + 2 + 1 + 3 = 7 个实体，但同步表**只登记父物体**，占 1 个槽位。

同步表的槽位和实体数量是**两回事**——这是整座桥最重要的性能设计：每帧两个 job 处理的是"被标记父物体"的 `Transform`，不是"所有实体"。

---

## 3. 双向同步：两个 job，一个索引表

### 3.1 索引严格对齐与两个 job

两个方向都基于 `TransformAccessArray` + `IJobParallelForTransform`，索引与 `registry.Entities`（`NativeArray<Entity>`）严格对齐：`Execute` 的第 `index` 个 transform 就是第 `index` 个实体。所以增删只能**同时**改两个容器，并用 swap-back 保持对齐：

```csharp
int last = Entities.Length - 1;
Transforms.RemoveAtSwapBack(index);   // 内部把 last 挪到 index
Entities[index] = Entities[last];     // 手工做同样的 swap
Entities.RemoveAt(last);
```

**忘了对齐 `Entities`**：从这一刻起每个索引都错位，GO A 的变换被写进实体 B，画面像"随机抖动"，且不报任何错。

同步方向的 job 长这样；回写方向的 job 结构相同，只是最后一跳换成把 `t.Position` / `t.Rotation` 赋给 `transform`：

```csharp
[BurstCompile]
struct SyncJob : IJobParallelForTransform
{
    [NativeDisableParallelForRestriction]      // 每个 index 只碰自己的实体，必须放开限制
    public ComponentLookup<LocalTransform> Transforms;
    [ReadOnly] public ComponentLookup<CulledTag> Culled;
    [ReadOnly] public NativeArray<Entity> Entities;

    public void Execute(int index, TransformAccess transform)
    {
        Entity e = Entities[index];
        if (Culled.IsCulled(e)) return;             // 与回写方向同一个判据（§3.4）

        var t = Transforms[e];
        if (math.all(t.Position == (float3)transform.position) &&
            math.all(t.Rotation.value == ((quaternion)transform.rotation).value))
            return;                                // 值没变，一个字段都不写

        t.Position = transform.position;
        t.Rotation = transform.rotation;
        Transforms[e] = t;
    }
}
```

```csharp
// 调度：同步方向只读 GO 侧，用只读重载；回写方向必须等它
m_Sync.PendingJob = new SyncJob { ... }.ScheduleReadOnly(registry.Transforms, 64, Dependency);
m_Push.PendingJob = new PushJob { ... }.Schedule(registry.Transforms,
    JobHandle.CombineDependencies(m_Sync.PendingJob, Dependency));
```

- **`ScheduleReadOnly` vs `Schedule`**：前者告诉 Job 系统"这个 job 不改 `Transform`"，于是能和其它只读 transform 的 job 并行。回写方向要写 GO，只能用 `Schedule`，**没有 `batchCount` 重载**，并行度交给调度器决定。反过来若回写不等同步，同一帧里就可能读到半新半旧的中间态。

### 3.3 往返的每一帧

```text
帧 N                                         帧 N+1
GO.Transform = P0                             GO.Transform = P1
  │ Sync（读 GO，写实体）                        │ Sync
  ▼                                            ▼
实体.LocalTransform = P0                      实体.LocalTransform = P1
  │ 你的逻辑系统推进实体                          │ 逻辑系统推进
  ▼                                            ▼
实体.LocalTransform = P1                      实体.LocalTransform = P2
  │ Push（读实体，写 GO）                        │ Push
  ▼                                            ▼
GO.Transform = P1                             GO.Transform = P2
```

一轮下来 GO 的位置"慢一帧"——不可避免，因为 GO 既是输入也是输出。想要 GO 零延迟，就得放弃"GO 是权威输入"、改成实体权威、GO 只读。**先把谁是权威定下来再写代码**，否则你会一直在两种语义之间打补丁。

### 3.4 为什么两个方向必须用同一份剔除判据

这是整座桥最反直觉、也最容易踩的一条。假设你想省点工作量：视口外的对象反正看不见，帧末别写回了。听起来完全合理。

```text
❌ 只在"实体 → GO"方向剔除                 ✅ 两个方向用同一份判据
  视口外的对象：                              视口外的对象：
   Sync  GO 旧位置 ─覆盖─▶ 实体                Sync  判定被剔除 ⇒ 跳过，不用 GO 的值覆盖实体
   Push  判定被剔除 ⇒ 跳过 ⇒ GO 停住             Push  判定被剔除 ⇒ 跳过，不把 GO 拉回来
   往返链路被切断 ⇒ 对象彻底冻结                实体照旧推进，回视野那一帧一次追上
```

关键在**同步方向会写**。很多人下意识觉得"GO 只是写目标，不会往回污染"，但帧初的 `Sync` 是**从 GO 读值、往实体写**的。视口外你不 `Push`，GO 的位置就停在离开视口那一帧；下一帧 `Sync` 又把这个**过时的 GO 值**灌回实体，把实体刚推进的位移覆盖掉——对象看起来"冻"在视口外，回到视野才猛地跳一下。这个症状和"逻辑系统没跑"一模一样，很容易查错方向。

修法就是把同一份判据装进两个 job。注意下面这个查表的**顺序不能反**：`IsComponentEnabled` 对"没挂该组件"的实体会**抛异常**，不是返回 `false`。

```csharp
// Sync / Push 共用，逐帧现取（CulledTag 是可选组件）
static bool IsCulled(this in ComponentLookup<CulledTag> tags, Entity e)
    => tags.HasComponent(e) && tags.IsComponentEnabled(e);
```

可选组件的 `ComponentLookup` 必须在 job 里现取，不能在 `OnCreate` 缓存——那时实体可能还没挂上这个标签。也要诚实写下代价：对**纯 GO 驱动**的对象（不往回走的），视口外那一段位移会被过时的实体值覆盖一次，回视野时位置回跳。所以"同一份判据"是前提，"用不用剔除"是后面的事。

> 剔除本身怎么算，看本系列另一篇《Unity DOTS —— 视锥剔除：让逻辑侧也知道"看不见"》。这里只强调"两端同一份判据"这条架构约束。

---

## 4. 定位、合批与"停止绘制"

**存 GameObject，不存组件引用。** `BridgeLink` 由 `UnityObjectRef<GameObject> Target` 加一个 `BridgeLinkKind` 组成。`Kind` 取 `Parent`（逻辑父实体，指向被标记的父物体）、`MeshRenderer`（指向那个 `MeshRenderer` 所在的 GameObject）、`LodGroup` / `LodLayer`（指向 `LODGroup`、该层 renderer 所在的 GameObject）。为什么存 GameObject 而不是 `MeshRenderer` 引用？因为在"销毁组件"模式下 `DestroyComponents` 会把 `MeshRenderer` 真正销毁，此后任何组件引用都变成 fake-null（`== null` 为 true 但对象还在），你连"这个实体对应谁"都定位不到。**GameObject 是组件消失后唯一稳定的锚点。**

**合批的基础是一个去重的池。** Entities Graphics 通过 `MaterialMeshInfo` 里的索引找到 `(mesh, 材质, 子网格)` 组合。给每个实体建独立的 `RenderMeshArray` 就等于放弃合批。池的键是 `(mesh, 材质序列, 子网格数)`，关键设计是**索引只追加、不重排**——已发出的 `MaterialMeshInfo` 永久有效，新条目命中旧条目时直接返回旧结果。

| 量 | 上限 | 原因 |
|---|---|---|
| 单代条目上限 | **65535** | 索引转 `ushort` 的位宽限制，超了要开新"代" |
| 单 mesh 子网格上限 | **127** | 32 位索引信息里 range length 只有 7 bit，构造函数断言 `rangeLength < 1 << 7` |

所以池要多代：第一代满了开第二代，查询时先查所有代，命中旧代就返回旧代的结果。别想着"满了重建整个池"——那会让所有已发出的索引失效。

**不停止绘制 = 画两遍。** 这一步最容易被跳过：转换只是**新增**了实体，原来的 `MeshRenderer` 一个字节都没动。不处理就是同一份几何被 GameObject 管线画一遍、Entities Graphics 再画一遍，表现为画面变亮、半透明物体颜色变浓、深度冲突闪烁。

| 模式 | `MeshRenderer` | `LODGroup` | 可逆 |
|---|---|---|---|
| `ForceRenderingOff`（默认） | `forceRenderingOff = true` | `enabled = false` | ✅ |
| `DisableComponents` | `enabled = false` | `enabled = false` | ✅ |
| `DestroyComponents` | `Destroy(MeshFilter)` + `Destroy(renderer)` | `Destroy(lodGroup)` | ❌ |

`LODGroup` **没有** `forceRenderingOff`，对它来说前两种模式等价，都是把组件 `enabled` 关掉；`DestroyComponents` 首次触发应打一条**一次性**警告。快照是 `DestroyComponents` 之后**唯一**的重建依据：注册一律从 `BridgeSnapshot` 读输入，只有 `Transform`、`layer` 这类实时值才现读。

---

## 5. 销毁、注销与"关掉域重载"的坑

注销的顺序是：丢掉待应用操作（目标马上没了）→ 按 `Disposal` 逐个 `Restore` → `DestroyEntity` → 同步表 swap-back 移除。**先还原再销毁实体**：反过来的话，回写 job 可能在你还原之后、销毁之前跑一次，用实体的旧值覆盖刚还原好的 `Transform`。

**Enter Play Mode Options 会改变销毁的语义。** 它可以**关掉域重载和场景重载**，进 Play 更快；代价是**静态字段和场景对象跨 Play 会话保留**。后果直接砸在 `Disposal` 模式上：

| 模式 | 关掉域重载时的行为 |
|---|---|
| `ForceRenderingOff` / `DisableComponents` | 退出 Play 时 `Restore` 把 `forceRenderingOff` 复位、`enabled = true`，正常 |
| `DestroyComponents` | `Object.Destroy` 销毁的是**被复用的那个场景对象**上的组件；退出 Play **不会恢复** |

更糟的是：一旦在这种状态下保存场景，销毁就**写进了场景资产**——`MeshFilter` 和 `MeshRenderer` 真的没了，下次打开场景也回不来。所以 `Restore` 在 `DestroyComponents` 下只能是**安全的 no-op**（而不是抛异常，那会掩盖真正的问题）。

```csharp
void Restore(Entity e)
{
    var go = EntityManager.GetComponentData<BridgeLink>(e).Target.Value;
    switch (Disposal)
    {
        case DisposalMode.ForceRenderingOff:
            if (go.TryGetComponent<MeshRenderer>(out var mr)) mr.forceRenderingOff = false;
            break;
        case DisposalMode.DisableComponents:
            if (go.TryGetComponent<MeshRenderer>(out var mr2)) mr2.enabled = true;
            break;
        case DisposalMode.DestroyComponents:
            break;   // 组件已经不在了 —— 静默返回，别抛异常
    }
}
```

**建议**：如果工程关掉了域重载，就把 `DestroyComponents` 从可选项里去掉（或至少默认改成可逆模式并在 Inspector 里显著警告）。把它开放给用户，本质是给了一个"按一下就把场景资产写坏"的按钮。

**预制体路径**：预制体走同一个建树函数，但有一条铁律——**绝不触碰预制体上的组件**（预制体资产共享，改了所有实例都变）。所以预制体路径下不做"隐藏原渲染器"，并靠 `LinkedEntityGroup` 做级联销毁：父实体销毁时同组的渲染实体一起走，省掉手工遍历。

---

## 6. 实现要点与常见坑

**缩放只支持等比**。每个实体只存一个标量 `Scale`，而 `TransformAccess` **没有** `lossyScale` 这类便捷入口（只能从 `localToWorldMatrix` 列长反推，代价高且容易写错）。所以：转换那一刻按 `localScale.x` 写一次；三轴不一致时 `Debug.LogWarning` 之后**仍按 `.x` 走**（几何会变形，但你至少知道了）；**两个同步方向都不碰 `Scale`**，运行时改 GO 缩放实体不会跟着变。子实体的缩放取"相对父的世界尺度之比"（`childWorldScale / parentWorldScale`），父世界缩放为 0 时退回 `localScale.x` 并警告。

**父子各自的同步范围**。**父物体双向同步**（位置 + 旋转）；**子实体的相对变换只在转换那一刻写一次**——运行时单独去动某个渲染子物体的 GO，桥不会同步它，它已经是实体的了。好记的规则：**同步表里只有父物体**；想让某个子物体也参与动画，就把它提成被标记的父物体。另外**别给参与同步的父物体挂 `Rigidbody`**：桥每帧直接写 `Transform.position`，物理引擎也每帧想写它，两者打架的结果是抖动、穿透或者物理完全失效。要物理驱动就让实体权威（`Physics` 写实体），用 `TransformDrivenByEntity` 之类的组件把 GO 标记成"只读跟随者"，此时同步方向对这个对象什么都不做。

**`IJobEntity` 的过滤必须显式写**：

```csharp
// ❌ Execute 的 Entity 参数和 [ChunkIndexInQuery] 都不产生组件要求
partial struct BadJob : IJobEntity
{ void Execute(Entity e, [ChunkIndexInQuery] int chunk, ref LocalTransform t) { } }

// ✅ 显式声明要求
[WithAll(typeof(BridgeLink))]
partial struct GoodJob : IJobEntity { /* ... */ }
```

漏了 `WithAll` / `WithAny` / `WithNone`，query 就退化成"整个世界"，job 会去处理一堆不相关实体——而且**不报错**，只是慢和算错。

**`ComponentLookup` 在并行 job 里只能碰自己那个索引。** `IJobParallelForTransform` 的每个 `index` 只允许访问 `Entities[index]` 那一个实体，同步 job 恰好满足。若想在并行 job 里访问**别的**实体（比如跳到父实体改组件），Job 系统会报安全错误；解决办法是 `[NativeDisableParallelForRestriction]`，**但你必须自己保证没有数据竞争**——同一个实体不能被两个 `index` 同时写。

**同一对象同时带 `MeshRenderer` 和 `LODGroup` 时，先收 `LODGroup`。** 天真做法是先遍历所有 `MeshRenderer` 建子实体、再遍历 `LODGroup` 建层实体，结果 LOD 里引用的 renderer 被转了两次，实体数翻倍、每帧多画一份。正确顺序是把 `GetLODs()` 引用到的 renderer 全部记进一个 `claimed` 集合，再遍历 `MeshRenderer` 并跳过 `claimed` 里的那些。另外，层实体的 `LocalTransform` 取的是**相对直接父（`LODGroup`）**的值；如果某层的 renderer 挂在更深的后代节点上，位置会错位且**不会有任何警告**——稳妥做法是沿层级链累乘出真实的相对变换，而不是想当然地"父就是 LODGroup"。

**组的挂载点应当固定下来。** 三个组分别用 `[UpdateInGroup(typeof(InitializationSystemGroup))]`、`[UpdateInGroup(typeof(SimulationSystemGroup), OrderFirst = true)]`、`[UpdateInGroup(typeof(SimulationSystemGroup), OrderLast = true)]`。这三点一定，"帧初同步 / 帧末回写"就是**结构保证**的，不依赖任何人记得写 `[UpdateBefore]`。同时注意只桥接 `World.DefaultGameObjectInjectionWorld`——`World.Active` 在多世界场景下并不等于"GO 所在的那个世界"。

**小结**：

| 设计决定 | 不这么做会怎样 |
|---|---|
| 采集与建实体分两步（标记 → 快照 → 入队 → 建） | 在 `OnEnable` 里建实体：顺序不可控、同步点、预制体冲突 |
| 快照只固化"之后拿不到"的值 | 把 `position` 也快照：标记到转换之间动过的对象，第一帧位置抖动 |
| 索引严格对齐 + swap-back | 索引错位：A 的变换写进 B，画面随机抖动且无报错 |
| 两个方向同一份剔除判据 | 视口外的对象被过时 GO 值覆盖，永久冻结 |
| 停止原渲染器绘制 | 同一份几何画两遍，透明物体颜色变浓 |
| 存 GameObject 而非组件引用 | 销毁组件后定位全丢（fake-null） |
| 池只追加不重排 | 重排会作废所有已发出的 `MaterialMeshInfo` |
| 显式 `WithAll` / `WithAny` / `WithNone` | query 静默退化成整个世界 |
| 不可逆销毁要防域重载 | 保存场景时把销毁写进资产 → 永久损坏 |
| `HasComponent` 在前、`IsComponentEnabled` 在后 | 对没挂组件的实体抛异常 |

---

## 7. 自己动手的推荐顺序

照着这篇从零实现的话，按这个顺序验证，每一步都可运行、可回滚：

1. **只做"标记 + 建父实体 + 帧初同步"**。此时画面还是 GameObject 在画，但你能在 Entity Debugger 里看到父实体跟着 GO 动——先证明同步链路是通的。
2. **加一个 `MeshRenderer` 子实体，并把 GO 的 `MeshRenderer` 关掉**（`ForceRenderingOff`）。画面不变就说明实体画对了。
3. **加帧末回写**。让一个逻辑系统每帧给实体 `Position.x += 1`，看 GO 是否跟着走、有没有抖动。
4. **加 `LODGroup` 分支和池**。观察实体数与 chunk 数是否符合预期（一个父物体一个槽位）。
5. **最后接剔除，而且两个方向一起接**。只接一个方向会得到"视口外冻结"这个经典症状，正好用来检验你有没有真的理解 §3.4。
