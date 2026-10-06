---
title: 'Unity DOTS —— 空间索引：四叉树与八叉树共用一套内核'
description: '从零推导 Morton 编码与隐式节点下标，一步步写出可用于 DOTS 的四叉树 / 八叉树：节点数组、元素池链表、插入与分裂、两遍 bulk 建树、范围与最近邻查询'
pubDate: '2026-09-29'
category: '算法'
tags: ['Unity', 'DOTS', '空间索引', '四叉树', '八叉树', 'Morton']
---

## 速览
- **空间索引解决的问题**：别让每个单位都和其他所有单位比一遍。暴力两两比较是 O(n²)，n = 10000 时约 5000 万次距离判断，一帧预算（16.7 ms）根本装不下。
- **四叉树和八叉树是同一套代码的两种参数**：子节点数 4 或 8、每层编码位数 2 或 3，其余（节点数组、元素池、分裂、查询）完全共用。
- **不存子女指针**：节点挤在一个满额预分配的数组里，子节点下标由 `父下标 + 1 + 子序号 × 该层子树大小` 直接算出，每节点只要 8 字节。
- **元素不搬家**：节点只存链表头，元素本体留在池里；分裂 / 合并只改链表指针，只要元素没被删，它的句柄就一直有效。
- **代价与元素数无关，只与最大深度有关**：八叉树每加一层节点数 ×8。想要格子更细，先想想是不是"世界范围开太大"。

## 1. 先算一笔账：为什么需要空间索引
场上有 n 个单位，每帧要找出每个单位半径 5 内的邻居。最容易写的做法是双重循环，比较次数是 `n(n-1)/2`：n = 1,000 时约 50 万次（Burst 里约 1 ms）；n = 10,000 时约 5,000 万次（约 0.1 s，单帧预算的 6 倍）；n = 100,000 时约 50 亿次，直接放弃。空间索引存在的唯一理由就是：**用一点预处理，把"和所有人比"换成"和附近的人比"。**

中间方案是**均匀网格**：世界切成固定大小的格子，查询时只看目标格和周围 8 格。它实现最简单，单位分布均匀时几乎是最优解，但密度不均就退化（所有单位挤在一格，回到 O(n²)），而且移动要重新分桶。**树**（四叉树 / 八叉树）换了个思路：切分自适应，哪个区域元素多就在那里切得更细；代价是定位从 O(1) 变成 O(D)，内存和最大深度绑定。分布均匀、世界不大 → 网格；分布不均、要范围与最近邻、还想塞进 job → 树。下面全部讲树。

## 2. 递归划分：4 个子盒 / 8 个子盒与编号约定
根节点持有一个轴对齐包围盒（**AABB**，axis-aligned bounding box，就是"中心 + 各轴半长"）。四叉树每次在 x、z 两个轴上各切一半，得到 2×2 = 4 个子盒；八叉树把 y 也切一半，得到 2×2×2 = 8 个子盒。子盒边长永远是父盒的一半。

**编号约定（先定死）**：子序号的第 k 个二进制位表示"是否落在第 k 个轴的较大一半"。四叉树 `bit0 = x`、`bit1 = z`，即 `子序号 = x_bit + 2 × z_bit`；八叉树再加 `bit1 = y`、`bit2 = z`，即 `子序号 = x_bit + 2 × y_bit + 4 × z_bit`。取根盒 `x, z ∈ [-8, 8)`（半开区间，边界点归"大"的一半）：

| 子序号 | x_bit | z_bit | 子盒（x × z） |
| --- | --- | --- | --- |
| 0 | 0 | 0 | `[-8, 0) × [-8, 0)` |
| 1 | 1 | 0 | `[0, 8) × [-8, 0)` |
| 2 | 0 | 1 | `[-8, 0) × [0, 8)` |
| 3 | 1 | 1 | `[0, 8) × [0, 8)` |

八叉树同理，只是多一个轴：`0` = 最小角，`1` = +x，`2` = +y，`3` = +x+y，`4` = +z，`5` = +x+z，`6` = +y+z，`7` = 最大角——正好是按 x→bit0、y→bit1、z→bit2 数出来的二进制序号。

