---
title: 'Unity DOTS —— 空间索引：四叉树与八叉树合成一棵 NativeSpatialTree'
description: '一份类型、一套节点布局、一批 job：NativeSpatialTree 如何用 Kind 把四叉树与八叉树做成两种模式，以及它的插入/分裂/查询与 ECS 集成'
pubDate: '2026-09-29'
category: '算法'
tags: ['Unity', 'DOTS', '空间索引', '四叉树', '八叉树']
---


## 速览
>- **四叉树与八叉树是同一个 `NativeSpatialTree` 的两种模式**（`Kind`）：节点布局、元素池、分裂/合并、bulk、查询、job、单例全都只有一份。
>- 差异只有**三处**（`MortonCode` / `IncrementIndex` / `GetChildBounds`），由 `ChildCount`（4/8）、`BitsPerLevel`（2/3）参数化。
>- 一个 World **同时只有一棵树**（`SpatialConfig.Index`，默认 `Quadtree`）；配置在装配时快照，改它要重建树，旧句柄全废。
>- 节点表**按最大深度满额预分配**（每节点 8 字节）、运行期永不增长，树里存**元素池的 slot 下标**而非指针 —— 分裂/合并只重挂链表，**元素一个都不搬**。
>- 八叉树 depth 6 的节点表就是 **2,396,745 个节点 = 18.29 MiB**，与元素数无关。
```
NativeSpatialTree（一份类型，Kind 选模式）
   ├─ Kind = Quadtree   ChildCount 4  BitsPerLevel 2  DepthSize = DepthSize4   只看 xz
   └─ Kind = Octree     ChildCount 8  BitsPerLevel 3  DepthSize = DepthSize8   完整 xyz
        ├─ MortonCode(pos)         ← 唯一的编码差异（4 叉：xz 两位交错 + 世界 z 翻转）
        ├─ IncrementIndex(d,m,i)   ← 唯一的寻址差异（每层 2 位 vs 3 位）
        ├─ GetChildBounds(box,k)   ← 唯一的几何差异（4 个子盒 vs 8 个子盒）
        └── 其余全部共用：节点表 / 元素池 / 分裂合并 / bulk 计数 / Collect* / 查询
```
| 你会碰到的东西 | 只有一个 |
| --- | --- |
| 手打的标记 | `SpatialIndexed`（空 `IComponentData`） |
| 系统挂的维护位 | `SpatialMember`（`Slot` + `Version` + `IndexedPos`）、清理位 `SpatialMemberDestroyed` |
| 内核 / 元素 | `NativeSpatialTree`；`SpatialElement`（24 字节）、`SpatialElementRef`（8 字节） |
| 查询入口 | `SpatialAccess.TryGetIndex` → `SpatialIndexReader`（只读视图） |
| job | `SpatialTreeRangeQueryJob` / `SpatialTreeApplyOpsJob` / `SpatialTreeBuildJob` |
| 运行态单例 | `SpatialSingleton { Tree, BuildVersion, LastAppliedOps }` |
---

## 1. 四叉树与八叉树怎么合成一棵树
分派点全在 `Utils/NativeSpatialTree.cs` 内部，不是策略类、也不是两批 job：

| 差异点 | 四叉树模式 | 八叉树模式 |
| --- | --- | --- |
| `MortonCode` | 查 `MortonLookup`，`(x, z)` 两位交错 | `ExpandBits8` 三位交错，完整 xyz |
| `IncrementIndex` | 每层 2 位（`& 0b11`） | 每层 3 位（`& 0b111`） |
| `GetChildBounds` | 子序号 0/1/2/3 = 世界空间左上/右上/左下/右下 | bit0=x、bit1=y、bit2=z，置位 = 该轴正方向 |

派生量只有三条：`ChildCount`（4/8）、`BitsPerLevel`（2/3）、`DepthSize(d)`（查 `DepthSize4` 还是 `DepthSize8`）。

