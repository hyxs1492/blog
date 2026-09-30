---
title: 'Unity DOTS —— 网格寻路：A* 与 Dijkstra 共用一套内核'
description: 'XZ 均匀方格上的 A*/Dijkstra 内核：二叉堆 + 生成标记、ECS 请求式并行求解、掩码提取闭合多边形'
pubDate: '2026-09-29'
category: '算法'
tags: ['Unity', 'DOTS', 'A*', 'Dijkstra', '寻路']
---


## 速览
>- **一份内核跑两种算法**：`PathfindingAlgorithm { AStar, Dijkstra }`，差别只在入堆的 f 值 —— A* 是 `f = g + h × max(1, weight)`，Dijkstra 把启发式权重取 0（`f = g`）。
>- **网格是一次性算出来的**：`AStarGrid` 内部是行主序 `UnsafeList<byte>` 掩码（`index = z * Size.x + x`，非 0 可走）；按值拷贝时**共享内存**，副本只读。
>- **求解不每帧清表**：`AStarScratch` 用世代值（`queryId`）区分 open / closed，`BeginQuery()` 只自增一次，重置是 O(1)。
>- **并行是"一个请求一个 job 下标"**：`IJobParallelFor` + 按 `[NativeSetThreadIndex]` 索引的工作区池（长度 `JobsUtility.MaxJobThreadCount`）；job 里**绝不改 `DynamicBuffer` 长度**。
>- **掩码还能再提一层几何**：`PathObstacleBuilder.BuildPolygons` 把有向格边接成闭合环，供 RVO2 语义的静态障碍物用（60×40 / 366 阻挡格 → 7 环 / 52 顶点）。
```
AStarSettings(静态装配口)         AStarGridAsset(资产)/AStarGridSource(场景)
      │ AStarConfig + byte[] mask          │ PushToSettings()
      └───────────► AStarSolveSystem ◄─────┘    ── 版本变化时重建网格
                          │
    AStarSingleton { Grid, Config, Algorithm, BuildVersion }   ← 单例，job 只读
                          │
  PathRequest ──► [ 求解 ] ──► PathStatus + PathWaypoint(buffer)  ← 每个 agent 一份
```
| 类型 | 角色 |
| --- | --- |
| `AStarConfig` | `Bounds`(只取 xz)/`CellSize`/`Neighbourhood`/`AllowCornerCutting`/`Algorithm`/`HeuristicWeight`/`MaxVisitedNodes`/`MaxSolvesPerFrame`/`SmoothPath` |
| `AStarStatus` | `Found=0`/`NoGrid`/`StartInvalid`/`EndInvalid`/`NoPath`/`ExceededLimit` |

---

## 1. 网格：XZ 平面上的均匀方格
`AStarGrid` 的全部状态就是参数 + 一行行可走字节：`Bounds`（只取 xz，格中心 y 沿用 `Bounds.Center.y`）、`CellSize`、`Size`、`Min`、`m_Walkable`。
```
世界 XZ（Bounds 的 y 被忽略）
          min.x                              ← 格坐标
   min.z ─┬──────┬──────┬──────┬──────┐
    z=0   │ x=0  │ x=1  │ ▓▓▓  │ x=3  │   ▓ = 阻挡（掩码字节 0）
          ├──────┼──────┼──────┼──────┤   index = z * Size.x + x  （行主序）
    z=1   │      │      │ ▓▓▓  │      │   Size.x = ceil(Extents.x*2 / CellSize)
          └──────┴──────┴──────┴──────┘
  WorldToCell(p) = floor((p − Min) / CellSize)   越界 → Index() 返回 -1
  CellCenter(c)  = Min + (c + 0.5) * CellSize    （y = Bounds.Center.y）
```
```csharp
public int2 WorldToCell(float3 world)
{
    var min = Min;
    return new int2((int)math.floor((world.x - min.x) / m_CellSize),
                    (int)math.floor((world.z - min.z) / m_CellSize));
}
```
>- `Size.y` 对应世界 **z**；`CellCenter` 收的也是格坐标，不是世界坐标。
>- `IsWalkableWorld(p)` = `IsWalkable(WorldToCell(p))`，越界算不可走 —— 演示里的位置约束直接用它。掩码 `null` 全可走，长度不足的部分保持不可走，非 1 的字节都算阻挡。
>- 装配口 `AStarSettings.Configure(config, mask)` 每次把 `Version` 加一，系统据此重建网格；进 Play 时静态字段复位（本工程关了域重载，否则会跨会话残留）。

