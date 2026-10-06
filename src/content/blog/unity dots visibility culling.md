---
title: 'Unity DOTS —— 视锥剔除：让逻辑侧也知道"看不见"'
description: '从取六个视锥平面开始，一步步实现一个只回答"在不在视锥里"的剔除系统，把结论用开关位交给逻辑侧使用'
pubDate: '2026-09-29'
category: '算法'
tags: ['Unity', 'DOTS', '视锥剔除', 'IEnableableComponent', 'Burst']
---

## 速览

>- **Entities Graphics 的剔除只管"画"**。实体在视口外，渲染那一步跳过了，但你的逻辑系统照样推进它——人群求解、路径跟随、变换回写，全是白烧的 CPU。
>- **逻辑侧需要自己的一份结论**。做法是加一个系统，每帧回答「这个实体在不在主相机的视锥里」，把答案写成 `IEnableableComponent` 的开关位。
>- **算法三步**：`GeometryUtility.CalculateFrustumPlanes(camera)` 拿到 6 个世界空间平面 → 算有符号距离 → 任一平面为负就算在外。
>- **别用增删组件表达"看不见"**：那是结构性变更，会搬 chunk、换 archetype、还要让渲染重建批次；改一个 bit 就够了。
>- **保守是硬要求**：拿不到相机、配置关掉、实体没挂标签，所有退化路径都倒向"全部可见"。假阴会让逻辑**静默**跳过，物体卡住且不报错。

---

## 1. 为什么渲染有剔除还不够

Entities Graphics 的剔除发生在**提交绘制**之前：判断哪些实体不在视锥里，把那些跳过去，结果只是"这一帧没画"。实体本身还在世界里，`LocalTransform` 还在，你的系统照样查得到它。

| 消费方 | 不知道可见性的后果 |
|---|---|
| 人群求解 / 避障推进 | 视口外的 agent 照样求解、照样积分 → 白烧 CPU |
| 帧末"实体 → GameObject"回写 | 把不可见对象的位置写回 GameObject，白写 |
| 帧初"GameObject → 实体"同步 | 用过时的 GO 位置覆盖实体（§1.1） |

实体数量到几万、而相机只看得见其中一小部分时，这几项差距非常大。

**为什么不"每个系统自己算一遍"**：成本会重复 N 倍；两个系统用了不同相机或不同 margin 就会出现"渲染认为可见、逻辑认为不可见"这种自相矛盾；相机切换、`Camera.main` 返回 null 之类的边界还要各写一遍。所以正确做法是**一个系统负责算、其余系统只读**——这也正是"让逻辑侧也知道"的意思：剔除模块的职责就是回答"在不在视锥里"，**怎么用由消费方决定**。

### 1.1 一个具体的翻车案例：只剔一个方向

如果工程里同时有"GO → 实体"和"实体 → GO"两个方向的变换同步，那"只在回写方向剔除"会引发一个很难查的 bug：

```text
❌ 只在"实体 → GO"方向剔除             ✅ 两个方向用同一份判据
  视口外的对象：                          视口外的对象：
   Sync  GO 旧位置 ─覆盖─▶ 实体            Sync  判定被剔除 ⇒ 跳过，不用 GO 的值覆盖实体
   Push  判定被剔除 ⇒ 跳过 ⇒ GO 停住         Push  判定被剔除 ⇒ 跳过，不把 GO 拉回来
   往返链路被切断 ⇒ 对象彻底冻结            实体照旧推进，回视野那一帧一次追上
```

根因是"帧初同步会写"：视口外你不回写，GO 就停在离开视口那一帧；下一帧帧初又把这个**过时的 GO 值**灌回实体，把实体刚推进的位移抹掉。表现是对象在视口外"冻"住、回视野时猛地跳一下——症状和"逻辑系统没跑"一模一样，很容易往错的方向查。要避免它，判据必须**只有一份**、且**两个方向都用**。这就是 §3 把结果写成组件开关位、而不是各自内联一段计算的理由。

---

## 2. 算法：从相机到六个平面

### 2.1 取视锥，别自己推矩阵

配置只需要一个开关、一个 `Margin`、一个相机：

```csharp
public struct Settings : IComponentData
{
    public bool Enabled;                     // 关掉 = 全部可见
    public float Margin;                     // 见 §2.4
    public UnityObjectRef<Camera> Camera;    // null ⇒ 本帧退化成"全部可见"
}
```