**z 翻转**：`MortonCode` 里有一行 `local2.y = -local2.y` —— morton 低位的含义必须与 `GetChildBounds` 的子编号同义（bit1 = 1 表示"世界 z 更小的那一半"），不翻转就会把元素挂到错误的子盒里。

**两个步长表基准不同**（刻意，别"统一"）：`DepthSize4[d] = 1+4+…+4^(d-1)`（不含自身）、`DepthSize8[d] = 1+8+…+8^d`（含自身），而 `NodeCapacity = DepthSize(maxDepth + 1)`。于是四叉树 depth 6 = `DepthSize4[7]` **5,461**（正好铺满），八叉树 depth 6 = `DepthSize8[7]` **2,396,745** = `1 + 8 × 299,593`、**多铺一层**（深度 6 最多只用 299,593 个）：`depth = MaxDepth - 1` 的步长是 `DepthSize8[1] = 9`，最深一层兄弟之间空着 8 个槽。

**怎么选**：四叉树只索引 xz（`Contains` 忽略 y、球形查询把包围盒 y 扩成 `float.MaxValue`、距离只算 `(x,z)`）→ 平面玩法（RVO、地面单位）；真要垂直分层才用八叉树，代价是每层节点数 ×8。

---

## 2. 节点内存布局（核心）
### 隐式路径：不存子女指针
```csharp
internal struct SpatialNode        // 8 字节
{
    public int   Head;             // 链表头（池内 slot 下标），-1 = 空链
    public short Count;
    public short Flags;            // k_FlagLeaf = 1, k_FlagUsed = 2
}
// 第 depth 层、下标 atIndex 的节点的第 child 个子节点：
var atDepth = m_MaxDepth - depth;
var child   = (morton >> ((atDepth - 1) * BitsPerLevel)) & ChildMask;  // 0b11 或 0b111
var childIndex = atIndex + DepthSize(atDepth) * child + 1;
```
```
m_Nodes : UnsafeList<SpatialNode>  长度 = NodeCapacity，构造时一次性 Resize，之后永不增长
┌──────┬───────┬───────┬───────┬───────┬───────┬─────┬───────┐
│ [0]  │  [1]  │  [2]  │  [3]  │  [4]  │  [5]  │ ... │[N-1]  │
│ root │ 子0   │ 子1   │ 子2   │ 子3   │ 子0-0 │     │       │
└──────┴───────┴───────┴───────┴───────┴───────┴─────┴───────┘
  ↑ 每格：Head(4) + Count(2) + Flags(2)；下标 0 是根（根永远不当叶子）
    未使用节点 = SpatialNode.Empty（Head = -1，Flags = 0）

元素池（下标就是句柄的 Slot，三张表并排、同增同减）：
m_Elements : [ E0 ][ E1 ][ E2 ][ E3 ] ...   24 B/个：float3 Pos + Entity Entity + float distancesq
m_Next     : [ -1 ][  2 ][ -1 ][  0 ] ...    4 B/个：链表 next（-1 = 链尾）
m_Version  : [  1 ][  1 ][  2 ][  1 ] ...    4 B/个：槽位版本（识别陈旧句柄）

叶子怎么串起来（分裂/合并只改 Head 与 Next，payload 原地不动）：
m_Nodes[leaf].Head ──► slot 3 ──► slot 1 ──► -1
                         │           │
                         └──► m_Elements[3] = 该元素的 payload
```
节点存"指引"、池存 payload：`Head` 是链表头，`Count` 是该叶元素数，对外只给 `SpatialElementRef{ Slot, Version }`；`SplitLeaf` 只重挂链表，**槽位与句柄不变**，句柄只在元素被移除、槽位复用后失效（`AllocSlot` 里 `m_Version[slot]++`）。空链哨兵是 **-1**，复位一律用 `SpatialNode.Empty`（写 `default` 会把 0 号槽当成链表头）。

