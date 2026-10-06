---
title: 'Unity 寻路入门：手写 A* 与 Dijkstra（附 DOTS 并行改造）'
description: '从零实现网格 A*：世界↔格坐标换算、g/h/f 与可采纳启发式、二叉堆 + 世代标记、视线拉直、掩码提取闭合多边形，最后用 IJobParallelFor 在 DOTS 里并行求解'
pubDate: '2026-09-29'
category: '算法'
tags: ['Unity', 'DOTS', 'A*', 'Dijkstra', '寻路', '算法']
---

## 速览

>- **A* 和 Dijkstra 是同一份代码**：启发式权重 `w` 取 1 就是 A*，取 0 就是 Dijkstra，其余逻辑一个字都不用改。
>- **网格的本质只有两样**：一组参数（原点、格边长、尺寸）+ 一行行"这格能不能走"的字节，行主序排放，`index = z * Size.x + x`。
>- **启发式只能低估、不能高估**：高估会让 A* 以为某条路很便宜，从而错过真正的最短路。
>- **别每帧清空 g/closed 表**：给每格记一个"世代号"，查询开始时只把世代号 +1，重置就是 O(1)。
>- **并行求解要给每个线程一份独立工作区**：多个请求共用一块 scratch，结果会互相踩烂。

---

## 0. 要做的东西

给你一个平面上的方格网，标出哪些格能走，输入起点与终点，输出一串格坐标。然后加三件事，让它能用在游戏里：

1. **平滑**：把一格一格拐直角的折线拉成尽量少的直线段；
2. **并行**：同一帧几百上千个角色要路，串行算不过来，扔进 DOTS 的 job；
3. **几何输出**：把阻挡格掩码变成闭合多边形，交给局部避让之类的系统当静态障碍物。

```text
[网格数据]──►[A* 内核]──►[回溯路径]──►[视线拉直]──►[一串路点]
                 ▲
                 └────── Dijkstra（同一份内核，只改一个权重数）
```

---

## 1. 网格：世界坐标 ↔ 格坐标

### 1.1 网格只用两样东西描述

```csharp
public struct Grid
{
    public float2 Min;        // 网格左下角（世界的 XZ 最小值）
    public float  CellSize;   // 每格边长（正方形格，X 与 Z 相同）
    public int2   Size;       // 每轴多少格：Size.x 对应世界 X，Size.y 对应世界 Z
    public float  CenterY;    // 格中心高度，所有格共用
}
```

`Size.y` 对应世界的 **z**：网格压在 XZ 水平面上做 2D 搜索，第三维不参与。沿用 `int2` 的 `.x/.y` 命名但心里要清楚第二个分量是 z —— 这种"格子坐标系"与"世界坐标系"混用是新手最常翻车的地方。`CenterY` 是一条约定：所有格中心取同一个 y（一般取包围盒中心高度），于是路径是平面上的、不随地面起伏乱拐；上下楼属于另一套系统的事。

### 1.2 世界坐标 → 格坐标

```text
WorldToCell(p) = floor( (p − Min) / CellSize )
```

`floor` 不能换成 `round` 或 `(int)` 强转。设 `Min = (0,0)`、`CellSize = 2`：`p=(1.9, 0.5)` 算出 `(0.95, 0.25)`，floor 后是格 `(0,0)`；`p=(2.0, 0.5)` 算出 `(1.0, 0.25)`，进格 `(1,0)`；而 `p=(−0.1, 0.5)` 算出 `(−0.05, 0.25)`，floor 后是格 `(−1, 0)` —— **负数也在网格外，必须判越界**。用 `(int)` 强转时 `−0.05` 会被截断成 `0`，"网格左侧外一点点"就被误判成"网格内最左一格"，所以必须用 `floor` 之后再查一次越界。

```csharp
public int2 WorldToCell(float3 world)   // 入参是世界位置，注意用 z
{
    return new int2((int)math.floor((world.x - Min.x) / CellSize),
                    (int)math.floor((world.z - Min.z) / CellSize));
}
```

### 1.3 格坐标 → 世界坐标（格中心）

一格 `c` 覆盖的世界区间是 `[Min + c*CellSize, Min + (c+1)*CellSize)`，取中心：`CellCenter(c) = Min + (c + 0.5) * CellSize`，y 取 `CenterY`。仍用 `Min = (0,0)`、`CellSize = 2`：格 `(0,0)` 中心是 `(1.0, 1.0)`，格 `(1,0)` 中心是 `(3.0, 1.0)` —— 相邻两格中心正好差一个 `CellSize`。

```csharp
public float3 CellCenter(int2 cell)     // 入参是"第几格"，别把世界坐标传进去
{
    return new float3(Min.x + (cell.x + 0.5f) * CellSize, CenterY,
                      Min.y + (cell.y + 0.5f) * CellSize);
}
```

### 1.4 行主序掩码与越界处理

每格"能不能走"用一个字节表示，全部连成一维数组，按行优先排：

```text
世界 XZ（Min 在左下角）
          min.x                              ← 格坐标 x
   min.z ─┬──────┬──────┬──────┬──────┐
    z=0   │ x=0  │ x=1  │ ▓▓▓  │ x=3  │   ▓ = 阻挡（掩码字节 0）
          ├──────┼──────┼──────┼──────┤   index = z * Size.x + x   （行主序）
          └──────┴──────┴──────┴──────┘   Size = ceil(包围盒长 / CellSize)
```

```csharp
public int Index(int2 cell)
{
    if (cell.x < 0 || cell.y < 0 || cell.x >= Size.x || cell.y >= Size.y) return -1;
    return cell.y * Size.x + cell.x;
}

public bool IsWalkable(int2 cell)
{
    var i = Index(cell);
    return i >= 0 && i < Mask.Length && Mask[i] != 0;   // 越界一律算不可走
}
```