取视锥用 Unity 现成的 API：`GeometryUtility.CalculateFrustumPlanes(camera)`。对透视相机，它返回 **6 个世界空间平面**，并且约定**法线朝内**（指向视锥内部）——这两条性质是后面所有推导的基础。拿到后压成紧凑表示，方便塞进 job：

```csharp
// 平面方程 dot(n, p) + d = 0；压成 float4
var plane = new float4(p.normal.x, p.normal.y, p.normal.z, p.distance);
```

很多人第一反应是自己从 `projectionMatrix * worldToCameraMatrix` 里加减出 6 个平面。不要。① **行列约定**上左乘/右乘、行主序/列主序写错一个都不报错，只是把视锥判歪，典型症状是"近平面和远平面互换"——相机背后的物体被判可见、正前方的被判不可见，而代码看起来毫无破绽；② 不同图形 API 的**深度范围与 Y 方向约定**不同（0..1 vs -1..1、是否翻转），手写提取式要照顾这些差异；③ 一旦启用**反向 Z** 之类的优化，深度映射又变一套。`CalculateFrustumPlanes` 是引擎维护、跟着渲染管线走的实现，你真正需要自己实现的是"**拿到 6 个平面之后怎么用**"。

### 2.2 有符号距离：为什么是"全部 ≥ 0 才算在内"

`dot(n, p) + d` 就是点 `p` 的**有符号距离**（`n` 是单位向量时绝对值就是真实距离）。符号含义完全由法线方向决定：法线朝内 ⇒ 视锥**内部**的点对 6 个平面算出的距离**全部 ≥ 0**；任意一个平面的距离 **< 0** ⇒ 该点在这个平面外侧 ⇒ 整体在视锥外。判定就一行：

```csharp
static bool Outside(float4 plane, float3 position, float margin)
    => math.dot(plane.xyz, position) + plane.w + margin < 0f;
```

```text
俯视剖面（只画 left / right 两个平面，另外 4 个同理）
      left  n→                            n→  right
         ╲                                    ╱
          ╲        ┌─ 视锥内部 ─┐            ╱
   ● B ────╲       │     ● A    │           ╱
  （在外）   ╲      └────────────┘          ╱
              ╲                          ╱
               ●────────────────────────●   相机（视锥顶点）
                ╲       +z →          ╱

  inside  ⟺ 6 个平面全部满足 dot(n, p) + d ≥ 0
  outside ⟺ 任意一个平面满足 dot(n, p) + d < 0
  A：对 left、right 都是正数 ⇒ 在里面（6 个平面都要看）
  B：对 left 是负数        ⇒ 立刻判在外（后面几个平面不用算了）
```

一个常见疑问：**相机正后方怎么处理？** 不用特殊处理。最后方是 **near 平面**在挡：它的法线与视线同向，相机背后点对它的距离项是个很大的负数，自然被判在外。所以点测试本身就足够严格，你不需要额外判 `dot(forward, p - cameraPos) > 0`。

### 2.3 点 / 球 / AABB 怎么选

```text
点测试（最省）                 球测试                        AABB 测试（最准）
p = 实体位置                   c = 球心，r = 半径            c = 盒中心，e = 半长
dot(n,p)+d+Margin < 0 ?       dot(n,c)+d+r+Margin < 0 ?     r = |n.x|·e.x + |n.y|·e.y + |n.z|·e.z
                                                             dot(n,c)+d+r+Margin < 0 ?

便宜；pivot 出界就剔除         便宜；对长条/扁平形状过保守      更贴合盒状；需要拿到尺寸
```

**球测试**多加一个 `r`，语义是"球心到平面的距离超过半径才算分离"。**AABB 测试**其实只是给平面距离加一个**投影半径**：

```csharp
// n 是单位法线，e 是盒的半长
float r = math.abs(n.x) * e.x + math.abs(n.y) * e.y + math.abs(n.z) * e.z;
bool outside = math.dot(n, c) + d + r < 0f;
```

推导很短：AABB 在法线方向上的**支撑函数**（最远点投影）就是 `|n.x|·e.x + |n.y|·e.y + |n.z|·e.z`，于是"整个盒子都在平面外侧"等价于"中心距离 + 投影半径仍为负"。每个轴取绝对值再相加，是因为要算"沿任意方向能伸多远"，正负两边都要覆盖。当 `r = 0` 时它就退化成点测试——**点测试是 AABB 测试的特例**。