### 为什么"编号"必须和"编码"同义
Morton 编码会把坐标压成一个整数，其中**低位段**就是"这一层的子序号"。两套规则必须完全一致，否则会出现"元素被挂进根本不含它的子盒"这种隐性错误：插入走编码、查询走几何，两边对不上，元素就永远查不到。具体反例：假设编码里 `z_bit = 1` 表示"z 更小的一半"，而几何编号里 `bit1 = 1` 表示"z 更大的一半"。点 `(x = -5, z = 5)`（根盒 `[-8,8)²`）在编码下是 `x_bit=0, z_bit=0` → 子 0，但几何上的子 0 是"x、z 都小"的盒子，**不含这个点**。后续按几何下探的查询永远不会访问子 0 的兄弟，于是这个元素"插进去了却查不到"。

> 最省事的保险：写两个小函数——"给坐标按几何算子序号"和"给坐标从编码里取子序号"——跑一批随机点断言两者相等。五分钟的测试，省一下午的 debug。

## 3. Morton 编码：把坐标压成一个整数
我们需要一个整数，满足两点：从高位往低位读，每 2 位（四叉树）或 3 位（八叉树）恰好是"某层选了第几个子盒"；高位对应浅层。做法是**位交错**：把 x 的第 i 位塞进 `2i` 位、z 的第 i 位塞进 `2i+1` 位（八叉树是 x→`3i`、y→`3i+1`、z→`3i+2`）。移位方向和上一节的编号规则是同一件事：**第 k 个轴占子序号第 k 位，就占每个位段的第 k 位。**

### 手算一个四叉树编码
取 `x = 5 = 0b101`、`z = 3 = 0b011`，各 3 位（即最大深度 3）：
```text
轴上第 i 位   x: x2=1  x1=0  x0=1        z: z2=0  z1=1  z0=1
放进 morton   x2→bit4  x1→bit2  x0→bit0   z2→bit5  z1→bit3  z0→bit1
从高位往低位： 0   1   1   0   1   1
              bit5 bit4 bit3 bit2 bit1 bit0
morton = 0b011011 = 32+16+8+2+1 = 27
```
把 27 每 2 位切开读回来，就是下探路径：`level 0 = bits[5:4] = 01b = 1`，`level 1 = bits[3:2] = 10b = 2`，`level 2 = bits[1:0] = 11b = 3`。用几何验证：坐标落在 `[0,8)`，切分中心依次是 4、2/6、1/3/5/7。第 0 层"x 大 z 小"→ `x=5 ≥ 4`、`z=3 < 4` ✓，盒 `[4,8)×[0,4)`；第 1 层"x 小 z 大"→ `x=5 < 6`、`z=3 ≥ 2` ✓，盒 `[4,6)×[2,4)`；第 2 层"x 大 z 大"→ `x=5 ≥ 4.5`、`z=3 ≥ 2.5` ✓，盒 `[4.5,5)×[2.5,3)`。最后一个盒子确实包含 `(5, 3)`，**编码路径和几何路径完全一致**。

### 手算一个八叉树编码
`(x, y, z) = (3, 5, 6)`，每轴 3 位、深度 3。每层一个 3 位段：`seg = x_i + 2·y_i + 4·z_i`。
```text
i=0: (x0,y0,z0) = (1,1,0) → 0b011 = 3 → bits[2:0]
i=1: (x1,y1,z1) = (1,0,1) → 0b101 = 5 → bits[5:3]
i=2: (x2,y2,z2) = (0,1,1) → 0b110 = 6 → bits[8:6]
morton = 3 | (5 << 3) | (6 << 6) = 3 + 40 + 384 = 427 = 0b110101011
路径：level 0 = 6，level 1 = 5，level 2 = 3
```
几何验证（`[0,8)³`，首层中心 4）：`x=3<4` 取小、`y=5≥4` 取大、`z=6≥4` 取大 → `0b110 = 6` ✓；第二层 `x=3≥2`、`y=5<6`、`z=6≥6` → `0b101 = 5` ✓；第三层 `x=3≥3`（边界点归大的一半）、`y=5≥5`、`z=6<7` → `0b011 = 3` ✓。