`index = z * Size.x + x` 的好处：同一行（z 相同）的数据在内存里连续，取邻居时缓存友好；代价是每行末尾要单独判边界。三条约定要写死：**掩码为空 → 全可走**（没有地形信息时不该把角色锁死）、**掩码长度不足 → 缺的部分算不可走**（宁可保守）、**非 1 的字节也算阻挡**（只有明确是 1 才可走，避免脏数据被当通行证）。

`IsWalkableWorld(p)` 就是 `IsWalkable(WorldToCell(p))`，凡是问"这位置能不能站"的地方都复用它。`Size` 用 `ceil` 而不是 `floor`：余下的零头也占一格，否则最右边一条被裁掉，角色走到边界就"凭空出界"。

---

## 2. A* 是怎么推出来的

### 2.1 三个分数：g、h、f

- **g**：从**起点**走到当前格的已知代价，真实走过的步数加权和；
- **h**：从当前格到**终点**的估计代价，叫启发式（heuristic），纯靠猜；
- **f = g + h**：总代价估计。每轮从待处理集合里挑 **f 最小**的格子继续扩展。

为什么挑 f 最小就能得到最短路？f 可以读成"已经花掉的 + 还要花的估计"。只要 h 从不高估，**当前 f 最小的那格的 f 值就是所有剩余路线的下界**；于是第一次把终点取出来时，其他候选的下界都不比它小，终点这条必然全局最优。

### 2.2 启发式必须不高估（可采纳性）

对任何格子算出的 h 都**不大于**真实剩余代价，就叫**可采纳**（admissible）。一旦高估，A* 可能提前认定"绕障碍那条路更贵"而放弃它，最后给出次优解。

```text
    x=0  x=1  x=2  x=3  x=4
z=0  S    .    .    .    .
z=1  .    #    #    #    .
z=2  .    #    G    #    .
z=3  .    #    #    #    .
z=4  .    .    .    .    .
```

上图真实最短路只能沿外圈绕：`2（下到 z=4）+ 4（横到 x=4）+ 2（回到 z=2）= 8` 步（4 邻、每步代价 1）。若写了个坏启发式 `h = 10 × 曼哈顿距离`，`S(0,0)` 到 `G(2,2)` 的曼哈顿距离是 4，于是 `h(S) = 40`，而真实最优只要 8；`G` 左边那格 `(1,2)` 的 `h = 10`，也远大于它的真实代价 1。于是 A* 优先探索"看起来离终点最近"的方向，撞墙后不得不回头，而"绕远路"的方向 h 被夸大、永远排在后面 —— 它找到终点就停手，手里那条是"以为最便宜"的路，不是最短路。

**结论**：h 只能是乐观估计。宁可低估（把 h 全取 0 就是 Dijkstra，一定最优但慢），也不要高估。

### 2.3 4 邻的曼哈顿距离

从 `(x1,z1)` 到 `(x2,z2)`，水平要走 `dx = |x1 − x2|` 步、垂直 `dz = |z1 − z2|` 步：

```text
h = dx + dz        （曼哈顿距离：每步最多让这个量减 1，所以它是剩余步数的下界）
```

**手算**：`(0,0)` → `(3,1)`，`dx=3, dz=1`，`h=4`；真实最优也确实是 4 步（3 横 + 1 纵）。

### 2.4 8 邻的 octile 距离

8 邻多了对角走，一步同时把 `dx`、`dz` 各减 1，代价 `√2 ≈ 1.414`（比走两次正交便宜，所以会尽量用对角）。最优走法很直观：先尽量对角，走不动了再直线。设 `d = min(dx,dz)`、`s = max(dx,dz) − d`：

```text
h = √2 · d + 1 · s
  = dx + dz + (√2 − 2) · min(dx, dz)      （整理后的等价写法，由 s = dx + dz − 2d 代入得到）
```

**手算**：`(0,0)` → `(3,1)`，`d=1, s=2`，即"1 步对角 + 2 步横向"，`h = 1.414×1 + 1×2 = 3.414`；用第二式验算 `3 + 1 + (1.414 − 2)×1 = 3.414` ✓。它小于"全走直线"的 4，因为对角更便宜；而这段算式恰好就是最优走法的精确代价，所以**绝不会高估**。

### 2.5 一致性：闭集里的格子为什么不用重开

相邻两格的 h 差不超过这一小步的代价，就叫**一致**（consistent）。曼哈顿与 octile 都满足，因为相邻一步最多让 `dx + dz` 减 1。好处很实在：把某格取出并标记 closed 时它的 g 已最优，后续不必回头修正，所以可以放心写 `if (State(nextIndex) == Closed) continue;`。

### 2.6 权重：一个数把 A* 变成 Dijkstra

在 h 前乘权重 `w`，`f = g + w × h`：

- `w = 1`：标准 A*，最优；
- `w = 0`：`f = g`，h 完全不参与 —— 这就是 **Dijkstra 算法**（按 g 一圈圈均匀铺开，直到淹到终点）；
- `w > 1`：更贪心、往终点冲得更快，**但可能不是最短路**；可以证明解代价不超过 `w × 最优代价`（h 一致时）。这是个好用的旋钮：路稍长一点，但算得快很多。

```csharp
// 只改这一行就切换了算法
var weight = config.Algorithm == Algorithm.Dijkstra ? 0f : math.max(1f, config.HeuristicWeight);
```

```text
   A*：f 最小的先出堆（朝终点偏置）      Dijkstra：h ≡ 0，按 g 均匀铺开
      S . . . .                              S ← 一圈一圈向外淹
      . # # # .                              ← 每圈代价相同
      . # G # .                              → 直到碰到 G 才停
      . . . . .
```