---

## 2. 两种算法共用一套内核
求解器只有一份循环，`Algorithm` 只改一个数：**启发式前面的权重**。
```csharp
// Dijkstra 的启发式恒为 0（权重取 0），HeuristicWeight 因此不参与。
var weight = config.Algorithm == PathfindingAlgorithm.Dijkstra ? 0f : math.max(1f, config.HeuristicWeight);
...
scratch.HeapPush(nextIndex, tentative + Heuristic(next, endCell, eight) * weight);  // tentative = g + step
```
| 邻接 | 启发式 `Heuristic` | 步长 |
| --- | --- | --- |
| `Four` | `dx + dy`（曼哈顿） | 正交 1 |
| `Eight` | `dx + dy + (√2 − 2) · min(dx, dy)`（octile） | 正交 1 / 对角 `k_Sqrt2 = 1.41421356f` |

**可采纳性与一致性**：4 邻时每步最多把 `|dx|+|dy|` 减 1，真实剩余代价 ≥ 曼哈顿距离（不高估）；8 邻的 octile 就是「`min(dx,dy)` 步对角 + 剩余正交」的精确代价。两者相邻格的 h 差都不超过最小步长，于是**一致** —— 代码里的 `if (scratch.State(nextIndex) == 2) continue;`（闭集不重开）正是靠「闭集里的 g 已最优」。`HeuristicWeight > 1` 放松了这个前提：更快但**可能不是最短**（h 一致时解代价 ≤ `w × 最优`）；`= 1` 才是最优解。Dijkstra 权重恒 0，复用同一张图、同一份堆、同一套上限与拉直，只是搜索形状变成「以起点为圆心按 g 铺开」。

**禁止贴角**：8 邻下若对角的两侧正交邻居**都**不可走，就禁止走这条对角 —— 斜穿等于从两格公共角挤过一条零宽缝隙，实体有半径，不行。
```csharp
if (diagonal && !grid.AllowCornerCutting)
    if (!grid.IsWalkable(new int2(cell.x + offset.x, cell.y)) ||
        !grid.IsWalkable(new int2(cell.x, cell.y + offset.y))) { continue; }
```
```
  A*：f 最小的先出堆（朝终点偏置）   Dijkstra：h ≡ 0，按 g 均匀铺开
   ▓ │ .   (0,0)、(1,1) 可走，(0,1)、(1,0) 阻挡
   ──┼──   禁贴角 ⇒ NoPath   允许贴角 ⇒ Found（路径 2 个点）
   . │ ▓
```
同一条规则在**视线拉直**的 Bresenham 里要再查一次，否则拉直会把路径重新穿回那个角。

---

## 3. 内核：二叉堆 + 生成标记
每次查询都清 `gScore`/`closed` 是上万请求下最容易被吃掉的预算。这里的标记表存的是**世代值**：
```
m_Marks[i] : int      m_G[i] : float      m_CameFrom[i] : int
   └─ 只记「哪一代碰过、碰到哪种状态」：
        == 2*q ⇒ open      == 2*q + 1 ⇒ closed      其它 ⇒ 本次没碰过
BeginQuery()：q++ → m_OpenMark = 2q、m_ClosedMark = 2q+1 → 堆 Clear()   ← O(1) 重置
              （只有 q 逼近 int.MaxValue/2 时才整表清零一次）
m_HeapIndex / m_HeapF：二叉最小堆（格下标 + f），初始容量 max(16, 格数/4)
  pop 出来若已 closed ⇒ 陈旧条目（同格被更优路径重新入堆过）⇒ continue
```
**三态**：`Found` 回溯 `CameFrom`（终点→起点）后原地反转，路径含起点与终点；`NoPath` 堆空却没到终点；`ExceededLimit` 是访问格数超限提前放弃。
```csharp
var limit = config.MaxVisitedNodes > 0 ? config.MaxVisitedNodes : grid.CellCount;
...
if (scratch.VisitedCount >= limit) { return AStarStatus.ExceededLimit; }
```
`SmoothPath` 的**视线拉直**：从左端锚点出发，能直达就尽量跳到最远那一点，用 Bresenham 逐格确认只穿过可走格。工作区同样复用：`EnsureCapacity(grid.CellCount, allocator)` 容量够就什么都不做 —— 实测同一块工作区连跑 50 次相同查询，结果逐点一致。

---