### 用查表算位交错
逐位循环太慢，标准做法是按字节查表：位 i 落到 `2i` 的表 `k_Spread2[256]`（8 位 → 16 位），和位 i 落到 `3i` 的表 `k_Spread3[256]`（8 位 → 24 位），再拼起来。
```csharp
static uint Morton2D(uint ix, uint iz) =>                 // 四叉树：2 位/层
    k_Spread2[ix & 0xFF] | (k_Spread2[iz & 0xFF] << 1);
static uint Morton3D(uint ix, uint iy, uint iz) =>        // 八叉树：3 位/层
    k_Spread3[ix & 0xFF] | (k_Spread3[iy & 0xFF] << 1) | (k_Spread3[iz & 0xFF] << 2);
```
三个容易忽略的点：**量化位数 = 最大深度**（世界坐标先夹取再线性映射成 D 位无符号整数，越界一定要夹，否则位段会串味）；**位预算**是四叉树每层 2 位（32 位整数最多 16 层）、八叉树每层 3 位（最多 10 层），实际先撑不住的是内存；**一帧算一次就够**——把编码存进元素（多 4 字节）比每次分裂、查询重算便宜得多，位置变了顺手更新即可。

## 4. 隐式节点数组：不存子女指针
朴素写法是每个节点存 4 或 8 个指针 / 下标。有了 Morton 编码就能完全省掉，因为子节点下标可以算出来。

### 先推步长表
定义 `Span(h)` = "根下面还有 h 层的完整子树"的节点数：
```text
Span(0) = 1                              // 只有自己，是叶子
Span(h) = 1 + C × Span(h-1)              // 自己 + C 棵 h-1 层的子树
        = 1 + C + C² + … + C^h           // 每层节点数 1, C, C², …
        = (C^(h+1) - 1) / (C - 1)        // 等比数列求和，C = 子节点数
```
手算 `C = 4`：`Span(1) = 1+4 = 5`，`Span(2) = 1+4×5 = 21`，`Span(3) = 1+4×21 = 85`；公式验证 `(4³-1)/3 = 21` ✓、`(4⁴-1)/3 = 85` ✓。整棵树的节点数就是 `Span(D)`（D = 最大深度，根算第 0 层）——所以**数组长度在构造时就能算出来，一次分配，运行期永不增长**：

| h | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Span(h)`，C=4 | 1 | 5 | 21 | 85 | 341 | 1,365 | 5,461 |
| `Span(h)`，C=8 | 1 | 9 | 73 | 585 | 4,681 | 37,449 | 299,593 |

### 子节点下标公式
深度为 t 的父节点（下标 `atIndex`），它的第 `child` 个子节点在：
```text
childIndex = atIndex + 1 + child × Span(D - t - 1)
  +1          ：子节点紧跟在父节点后面（父节点自己占一格）
  Span(D-t-1) ：每个兄弟子树等大，跨过一个兄弟就跳过这么多格
  D - t - 1   ：父节点下面还剩几层
```
手算验证 `C = 4, D = 2`（数组总长 `Span(2) = 21`，下标 0..20）：
```text
根 t=0 → 子节点 0 + 1 + child × Span(1)=5        → 1, 6, 11, 16
t=1 的节点 1 → 1 + 1 + child × Span(0)=1         → 2, 3, 4, 5
节点 6 → 7..10    节点 11 → 12..15    节点 16 → 17..20
下标 0..20 正好铺满 21 格 ✓
```
```text
_nodes : TreeNode[Span(D)]，构造时一次分配，之后永不 Resize
下标  0        1                                6
      ┌────────┬────────────────────────────────┬───────────
内容  │ root   │ 子 0 的整棵子树（Span(D-1) 格）  │ 子 1 的子树 …
      └────────┴────────────────────────────────┴───────────
        ↑ 每格 8 字节；根永远不是叶子；未使用节点 = Empty（Head = -1，Flags = 0）