| 方案 | 需要的数据 | 优点 | 代价 |
|---|---|---|---|
| 点 | 只有 `LocalTransform.Position` | 最便宜，一行 | pivot 出视锥就算不可见；大物体压着视口也会被误剔 |
| 球 | 位置 + 一个半径 | 仍很便宜，抗旋转 | 对长条/扁平物体过保守，会多留一批 |
| AABB | 位置 + 中心偏移 + 半长 | 最贴合盒状物体，误剔最少 | 要拿到尺寸；有旋转的物体得用 OBB 或退化成球 |

**点的代价具体感受一下**：一棵树、一栋楼的 pivot 通常在下方的根部，相机对着树的一半时 pivot 可能已经在视锥外——于是整棵树被判不可见、突然消失，而屏幕里明明还有一半。这是点测试最典型的误判。那为什么很多模块还是用点测试？因为**误剔只在"误剔方向安全"时才可接受**：如果剔除只是"少算一点"，误剔会让画面穿帮；如果结论交给逻辑侧、而"被剔除"意味着"跳过推进"，误剔的后果是物体卡住（§5）。顺带一句：如果实体是渲染实体，尺寸其实拿得到（`RenderMeshArray` 里 mesh 有 `bounds`），在转换时算好存成一个组件，运行时用球测试几乎零成本；**别在 job 里现算 `mesh.bounds`**，那要读托管对象，Burst 里做不了。

### 2.4 `Margin` 的作用

`margin` 加在有符号距离上，等价于**把 6 个平面整体朝外推**。不推会怎样？一个实体正好压在视锥边界上、相机轻微晃动时：帧 N 距离 `+0.01` ⇒ 可见；帧 N+1 距离 `-0.01` ⇒ 不可见；帧 N+2 又可见……物体的逻辑一帧跑一帧不跑，表现为卡顿、速度不稳，甚至比完全不剔还难看。加 `Margin`（比如 1 米）后，边界外 1 米以内的对象仍算可见，进出视锥变成一次有滞后的翻转，抖动消失。代价是"多算了一点"——这正是"保守"的具体体现：**多算只是浪费，少算是错误**。

---

## 3. 结果怎么存：`IEnableableComponent` 的开关位

### 3.1 为什么不用增删组件

在 ECS 里，**增删组件是结构性变更**：

```text
AddComponent / RemoveComponent
  → 实体的 archetype 变了
  → 实体必须从一个 chunk 搬到另一个 chunk（memcpy 搬家）
  → 相关 query 的匹配集合变了
  → 若它是渲染实体，Entities Graphics 的批次要重建
  → 而且在 job 里不能直接做，得走 EntityCommandBuffer，还要等同步点
```

而可见性**每帧都可能翻转**：相机一转，一批实体就在视锥边界上进进出出，这些实体每帧搬一次家，开销远超剔除省下的东西；长期看还会打乱 chunk 内的实体聚集度，伤害内存局部性。`IEnableableComponent` 提供了另一条路：**组件一直挂着，只翻 chunk 掩码里的一个 bit**。

```text
SetComponentEnabled<T>() / EnabledRefRW<T>
  → archetype 不变、不搬 chunk、不需要 EntityCommandBuffer
  → job 里就能改（EnabledRefRW 是 job 安全的）
  → query 依然能按"启用/禁用"过滤（见 §4.1，注意必须用泛型重载）
```

```csharp
using Unity.Entities;

// 空组件，只作为开关载体
public struct CulledTag : IComponentData, IEnableableComponent { }
```

**启用 = 被裁剪（不可见）**。这个极性选定之后要写进注释，因为反过来也能用，混用必出错。

### 3.2 每帧做什么

```text
CullingSystem.OnUpdate()                        ← 主线程，每帧一次
 ├─ 读配置
 ├─ if (!config.Enabled || !TryGetCamera(out var cam))
 │      └─ 收不到相机 / 关掉了 ⇒ 走"全部可见"分支
 │            用 SetVisibleJob { Culled = false } 把所有位清零
 └─ else
      ├─ GeometryUtility.CalculateFrustumPlanes(cam) → 6 个 Plane
      ├─ 压成 float4(n.xyz, d) × 6
      └─ CullJob { P0..P5, Margin }.ScheduleParallel()
            └─ 按 chunk 并行：outside = P0 || P1 || … || P5
                 culledRef.ValueRW = outside
```