### 地址稳定性：为什么用 slot 下标而不是指针
`UnsafeList<T>` 是**值语义 struct**（指针 + 长度），**拷贝树 = 拷贝指针** —— 于是有下表这些"看着像优化、其实是陷阱"的点：

| 事实 | 后果 / 代码里的应对 |
| --- | --- |
| 池（`m_Elements` / `m_Next` / `m_Version`）按 2 倍增长（`GrowPool` / `ReserveElements`）；`Resize` 内部是"新块 → `MemCpy` 旧前缀 → `Free` 旧块" | 扩容后**旧拷贝的指针悬垂**：job 字段或 `GetSingleton` 的值拷贝仍指向已释放内存。规避只有一条 —— 不跨帧持有拷贝，结果经 `NativeReference<NativeSpatialTree> ResultTree` 从 job 带回再写回组件 |
| `Resize` 保留旧值、**不清新区间**（`ClearMemory` 也只清 `[oldLength, length)`） | `m_Next` 必须由 `InitNextRange(previousCapacity, capacity)` 显式补 -1（构造 / `ReserveElements` / `GrowPool` 三处都调）；`m_Version.Resize(capacity, ClearMemory)` 恰好语义对齐 |
| 节点表 `m_NodeCapacity` 构造时按 `maxDepth` 算死，分配后不动 | 节点表不受扩容影响 —— 这正是"满额预分配"换来的稳定性 |

### "稀疏"在哪里：没有分页
节点表就是满额连续数组，稀疏只体现在两处优化上：

| 优化 | 做法 |
| --- | --- |
| 稀疏复位 | `Clear()` 只遍历 `m_UsedNodes`、不遍历 `NodeCapacity`；节点"未使用 → 使用中"时 `MarkUsed(index)`，位图 `m_UsedBits`（每节点 1 bit）**幂等去重**，清空成本 ∝ 本周期用过的节点数 |
| 惰性 bulk 计数表 | `m_Counts` 构造时只建 0 容量空壳，首次 bulk 才由 `EnsureBulkCounts()` 建到 `NodeCapacity`；每轮只清"本轮动过的"（`m_TouchedCounts`，允许重复下标），不再整表 `MemClear`（八叉树 depth 6 是 9.14 MiB）。`Dispose` 里因此要判 `m_Counts.IsCreated` |

### 内存数字（`SpatialNode` 8 字节）
| maxDepth | 四叉树节点表 | 八叉树节点表 |
| --- | --- | --- |
| 5 | 1,365 / 10.7 KiB | 299,593 / 2.29 MiB |
| 6（默认） | 5,461 / 42.7 KiB | **2,396,745 / 18.29 MiB** |
| 7（上限） | 21,845 / 170.7 KiB | 19,173,961 / 146.3 MiB |

另有 `m_UsedBits` = `(NodeCapacity + 7) >> 3` 字节（八叉树 depth 6 是 299,594 B）；元素池每元素 32 字节（24+4+4），从 256 起按 2 倍长。**"范围要大"要收 `Bounds` 而不是加深度**：depth 6 下 `Extents = ±2000` 的格子边长 62.5，`±500` 只有 15.6。

---