```
```csharp
public const ushort FlagLeaf = 1;   // 是叶子：元素挂在这一层的链上
public const ushort FlagUsed = 2;   // 这一轮用过（复位时只处理它）
public struct TreeNode              // 8 字节
{
    public int    Head;             // 链表第一个元素的 slot，-1 = 空链
    public short  Count;            // 本节点元素数
    public ushort Flags;
    public static TreeNode Empty => new TreeNode { Head = -1 };
}
```
> **复位一定要用 `Empty`，不要写 `default`**：`default(TreeNode).Head` 是 0，会被当成"链表头是 slot 0"，于是空节点莫名指向了一个真实元素。哨兵值必须显式定义成 -1。

**稀疏体现在哪**：数组满额分配，但每帧真正碰过的节点远少于 `Span(D)`。所以维护一个"本轮碰过的下标"列表（允许重复，写前不用查重），复位时只遍历它，成本 ∝ 实际使用量；另一个选择是每节点 1 bit 的位图（`Span(D)/8` 字节，八叉树 D=6 约 37 KB），重复标记幂等，但要多一块内存。满额预分配换来 O(1) 寻址、无指针跳转、可放进 job；代价是内存与深度绑定，稀疏场景会浪费。

## 5. 元素池与链表：元素不搬家
节点只存"指引"，元素本体放在池里，三张表并排、同增同减：
```text
_elements : [ E0 ][ E1 ][ E2 ][ E3 ] ...   24 B/个：float3 Pos + Entity + float DistSq
_next     : [ -1 ][  2 ][ -1 ][  0 ] ...    4 B/个：同一叶链表的下一个 slot，-1 = 链尾
_version  : [  1 ][  1 ][  2 ][  1 ] ...    4 B/个：槽位版本号
_freeHead : 空闲槽链的链头（-1 = 没有空洞）
某个叶子把元素串起来（_next 只描述"下一个是谁"）：
_nodes[leaf].Head ──► slot 3 ──► slot 1 ──► -1
                        │           │
                        └─► _elements[3] = 该元素的 payload
```
每个活元素 32 字节（24+4+4）。对外只发句柄 `Handle { int Slot; int Version; }`，有效性判据是"`Slot` 在范围内，且 `Version` 与池里 `_version[Slot]` 相等"。

**为什么必须带版本号**：元素被移除后槽位会被复用，只存 slot 的话，一个陈旧句柄会"指到另一个实体"——看起来像逻辑 bug，实际是内存复用；`Version` 让陈旧句柄直接失效。分裂 / 合并**只重挂链表**：元素留在原 slot，`_elements` 一个字节都不动，句柄继续有效。

**移除是最别扭的一步**：单链表摘中间节点要找前驱，也就是扫描该叶整条链；链长通常不超过叶容量阈值，但深度到顶时可能很长。三条路：**接受扫描**（最简单，链短时够用）；**双向链表**（`_prev` 再占 4 字节，O(1) 摘除）；**惰性删除**（先标 `Dead`、查询时跳过，攒够一批统一压缩重建，批量场景最划算）。

**移动元素有个便宜优化**：位置变了先重算 Morton，如果它到当前叶深度为止的前缀没变（`code >> shift` 相等），说明还在同一个叶盒里，那就**只改坐标，一个指针都不用动**；只有跨叶盒才需要摘链重插。

## 6. 插入与分裂
```csharp
public Handle Insert(in Element e)
{
    if (!math.all(math.isfinite(e.Pos)) || !_bounds.Contains(e.Pos))
    { _rejected++; return default; }              // NaN / Inf / 越界一律拒绝，不要 clamp
    uint code = Morton2D(Quantize(e.Pos));
    int node = FindLeaf(code, out int depth);     // 从根下探，碰到空节点就当叶子用
    int slot = AllocSlot();
    _elements[slot] = e;
    PushFront(node, slot);                        // 头插：Count++，打上 Used|Leaf
    while (_nodes[node].Count > _maxLeafElements && depth < _maxDepth)
    { Split(node, depth); node = FindLeaf(code, out depth); }
    return new Handle { Slot = slot, Version = _version[slot] };
}
```
阈值判定是**严格大于**：`_maxLeafElements = 16` 时，一个叶子装到 16 个不动，第 17 个进来才分裂。这样叶的平均负载接近阈值而不是阈值的一半，树更浅、分裂次数更少。分裂时元素本体不动，只按各自编码重新归位：
```csharp
void Split(int node, int depth)
{
    int head = _nodes[node].Head;
    _nodes[node].Head = -1; _nodes[node].Count = 0;
    _nodes[node].Flags = FlagUsed;                // 不再是叶子
    for (int c = 0; c < ChildCount; c++) InitNode(ChildIndex(node, depth, c));
    int s = head;
    while (s != -1)                               // 逐个元素重新归位（元素本身不搬）
    {
        int next = _next[s];
        uint code = Morton2D(Quantize(_elements[s].Pos));
        int c = (int)((code >> ((_maxDepth - depth - 1) * BitsPerLevel)) & ChildMask);
        PushFront(ChildIndex(node, depth, c), s);
        s = next;
    }
}
```
```text
分裂前：leaf(node=6, Count=17) ──► [a] ──► [b] ──► … ──► [q]
分裂后：node=6 变成内部节点（FlagUsed，Head=-1，Count=0）
        ├─ 子 0  Head ──► 落在这块的 a, c, k …
        └─ 子 1  Head ──► 落在那块的 b, f …
        元素槽位与句柄完全不变，只是换了条链挂着