| 邻接方式 | 启发式 h | 单步代价 | 可采纳性 |
| --- | --- | --- | --- |
| 4 邻 | `dx + dz`（曼哈顿） | 正交 1 | 是（下界） |
| 8 邻 | `dx + dz + (√2 − 2) · min(dx, dz)`（octile） | 正交 1 / 对角 `√2 ≈ 1.41421356` | 是（8 邻下精确） |

---

## 3. 八个邻居与"禁止贴角"

```csharp
static readonly int2[] k_Neighbours8 = {
    new int2( 1, 0), new int2(-1, 0), new int2(0,  1), new int2(0, -1),   // 正交，代价 1
    new int2( 1, 1), new int2( 1,-1), new int2(-1, 1), new int2(-1,-1),   // 对角，代价 √2
};
```

```text
   ▓ │ .      (0,0)、(1,1) 可走，(0,1)、(1,0) 阻挡
   ──┼──      从 (0,1) 斜走到 (1,0)？目标格本身就是阻挡，走不了
   . │ ▓
```

真正阴险的是这种：起点左上、终点右下，右上和左下都是阻挡，那条对角恰好穿过两个阻挡格共用的角点。数学上"从角点穿过去"是一条**零宽度**通道，但角色有半径，物理上过不去；允许这么走，角色就会卡在墙角来回蹭。

```text
   允许贴角                        禁止贴角
   ▓ │ .                          ▓ │ .
   ──┼──  ⇒ 找到路径（两点直达）    ──┼──  ⇒ NoPath（必须绕远）
   . │ ▓                          . │ ▓
```

判据：对角 `(x,z) → (x+dx, z+dz)` 能走，当且仅当它的**两个正交邻居** `(x+dx, z)` 与 `(x, z+dz)` 里**至少一个**可走。

```csharp
if (diagonal && !config.AllowCornerCutting)
{
    var sideA = new int2(cell.x + offset.x, cell.y);   // 先横后纵
    var sideB = new int2(cell.x, cell.y + offset.y);   // 先纵后横
    if (!grid.IsWalkable(sideA) && !grid.IsWalkable(sideB)) continue;  // 都堵 → 禁斜穿
}
```

做成 `AllowCornerCutting` 开关是为了适配不同游戏：不考虑体积的棋类反而需要贴角通行。**第 5 节的视线拉直必须复用同一条判据**，否则会出现荒唐结果：寻路阶段老实绕开了墙角，拉直阶段又用"只看格子是否可走"的宽松判据把路径从那个角上拽回去 —— 绕了一圈等于没绕。一句话：**规则在哪个环节生效，就必须在每个会改动路径的环节都生效。**

---

## 4. 内核：二叉堆 + 世代标记

A* 每轮都要取 f 最小的待处理格。线性扫描是 O(n)，上万格跑一次到 O(n²) 直接卡死；**二叉最小堆**把取最小与插入都降到 O(log n)，两个并行数组就够（`m_HeapIndex` 存"堆里第 i 个元素是哪个格子"，`m_HeapF` 存它的 f，外加一个 `m_HeapCount`）。上浮 / 下沉就是教科书那套"和父节点比大小，不行就换"。

同一格可能被多次入堆（每次找到更短的 g 就再插一次），旧条目不会主动消失。省事的处理：**出堆时看这格是否已定稿，是就丢掉继续弹**（`if (State(index) == Closed) continue;`）。

### 4.1 世代标记：不清理也能重置

朴素实现每次查询开头都要把 `gScore`、`closed`、`cameFrom` 整表清一遍。几千格、一帧几百请求时，这个清理本身就是大头。技巧是**不清表，改记"哪个世代碰过它"**：每次查询分配一个自增世代号 `q`，标记表里存**编码后的状态**：

```text
m_Marks[i] : int        m_G[i] : float        m_CameFrom[i] : int
  └─ 只记「哪一代碰过、碰到哪种状态」：
       == 2*q      ⇒ 本代的 open
       == 2*q + 1  ⇒ 本代的 closed
       其它         ⇒ 本代没碰过（等价于"没有值"）
```

为什么乘 2？一次查询里一格只有两种状态，用"偶数 / 奇数"两个编码就能区分，而且都带着世代信息；`2q` 与 `2q+1` 天然错开，上一代的编码不可能与这一代撞上。

```csharp
int m_QueryId, m_OpenMark, m_ClosedMark;

public void BeginQuery()               // 全程没有循环 ⇒ O(1)
{
    m_QueryId++;
    m_OpenMark   = 2 * m_QueryId;
    m_ClosedMark = 2 * m_QueryId + 1;
    m_HeapCount  = 0;                  // 堆只清计数
}

int State(int i) => m_Marks[i] == m_OpenMark   ? Open
                  : m_Marks[i] == m_ClosedMark ? Closed
                  : None;
```

（`m_QueryId` 逼近 `int.MaxValue / 2` 时才需要整表清零一次，属于万年一遇。）

```text
   m_Marks[]  →  [ 6, 7, 0, 6, 0, 7, ... ]        （假设本代 q = 3）
                   │  │  │  │  │  └─ 本代 closed（2*3+1）
                   │  │  │  │  └──── 本代没碰过
                   │  │  │  └─────── 本代 open（2*3）
                   │  │  └────────── 上一代残留，本代视为"没有值"
                   └──┴───────────── 同样被忽略
```

> 这个模式别处也通用：**版本号 / 世代号代替"清空"**，是高频复用缓冲区的标准套路。

### 4.2 上限、三种结果、回溯

搜索可能因网格太大而跑很久，给一个访问格数上限：