```csharp
[BurstCompile]
[UpdateInGroup(typeof(SimulationSystemGroup))]
public partial struct CullingSystem : ISystem
{
    public void OnCreate(ref SystemState state) => state.RequireForUpdate<Settings>();

    [BurstCompile]
    public void OnUpdate(ref SystemState state)
    {
        var settings = SystemAPI.GetSingleton<Settings>();
        if (!settings.Enabled || settings.Camera.Value == null)
        {
            // 退化路径：全部可见。注意这里也必须"写"，
            // 否则上一位还是 1 的实体会永远保持被裁剪。
            state.Dependency = new SetVisibleJob().ScheduleParallel(state.Dependency);
            return;
        }
        // Plane[] 是托管数组：取值后立刻拷进非托管结构再进 job
        var planes = GeometryUtility.CalculateFrustumPlanes(settings.Camera.Value);
        var job = new CullJob
        {
            P0 = ToFloat4(planes[0]), P1 = ToFloat4(planes[1]), P2 = ToFloat4(planes[2]),
            P3 = ToFloat4(planes[3]), P4 = ToFloat4(planes[4]), P5 = ToFloat4(planes[5]),
            Margin = settings.Margin,
        };
        state.Dependency = job.ScheduleParallel(state.Dependency);
    }
}
```

两个值得展开的细节。**① 六个平面逐个作为 job 字段传，不要塞进容器。** 把固定容量的容器传进 job，很容易踩到"job 里读到空容器且不报错"这类问题——症状正是"所有实体都被判成可见"，即剔除**完全空转**，而代码看起来完全正常。六个 `float4` 当字段传最不容易出错。**② 只处理显式挂了 `CulledTag` 的实体。** `EnabledRefRW<T>` 要求组件存在，job 天然只覆盖挂了标签的实体；没挂的一概不管，读取侧也当它们"可见"——**没有信息 ≠ 不可见**。

```csharp
[BurstCompile]
[WithAll(typeof(CulledTag))]     // 显式限定范围，别让 query 退化成整个世界
partial struct CullJob : IJobEntity
{
    public float4 P0, P1, P2, P3, P4, P5;
    public float Margin;

    void Execute(EnabledRefRW<CulledTag> culled, in LocalTransform t)
    {
        bool outside =
            Outside(P0, t.Position, Margin) || Outside(P1, t.Position, Margin) ||
            Outside(P2, t.Position, Margin) || Outside(P3, t.Position, Margin) ||
            Outside(P4, t.Position, Margin) || Outside(P5, t.Position, Margin);
        culled.ValueRW = outside;
    }

    static bool Outside(float4 plane, float3 p, float margin)
        => math.dot(plane.xyz, p) + plane.w + margin < 0f;
}
```

这个系统**只写入、不行为**：它不参与任何业务决策，只维护一个"当前可见性"的位。这条边界保证它可以被任何系统消费，而不需要知道它们在想什么。

### 3.3 三态语义

| 状态 | 含义 | 谁负责摆成这个态 |
|---|---|---|
| **没挂标签** | 不参与裁剪，**照常处理**（模块不自动挂） | 作者显式 `AddComponent<CulledTag>()` |
| **挂了 + 禁用** | 可见（系统每帧会写；刚 `AddComponent` 之后也是这个态） | 剔除系统（写 0） |
| **挂了 + 启用** | 不可见，消费方应跳过 | 剔除系统（写 1） |

第一条特别重要：**模块不自动给所有实体挂标签**。"参与剔除"是有成本的决定（每帧多扫一遍），而且很多实体根本不需要；让作者显式挂，语义最清楚。第二条是初学者的经典坑：

```csharp
em.AddComponent<CulledTag>(entity);                 // 启用位默认是 true（= 被裁剪）
em.SetComponentEnabled<CulledTag>(entity, false);   // false = 可见，必须补这一句
```

少了第二句，"刚创建、还没被剔除系统扫到"的那一帧里实体被当成不可见 ⇒ 逻辑跳过它，表现为"刚出现的物体要等一帧才动"。

---

## 4. 消费方怎么读

**能改 query 的，用泛型 `WithNone`**：

```csharp
[WithNone(typeof(CulledTag))]
[BurstCompile]
partial struct AdvanceJob : IJobEntity { void Execute(ref LocalTransform t, in Velocity v) { } }
```

但要小心：**`WithNone<T>()` 的泛型形式和 `EntityQueryDesc.None` 里塞 `ComponentType` 的行为不一样**。

```csharp
// ❌ 对 enableable 组件，这个只匹配"没挂"的实体
//    "挂了但禁用"（= 可见）的实体会被漏掉 ⇒ 可见的也不推进
new EntityQueryDesc { None = new[] { ComponentType.ReadOnly<CulledTag>() } }
```