```
**同位置元素会连锁分裂**：17 个坐标完全相同的元素全落在同一个子盒里，那个子盒 `Count` 还是 17，于是循环再分裂一次……一次 `Insert` 最多触发 D 次分裂，这是最坏情况，不是死循环。**深度到顶就停**：`depth == _maxDepth` 时不再分裂，同位置元素全堆在一个叶里，`Count` 可以远超阈值。所以叶容量阈值是**软上界**；`Count` 用 `short` 时单叶超过 32,767 个元素会溢出（几十个单位叠在一个点的场景要留意），要么用 `int`，要么写入时夹取。所有"沿链走"的循环都要带**守卫计数**（超过当前活元素数就抛异常），否则链表一旦写坏就是死循环，Burst 里连日志都难打。

**删除一个叶会把子树收窄**：叶子空了、兄弟也全空，就把父节点标记回未使用，逐级向上收（根不回收）。不做也能跑，代价是查询白白穿过一堆空节点。

## 7. bulk 建树：两遍计数，一次成型
增量插入每次从根走一遍、还要逐次分裂，几万个元素一次性入树太慢。批量建树用"两遍计数"：
```text
第 1 遍（只数不建）：每个元素算 morton 后从根下沉，路径上每个节点 _counts[i]++
                    只在"从 0 变非 0"时把下标记进本轮脏表（复位用）
定型骨架（递归）Build(node, depth):
    若 _counts[node] > _maxLeafElements 且 depth < _maxDepth
        → 标成内部节点（FlagUsed），对 C 个子节点递归
    否则 → 标成叶子（FlagUsed | FlagLeaf），停止
第 2 遍（一次填满）：沿定型的骨架下沉到叶，PushFront(leaf, AllocSlot())
```
三个好处：**分裂只判断一次**，不是每插一个元素判断一轮；**元素槽位按输入顺序连续分配**，池里没有空洞；**第一遍天然可并行**——计数各走各的路径，只需对 `_counts` 做原子加，或每个线程各持一份再合并。想全并行还有一步：第一遍结束后对 `_counts` 做**前缀和**，得到每个叶在池里的"预定区间"，第二遍每个元素就知道自己该写哪，多线程互不冲突；前缀和还顺手给出一个**按 Morton 排序的元素池**——第 8 节会用到这个附加收益。越界 / NaN 元素在第 1 遍统计、第 2 遍跳过，返回值给"实际接受"的数量，不要静默丢弃。

## 8. 范围查询与最近邻
### 递归下探 + 三类剪枝
```csharp
public void QueryRange(in AABB q, ref NativeList<Element> hits) => Query(0, 0, q, false, ref hits);
void Query(int atIndex, int depth, in AABB q, bool contained, ref NativeList<Element> hits)
{
    ref var node = ref _nodes.ElementAt(atIndex);
    if (node.Flags == 0) return;                     // 空子树
    if ((node.Flags & FlagLeaf) != 0)                // 叶子：顺着链逐个判定
    {
        int slot = node.Head, guard = 0;
        while (slot != -1)
        {
            if (++guard > _elementCount + 1) throw new InvalidOperationException("链表成环");
            if (contained || q.Contains(_elements[slot].Pos)) hits.Add(_elements[slot]);
            slot = _next[slot];
        }
        return;
    }
    for (int c = 0; c < ChildCount; c++)
    {
        int  ci = ChildIndex(atIndex, depth, c);
        AABB cb = ChildBounds(atIndex, depth, c);    // 由几何算出的子盒
        if (q.Contains(cb))        Query(ci, depth + 1, q, true, ref hits);
        else if (q.Intersects(cb)) Query(ci, depth + 1, q, contained, ref hits);
        // 不相交：整棵子树剪掉，连一次 AABB 测试都不用再花
    }
}
```
```text
查询盒 q 与某个内部节点的子盒：
  ┌───────────────────────────────┐
  │ 父节点盒                       │   ① 子盒 ⊂ q：整棵子树全命中
  │   ┌───────────┬───────────┐   │      → contained = true，免掉对每个元素
  │   │ ① 全含    │ ② 相交     │   │        再做一次"在不在查询盒里"
  │   │ 收下      │ 继续下探    │   │   ② 相交：继承 contained 继续下探
  │   ├───────────┼───────────┤   │   ③ 不相交：一次 AABB 测试省掉整棵子树
  │   │ ③ 剪掉    │ ① 全含     │   │
  │   └───────────┴───────────┘   │
  └───────────────────────────────┘
