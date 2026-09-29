---
title: 'Unity DOTS —— 视锥剔除：让逻辑侧也知道"看不见"'
description: '拆解 DOTSUtils.Visibility：从相机取六个世界空间平面、逐点判定、写 IEnableableComponent 开关位，以及一个尚未定位的开放缺陷'
pubDate: '2026-09-29'
category: 'Unity DOTS'
tags: ['Unity', 'DOTS', '视锥剔除', 'IEnableableComponent']
---

## 速览
>- Entities.Graphics 的剔除只管**画**；**逻辑**侧（RVO 推进、变换回写）照样在跑视口外的实体。
>- 本模块是「在不在视锥里」的**单一真源**：`VisibilitySystem` 每帧写 `VisibilityCulledTag`，谁需要谁读。
>- 算法：`GeometryUtility.CalculateFrustumPlanes(camera)` 给出 6 个**世界空间、法线朝内**的平面，逐实体判 `dot(n,p)+d+Margin < 0` → 在外。
>- 结果是 `IEnableableComponent` 的**开关位**（启用 = 被裁剪），不增删组件、不换 archetype。⚠️ 但**已知缺陷**：job 恒判「可见」，根因未定位（§6）。

---

## 1. 为什么需要它
Entities.Graphics 的剔除作用在渲染实体上，结果只是"这一帧没画"。逻辑侧该跑还是跑：
| 消费方 | 不知道可见性的后果 |
|---|---|
| `RvoSolveSystem` | 视口外的 agent 照样求解、照样积分 → 白烧 CPU |
| `DotsRenderTransformPushSystem`（帧末 实体→GO） | 把不可见对象的位置写回 GameObject |
| `DotsRenderTransformSyncSystem`（帧初 GO→实体） | 用**过时的** GO 位置覆盖实体 |

实测缺陷：**只有回写方向剔了**，帧初同步仍无条件把 GO 的值写回实体 → "实体推进 → 帧末回写 GO → 下帧初同步回来"
在视口外被切断，表现是**视口外的对象彻底冻结**（走桥路径的船最明显）。修法是两向共用一个判据——判据只能有一份，
这就是本模块的理由：它只回答"在不在视锥里"，怎么用由消费方决定。

---

## 2. 算法
### 2.1 取视锥
`VisibilitySystem.TryBuildFrustum()`（`VisibilitySystem.cs:54-74`）：① 经 `VisibilitySettings.CameraProvider`
（默认 `() => Camera.main`，`VisibilitySettings.cs:25`）拿相机，`null` → 本帧退化成"全部可见"；
② `CalculateFrustumPlanes(camera)`（`:65`）→ 透视图 **6 个世界空间平面、法线朝内**；
③ 每个压成 `float4(n.xyz, distance)`（`:70`），即平面方程 `dot(n,p) + d = 0`。
**不自己从矩阵提**：`projectionMatrix * worldToCameraMatrix` 对行列约定极敏感，写错不报错、只把视锥判歪
（实测过近/远平面互换 → "相机背后"当成可见，PITFALLS §4.11）。

### 2.2 法线与"哪一侧"
法线朝内 ⇒ **内部点对全部 6 个平面的有符号距离都 ≥ 0**。判"在外"就一行（`:108-109`）：
```csharp
private bool Outside(float4 plane, float3 position)
    => math.dot(plane.xyz, position) + plane.w + Margin < 0f;
```
`Margin` 加在有符号距离上 = 把 6 个平面**整体朝外推**（`VisibilityConfig.cs:12`，默认 `1f`）：贴边实体提前算可见，
抑制"压在边界上一帧剔、一帧不剔"的抖动。正后方则天然被 **near 平面**挡住：其法线与视线同向，背后点距离项是大负数。
```
俯视剖面（只画 left/right，另 4 个同理）
   left n→                     n→ right
      ╲                            ╱
       ╲    ┌─ 视锥内部 ─┐        ╱
●B ─────╲   │    ●A      │       ╱    ← B 在 left 外侧
（在外）  ╲  └────────────┘      ╱
           ●───────────────────●  相机（视锥顶点）
            ╲     +z →      ╱
 inside ⟺ 6 个平面全部 dot(n,p)+d ≥ 0    outside ⟺ 任一平面成"外"即判在外
```
### 2.3 判定粒度是**点**，不是 AABB
以代码为准：**当前是纯点测试**。job 只读 `LocalTransform`、用 `transform.Position` 一个点（`:93-96`）；
全工程**没有** `TestPlanesAABB`，也没有 `Plane.GetDistanceToPoint`（托管 API，Burst job 用不了）；
`Common/Utils/AABB.cs` 的 `AABB` 只有 `Intersects`/`Contains`，**没有与平面求交的方法**，本模块一行都没用。
点的好处是便宜，代价是 **pivot 一出视锥就算不可见**（中心在外、本体压着视口的大物体会被误剔）。球（中心 + 半径）更省一步 `dot`
但对非球形物过保守；AABB 更贴合盒状、代价是要拿到尺寸——换成 AABB 仍是分离轴那一套，只给平面距离加一个投影半径：
```
点测试（现状，r ≡ 0）          AABB 测试（本模块未实现）
 p = transform.Position        c = 盒中心，e = 半长
 dot(n,p)+d+Margin < 0 ?       r = |n.x|·e.x + |n.y|·e.y + |n.z|·e.z
                               dot(n,c)+d+r < 0 ?  ← 点测试就是 r = 0 的退化情形
 便宜；pivot 出界即剔除         更准；但要实体的尺寸/包围盒（本模块拿不到）
```
---