## 3. 插入：bulk 与增量是两条路
### 增量：逐条 `Insert` + 逐级分裂
```csharp
var morton = MortonCode(element.Pos);
var leafIndex = FindLeafIndex(morton, out var depth);  // 下探；遇到未使用节点就地"当叶"
var slot = AllocSlot();
PushFront(leafIndex, slot, element);                   // 头插 + Count++ + 打 Used|Leaf
while (m_Nodes[leafIndex].Count > m_MaxLeafElements && depth < m_MaxDepth)
{
    SplitLeaf(leafIndex, depth);                       // 只重挂链表，元素不搬
    leafIndex = FindLeafIndex(morton, out depth);
}
```
- 阈值是**严格大于** `MaxLeafElements`（默认 16）：第 17 个才分裂；`SplitLeaf` 用 `MortonCode(m_Elements[slot].Pos)` **重算**每个元素该落哪个子盒。
- 深度到 `MaxDepth` 就**停**：同位置元素全堆在同一叶，`Count` 可远超阈值 —— 所以 `Unlink` / `SplitLeaf` / 查询的环守卫都按 `m_ElementCount + 1` 计数。删空一个叶会 `CollapseSubtree` 自底向上回收"子节点全未使用"的内部节点（根不回收）。
- `Remove` / `Update` 摘链失败就**放弃整次修改**（`Unlink` 返回 false = "位置 → 叶"这条不变式已破，此时什么都不能改）。

### bulk：两遍计数，一次成型
第 1 遍只数不建：逐元素下探，沿途每个节点 `m_Counts[atIndex]++`，只在"从 0 变非 0"时记进 `m_TouchedCounts`。然后 `PrepareLeavesFromCounts(0, 0)` 按 `count > MaxLeafElements && childDepth < MaxDepth` 递归定型骨架（满足 → 分裂节点 `Flags = Used`；否则 → 叶子 `Used | Leaf`）。第 2 遍沿已定型骨架 `FindLeafIndex(morton)` 下探到叶，再 `PushFront(leaf, AllocSlot(), element)`。

即 **bulk 不逐条触发分裂**，且元素槽位按输入顺序连续分配；越界/NaN 的元素在第一遍计入 `m_OutOfBoundsRejected`、第二遍跳过，返回值是**被接受**的元素数。

**退化输入**：不 clamp —— 位置非有限（NaN/Inf）或落在 `Bounds` 之外一律拒绝（`Insert` 返回 `SpatialElementRef.Invalid`）；`OutOfBoundsRejected` 累计、`Clear()` 不重置，`WarnOnOutOfBounds` 为真时首次 warning。全同点输入不会死循环，只是全堆在 maxDepth 的同一个叶里。

---

## 4. 查询：递归下探 + 盒含盒早停
三个入口：`RangeQuery(AABB, ref NativeList)`、`RangeQuery(center, radius, …)`（球形，可把距离平方回填进 `distancesq`）、`RangeQueryNearest(center, radius, NativeArray results)`（有界最近邻）。实现是**递归函数**（`QueryRecursive` / `QueryNearestRecursive`），不是显式栈或队列 —— 递归深度上界 `MaxDepth + 1 ≤ 8`，没有爆栈风险。

```
QueryRecursive(nodeBounds, contained, atIndex, depth, query, ref results, ...)
   ├─ depth > 0 且节点是叶 ──► 沿 Head → m_Next 遍历链表：
   │                            逐元素判 query.Contains / 距离 ≤ radius，命中就 results.Add
   │                            环守卫：遍历次数 > 活元素数 ⇒ 抛异常
   ├─ 未使用 或 depth == MaxDepth ──► 返回
   └─ 对 4/8 个子盒各判一次：
        ① ContainsBox(query, childBounds)  盒含盒 ⇒ childContained = true（后代整棵免检）
        ② query.Intersects(childBounds)    相交   ⇒ 继承 contained 继续下探
        ③ 都不满足                          ⇒ 整棵子树剪掉

查询盒 query 与 root 的四个子盒：
   ┌───────────────────────────────┐
   │ root                          │
   │   ┌───────────┬───────────┐   │   ① 该子树里的元素不再做
   │   │ ① 内含    │ ② 相交     │   │      query.Contains 测试
   │   │ 整盒收下  │ 继续下探    │   │   ③ 一次 Intersects 就省掉
   │   ├───────────┼───────────┤   │      整棵子树
   │   │ ③ 剪掉    │ ① 内含     │   │
   │   └───────────┴───────────┘   │
   └───────────────────────────────┘
```
`contained` **沿递归向下传递**：节点的盒一旦被查询盒完全包住，它下面所有元素都是命中，逐元素测试整段跳过 —— 主要剪枝，代价只是一次 `ContainsBox`。

