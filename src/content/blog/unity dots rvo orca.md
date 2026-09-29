---
title: 'Unity DOTS —— RVO/ORCA 避障：从速度障碍到半平面线性规划'
description: 'RVO/ORCA 的算法原理（速度障碍、半平面、三层线性规划）、静态障碍物的拓扑语义，以及 DOTS 三阶段 job 集成与实测踩坑'
pubDate: '2026-09-29'
category: 'Unity DOTS'
tags: ['Unity', 'DOTS', 'RVO', 'ORCA', '避障']
---

## 速览
>- RVO/ORCA 的输出**不是一个方向，而是一组半平面**：每个邻居一条，解是「最大速度圆 ∩ 全部半平面」里离偏好速度最近的点。
>- 半平面边界固定在 `v + u/2`：`u` 是最小分离速度，**双方各担一半责任**，这就是 reciprocal。
>- 障碍物**必须带拓扑**（`Prev` / `Next` / `IsConvex`）：当孤立凸边会让腿指进相邻边，实测 **400/400 全穿**。
>- 三层 LP 分工：`LinearProgram2` 顺序贪心、`LinearProgram1` 沿边界滑动、`LinearProgram3` 求**最小违反量**；内核 `OrcaSolver` 是**纯函数**（不认识 ECS、不做托管分配）。

| 常量 / 类型 | 值 |
| --- | --- |
| `OrcaSolver.Epsilon` / `MaxLines` | `1e-5f`（同 RVO2 的 `RVO_EPSILON`）/ **31** = `(512 − 2) / 16` |
| `AgentState` / `RvoNeighbor` | **32 字节**，可 `Reinterpret<AgentState>()` 零拷贝 |
| `RvoObstacleVertex` / `RvoObstaclePolygon` | 28 / 8 字节；`RvoConfig.Default`：τ = 2 s、`NeighborDist` = 15、`MaxNeighbors` = 10 |
---
## 1. 速度障碍 → ORCA 半平面
**速度障碍（VO）**：把 B 膨胀成半径 `rA + rB` 的圆；相对速度 `v_rel = v_A − v_B` 落在以 A 为顶点、过该圆两条外公切线的圆锥里，则 τ 秒内必撞。
```
   相对速度空间：原点 = A，B 膨胀成半径 rA + rB 的圆
                    ╱╲
      VO_{A|B}     ╱  ╲  ← 两条外公切线（"腿"）
                 ╱  ● ╲   ● = B（膨胀后），位于 pB − pA
                ╱──────╲  ← τ 处截断：截断圆（cut-off circle）
   v_rel 落在圆锥里 ⇒ τ 秒内必撞
```
**互惠（reciprocal）**：`VO` 要求 A 单方面躲开（B 不动），`RVO` 改成「双方各改一半」。ORCA 再把它**压成一条半平面** —— 锥体不是凸约束，半平面才是：
- `u` = **最小分离速度**（把 `v_A` 推到「刚好不撞」的最小改动），`line.Point = v_A + 0.5f * u`：边界过这里，A 只挪一半，另一半由 B 自己承担；
- `line.Direction` 是边界**切向**（单位向量），实测恒有 `u ⟂ line.Direction`；可行侧恒为 `det(line.Direction, X − line.Point) >= 0`（RVO2 原始约定，见 `OrcaLine` 注释）。
```
        不可行侧（v 在这里 ⇒ τ 内会撞）      可行侧
   ────────────────────────┬──────────────────────
                           │ ← 边界：过 line.Point = v + u/2
           v               │        v + u
           ●───────────────┼───────────●
           │←──── u/2 ────→│←── u/2 ──→│
   n 指向可行侧：n·(X − (v + u/2)) ≥ 0
```
**逐对构造（`BuildLine`）三分支**，其中 `w = relativeVelocity − relativePosition / τ`：
| 条件 | 分支 | 结果 |
| --- | --- | --- |
| `distSq > combinedRadiusSq`、`w` 投影落在截断圆上 | 截断圆锥 | `Direction = (unitW.y, −unitW.x)`，`u = (combinedRadius/τ − wLength)·unitW` |
| 同上但投影在外侧 | 两条腿 | `Direction` = 左腿 / 右腿（由 `Det(relativePosition, w)` 定左右） |
| `distSq <= combinedRadiusSq` | **已重叠** | 用 `1/timeStep` 推开；`w` 退化时沿中心连线兜底 |
**一个可验算的例子**（用例 `侧向擦过_腿投影的半平面与手算一致`）：A 在原点 `v = (1,0)`，B 在 `(0,2)` `v = (−1,0)`，半径各 0.5，τ = 2：
```
rp = (0,2)   rv = (2,0)   w = rv − rp/τ = (2,−1)   Det(rp, w) = −4 < 0 ⇒ 右腿
line.Direction = (−0.5, −0.8660254)    u = (−1.5, 0.8660254)
line.Point = (1,0) + 0.5u = (0.25, 0.4330127)   ← 与用例断言逐位相同
```
**三个尺度参数**：`TimeHorizon` τ（只看 τ 秒内会撞的邻居；τ → 0 = 不避障，越大越早绕）；`NeighborDist`（判定距离，**由空间索引执行**）；`MaxNeighbors`（邻居数上限，夹到 ≤ `k_MaxNeighborsCap = 64`）。