```csharp
var limit = config.MaxVisitedNodes > 0 ? config.MaxVisitedNodes : grid.CellCount;
...
if (scratch.VisitedCount >= limit) return Status.ExceededLimit;
```

`limit <= 0` 时退回"整张网格的格数"，实质不限；每弹出一个真正有效的格子（不是陈旧条目）`VisitedCount` 加一。于是有三种结果：

| 结果 | 含义 | 表现 |
| --- | --- | --- |
| `Found` | 找到路径 | 堆里弹出了终点 |
| `NoPath` | 起终点不连通 | 堆弹空了还没见到终点 |
| `ExceededLimit` | 主动放弃 | 访问格数到达上限 |

调用方必须能区分三者。最常见的 bug 就是把"超限放弃"当成"确实没路"，然后告诉玩家"此地无法到达"。

每个被扩展的格子记下"我从谁而来"（`m_CameFrom[nextIndex] = currentIndex;`）。找到终点后顺着 `CameFrom` 从终点往回走到起点，得到的是**终点 → … → 起点**，原地反转一次就是正常行进顺序（含起点与终点）：

```csharp
// 约定：结果路径 L[0] = 起点、L[^1] = 终点
for (var i = L.Length / 2 - 1; i >= 0; i--) { /* swap L[i], L[L.Length-1-i] */ }
```

把 `m_Marks`、`m_G`、`m_CameFrom`、堆数组打包成 `Scratch`，配 `EnsureCapacity(cellCount, allocator)`：容量够就**什么都不做**，不够才重新分配。连续跑很多次查询只分配一次内存，且世代标记保证结果不互相污染 —— 复用的前提是"语义上确实没有残留"，换别的数据结构时先想清楚：**上次的数据会不会被这次当成有效值读出来？**

---

## 5. 视线拉直：把折线变成直线段

A* 输出的是"一格一格"的路径，8 邻下已会走对角，但仍呈锯齿状。拉直的目标：**路点尽量少**，且每段不穿过任何阻挡格。"从 A 能不能直着走到 B"等价于"沿 A→B 的线段经过的每一格都可走"，逐格枚举这条线的办法就是 **Bresenham 直线算法**：每步在 x 或 z 方向前进一格，有时两轴同时前进 —— 那就是一次对角步。

```csharp
bool LineOfSight(int2 a, int2 b, in Grid grid)
{
    int dx = math.abs(b.x - a.x), dz = math.abs(b.y - a.y);
    int sx = a.x < b.x ? 1 : -1, sz = a.y < b.y ? 1 : -1;
    int err = dx - dz;
    var cur = a;

    while (true)
    {
        if (!grid.IsWalkable(cur)) return false;
        if (cur.x == b.x && cur.y == b.y) return true;

        int e2 = 2 * err;
        var stepX = e2 > -dz;
        var stepZ = e2 <  dx;

        // 两轴同时动 = 一次斜穿角，判据必须和 A* 的 8 邻一致
        if (stepX && stepZ && !grid.AllowCornerCutting)
        {
            var sideA = new int2(cur.x + sx, cur.y);
            var sideB = new int2(cur.x, cur.y + sz);
            if (!grid.IsWalkable(sideA) && !grid.IsWalkable(sideB)) return false;
        }

        if (stepX) { err -= dz; cur.x += sx; }
        if (stepZ) { err += dx; cur.y += sz; }
    }
}
```

`stepX && stepZ` 这个分支就是第 3 节说的"同一条判据"：Bresenham 的对角步与 A* 的对角扩展，是同一件事在两个环节的形态。有了它，拉直就是个贪心循环 —— 锚点从左端起，从最远处倒着试，能直达就直接跳过去：

```text
原始路径（逐步）:  S ─ a ─ b ─ c ─ d ─ G
          锚点 = S：S→G 通 ⇒ 结果 [S, G]，一次到位
                    S→G 不通 ⇒ 试 S→d、S→c … 取第一个通的位置设为新锚点
```

```csharp
var output = new NativeList<int2>(allocator);
output.Add(path[0]);                       // 起点一定是路点
var anchor = 0;
while (anchor < path.Length - 1)
{
    var next = path.Length - 1;            // 从最远处往回找
    while (next > anchor + 1 && !LineOfSight(path[anchor], path[next], grid)) next--;
    output.Add(path[next]);                // 至少推进一格，不会死循环
    anchor = next;
}
```

```text
  拉直前（8 邻 A*，锯齿）            拉直后（少路点、方向干净）
  S─┐                                S ─────────────┐
    └─┐                                            │
      └─┐                                          │
        └─G                                        G
```

另一个好处是省掉"格中心之间来回拐"的抖动：转向目标从一个锯齿序列变成几段直线，转向角自然平顺。代价是 `LineOfSight` 单次 O(线段长度)，最坏整条路径反复试到 O(n²)；路径几十到几百格时可接受，特别长就限制"每次最多看 K 格"。

---

## 6. DOTS 里的并行求解

### 6.1 请求与结果的组件划分

最自然的拆分：**一个实体挂一个"请求组件"和一个"结果组件"**。

```csharp
// 请求：我要一条从 Start 到 End 的路（格坐标）
public struct Request : IComponentData
{
    public int2 Start, End;
    public int  Version;          // 调用方每改一次起点/终点就 +1
}

// 结果：上次解出的状态与版本
public struct Status : IComponentData
{
    public int SolvedVersion;     // 对应哪一版请求
    public int Result;            // Found / NoPath / ExceededLimit / 未解
    public int WaypointCount;
}

[InternalBufferCapacity(16)]
public struct Waypoint : IBufferElementData { public float3 Position; }
```