## 4. ECS 集成：请求 → 并行求解 → 写回
契约是三个组件 + 一个缓冲。`AStarAccess.RequestPath` 自动补齐缺失的 `PathStatus`/`PathWaypoint` 并把 `Version` 加一；`AStarAccess.FindPath` 是主线程同步出口。系统只在 `PathStatus.SolvedVersion != PathRequest.Version` 时重算。
```
AStarSolveSystem.OnUpdate（主线程）
 ① ToArchetypeChunkArray ──► requests[] / solved[]   一次批量拷，不再逐实体 GetComponentData
 ② 挑「版本落后」的请求 ──► solveIndices（受 MaxSolvesPerFrame 预算）
 ③ Schedule(SolvePathsJob, solveIndices.Length, 1)
       i ─► SolveIndices[i] ─► ScratchPool[ThreadIndex]  （每线程一份工作区）
                              └► PathPool[ThreadIndex]    （每线程一块路径，追加）
 ④ Complete()
 ⑤ 各块路径拼成扁平 paths[]，再按 chunk 写回 PathWaypoint / PathStatus
       ↑ job 里不改 DynamicBuffer 长度 —— 那是结构性变更，只能主线程做
```
```csharp
[NativeSetThreadIndex] public int ThreadIndex;
[NativeDisableParallelForRestriction] public NativeArray<AStarScratch> ScratchPool;

public void Execute(int i)                 // 下标 i 只对应 SolveIndices[i] 这一个请求
{
    var scratch = ScratchPool[ThreadIndex];              // 只碰自己那块
    scratch.EnsureCapacity(Grid.CellCount, Allocator.Persistent);
    var block = PathPool[ThreadIndex];                   // 路径块按需新建（Persistent）
    var offset = block.Length;                           // 本线程本帧的路径依次拼进自己这块
    var status = AStarPathfinder.FindPath(Grid, Requests[SolveIndices[i]].Start,
                                          Requests[SolveIndices[i]].End, Config, ref scratch, ref block);
    ScratchPool[ThreadIndex] = scratch;
    PathPool[ThreadIndex] = block;                       // UnsafeList 按值拷贝 ⇒ 必须写回
    Slots[SolveIndices[i]] = new SolveSlot { Solved = 1, Status = status, Block = ThreadIndex,
                                             BlockOffset = offset, Length = block.Length - offset };
}
```
| 原来 | 现在 |
| --- | --- |
| 逐实体 `GetComponentData<PathStatus>` | 一次 `ToArchetypeChunkArray` + chunk 批量拷（1 万实体少 1 万次主线程组件访问） |
| 串行 `IJob` + 每请求各开工作区 | `IJobParallelFor` + 按线程索引的池（长 `JobsUtility.MaxJobThreadCount`，`OnDestroy` 释放） |
>- `SolveSlot.Block` 就是**写它的 job 线程号**，拼接阶段不需要锁，也不需要每请求分配。
>- 网格在 `OnCreate` 里就建一次，World 刚建好 `AStarAccess` 就能取到；之后只在 `AStarSettings.Version` 变化时重建。
>- 缺 `PathWaypoint` 的实体会被补一个空缓冲，但结构性变更会重建 chunk 列表 —— 补完必须重新取 chunk 与类型句柄。

---

## 5. `MaxSolvesPerFrame`：超出的请求留到下一帧
`<= 0` 不限；否则每帧最多解 K 个「版本落后」的请求。
```csharp
var budget = config.MaxSolvesPerFrame > 0 ? math.min(config.MaxSolvesPerFrame, total) : total;
for (var i = 0; i < total && solveIndices.Length < budget; i++)
    if (solved[i] != requests[i].Version) { solveIndices.Add(i); }
```
>- **不是丢弃**：没解到的 `SolveSlot.Solved == 0`，主线程按 `Skipped` 跳过，`PathStatus` 一个字节不动、版本也不改，下一帧还在候选里。
>- 候选按 chunk 顺序扫描，公平性只是"按遍历顺序轮转"，不保证同一实体每 K 帧一定轮到；调用方要自带看门狗（演示里等待超过 `PendingTimeoutSeconds` 就强制重发），避免"模块没装 / 网格没建"时永久停在等待里。

---