---
## 2. 三层线性规划
目标：在「半径 `maxSpeed` 的圆 ∩ 全部半平面」里，找离 `optimum = ClampLength(PrefVelocity, maxSpeed)` 最近的点。
```
   输入：optimum + lines[0..N)（障碍物线在前）
                 │
   ┌─────────────▼────────────────────────────┐
   │ LinearProgram2  顺序贪心                  │
   │   result = optimum（超上限先截到圆上）     │
   │   逐条 det(D_i, P_i − result) > 0 ⇒ 违反   │
   │     → LinearProgram1(i)：成功继续/失败回滚 │
   └──────┬───────────────────────┬───────────┘
     return N（全满足）      return i < N（矛盾）→ LinearProgram3
          │                        │
          ▼                        ▼
    result 即解       ┌────────────────────────────┐
                      │ 目标方向 = 第 i 条法向      │
                      │ lines[0..i) 与第 i 条投影   │
                      │ → LP2(directionOpt) 迭代    │
                      └────────────────────────────┘
```
- **`LinearProgram2`（顺序贪心）**：逐条检查 `det(Direction, Point − result) > 0`（违反）。第 `i` 条违反就调 `LinearProgram1(lines, i, …)` 重算：成功继续，失败回滚 `result` 并返回 `i`。返回 `lines.Length` = 全部满足。
- **`LinearProgram1`（沿边界滑动）**：解必须落在第 `i` 条边界上，参数化成 `Point + t·Direction`。先由「边界 ∩ 最大速度圆」得 `[tLeft, tRight]`（判别式 `< 0` ⇒ 无解），再与 `lines[0..i)` 逐条求交收窄（`|Det| <= Epsilon` 视为平行，`numerator < 0` 即无解），最后 `t = clamp(Direction·(optimum − Point), tLeft, tRight)`。
- **`LinearProgram3`（最小违反量）**：前两层都可能失败（可行域为空）。此时**不求可行解，而求违反最小的解**：拿第 `i` 条法向当目标方向，把 `lines[numObstLines..i)` 与第 `i` 条**两两投影**成新线（同向跳过 / 反向取中点 / 否则求交），再跑一次 `directionOpt: true` 的 `LinearProgram2`；`distance = det(line.Direction, line.Point − result)` 记录违反量并**单调迭代**，后续只处理违反量更大的线。硬求可行解会让整个求解失败、速度归零；最小违反量保证**每个 agent 都还能动**。

---
## 3. agent 数据：偏好速度 vs 实际速度
```csharp
public struct RvoAgent : IComponentData      // 挂在带 LocalTransform 的实体上
{
    public float Radius;         // 碰撞半径
    public float MaxSpeed;       // 速度上限
    public float2 PrefVelocity;  // 期望速度：由目标系统 / 玩家输入写
    public float2 Velocity;      // 实际速度：本模块是它的权威写入方
    public float2 NewVelocity;   // 求解输出（系统内部字段，用户不要写）
}
```
内核侧入参是 `AgentState`（`Position` / `Velocity` / `Radius` / `MaxSpeed` / `PrefVelocity`，**32 字节、只有 xz**），由系统侧从 `LocalTransform` + `RvoAgent` 拼出来。

**为什么必须分两个字段**：`PrefVelocity` 是**意图**（"我想以 2 m/s 朝目标走"），`Velocity` 是**协商结果**（"这一帧我只能以 1.4 m/s 侧着走"）。同一个 `PrefVelocity` 配不同邻居会得到不同 `Velocity`，这正是避障的意义。求解吃的是**快照**：阶段①把邻居的位置/速度/半径拷进 `DynamicBuffer<RvoNeighbor>`，阶段②只读快照 —— 全体基于**同一帧初**状态求解，结果与 job 调度顺序无关、可复现。不变量：`|Velocity| <= MaxSpeed`；`LocalTransform.Position.y` 全程不变（`RvoIntegrateJob` 只写 x / z）。