系统只在 `Status.SolvedVersion != Request.Version` 时重算。这就是**版本号驱动的脏标记**：免去额外的 bool 标记，还天然处理"同一帧里请求改了好几次"。

### 6.2 每线程一份工作区

并行 job 里多个请求同时在多个线程上跑。共用一份 `Scratch` 的话，A 的 `m_Marks` 会被 B 覆盖，两边结果都成垃圾。所以工作区**按线程**分配，用 `[NativeSetThreadIndex]` 拿线程号去索引：

```csharp
[NativeSetThreadIndex] public int ThreadIndex;                    // 0 .. MaxJobThreadCount-1
[NativeDisableParallelForRestriction] public NativeArray<Scratch> ScratchPool;
[NativeDisableParallelForRestriction] public NativeArray<UnsafeList<int2>> PathPool;

public void Execute(int i)                  // 下标 i 只对应 SolveIndices[i] 这一个请求
{
    var scratch = ScratchPool[ThreadIndex]; // 只碰自己那一份
    scratch.EnsureCapacity(Grid.CellCount, Allocator.Persistent);

    var block  = PathPool[ThreadIndex];
    var offset = block.Length;              // 本线程本帧的路径依次追加到自己这块后面
    var status = Solve(Grid, Requests[SolveIndices[i]].Start,
                             Requests[SolveIndices[i]].End, Config,
                             ref scratch, ref block);

    ScratchPool[ThreadIndex] = scratch;
    PathPool[ThreadIndex]    = block;       // UnsafeList 是值类型 ⇒ 必须写回数组
    Slots[SolveIndices[i]]   = new Slot { Result = status, Block = ThreadIndex,
                                          Offset = offset, Length = block.Length - offset };
}
```

必须记住的点：

- **池长度取 `JobsUtility.MaxJobThreadCount`**，一次分配到位、销毁时统一释放；
- **`[NativeSetThreadIndex]` 是线程槽位号，不是请求下标**，取值范围固定，所以数组长度可以提前确定；
- **`UnsafeList` 是值类型**（内部只是指针 + 长度 + 容量），从 `NativeArray` 里取出来是拷贝，改完必须 `PathPool[ThreadIndex] = block;` 写回去，否则新增容量和长度全丢；
- 每线程一块路径而不是每请求一块，省掉"每请求分配一次 NativeList"的开销，代价是拼接阶段要按 `(Block, Offset, Length)` 取。

### 6.3 job 里不能改 DynamicBuffer 长度

`DynamicBuffer<T>` 的长度变化是**结构性变更**（structural change）：会移动实体、重建 chunk，只能在主线程做，job 里绝不行。所以 job 里只写"扁平路径数组 + 槽位信息"，回主线程再逐实体写入：

```text
主线程                                        job 线程
 ① 收集 chunk 数组，批量读出请求 ─────────►
 ② 挑出"版本落后"的请求下标（受预算限制）
 ③ Schedule(SolveJob, count, 1) ──────────► 每个下标用自己线程的工作区求解
                                            结果写进扁平 paths[] + slots[]
 ④ Complete()  ◄────────────────────────────
 ⑤ 按 chunk 把路点写回各实体的 Waypoint 缓冲（只在此处做结构性变更）
```

第 ① 步的"批量读"值得说：别 `GetComponentData` 逐个实体取（每个实体一次主线程开销），用 `ToArchetypeChunkArray` 一次拿所有 chunk 再按 chunk 批量拷贝。实体一多，这是最直接的收益。另外，某实体**缺少** `Waypoint` 缓冲时要先补上（这本身也是结构性变更），补完之后**之前拿到的 chunk 列表与类型句柄全部失效、必须重新取一遍** —— 这类"改完结构就重新获取"的纪律，在 ECS 里要养成习惯。

### 6.4 结果怎么拼回主线程

job 结束后，每个线程的路径块是连续一段内存，主线程按槽位信息复制进各实体缓冲：

```csharp
for (var i = 0; i < count; i++)
{
    var slot = slots[i];
    if (slot.Result != k_Solved) continue;         // 本帧没解到，跳过
    var buffer = SystemAPI.GetBuffer<Waypoint>(entityFor[i]);
    buffer.Clear();
    for (var k = 0; k < slot.Length; k++)
    {
        var cell = PathPool[slot.Block][slot.Offset + k];
        buffer.Add(new Waypoint { Position = grid.CellCenter(cell) });   // 格坐标 → 世界坐标
    }
}
```

这里把格坐标转成世界坐标再写进缓冲 —— 上层运动代码只关心世界位置，不该再知道格子的存在。

---

## 7. 每帧求解预算：解不完就留到下一帧

一帧里可能几千个请求同时变脏，全解完会卡帧。加每帧上限：

```csharp
var budget = config.MaxSolvesPerFrame > 0
           ? math.min(config.MaxSolvesPerFrame, total)
           : total;                                  // <= 0 表示不限

for (var i = 0; i < total && solveIndices.Length < budget; i++)
    if (solved[i] != requests[i].Version)            // 版本落后 = 需要重算
        solveIndices.Add(i);
```

关键设计是**"留到下一帧"而不是"丢弃"**：没轮到的请求，结果组件里的 `SolvedVersion` 一个字节都不动，所以下一帧**仍然满足"版本落后"**，自然又进候选；主线程写回时按"本帧是否真的解过"跳过，绝不能顺手写一个 `NoPath` 进去 —— 那会让调用方以为"真的没路"。

```text
  帧 N：请求 0..999 都脏，预算 200 ⇒ 只解 0..199；帧 N+1 时它们的版本已相等，
        候选自然变成 200..999 ⇒ 再解 200..399
```