**最近邻**复用同一骨架，结果写进**调用方给定长的 `NativeArray`**：`InsertNearest` 做插入排序（距离升序，同距离按 `Entity.Index` 打平局），比容量内最远那条还远就丢 —— 不分配缓冲、结果有界，可安全并行。

**job 里怎么用**：树是 unmanaged struct，按值拷进 job 字段即可 —— 值拷贝 + `UnsafeList` 共享内存，job 里看到的还是同一棵树：
```csharp
[BurstCompile]
public struct SpatialTreeRangeQueryJob : IJob
{
    public NativeSpatialTree Tree;              // UnsafeList 无 safety handle，不需要 [ReadOnly]
    public AABB Query;
    public NativeList<SpatialElement> Results;  // 调用方持有缓冲
    public void Execute() => Tree.RangeQuery(Query, ref Results);
}
```
读可多 job 并行（各自持结果缓冲），**写必须单线程** —— `Insert` / `Update` / `Remove` / `Clear` 不是并发安全结构。

---

## 5. 与 ECS 的集成
```
SpatialIndexed（手打 tag）+ LocalTransform ──► DotsSpatialModule（SortKey 200）→ SpatialGroup
        │      SpatialBuildSystem.OnUpdate（ISystem，[DisableAutoCreation]）
        │      ├─ Bulk        : CollectSpatialElementsJob → SpatialTreeBuildJob            （Burst）
        │      └─ Incremental : 新增/销毁 = 主线程 + EntityCommandBuffer
        │                       位置变化 = CollectSpatialMovesJob → SpatialTreeApplyOpsJob （Burst）
        ▼
SpatialSingleton { Tree, BuildVersion, LastAppliedOps }   ← 树住在这个单例组件里
        ├─ SpatialAccess.TryGetIndex(world / EntityManager, out SpatialIndexReader)  ← 只读视图
        └─ RvoCollectNeighborsJob（RvoGroup：[UpdateAfter(typeof(SpatialGroup))]）
```
| 环节 | 具体机制 |
| --- | --- |
| 谁进树 | `SpatialIndexed` 是唯一标记；两个 `Collect*Job` 都用 `[WithAll(typeof(SpatialIndexed))]` 限定范围，位置取 `LocalTransform.Position` |
| 生命周期 | 入树时 `AddMember` 一次挂 `SpatialMember`（句柄 + `IndexedPos`）**和** `SpatialMemberDestroyed`（句柄备份，`ICleanupComponentData`）；实体销毁后清理位仍在，`RemoveDestroyed` 靠 **`WithNone<SpatialIndexed>`** 区分"真死了"和"活实体的句柄备份" |
| 增量三阶段 | ① `WithNone<SpatialMember>` 的新实体在主线程 `tree.Insert` + ECB 落地（结构性变更不能在 `SystemAPI.Query` 迭代里做）；② `CollectSpatialMovesJob` 只比 `transform.Position` 与 `member.IndexedPos`，变了才产出 `SpatialOp.Update` 并**回写 `IndexedPos`**（Update 因越界失败也算"已同步"）；③ 销毁走清理位 |
| 配置 | `SpatialSettings.Configure(kind, tree)` 写静态 `Pending`，`OnCreate` 用 struct 赋值**快照**成 `m_Config`（`Mode` 选 `Bulk` / `Incremental`）—— 所以**运行期再改 `Pending` 不生效**，要换配置就得重建 World / 重装模块。`Matches()` 发现“树没建”或“树的 `Kind` / `Bounds` / `MaxDepth` / `MaxLeafElements` 与 `m_Config` 不一致”时才 `Dispose` 旧树 + 新建 + `ClearAllMembers()`（旧句柄全废、下一帧重插） |
| 只读视图 | `SpatialIndexReader` 只把树与 `ElementCount` / `NodeCount` / `LeafCount` / `MaxDepth` / `OutOfBoundsRejected` / `Bounds` 等**标量**快照一份，**能查不能写** |
| Rvo 怎么消费 | `RvoSolveSystem.ResolveIndex` 用 `EntityManager.GetComponentData<SpatialSingleton>`（主线程读 ⇒ 触发 job 同步点）拿 `data.Tree` → `SpatialIndexReader` → `RvoCollectNeighborsJob.Index.RangeQueryNearest(pos, NeighborDist, hits.AsNativeArray())`（`hits` 是 `DynamicBuffer<SpatialElement>`，按 `MaxNeighbors + 1` 开）；时序靠 `RvoGroup` 的 `[UpdateAfter(typeof(SpatialGroup))]`。**Visibility 不消费空间索引** —— 它只是 Rvo 的上游，Rvo 拿到邻居后再用 `VisibilityAccess.IsCulled` 剔掉不可见的 |