---
## 4. 静态障碍物：带拓扑的闭合多边形
**数据（照 RVO2 `RVOSimulator::addObstacle` 语义，由 `RvoObstacleBuilder` 补全）**：
| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `RvoObstacleVertex`（28 B） | `Point` / `UnitDir` | `UnitDir = normalize(Next.Point − Point)`，零长边取 `float2.zero` |
| | `Prev` / `Next` | 扁平顶点数组的下标，多边形内**首尾相接** |
| | `IsConvex` | `n == 2` ⇒ `1`；否则 `det(Point − Prev.Point, Next.Point − Point) >= 0` |
| `RvoObstaclePolygon`（8 B） | `Start` / `Count` | `[Start, Start + Count)` 是扁平顶点数组里的一段 |

线段由 `Next` **隐含**给出：`[Point, Next.Point]`。`n == 2` 就是**零厚度墙** —— `Prev` / `Next` 都指向另一顶点，两条边 `A→B` 与 `B→A` 都算凸。

**构造一条障碍物半平面（`BuildObstacleLines` → `TryBuildObstacleLine`）**：① 候选范围 `range = τ_obst·maxSpeed + radius`，按到线段 `[Point, Next.Point]` 的距离**升序**插入（容量 `MaxObstacleCandidates = 60`，满了丢**最远**的），绝不因上限丢掉贴身的墙；② **覆盖判定**（已加入的线把两端都盖住就跳过）；③ **零长边**（`obstacleLengthSq <= Epsilon`）跳过；④ **三个碰撞分支**（左顶点 / 右顶点 / 线段本体），各带 `IsConvex` 门控；⑤ **两条腿**（非凸顶点退化为邻边截断线方向）；⑥ **邻边 foreign 修正** ← 前两次失败就败在这里；⑦ 两条**截断圆**分支；⑧ 三条候选取最近。
```
   带拓扑的闭合多边形：线段 = [Point, Next.Point]，Prev/Next 环内首尾相接
        Prev
         ●───────────────●  Next     腿不许指进相邻边（RVO2 原码）：
         │               │          leftNeighbor = vertices[Point.Prev]
   Point ●               │          if (IsConvex && det(leftLeg, −u_prev) >= 0)
         │               │          { leftLeg = −u_prev; isLeftLegForeign = true; }
         ●───────────────●          被选中的 foreign 腿「不加约束」→ return false
     IsConvex = det(Point − Prev, Next − Point) >= 0
     n == 2（零厚度墙）⇒ Prev = Next = 另一顶点，两顶点都算凸
```
```csharp
var leftNeighbor = vertices[obstacle1.Prev];
if (obstacle1.IsConvex != 0 && Det(leftLegDirection, -leftNeighbor.UnitDir) >= 0f)
{ leftLegDirection = -leftNeighbor.UnitDir; isLeftLegForeign = true; }
if (obstacle2.IsConvex != 0 && Det(rightLegDirection, obstacle2.UnitDir) <= 0f)
{ rightLegDirection = obstacle2.UnitDir;    isRightLegForeign = true; }
if (distSqLeft <= distSqRight) { if (isLeftLegForeign)  return false; }  // foreign 腿不加约束
else                           { if (isRightLegForeign) return false; }
```
**为什么必须带拓扑**：把每条线段当**孤立凸边**（不借 `Prev` / `Next`）时腿会指进相邻边 ⇒ 约束方向错 ⇒ 双面薄墙实测 **400/400 全穿**；几何正确、只是把闭合方形拆成 4 条独立线段时，2647 条外侧轨迹里 **54 条钻进内部**，新内核 **0 条**。真正差别在**拐角 / 共享顶点**，不在单条线段：「1 个 2 顶点多边形 vs 两条反向独立线段」这个对照**不成立** —— `n == 2` 时本身已含两条边。

**几何从哪来**：`PathObstacleBuilder.BuildPolygons` 把 A* 网格掩码提成闭合环 —— 有向单位格边取 `(角点, 方向)`，后继按「左转 → 直行 → 右转 → 掉头」取第一条，共线顶点丢掉；洞用同一套「阻挡区在左」规则自然反向成环。真实掩码（60×40、366 个阻挡格）实测 **7 个闭环 / 52 个顶点**，Σ有向面积 = **366** = 阻挡格数，由调用方喂给 `RvoAccess.SetObstacles`。