```
`contained` **沿递归向下传递**：一个节点的盒子被查询盒完全包住时，它下面所有元素必然命中，逐个元素的 `Contains` 测试整段跳过。这是主要剪枝，代价只是每层一次 `ContainsBox`。

### 剪枝到底省了多少：一个具体例子
世界取 `[-512, 512)²`（半边长 E = 512），16,384 个大致均匀的元素，最大深度 D = 6，叶容量阈值 16：叶格数 `4^6 = 4096`，叶边长 `2E / 2^D = 1024/64 = 16`，平均每叶 `16384/4096 = 4` 个元素 ✓。查询盒取边长 64、中心在原点的方块（跨 4×4 = 16 个叶格）：

| 做法 | 逐元素测试次数 | 节点访问次数 |
| --- | --- | --- |
| 暴力 | 16,384 | 0 |
| 树 | 约 `16 格 × 4 元素 = 64` | 几十个（只走与 q 相交的分支） |

逐元素的工作量降了两个数量级，代价是几十次 AABB 相交判断——每次只有几次比较。还能再加两个优化：**盒对齐时 `contained` 直接吃下整棵子树**（查询盒正好和某个深 k 的节点盒重合，一次 `ContainsBox` 全部命中）；**元素池按 Morton 排序后**，完全被包含的子树里元素在池中是**连续区间**，可以整段拷贝，连链都不用走。

### 最近邻
骨架和范围查询一样，只是判定换成距离，结果写进**调用方给定长度的 `NativeArray`**：
```csharp
// 结果按距离升序维护；满了以后只和最远那条比，比它远就扔掉
void AddSorted(NativeArray<Element> results, ref int count, in Element e, float d2)
{
    int cap = results.Length;
    if (count == cap && d2 >= results[cap - 1].DistSq) return;
    int i = (count < cap) ? count : cap - 1;          // 满时从最后一格往前挤
    while (i > 0 && (results[i-1].DistSq > d2 ||
           (results[i-1].DistSq == d2 && results[i-1].Entity.Index > e.Entity.Index)))
    { results[i] = results[i-1]; i--; }
    results[i] = e; results[i].DistSq = d2;
    if (count < cap) count++;
}
```
要点：**不分配缓冲**（容量由调用方给，结果天然有界，可直接在 job 里用）；**距离比较用平方**（省开方，排序结果一样）；**同距离按 `Entity.Index` 打平局**（并行查询的结果才确定，否则同样输入可能出不同邻居）；**半径随结果收缩**（填满后把下探半径收到当前最远距离，进一步剪枝）。

## 9. 放进 DOTS：并行边界与内存正确性
树本身是纯 unmanaged 结构（几个 `UnsafeList` + 几个标量），可以直接按值拷进 job 字段：
```csharp
[BurstCompile]
public struct RangeQueryJob : IJob
{
    public Tree Tree;                      // UnsafeList 没有 safety handle，不需要 [ReadOnly]
    public AABB Query;
    public NativeList<Element> Hits;       // 结果缓冲由调用方持有
    public void Execute() => Tree.QueryRange(Query, ref Hits);
}
```
**读可以并行**：多个 job 同时查询同一棵树没问题，只要各自持有自己的结果缓冲。**写必须单线程**：插入 / 更新 / 删除 / 清空会改链表和池，没有任何锁，绝不能并发。**`UnsafeList` 不受安全系统保护**：`[ReadOnly]` 只对带 safety handle 的容器（`NativeArray` / `NativeList`）生效，这里的安全性完全来自"读可并行、写单线程"这条约定，所以要把它写进注释里。

### 四个一定会踩的坑
**① 值类型容器按值拷贝 + 扩容 = 悬垂指针。** `UnsafeList<T>` 是 struct，里面是"指针 + 长度 + 容量"，拷贝一棵树拷的是**指针**，两边指向同一块内存（这通常是你想要的）。但扩容的内部动作是"申请新块 → `MemCpy` 旧前缀 → 释放旧块"，于是**扩容前拿到的所有拷贝都指向已释放内存**，继续用就是崩溃或读到垃圾。规避只有一条：**不要跨帧持有树的拷贝**，写路径自己持有 `ref`，job 要带回结果就整体走 `NativeReference<Tree>`：
```csharp
[BurstCompile]
public struct BuildJob : IJob
{
    [ReadOnly] public NativeArray<Element> Input;
    public NativeReference<Tree> Result;        // 树本身带回主线程再写回组件
    public void Execute()
    { var t = new Tree(_settings); t.BulkBuild(Input); Result.Value = t; }  // 指针+长度整体赋值
}
```
更省心的办法：**让池在开局前就长够**（按最大可能元素数预分配），运行期只增不扩，扩容坑自然消失。

**② 扩容后的新区间是脏内存。** `Resize` 保留旧数据但**不清新分配的区间**；`_next` 的初值是 -1，新槽位里却是随机数，那条链就会指到不知道哪里去。每次扩容后必须显式初始化新区间：
```csharp
void EnsurePoolCapacity(int newCapacity)
{
    int old = _elements.Length;
    _elements.Resize(newCapacity); _next.Resize(newCapacity); _version.Resize(newCapacity);
    for (int i = old; i < newCapacity; i++) { _next[i] = -1; _version[i] = 1; }
}
```
**③ job 执行完，读不到 job 字段里的写入结果。** `Schedule()` 和 `Run()` 都是**按值把 job 实例拷走**的，`Execute()` 里对 `this.Tree` 或任何值类型字段的修改改的是那份拷贝；`Complete()` 之后回读 `job.Tree` 什么也没变。所有输出都必须走有引用的容器：`NativeReference<T>`、`NativeArray<T>`、`NativeList<T>`。job 产出不定数量结果时，记得在 `Complete()` 之后检查长度，而不是假设写满了。

**④ 单例组件不能就地改。** `SystemAPI.GetSingleton<T>()` 返回的是值拷贝，`holder.Tree.Insert(e)` 只写到拷贝上，组件里什么也没变；要 `ref var h = ref SystemAPI.GetSingletonRW<TreeHolder>().ValueRW;` 再写。同理 `ComponentLookup<T>.GetRef` 给的是 `ref`，而 `GetComponentData<T>()` 给的是拷贝——**写路径必须自己持有 ref**，或者改完整个结构后整体写回组件。

### 和 ECS 的常规接法
1. **谁进树**：给需要参与空间查询的实体挂一个空 tag（`IComponentData` 不带字段），采集 job 用 `[WithAll(typeof(该Tag))]` 限定范围，位置取 `LocalTransform.Position`。
2. **句柄存哪**：入树时把 `Handle` 和"上次同步的位置"存进一个组件；每帧只比较 `transform.Position` 与缓存位置，变了才产出一次更新操作。
3. **实体销毁怎么回收槽位**：实体没了，句柄也跟着没了，槽位会永久泄漏；常见做法是用一个只用于清理的组件（`ICleanupComponentData`，实体销毁后仍留在 archetype 上）备份句柄，清理阶段用"没有主 tag 但有清理组件"区分"真被销毁"和"活实体身上的备份"。
4. **结构性变更**走 `EntityCommandBuffer`（`Allocator.Temp`）并在查询循环之外播放；**采集再消费**时收集结果用 `Allocator.TempJob` 的 `NativeList`，`AsDeferredJobArray()` 喂给下游，等下游 `Complete()` 后由最后使用者释放。
5. **`DynamicBuffer` 不能当 job 字段**（它和实体 / chunk 绑定），要么用 `IJobEntity` 参数注入，要么先拷进 `NativeArray`。**发布一个自增的 `BuildVersion`**：整棵树重建后之前的句柄全部作废，让持有者能判断句柄是不是上一代的。

## 10. 参数怎么选，以及小结
### 三个公式
```text
① 节点总数       N(D) = (C^(D+1) - 1) / (C - 1) ≈ C^D · C/(C-1)
   C = 子节点数（4 或 8），D = 最大深度
   → 最深一层占了大约 C/(C-1) 的份额，所以内存几乎全押在叶子上