因为对 enableable 组件来说，"挂没挂"和"启用没启用"是两个独立的匹配维度：泛型 `WithNone<T>()` 会按"启用位为 1"来排除，而 `ComponentType` 形式只表达"没有这个组件类型"。这个坑的症状是"**所有**该动的实体都不动"或者"只有从不参与剔除的实体在动"，很容易被误判成剔除系统写反了。所以定一条规格：**消费方一律用泛型 `WithNone<T>()`。**

**改不了 query 的，用 `HasComponent` + `IsComponentEnabled`。** 有两种场合改不了 query：① 你在 `IJobParallelForTransform` 里（比如渲染桥的两个同步方向 job），它按 `TransformAccessArray` 索引遍历，根本没有 query；② 你要判断的是**别的**实体，比如人群系统过滤邻居时要跳过被裁剪的邻居。这时用一次查表：

```csharp
public static class Culled
{
    // 顺序不能反！
    public static bool IsCulled(in ComponentLookup<CulledTag> tags, Entity entity)
        => tags.HasComponent(entity) && tags.IsComponentEnabled(entity);
}
```

**顺序是硬性要求**：`IsComponentEnabled` 对"没挂该组件"的实体会**抛异常**，而不是返回 `false`；反过来写就是随机崩，而且崩在 job 里、堆栈很难看。另外，`ComponentLookup` 指向**可选组件**时必须在 job 里**每帧现取**，不能在 `OnCreate` 里缓存——建系统时实体可能还没挂上标签。附带的结论是：**执行顺序会影响你读到哪一帧的位**。帧初的同步组读到的是上一帧的位，本帧的剔除系统跑完之后，帧末的回写组读到的才是本帧的位。两侧差一帧本身是安全的（可见性变化本来就慢），但**两个同步方向必须用同一份判据**，否则会出现 §1.1 的"视口外冻结"；若你发现两个方向的剔除行为不一致，多半就是这里读到了不同帧的位，或者其中一个干脆忘了接。

| 消费场景 | 推荐读法 | 被裁剪时 |
|---|---|---|
| 能改 query 的求解 / 推进系统 | 泛型 `WithNone<CulledTag>()` | 该实体整个不进入 job |
| `IJobParallelForTransform`（回写方向） | `Culled.IsCulled` | 不把实体写回 GO |
| `IJobParallelForTransform`（同步方向） | `Culled.IsCulled`（**同一个判据**） | 不用 GO 的值覆盖实体 |
| 过滤"别的"实体（邻居查询） | `Culled.IsCulled` | 视为不存在 |

---

## 5. 保守是硬要求

**假阴和假阳的代价完全不对称。**

```text
假阳（其实不可见，却判成可见）
  → 多做一点计算，画面完全正常，只是没省下那点 CPU
假阴（其实可见，却判成不可见）
  → 逻辑系统静默跳过它：不推进、不回写、不响应 ⇒ 物体卡住
  → 没有任何报错、没有任何日志
```

第二种是**静默错误**：Console 里什么都看不到，只看到"有些物体不动"，然后开始怀疑寻路、怀疑物理、怀疑多线程——而真正的问题只在剔除这一行。所以设计原则是：**所有退化路径都倒向"全部可见"**。

| 情况 | 选择 |
|---|---|
| 拿不到相机（`Camera.main` 为 null、相机被禁用） | 全部可见 |
| 配置里 `Enabled = false` | 全部可见 |
| 实体没挂 `CulledTag` | 全部可见（不参与裁剪） |
| 视锥平面提取失败 / 数量不对 | 全部可见 |
| 实体位置是 NaN | 全部可见（NaN 比较全为 false，天然倒向"在外"，所以在算之前判掉更稳） |
| 多相机、只支持单相机 | 按"至少一个相机能看见"算可见 |

最后一条值得展开：**多相机时，任何"被裁剪"的判定都必须取交集**——A 相机看不见、B 相机看得见，就必须算可见。把"某一台相机看不见"当成"不可见"，等于给多屏 / 分屏 / 小地图场景埋了一个必然触发的 bug。同理，遮挡剔除、空间加速结构这类更激进的剔除，前提是你已经验证过它的保守性——它们用的信息（深度缓冲、光栅化结果）本身就带延迟和近似。

---

## 6. 性能与可扩展性