> 公平性只是"按遍历顺序轮转"，不保证每个实体每隔 K 帧一定轮到。所以调用方最好自带**看门狗**：等待超时就重发请求或退化到直走。否则一旦出现"系统没启用 / 网格没建好"，"永远在等"就变成永久定住。

---

## 8. 从掩码提取闭合多边形

### 8.1 为什么下游要闭合环而不是一堆线段

局部避让这类算法需要知道"障碍物边界是一圈"，还要回答两个问题：这条边的前一条、后一条是谁（算转向与法线方向）？哪一侧是障碍物内部（算"往外推"的方向）？一堆互不相连的线段回答不了：每条线段都是孤儿。**闭合环**天然带"上一个 / 下一个顶点"的结构，方向与内外随之确定。

### 8.2 第一步：有向格边

取出每条"阻挡格与可走格的公共边"，并统一方向，让**阻挡格永远在前进方向的左侧**。统一方向很重要：接环靠的就是"始终贴着障碍物走"，方向一致才能保证每个角点的选择是确定的。一个阻挡格最多贡献 4 条这样的有向边；相邻两个阻挡格共享的边不在"阻挡—可走"交界上，**不产出**，所以每条格边只用一次。

```text
  阻挡格 ▓ 的四条边（箭头 = 行进方向，▓ 在左侧）
        ▲
     ┌──┼──┐
     │  ▓  │◄──┐
     └──┼──┘   │
        ▼ ─────┘
  内部共用的边不产出：▓│▓ 两侧都是阻挡，不属于边界
```

### 8.3 第二步：按"左转优先"接环

所有有向边记在"起点角点 → 方向"的索引里。从一个角点出发，按固定优先级挑下一条边：**左转 → 直行 → 右转 → 掉头**（取第一条存在的边）。

```csharp
// inDirection 是"进这个角点时的方向"，k_DirectionCount 是方向总数
var direction = (inDirection + 1 - k_DirectionCount + k_DirectionCount) % k_DirectionCount;  // 先试左转
if (EdgeExists(in grid, x, z, direction)) return direction;
// 再依次试 直行、右转、掉头 …
```

**为什么"左转优先"就不交叉、不串环**？因为 4 邻网格上每个角点最多只有 2 条格边，而且必然**互为反向**的一进一出。于是"贴着障碍物沿边界走、遇到对角相接处向左拐"成了唯一自洽的走法：环不会自交，两个环也不会粘到一起。

**共线合并**：如果进边方向与出边方向相同（在这个角点直着穿过、什么都没拐），它就不是真拐点，直接丢掉 —— 合并与接环是同一步完成的，不是事后处理。

**洞怎么办？** 不用特判。因为"阻挡格在左侧"对洞的内壁同样成立，只是走出来的环方向相反、有向面积为负。下游按"正面积 = 外边界、负面积 = 洞"就能自动区分 —— 特殊情形被规则本身覆盖，代码里不需要多一个 `if (isHole)`。

### 8.4 4×4 手算例子

```text
      x=0  x=1  x=2  x=3
z=0    #    #    .    .
z=1    #    #    .    .
z=2    .    .    .    .
z=3    .    .    .    #
```

阻挡格 5 个：`(0,0)(1,0)(0,1)(1,1)` 组成的 2×2 方块，加右下角 `(3,3)`。

**① 取有向格边。** 2×2 方块四边都与可走区相邻 ⇒ 8 条；方块内部两格之间的竖边 / 横边属"阻挡—阻挡"，不产出。右下角 `(3,3)` 的上边和左边邻可走区 ⇒ 2 条；右边和下边紧挨网格外沿，按"网格外一律算非阻挡"的约定也算边界 ⇒ 2 条。合计 **12 条**。

**② 接环。** 方块沿边界走一圈：

```text
  (0,0) ─► (2,0)      沿上边（阻挡在左）
  (2,0) ─► (2,2)      沿右边
  (2,2) ─► (0,2)      沿下边
  (0,2) ─► (0,0)      沿左边，闭环 ⇒ 环 A = 4 个顶点（没有共线可合并）
```

右下角那格同理（外沿两条 + 贴着可走区两条）也是 4 顶点闭环 ⇒ 环 B = 4 个顶点。

**③ 面积校验**（对多边形逐边累加 `x_i·z_{i+1} − x_{i+1}·z_i`，再除 2）：

| 环 | 顶点数 | 有向面积 | 含义 |
| --- | --- | --- | --- |
| A（2×2 方块） | 4 | `+4` | 外边界，正 |
| B（右下角格） | 4 | `+1` | 外边界，正 |
| **合计** | **8** | **`+5`** | 正好等于阻挡格数 5 |

最后一行是很好的自检：**所有环的有向面积之和应等于阻挡格总数** —— 每个阻挡格恰好贡献 1 个单位面积，外环与洞环的正负号会自动抵消出净面积；对不上就说明接环或方向约定有 bug。

再看一个**带洞**的例子：

```text
      x=0  x=1  x=2  x=3  x=4
z=0    #    #    #    #    #
z=1    #    .    .    .    #
z=2    #    .    .    .    #
z=3    #    .    .    .    #
z=4    #    #    #    #    #
```

最外圈走一圈：5×5 的外边界有 `5+5+5+5 = 20` 个角点 ⇒ 外环 20 顶点、有向面积 `+25`（等于 5×5 的总格数）。中间可走区（3×3 = 9 格）的边界被"阻挡在左"的规则反着走一圈 ⇒ 内环 12 顶点、有向面积 `−9`。合计 `25 − 9 = 16`，正好等于图上 16 个阻挡格 ✓。

### 8.5 复杂度与上界