② 每叶平均元素数 avg = n / C^D    （n = 元素总数）
   → 想让它 ≤ m，需要 C^D ≥ n/m，也就是 D ≥ log_C(n/m)
③ 叶盒边长       side = 2E / 2^D  （E = 世界半边长）
   → side 减半只有两条路：D 加 1（内存 ×C），或者 E 减半（不动内存）
```
**"深度比元素数更贵"**：`N(D)` 里根本没有 n，也没有 E。元素翻十倍，节点数一个不变；深度加一层，节点数直接乘 4 或 8。内存预算要按深度算，不是按元素数算。

### 一个完整的选参例子
要索引 20,000 个元素，叶容量阈值取 16，即 `n/m = 1250`：
```text
四叉树：4^D ≥ 1250 → D=5 是 1024（不够），D=6 是 4096 ✓
        节点数 Span(6) = 5,461 → 5,461 × 8 B ≈ 42.7 KiB
        叶边长 = 2E/64；E=512 时是 16
八叉树：8^D ≥ 1250 → D=3 是 512（不够），D=4 是 4096 ✓
        节点数 Span(4) = 4,681 → 4,681 × 8 B ≈ 36.6 KiB
```
有意思的是八叉树用更少的节点达到了同样的叶分辨率——每层细 8 倍，深度只要 4。节点数大致是"叶子数 × C/(C-1)"：四叉树多 1/3，八叉树只多 1/7。

### 内存对照表（每节点 8 字节）

| 最大深度 D | 四叉树节点数 / 内存 | 八叉树节点数 / 内存 |
| --- | --- | --- |
| 4 | 341 / 2.7 KiB | 4,681 / 36.6 KiB |
| 5 | 1,365 / 10.7 KiB | 37,449 / 292.6 KiB |
| 6 | 5,461 / 42.7 KiB | 299,593 / 2.29 MiB |
| 7 | 21,845 / 170.7 KiB | ≈2.40 M / ≈18.3 MiB |
| 8 | 87,381 / 682.7 KiB | ≈19.2 M / ≈146.4 MiB |

另有元素池：每元素 32 字节，按需增长；以及杂项簿记——"本轮碰过的节点"列表或位图，位图约 `N/8` 字节。**范围要大，收 `Bounds`，别加深度**：深度加一层内存 ×4 到 ×8，而缩小世界范围只是让格子跟着变小，一分钱内存不花。E = 512、D = 6 时格子边长 16；想让格子变成 8，D = 7 要花 170.7 KiB（还是四叉树，八叉树要 8 倍），而把 E 收到 256 只是一行配置。

### 起步参数与收尾清单

| 参数 | 建议起点 | 说明 |
| --- | --- | --- |
| 子节点数 C | 4（平面玩法）/ 8（有垂直分层） | 平面玩法用八叉树索引 y 纯属浪费内存 |
| 最大深度 D | 5 ~ 7 | 先用公式 ② 算下限，再用 ① 检查内存 |
| 叶容量阈值 m | 16 ~ 32 | 太小 → 树深、跳转多；太大 → 叶内退化成线性扫描 |
| 元素池初始容量 | 预估峰值的 1.5 倍 | 避免运行期扩容（悬垂指针的唯一来源） |

- 把"几何子序号"与"编码子序号"的一致性写成随机点断言，别靠肉眼。
- 复位节点用显式哨兵（`Head = -1`），不要用 `default`。
- 沿链走的循环都带守卫计数；单叶元素数别用 `short` 硬扛。
- 扩容后手动初始化新区间；能不扩容就不扩容。
- job 输出一律走 `NativeReference` / `NativeArray`；改单例组件一定要拿 `ref`。
- 读并行、写单线程这条约定要写在注释里，因为 `UnsafeList` 没有安全系统兜底。
- 深度到顶后叶容量不再是上界，同位置元素会堆成长链——这是设计不是 bug，但要为最坏情况留退路。