## 6. 编辑器工具链
```
┌─ A* 寻路网格（菜单 Tools/DOTSUtils/A* 寻路网格）────────┐
│ 网格资产  [AStarShipGrid.asset]  [新建并保存][定位]      │
│ 参数      Bounds 中心/半长、格边长、邻接方式、允许贴角、  │
│           算法、启发式权重（Dijkstra 时置灰）、最大访问   │
│           格数、每帧最大求解数、拉直路径                  │
│ 统计      尺寸 60 × 40   总格数 2400                      │
│           可走 2034（阻挡 366）   掩码 2400 字节          │
│ 掩码编辑  [全部可走][全部阻挡][反转][导入][导出][复制]    │
│ 从场景烘焙 层遮罩/射线起点高度/最大落差/命中算可走        │
│ 绘制模式  ☑启用 笔刷半径 0–32 左键=可走 右键=阻挡(Undo)   │
│ 示例寻路  起点/终点（或在 SceneView 点选）→ [算一条路径]  │
│ SceneView 叠加  ☑网格外框 ☑格线 ☑阻挡格 ☑路径与端点      │
└───────────────────────────────────────────────────────────┘
SceneView：青=格线 红=阻挡格 绿=起点 橙=终点 黄=示例路径(宽 4)
上限：> 2500 格不画每条格线；阻挡格 > 600 只画轮廓线；只画前 4000 个阻挡格
```
**从场景烘焙**（`AStarBakeUtility`）：逐格从「格中心 + 起点高度」向下打一条长为 `起点高度 + 最大落差` 的射线；命中且落差在 `[0, maxDrop]` 内时，按 `hitWalkable` 决定这格算可走还是阻挡。
```csharp
// 把场景里刚摆好 / 刚改过的 Transform 同步进物理世界，射线才打得到当前位置的碰撞体。
Physics.SyncTransforms();
Physics.Raycast(origin, Vector3.down, out var hit, rayLength,
                layers.value, QueryTriggerInteraction.Ignore)
```
>- **`Physics.SyncTransforms()`**：物理世界不会在每次改 `Transform` 后立刻更新；不调它，刚摆好的墙对射线"不存在"。
>- **`QueryTriggerInteraction.Ignore`**：`isTrigger` 是给触发器逻辑用的，不该被当成地面或墙。
>- 射线只打**已加载场景**的物理世界（目标场景必须是当前场景）；整个掩码会被覆盖，函数自己记 `Undo`、标脏并刷新 SceneView。资产侧 `AStarGridAsset`（参数 + 行主序 `byte[] mask`）参数变化时 `ResizeIfNeeded()` 按格对齐搬旧掩码、新格默认全可走；场景挂 `AStarGridSource`，`OnEnable` 推给 `AStarSettings`。

---

## 7. `PathObstacleBuilder`：掩码 → 闭合多边形
把阻挡格交给 RVO 时，**一堆独立线段不够用**：RVO2 的静态障碍物是**带拓扑的闭合多边形**（每个顶点带 `Prev`/`Next`/`UnitDir`/`IsConvex`，腿方向和凸性都要借邻边算）。本工程在 1 格厚双面薄墙上试过两版：只用"中心到线段距离"的正统判据 → **400/400 全穿**；改用自创的"落在内侧半平面即已侵入"判据 → 位移被压到 0.45~0.52（越走越慢 / 爬行）。两次都缺邻边方向修正与 `isConvex` 门控。
```
① 有向单位格边：阻挡格永远在行进方向（A→B）的左侧
   60×40 / 366 阻挡格 → 742 条有向格边（每条格边只用一次）

② 接环：在角点上按「左转 → 直行 → 右转 → 掉头」取第一条存在的格边
     ├─ 4 邻网格：每角点最多 2 条格边且必互为反向
     │   ⇒ 等价于「沿边界直行、对角相接处左转」⇒ 环不交叉、不同环不串
     ├─ 共线合并：进边方向 == 出边方向 ⇒ 丢掉该顶点
     └─ 洞：同一套「阻挡区在左」规则自然反向成环，无需特判

③ 输出（真实掩码 AStarShipGrid.asset：60×40 / 366 阻挡格）
   7 个闭环 / 52 个顶点      外框 +2400
     ├─ 28 顶点的大洞环 −2082    Σ有向面积 = 2400 − 2082 + 48 = 366
     └─ 5 个矩形岛 +5 +5 +28 +5 +5   （上界：顶点 9600 / 多边形 2400）
```
```csharp
// 后继：按「左转 → 直行 → 右转 → 掉头」取第一条存在的格边
var direction = (inDirection + 1 - k + k_DirectionCount) % k_DirectionCount;
if (EdgeExists(in grid, x, z, direction)) { return direction; }
```
>- **为什么必须闭合**：只有成环，下游才算得出"这条边的两条邻边是谁"和"哪侧是障碍物内部"。`RvoAccess.SetObstacles(world, 扁平顶点, 每个多边形的顶点数)` 收的就是这个形状，`RvoObstacleBuilder` 再按 RVO2 `RVOSimulator::addObstacle` 的语义补 `Prev`/`Next`/`UnitDir`/`IsConvex`（`n == 2` 的退化多边形就是一条零厚度墙，两条边都算凸）。
>- **外框为什么是一个环**：网格外一律算非阻挡，所以可走区边界自身也成环（面积 +2400 = 整块场地）；洞反向成环、面积取负，两者自动抵消出 366。
>- 顶点数（52）与合并后的线段条数相同 —— 合并在接环时就完成了；`BuildPolygons` 是纯函数、不分配托管内存，job 与编辑器两侧都能调（旧入口 `PathObstacleSegment`/`Build` 保留）。
>- 船群演示 `UseRvoObstacles = true`，`SyncObstacles()` 用 `AStarSettings.Version` 做版本守卫，只在网格重建时写一次；失败各打一条 warning 后继续。