---

## 6. 实现要点与坑
| 坑 | 具体表现 |
| --- | --- |
| 单例里的树不能就地改 | `GetSingleton<T>()` / `GetComponentData<T>()` 给的是值拷贝，写只落在拷贝上 —— 写路径必须自己持有 `ref NativeSpatialTree` 并写回组件 |
| job 的写结果读不到 | `Schedule()` / `Run()` 都按值拷走 job 实例，**执行完读 `job.Tree` 字段什么也不会变**；结果必须走 `NativeReference`（`ResultTree` / `Accepted` / `Results`），`ApplyOps` 还要检查 `Results.Length >= Ops.Length` |
| `[ReadOnly]` 的边界 | 只有 `ApplyOpsJob.Ops` / `BuildJob.Elements`（`[ReadOnly] NativeArray<T>`）标了；树字段没标 —— `UnsafeList` 没有 safety handle，**保护只来自"读可并行、写单线程"这个约定** |
| 动态 buffer 不能当 job 字段 | RVO 的命中缓冲是 `Execute(…, DynamicBuffer<SpatialElement> hits, …)` 的**参数**（`IJobEntity` 注入）；`CollectSpatialElementsJob` 要"收集后再读"，所以用 `Allocator.TempJob` 的 `NativeList` + `AsDeferredJobArray()` 喂下游、调用方 Dispose |
| 结构性变更与 job 的同步 | 新增/销毁走 `EntityCommandBuffer(Allocator.Temp)` + **立刻 Playback**；位置变化是 `Schedule` → **立刻 `Complete()`** → 再 `ApplyOps`。增量路径每帧至少一次 job join，换来热点逻辑在 worker 线程上 Burst 执行 |
| 扩容 = 旧拷贝悬垂 | 池 2 倍增长会让此前取出的树拷贝指向已释放内存；节点表不增长，所以只有池会踩这个坑 |
| `MaxLeafElements` 不是硬上界 | 到 `MaxDepth` 后不再分裂，同位置元素一直堆在同一叶；`SpatialNode.Count` 是 **`short`**、`PushFrontInternal` 里直接 `Count++` 没有夹取，单叶元素数逼近 32767 要留意溢出 |
| 深度比元素数更贵 | `NodeCapacity` 只看 `maxDepth`（+1 层 = ×8），与元素数、`Bounds` 都无关；`MaxSupportedDepth = 7`（八叉树每轴 8 位 morton = 24 位），超了构造函数直接抛 `ArgumentOutOfRangeException` |
| `BuildVersion` 是帧序号 | `OnUpdate` 每帧结尾**无条件 ++**（重建那帧 +2），它只回答"这一帧树更新过没有"；真正的变更信号是 `SpatialMember`（新入树）、`LastAppliedOps`、`OutOfBoundsRejected` |