枚举有向格边 O(N)（每格看 4 个方向），接环与共线合并 O(E)（`E ≤ 4N`，每条边只被消费一次），输出顶点最坏 O(E) = O(N)。上界就是"所有阻挡格互不相邻"的退化情形：顶点最多 `4N`、多边形最多 `N`；实际地形通常成片相连，顶点数远小于上界。整个过程是**纯函数**：只读掩码、写进调用方给的数组、不分配托管内存，所以 job 里和编辑器工具里都能调。

> 顺带解释"为什么外框本身也是一个环"：我们约定**网格外一律算非阻挡**，于是可走区的外边界也构成闭环。它与洞环方向相反，正好在面积校验里互相抵消 —— 这个约定让"网格边缘"不需要任何特殊处理。

---

## 9. 从场景烘焙网格

手画掩码很累，常见做法是：在场景里摆好地面和墙，逐格往下打射线，打中什么就按什么算。

```csharp
// 逐格：从「格中心 + 起点高度」往正下方打一条射线
var origin = new Vector3(center.x, startHeight, center.z);
var rayLength = startHeight + maxDrop;

Physics.SyncTransforms();                    // 先把 Transform 变更同步进物理世界
if (Physics.Raycast(origin, Vector3.down, out var hit, rayLength,
                    layers.value, QueryTriggerInteraction.Ignore))
{
    var drop = startHeight - hit.point.y;    // 命中点比射线起点低多少
    mask[i] = (byte)(drop >= 0f && drop <= maxDrop && hitWalkable ? 1 : 0);
}
```

同一个"命中"在两类关卡里含义相反：想做**地板格**就打中地面算可走（`hitWalkable = true`），想做**障碍格**就打中墙算阻挡（`hitWalkable = false`）。三个通用注意点：

**① `Physics.SyncTransforms()`**：物理引擎不会在你每次改完 `Transform` 后立刻更新内部状态，它只在固定时机刷新。所以刚用脚本摆好的墙，对射线来说"还不存在"。批量打射线前调一次，把当前位置推给物理世界，射线才打得到。

**② `QueryTriggerInteraction.Ignore`**：`isTrigger` 的碰撞体是给触发逻辑用的（比如"进入区域"事件），不该被当成地面或墙；默认行为可能受项目设置影响，显式写 `Ignore` 最稳。

**③ 射线只能打已加载的物理世界**：烘焙的目标场景必须就是当前场景，射线不会去别的场景里找碰撞体。

编辑器工具还有几条经验：画笔操作包进 `Undo.RecordObject` 才能 Ctrl+Z；改完资产要标脏（`EditorUtility.SetDirty`）并刷新 `SceneView`；大网格要**分级绘制**（格线太多时只画外框、阻挡格太多时只画轮廓，并给"最多画多少个阻挡格"的硬上限），否则一开工具 `SceneView` 直接卡住。

资产参数一改，旧掩码的行列就对不上新网格了，通用的 `ResizeIfNeeded()` 做法是：格边长不变时按"格子对齐"把旧值搬进新数组对应行列；**新增格子默认取值要写死并注释**（全可走或全阻挡，二选一）；超出新范围的旧格丢弃。这类"参数变了但数据还有用"的场景，本质是**一次坐标重映射** —— 先把新旧坐标的换算公式写出来，比直接写双重循环再调试快得多。

---

## 10. 实现要点与几个通用坑

### 坑 1：枚举默认值会被误读成"成功"

若把状态枚举写成 `enum Status { Found = 0, NoGrid, StartInvalid, EndInvalid, NoPath, ExceededLimit }`，那么 `Found` 就是 0，而 C# struct 的默认值正是"所有字段为 0"。于是**一个从未被写入过的结果组件，读出来就是"找到了路径"**；再套一层"版本相等 ⇒ 已是最新"的判据，一个从没请求过的实体（请求版本与结果版本都是 0）就会被判为"已经解好"，永远停在这个"看起来成功"的默认值上。后果很隐蔽：统计成功解出路径的数量时会看到一大堆"成功"，但它们全是假的。两种修法任选其一，但一定要选一个：

```csharp
// 写法 A：让"未知"占住 0
public enum Status { Unknown = 0, Found, NoPath, ExceededLimit }

// 写法 B：用独立的"是否处理过"字段（版本号）判定有效性
if (status.SolvedVersion > 0 && status.Result == Status.Found && status.WaypointCount > 0)
```

写法 B 更通用，因为它把"有效性"与"业务状态"解耦：将来把 `Found` 挪到别的值，判据依然成立。反面也成立 —— 这个特性有时能白捡好处（初始化出来的实体天然不会被当成待解请求），但**依赖默认值省事**不可靠：枚举顺序一被调整，行为就悄悄变了。

> 通用教训：**任何时候把某个枚举成员定义为 0，都要问一句"默认值语义对不对"。**

另外两个相关的小陷阱：请求发出去了结果没回来，先分清是这帧**真的解过它但没成功**（业务结果），还是这帧**没轮到它**（被每帧预算排队）；网格被重建（格边长改了、掩码重画了）时旧路径的格坐标可能已对应到别的位置，所以要给网格加一个**构建版本号**，版本对不上就丢弃旧路径、重新请求。

### 坑 2：跟路径必须用单调游标

路径的第一个路点是**申请那一刻角色所在的位置**（通常就是格中心）。如果运动代码每帧都从头扫"离我最近的路点"，刚出发时最近的点永远是 `waypoints[0]` —— 角色先掉头回去找起点，走近了又发现 `waypoints[1]` 更近，再转回来奔目标。表现就是**原地来回摆**，转向角在正负之间反复横跳。正确做法是维护一个**只前进不后退**的游标：