| 维度 | 单相机实现 | 说明 |
|---|---|---|
| 相机数量 | **单相机** | 一个全局可见性位；多相机需要"一实体对多相机"的位掩码或分桶，属于另一个量级的工作 |
| 判定粒度 | per-entity，按 chunk 并行 | `ScheduleParallel()` 的并行单元是 chunk；chunk 内可以既有可见又有不可见，不需要拆块 |
| 每帧固定开销 | 1 次取视锥 + 1 次 `Plane[]` 分配 | 见本节末尾的零分配方案 |
| 遮挡剔除 | **不做** | 需要读深度缓冲、做光栅化或硬件查询，CPU 侧的逻辑模块拿不到这些数据 |
| 空间加速（视锥 vs 树） | **不做** | 全量扫一遍；实体到十万级再考虑分块 / 八叉树 |

**那一次 `Plane[]` 分配。** `CalculateFrustumPlanes(Camera)` 每次都 `new Plane[6]`，每帧一次托管分配量不大，但会累积 GC 压力。用不分配的重载：把 `Plane[6]` 缓存成字段，调 `GeometryUtility.CalculateFrustumPlanes(camera, m_Planes)`——它是 `void`，会把结果写进你传入的数组。但注意：`ISystem` 的 `OnUpdate` 会被 Burst 编译，而 `GeometryUtility.CalculateFrustumPlanes` 是**托管 API**，在 Burst 的 `OnUpdate` 里调不了。所以标准结构是「托管系统在主线程取视锥 + Burst job 做海量的逐实体判定」：

```text
partial class CullingSystem : SystemBase      // 托管系统
  └─ OnUpdate()  主线程：取视锥 + 压低成 float4 + 调度 job
       └─ CullJob : IJobEntity  Burst：海量的逐实体判定
```

这个分工是关键；别想着整个流程都 Burst 化，取视锥本来就只有一次。

**什么时候该升级粒度。** 出现下面任一情况，就该从点测试升级到球 / AABB：视口边缘的物体**明显**被误剔（pivot 在外、本体在内）；场景里有大量长条 / 薄片 / 大体量物体（管道、地板、地形块、树）；剔除结论会影响游戏状态（物体被跳过推进），而不只是省 CPU。升级路径很短：初始化时把尺寸存成一个组件，判定时把 `dot(n, c) + d + Margin < 0` 换成 `dot(n, c) + d + r + Margin < 0`。注意 `Margin` 和 `r` 是**相加**的，两个都可以理解成"把边界朝外放"。

---

## 7. 一张自查清单

| # | 检查项 | 错了会怎样 |
|---|---|---|
| 1 | 剔除结论只有**一个**系统在算 | 结论不一致，两边互相矛盾 |
| 2 | 用 `CalculateFrustumPlanes`，不手推矩阵 | 近/远平面互换之类的错判，且不报错 |
| 3 | 确认法线朝内，判据是"任一平面 `< 0` 即在外" | 逻辑写反：视锥内全被判不可见 |
| 4 | 粒度选了点 / 球 / AABB 中的哪一个，为什么 | 点测试在边缘误剔，物体莫名消失 |
| 5 | `Margin` 设了非零值 | 边界抖动：物体一帧动一帧不动 |
| 6 | 用 `IEnableableComponent` 开关位，不增删组件 | 每帧结构性变更 + 渲染批次重建 |
| 7 | 刚挂标签就手动 `SetComponentEnabled(false)` | 新实体第一帧被跳过 |
| 8 | 消费方用泛型 `WithNone<T>()` | `ComponentType` 形式会漏掉"挂但禁用"的实体 |
| 9 | `HasComponent` 在 `IsComponentEnabled` **之前** | 对没挂组件的实体抛异常 |
| 10 | `ComponentLookup` 在 job 里现取，不在 `OnCreate` 缓存 | 可选组件还没挂上时读到空 |
| 11 | **两个同步方向用同一份判据** | 视口外对象被过时值覆盖，永久冻结 |
| 12 | 每个退化路径都倒向"全部可见" | 假阴 ⇒ 逻辑静默跳过 ⇒ 物体卡住且无报错 |
| 13 | 多相机时"至少一个看得见"算可见 | 分屏 / 小地图场景必然出错 |
| 14 | `Plane[]` 缓存复用（零分配重载） | 每帧一次托管分配，累积 GC |
| 15 | 拿尺寸的话在初始化时算好，不在 job 里读 mesh | Burst 里读不了托管对象 |

第 11、12 条是这篇文章真正想留下的两条经验。算法部分（取平面、算距离）其实很短，真正让人熬夜的是"结论怎么用、用在几个地方、每个地方的退化路径对不对"。**把剔除看成一个需要向多个消费者发布的接口，而不是一段内联的计算**，实现就会顺很多。