---
## 5. 与 ECS 的集成
模块 `DotsRvoModule`（`SortKey = 250`，`Requires = { "Spatial", "Visibility" }`）；`RvoGroup` 声明 `[UpdateAfter(typeof(SpatialGroup))]` + `[UpdateAfter(typeof(VisibilityGroup))]` —— 索引树必须先建好，可见性必须先标好。
```
  RvoSolveSystem.OnUpdate（主线程）
   ├─ dt = FixedTimeStep > 0 ? FixedTimeStep : Time.DeltaTime
   │    dt <= 0 ⇒ 写 RvoStatus{ Index = None, LastDt = dt } 并 return   ★失焦坑（§6）
   ├─ ResolveIndex()：读 SpatialSingleton.Tree ⇒ SpatialIndexReader（四叉树优先）
   ├─ ① EnsureRvoNeighborBufferJob  补空缓冲（ScheduleParallel + ECB）
   ├─ ② RvoCollectNeighborsJob  RangeQueryNearest（最近优先）→ 摘掉自己/非 agent/被裁剪的
   ├─ ③ RvoSolveJob  Reinterpret<AgentState>() → Solve(快照) → 写回 Velocity
   └─ ④ RvoIntegrateJob（可选）position.xz += Velocity * dt
```
- **邻居来自空间索引，不自建树**：`ResolveIndex` 主线程读 `SpatialSingleton`（隐含同步点，保证 `SpatialBuildSystem` 本帧写完树），再包成 `SpatialIndexReader`；`RvoStatus.Index` 如实报告 `Quadtree` / `Octree` / `Disabled` / `None`。没有树 ⇒ 本帧**没有邻居**，不偷偷退回暴力两两。
- `RangeQueryNearest(transform.Position, NeighborDist, hits)` 返回**按距离升序、同距离按 `Entity.Index`** 的最近若干条；缓冲按 `MaxNeighbors + 1` 开（自己距离 0 必定入选），查完再缩到实际条数。
- **`VisibilityCulledTag` 是硬门**：query 上的 `WithNone<VisibilityCulledTag>()` 让被裁剪的 agent **整帧不被推进**，`VisibilityAccess.IsCulled` 又把被裁剪的邻居**当作不存在**。
- **配置是全局快照**：`RvoSettings.Config` 进程级、所有 World 共用，`Version` 每次 `Set` / `Reset` 自增；`OnUpdate` 开头取一次、整帧同一份。参数**不是组件**，不能按 World / 按阵营调参。

---
## 6. 实现要点与坑
| 坑 | 现象 / 原因 | 处置 |
| --- | --- | --- |
| **`MaxLines = 31` 障碍物线 / 邻居线共用** | 障碍物先占位，邻居可能被整体截断；RVO2 原版**无此上限** | 先把 `TimeHorizonObst` 调小（0.5–1.0）应急；根治要按距离排序候选 |
| **自创判据「落在内侧半平面就算已侵入」** | 双面薄墙上把十几米外的正常航行误判成已侵入 ⇒ 互相矛盾的约束把速度压死：**400 艘船每 60 帧平均位移掉到 0.45**（像"只能转向、不能移动"） | **删掉它**，只留 RVO2 正统判据。教训：验收"约束类"改动必须**同时**量「没穿透」与「还在动」 |
| **失焦时 `Time.deltaTime == 0`** | `if (dt <= 0f)` 早退：`LastDt = 0`、速度不更新、位置积分 ×0 —— 一个原因、三个现象 | 判据先看 `is_focused` 再看 `deltaTime`；要确定性模拟就设 `FixedTimeStep > 0`（手动 `world.Update()` 不推进 `Time`） |
| **数值兜底** | 零半径 / 零距离 / 零速度 / 零长边 / 非有限顶点 —— RVO2 原版在这些点会产出 NaN | `NormalizeOr` / `FiniteOr` / `IsUsable`（`Point`、`Direction` 有限且 `lengthsq(Direction) > Epsilon`）、`ClampLength` 零向量原样返回、`Sanitize` 换 `zero`、`SolveLines` 出口兜 NaN |

另两条硬约束：`RvoNeighbor` 与 `AgentState` 必须同为 **32 字节**（`Reinterpret` 的前提）；`RvoAccess.SetObstacles` **只在帧之间调用** —— 求解 job 持有障碍物缓冲的只读句柄。

---
## 7. 实测（400 艘船 / 300 帧）
| 配置 | 平均位移 | 落在阻挡格 |
| --- | --- | --- |
| 无约束（`UseObstacles = false`） | 3.4 ~ 4.0 | 26 ~ 55 / 400 |
| RVO2 判据 + 孤立凸边 | 3.84 → 1.75 | **400 / 400** |
| 位置硬约束（掩码积分） | 0.75 / 2.56 / 3.57 / 3.52 / 3.11 | 0 / 0 / 0 / 0 / 0 |
| **带拓扑 ORCA（当前）** | **1.41 / 3.07 / 3.56 / 3.71 / 3.28** | **0 / 0 / 0 / 0 / 0** |

「能动」与「不穿」这次同时成立，而且是**正统 ORCA 主动避让**，不是位置硬约束。回归：EditMode **153/153**；PlayMode **176 总 / 174 passed / 0 failed / 2 skipped**（Visibility 模块既有 `[Ignore]`）。