---

## 8. 实现要点与坑
**坑 1：`AStarStatus.Found == 0`，默认 `PathStatus` 会误报。**
```csharp
// Found 是 0，默认值也报 Found：必须配 SolvedVersion 才说明真的解过。
if (status.SolvedVersion > 0 && status.Status == AStarStatus.Found && status.WaypointCount > 0)
```
`PathStatus` 是 struct，默认构造就是 `Status = Found`；从没请求过的实体（`Version == 0`、`SolvedVersion == 0`）被"版本相等 ⇒ 已是最新"这条判据跳过，于是永远停在"看起来 Found"的默认值上。曾把「1 万个 Found」当成求解成功，**真判据是 `SolvedVersion > 0`**。反过来这也是特性：演示生成 agent 时故意让请求与结果留默认值，系统就不会去解它。

**坑 2：跟路径必须用单调游标。**
```csharp
// 换到新路径就把游标重置为 1（跳过 waypoints[0] —— 那是申请路径时所在的位置）
if (motion.PathCursorVersion != status.SolvedVersion)
{
    motion.PathCursorVersion = status.SolvedVersion;
    motion.WaypointIndex = waypoints.Length > 1 ? 1 : 0;
}
while (motion.WaypointIndex < waypoints.Length - 1 &&
       DistanceSqXZ(waypoints[motion.WaypointIndex].Position, position) <= arriveSq)
    motion.WaypointIndex++;      // 只前进不后退：避免「掉头回起点」与「去目标」来回摆
```
`PathWaypoint[0]` 是**申请那一刻的位置**。若每帧都从 0 起找"最近路点"，船会先掉头回去找刚离开的起点、再转回来奔目标 —— 表现为原地来回摆。实测转向角从 **29.36°/帧 → 0.01°/帧**。游标只在**新的 `SolvedVersion`** 到来时重置，所以"改目标 → 求解 → 换路径"这条链是干净的。

两条推论：改参数后要比对 `AStarSingleton.BuildVersion`（演示里是 `motion.GridBuildVersion`）作废旧路径；请求迟迟不回来时先分清是"在等在解"（`SolvedVersion != Version`）还是被 `MaxSolvesPerFrame` 排队。另外**路径不穿墙 ≠ 积分不穿墙** —— 演示在 `Integrate` 里用同一份掩码做分轴滑动，两轴都被挡才退回上一位置。

---

## 9. 验收与基线
| 项 | 值 |
| --- | --- |
| EditMode / PlayMode | `AStarTests` **19 条** + `PathObstacleBuilderTests` **24 条**（工作区连续 50 次复用结果稳定、拉直不穿墙、Dijkstra 不受权重影响、40 组随机掩码不变量、演示掩码 7 环/52 顶点）；`AStarSystemTests` **12 条**（装配与重建、同步门面、版本没变不重算、每帧上限超出的留到下一帧、Dijkstra 切换） |
| 工程与演示基线 | EditMode **153 / 153 passed**、PlayMode **176 总 / 174 passed / 0 failed / 2 skipped**（2 条 `[Ignore]` 在 Visibility，与本模块无关）；1 万实体演示 20008 个实体、纯系统成本 **5.3 ~ 13.2 ms/帧**；船群 400 艘（τ_obst = 2）障碍物 7 环/52 顶点、第 60/120/180/240/300 帧平均位移 `1.41/3.07/3.56/3.71/3.28`、落在阻挡格 `0/0/0/0/0` |