```csharp
// 换到新路径时把游标重置到 1（跳过 waypoints[0] —— 那是申请时的位置）
if (motion.PathCursorVersion != status.SolvedVersion)
{
    motion.PathCursorVersion = status.SolvedVersion;
    motion.WaypointIndex = waypoints.Length > 1 ? 1 : 0;
}

// 到达当前路点附近就前进；只前进不后退
while (motion.WaypointIndex < waypoints.Length - 1 &&
       DistanceSqXZ(waypoints[motion.WaypointIndex].Position, position) <= arriveSq)
{
    motion.WaypointIndex++;
}

var target = waypoints[motion.WaypointIndex].Position;   // 本帧的转向目标
```

三个要点：**游标只在"新路径"到来时重置**（判据是结果版本号变了），不是每帧重置；**重置值跳过第 0 个路点**（那是身后，不是前方）；**用"距离小于阈值"推进**而不是"精确到达"，否则角色会在格中心附近反复微调，永远够不到那个点（阈值取略小于 1 格的平方距离即可）。摆动的根源是"目标点在角色两侧交替出现"，单调游标从结构上消灭了这个交替，比调转向速度参数靠谱得多。

### 坑 3：路径不穿墙 ≠ 积分不穿墙

我们辛苦保证寻路结果不穿墙，但角色最终位置是**积分**出来的（每帧 `pos += velocity * dt`），而积分步子和网格不是一回事：寻路保证的是**离散路径**（格子序列）合法，运动却是**连续**的，一帧位移可能跨过半格、甚至跨过一整格薄墙；拉直的直线段虽然不穿格，但角色被挤、被推、被别的力带走时可以直接陷进墙里。所以运动侧需要自己的兜底，最省事也最稳的是**分轴滑动**：把移动拆成"先走 x、再走 z"，每轴单独判断"走完这步会不会进阻挡格"，哪个轴被挡就取消哪个轴的位移。

```csharp
// 用同一份掩码做分轴滑动
var nextX = new float3(position.x + delta.x, position.y, position.z);
if (grid.IsWalkableWorld(nextX)) position = nextX;      // x 能走就吃下

var nextZ = new float3(position.x, position.y, position.z + delta.z);
if (grid.IsWalkableWorld(nextZ)) position = nextZ;      // z 单独判
```

```text
   墙                    分轴滑动
  ▓▓▓▓                  运动方向 ↘（斜向撞墙）
     ▲  角色想往右上走      → x 轴被挡，取消
     │                     → z 轴能走，吃下 ⇒ 沿墙下滑而不是卡住
   角色
```

效果是角色沿墙"滑"过去而不是卡死；两轴都被挡就都不动，至少不会陷进去。更严谨的做法（胶囊体投射 / 物理引擎的 `sweep`）能处理复杂形状，但"用同一份掩码做分轴滑动"是零成本、零依赖的第一步，值得先加上。

---

## 11. 小结与复杂度

### 11.1 全流程回顾

```text
① 建网格      参数 + 行主序掩码（可选：从场景打射线烘焙）
      │
② 求路径      A*（w=1）/ Dijkstra（w=0）共用一份内核：二叉堆 + 世代标记
      │            三种结果：Found / NoPath / ExceededLimit
③ 拉直        Bresenham 逐格确认 + 贪心跳最远点（判据必须与 8 邻贴角一致）
      │
④ 世界里      格坐标 → 格中心世界坐标 → 写进路点缓冲
      │
⑤ 运动        单调游标跟路点；分轴滑动兜底，保证积分也不穿墙
      │
⑥ 几何        掩码 → 有向格边 → 左转接环 → 共线合并 → 闭合多边形（洞自然反向）
```

### 11.2 复杂度

设网格 `N` 个格、有向格边 `E ≤ 4N`、原路径 `n` 个格：

| 环节 | 时间复杂度 | 空间 | 备注 |
| --- | --- | --- | --- |
| 世界↔格换算、越界与可走查询 | O(1) | O(N) 掩码 | 行主序 |
| A* / Dijkstra | 最坏 O(N log N) | O(N) 工作区 | 每次扩展 O(log N)，每格至多进堆常数次 |
| 视线拉直 | 最坏 O(n²) | O(n) | 可加"每次最多看 K 格"上限 |
| 多边形提取 | O(N) | O(E) | 每条边只消费一次 |
| 并行求解 | 单次查询同上 | 每线程一份工作区 | 吞吐 ≈ 线程数倍；工作区复用不重复分配 |

A* 的实际表现通常远好于最坏情况：可采纳的启发式会把它"拉"向终点，扩展格数往往只占总格数一小部分。Dijkstra（`w = 0`）没有这个拉力，以起点为圆心均匀铺开，扩展量接近"到终点距离内的所有格子"；好处是一次算完就得到到**所有**格子的最短距离场，多个终点共用很划算。

### 11.3 建议的实现顺序

每步都能单独验证，按这个顺序加功能：

1. **先只做 4 邻 A* + 曼哈顿**：能输出一条合法路径就赢了，别急着优化；
2. **换成 8 邻 + octile + 禁止贴角**：对比同一场景的输出，确认斜穿被挡住；
3. **加视线拉直**：看路点数量掉到原来的几分之一；
4. **把权重调成 0**：确认退化成 Dijkstra 的"均匀铺开"（更慢，但 4 邻下距离一样）；
5. **加世代标记和堆**：这时候才谈性能；
6. **搬进 DOTS**：先串行 `IJob`，确认结果与主线程版本逐点一致，再换 `IJobParallelFor` + 每线程工作区；
7. **最后接多边形提取和烘焙工具**：这两件事与求解内核解耦，可以独立开发和测试。

每一步都保留一个"能和上一步对比"的小用例（同一起点终点、同一张掩码，比较路径是否逐点一致），改起来才有底气。