## 3. 实现过程
### 3.1 配置
`VisibilityConfig` 只有 `Enabled`（关掉 = 全部可见）和 `Margin`，是**全局配置**、所有 World 共用一份：
```csharp
VisibilitySettings.Configure(VisibilityConfig.Default);
VisibilitySettings.CameraProvider = () => someCamera;   // 以哪个相机为准
```
与 `RvoSettings` 的差别：后者有 `Version`（配置改动计数），**`VisibilitySettings` 没有版本字段**；
`VisibilitySystem` 每帧现读 `Pending`（`:31`），所以 `Configure` **立即生效**、不是"装配时取走一次"（类注释写的是后者，以代码为准）。
`Reset()` 另有 `[RuntimeInitializeOnLoadMethod(SubsystemRegistration)]` 钩子（`:38-39`）——本工程关了域重载，静态字段跨 Play 保留。

### 3.2 组与模块
`VisibilityGroup` 挂 `SimulationSystemGroup`，`VisibilitySystem` 在组内（`VisibilityGroup.cs:11-13`）。硬契约：
**消费 `VisibilityCulledTag` 的系统必须 `[UpdateAfter(typeof(VisibilityGroup))]`**（`RvoGroup` 也这么写）。
`DotsVisibilityModule` 的 `SortKey = 220`（Spatial 200 之后、Rvo 250 之前）只管**装配顺序**，执行顺序靠 `[UpdateAfter]`；
它**不声明 `Templates`**，是"可选能力"，由别的模块 `Requires` 拖进来。

### 3.3 每帧做什么
```
VisibilitySystem.OnUpdate()                 ← 主线程，每帧一次
 ├─ config = VisibilitySettings.Pending                      :31
 ├─ if (!config.Enabled || !TryBuildFrustum()) ───────┐
 │    收不到相机 → false                               ▼
 │                        SetCulledJob{Culled=false}  :36
 └─ else CalculateFrustumPlanes → float4[n.xyz,d]×6   :65-71
      VisibilityJob{P0..P5, Margin}.ScheduleParallel() :41-50
        └─ 按 chunk 并行：outside = P0||…||P5        :97-102
             culledRef.ValueRW = outside             :105
```
① **6 个平面逐个当 job 字段传**（`P0`…`P5`），不塞容器：实测 `FastList128Bytes` 传进 `IJobEntity` 后
job 里读到**空列表且不报错**，症状正是"所有实体都被判成可见"，极难查。② **只处理显式挂了标签的实体**
（`EnabledRefRW<T>` 要求组件存在），没挂的一概不管、读取侧也当它们"可见"——没有信息 ≠ 不可见。③ **只写入、不行为**。

### 3.4 为什么用 `IEnableableComponent`
`VisibilityCulledTag` 是空 struct + `IComponentData, IEnableableComponent`（`VisibilityCulled.cs:37`），**启用 = 被裁剪**。
增删组件表达状态 = **结构性变更** → 换 archetype → memcpy 搬家，渲染实体还会逼 Entities Graphics 重建批次；
而 `SetComponentEnabled<T>` / `EnabledRefRW<T>` 只翻 chunk 掩码 1 个 bit，archetype 不变，**job 里就能改**（无 ECB、无同步点）。
可见性**每帧都可能翻转**（相机一转，实体反复进出视锥），正是 enableable 的场景。三态语义：
| 状态 | 含义 |
|---|---|
| 没挂标签 | 不参与裁剪，**照常处理**（模块不自动挂，作者显式 `AddComponent`） |
| 挂了 + **禁用** | 可见（系统每帧写；刚 `AddComponent` 后也是先手动摆成这个态） |
| 挂了 + **启用** | 不可见，消费方跳过 |

---

## 4. 消费方怎么读
**能改 query 的**用泛型 `WithNone<VisibilityCulledTag>()`（`RvoSolveSystem.cs:78-84` 求解查询、`:95` 计数查询）。
必须用**泛型**重载：`EntityQueryDesc.None`（吃 `ComponentType` 的那个）对 enableable 只匹配"没挂"，**匹配不到"挂但禁用"**。
**改不了 query 的**走 `VisibilityAccess`：
```csharp
// VisibilityAccess.cs:26-27
public static bool IsCulled(in ComponentLookup<VisibilityCulledTag> tags, Entity entity)
    => tags.HasComponent(entity) && tags.IsComponentEnabled(entity);
```
两个场合：① `IJobParallelForTransform`（渲染桥两个方向）——job 里没有 query 可改；② 判断**别的**实体——Rvo 过滤邻居
就是这条（`:357`，被裁剪的邻居等同于不存在）。**顺序不能反**：`IsComponentEnabled` 对"没挂该组件"的实体**抛异常**。
| 渲染桥 | 组 / 时机 | 被裁剪时 |
|---|---|---|
| `DotsRenderTransformSyncSystem` | `RenderBridgeInputGroup`（`OrderFirst`，帧初） | **不把 GO 的值写进实体**（`:97`） |
| `DotsRenderTransformPushSystem` | `RenderBridgeOutputGroup`（`OrderLast`，帧末） | **不把实体写回 GO**（`:101`） |
两个 job 每帧现取 `ComponentLookup`（`Push:65`、`Sync:59`），不在 `OnCreate` 缓存（该类型可选）。同步组是 `OrderFirst`、
`VisibilityGroup` 是默认档，所以同步方向读的是**上一帧的位**。

---

## 5. 性能与正确性权衡
| 维度 | 现状 | 说明 |
|---|---|---|
| 相机数量 | **单相机** | `CameraProvider` 只返回一个 `Camera`、全局一份标记；多相机要"一实体对多相机"的位掩码或分桶，**当前不支持** |
| 判定 / 标记粒度 | per-entity，并行按 chunk | `ScheduleParallel()` 的并行单元是 chunk；chunk 内可既有可见又有不可见，无需拆块 |
| 每帧固定开销 | 1 次取视锥 + 1 个 `Plane[]` 分配 | 用了返回数组的重载（`:65`）；`CalculateFrustumPlanes(Camera, Plane[])` 那个 `void` 重载可零分配，本模块没用 |
| 遮挡剔除 / 空间加速 | **都不做** | 遮挡剔除要读深度缓冲、做光栅化或硬件查询，CPU 侧的逻辑模块拿不到这些；也没做"视锥 vs 空间索引树"的粗剔除，全量扫一遍 |
**保守是硬要求**：假阴（误判不可见）让逻辑静默跳过——RVO 不推进、位置不回写，物体卡住且无报错；假阳只是白算一点。
所以所有退化路径都倒向"全部可见"：拿不到相机 / `Enabled = false` / 没挂标签。

---

## 6. 已知问题 / 待确认（未解决的开放缺陷）
**现象**：`VisibilityJob` 恒判「可见」，一处都没裁掉。`VisibilityCullingTests.cs` 两条端到端用例被 `[Ignore]`，另两条绿：
| 用例 | 断言 | 状态 |
|---|---|---|
| `视锥外被标记为裁剪_视锥内不被标记`（`:93`） | 相机前的实体 `IsComponentEnabled == false`（`:102`）；相机背后的实体 `== true`（`:104`） | **[Ignore]** |
| `被裁剪的agent不被Rvo推进_可见的会`（`:145`） | 5 帧后视野内 agent 的 `Position.x` 变了（`:166`）；被裁剪的**不变**（`:167`） | **[Ignore]** |
| `关掉裁剪_全部视为可见`（`:109`） | `Enabled = false` 时两个实体都不被标记 | 通过 |
| `没挂标签的实体_视为不被裁剪`（`:127`） | 没挂标签的实体 `IsCulled == false` | 通过 |

测试**真建相机、真跑帧**：相机 `(0,0,-10)`、朝 +z，实体 `(0,0,5)` / `(0,0,-50)`；自建 World 不接 PlayerLoop，
靠手动 `m_World.Update()` 推进（`:95-97`），实体挂标签后先 `SetComponentEnabled(false)` 摆成可见（`:79-81`）。
**已排除的假设**（`docs/PITFALLS.md` §6.1 的 6 项）：① World 未接 PlayerLoop；② 视锥平面提取错；③ 系统未被更新；
④ `WithNone` 语义；⑤ 模块装配；⑥ `FixedList` 传参。
> ⚠️ 文档漂移：两条 `[Ignore]` 的消息都写"见上方注释里已排除的假设"，但**测试文件里并没有这段注释**，6 项实际记在 PITFALLS §6.1。

**后果**：Rvo 的 `WithNone<VisibilityCulledTag>()` 与渲染桥两个方向的视口剔除**当前都是空转**——正确性不受影响，
但一处都没省下。**本文不给根因**：假设已排除 6 条，剩下的无证据支撑；该做的是运行时观测，而不是再猜一条。
