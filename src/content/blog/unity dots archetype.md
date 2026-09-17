---
title: 'Unity DOTS —— Archetype、Chunk、Entity'
description: 'DOTS Archetype、Chunk、Entity 基本概念'
pubDate: '2026-01-15'
---


## 速览
>- 一个 archetype 可以有**任意多个** chunk（实体多了就开新块）。
>- **哪怕只有 1 个实体，它也至少占一个 16 KiB 的 chunk**（内存浪费的根源）。
>- **只有同一 archetype 的实体才能待在同一个 chunk 里。**
```
World
 ├── Archetype A（签名：Entity + Position + Velocity + Health）
 │    ├── Chunk #0   16 KiB   ← 装 128 个该签名的实体
 │    ├── Chunk #1   16 KiB
 │    └── ...
 ├── Archetype B（签名少了 Health）
 │    └── Chunk #0
 └── ...
```
| 概念 | 含义 |
| --- | --- |
| **Archetype** | 组件组合的"签名"。组件种类完全一致的实体属于同一 archetype；多/少一个组件类型就是另一个 archetype |
| **Chunk** | 存放同 archetype 实体的 16 KiB 内存块 |
| **Entity** | 8 字节的 ID（`int Index` + `int Version`）。**它本身不存数据**——数据在 chunk 的各"列"里 |
---

## 1. 内部结构
**chunk** 不是"每个实体一坨结构体"，而是**每种组件一条连续数组**：
```
        Chunk（固定 16 KiB 数据区 + 元数据）
┌──────────────────────────────────────────────────────────┐
│ 元数据：Archetype 指针 / shared component 索引 /          │
│         enableable 掩码 / 实体数 Count / 容量 Capacity    │
├──────────────────────────────────────────────────────────┤
│ Entities  : [E0][E1][E2][E3] … [En]                      │ ← 实体 ID 也是一"列"
│ Position  : [P0][P1][P2][P3] … [Pn]                      │
│ Velocity  : [V0][V1][V2][V3] … [Vn]                      │
│ Health    : [H0][H1][H2][H3] … [Hn]                      │
└──────────────────────────────────────────────────────────┘
   ↑ 同一索引 i 上的各列值，拼成"第 i 个实体"
```
>- **"第 i 个实体"不是一块连续内存**，而是各列的第 i 项 ↔ 遍历同一组件时数据连续 → cache 友好、可 SIMD 向量化。
>- 实体在 chunk 内**紧密排列**（索引 0,1,2… 无空洞）。
>- 移除实体时用 **swap back**：把 chunk 里最后一个实体搬来填坑。
>- 官方原文：*"一个 chunk 为每种组件类型存一个数组，另外还存一个实体 ID 数组。"*

| 量 | 值 |
| --- | --- |
| Chunk 固定大小 | **16 KiB（16384 字节）** |
| 每 chunk 实体上限 | **128**（硬上限） |
| 单实体占用 | 它所有组件大小之和 **+ 8 字节**（Entity ID）；`DynamicBuffer` 另算 |
| 每chunk实体数量 | **min**(**16384** ÷ 单个实体占用字节数, **128**) |

| 情况 | 后果 | 例子 |
| --- | --- | --- |
| 实体 **< ~128 字节** | 卡在 128 上限，**chunk 有空隙** | 24 字节的小实体：`16384 ÷ 24 ≈ 682`，但只放得下 128 个 → 仅用 `128 × 24 = 3072` 字节（约 19%），其余空着 |
| 实体 **> ~128 字节** | 卡在 16 KiB 上限，装不满 128 个 → **chunk 更多、跨块更多** | 300 字节的实体：每 chunk 约 54 个 |

> 官方口径：*"容量由 ECS 分配的固定 16KB 内存块和 archetype 中所有组件类型的总存储大小决定"*；*"一个 chunk 最多容纳 128 个实体，所以 chunk 容量永远不会高于此值。"*

| 元数据 | 粒度 | 说明 |
|---|---|---|
| Archetype 指针 | 每 chunk 一份 | 这个块属于哪个签名 |
| shared component 索引 | 每个 shared component 类型一份 | 真值在 chunk 外（§4.2） |
| enableable 掩码 | 每个 enableable 组件类型一份（`v128`） | §4.1 |
| `Count` / `Capacity` | 每 chunk 一份 | 当前实体数 / 最大容量 |
| chunk component | 每 chunk 一份 | 整块共享一份值的组件 |
>- **`DynamicBuffer<T>` 是特例**：默认占用 chunk 数据区（**挤占同 chunk 的实体容量**），超出部分落到 chunk 外的堆内存；用 `[InternalBufferCapacity(0)]` 可以让它完全在 chunk 外。

---
## 2. 操作与代价
| 操作 | 底层发生什么 | 代价 |
|---|---|---|
| 改组件的一个字段 | 原地写某一列的第 i 项 | **极低** |
| `SetComponentEnabled<T>` | 改启用掩码里的一个 bit | **极低**（chunk 不搬） |
| `AddComponent` / `RemoveComponent` | **archetype 变了 → 整个实体 memcpy 到另一个 chunk** | **高** |
| 修改 shared component 的值 | 可能搬到另一个 chunk 分组（§4.2） | **高** |
| `DestroyEntity` | **swap back**：末位实体填补空位 | 中 |
| `Instantiate` | 复用 / 分配 chunk | 中 |
| 新增一个 archetype | 至少多占一个 16 KiB chunk | 高 |
两条推论：
1. **用"开关"而不是"增删组件"表达状态切换** —— 这正是 `IEnableableComponent`存在的理由。
2. **实体在 chunk 内的顺序不稳定**（swap back 会改位置）——不要依赖索引顺序；`unfilteredChunkIndex` 之类的索引也不是业务 ID。
---

## 3. chunk 级的两种特殊组件
普通组件只有"数据列"。另有两类组件会在 **chunk 元数据**上加东西，规则各不相同：
|  | 普通组件 | `IEnableableComponent` | `ISharedComponentData` |
| --- | --- | --- | --- |
| 值存放 | chunk 数据区，每实体一份 | 同左 + chunk 里一个 bit | **chunk 外**（World 级值表）；chunk 只存索引 |
| 每实体开销 | 有 | 有 | **零** |
| 是否影响分块 | ❌ | ❌（同 chunk 内可混合启停） | ✅ **值不同 → 不同 chunk** |
| 改值的代价 | 原地写 | 翻一个 bit | **结构性变更 → 实体搬家** |
| 能否在 Job 里改 | ✅ | ✅ | ❌（主线程 + 同步点） |
>- 一句话区分：**`IEnableableComponent` 管"这个实体现在要不要参与"（不看分块），`ISharedComponentData` 管"这批实体属于哪一类"（就是分块依据）。**
###  `IEnableableComponent`：启用位图
**只有实现该接口的组件才有位图**。普通 `IComponentData` 没有——它在 ECS 眼里没有"开/关"状态：实体上有它就在生效，想让它失效只能 `RemoveComponent`（结构性变更）。
>普通组件          →  只有"数据列"
> enableable 组件   →  数据列  +  chunk 里一条 128 位掩码

| 对比项 | 普通 `IComponentData` | `IEnableableComponent` |
| --- | --- | --- |
| "关掉它"的手段 | 只能 `RemoveComponent` → 换 archetype → **搬 chunk** | `SetComponentEnabled(false)` → **改 1 bit** |
| 查询匹配条件 | 实体**有**该组件 | 实体有该组件 **且** 对应位为 1 |
| 能在 Job 里安全切换 | ❌（结构性变更，必须走 ECB） | ✅（无需 ECB、无同步点） |
**位图的四个性质**
>- 粒度是"**组件类型 × chunk**"，不是"每实体一份"——同一 chunk 内所有实体共用一条掩码。
>- **固定 16 字节**（`v128` = 128 bit）——这就是 128 实体上限的来源。
>- **不参与 `chunkCapacity` 计算**：它是 chunk 级元数据，决定装多少实体的只有组件**数据**字节数。加 enableable **不会**让 chunk 装更少。
>- **有效位只到** `chunk.Count`，其后恒为 0。

**坑：`chunkEnabledMask` 是"合成"掩码**查询里包含多个 enableable 组件时，`IJobChunk.Execute` 收到的 `chunkEnabledMask` 是**它们合并后的结果**——只回答"所有相关开关是否都打开"，**不告诉你是哪个组件被关了**。要精确问单个组件：
```csharp
bool on = chunk.IsComponentEnabled<MoveEnabled>(index);          // 按实体索引逐项问
EnabledMask mask = chunk.GetEnabledMask(ref moveEnabledHandle);  // 该类型专属掩码，可读可写
mask[i] = false;
```
（用 `IJobEntity` 时生成代码会按实体语义处理，通常不必关心。）
**使用建议**
>- 只给**确实会被频繁启停**的组件用。每个 enableable 组件都会带来：每 chunk 16 字节元数据、查询时的掩码合并与逐实体枚举开销、archetype 签名上的一个类型位。
>- **特例**：`IBufferElementData` 也可以实现 `IEnableableComponent`（buffer 同样有位图）。
**调试结论**：`SetComponentEnabled(false)` **不清空数据**——值仍在数据列里，重新启用后读到的是关掉之前的值。这与 `RemoveComponent`（数据搬走、值丢失）完全不同。排查行为异常时，先确认是**被禁用**还是**组件被删**。

###   `ISharedComponentData`：分块维度
**核心规则：同一个 chunk 里的所有实体，shared component 的值必须相同。**
这不是优化建议，而是它的定义。因此 shared component 不是"每个实体的数据"，而是 **chunk 级的分类标签**。
#### 值存在哪
```
Chunk 元数据
  └── shared component 索引（每类型一份）  ──►  World 级"去重值表"
                                                  ├─ [0] 材质A + 网格X   (引用计数 3)
                                                  ├─ [1] 材质B + 网格Y   (引用计数 1)
                                                  └─ ...
```
- 真值在 **World 级值表**里，**按类型分表**（不同类型的值不会互相比较）。
- 值**去重**：设置时若已有相等的值，直接复用索引；没有才追加（靠 `GetHashCode()` / `Equals()` 查找）。
- 每个索引带**引用计数**，归零后槽位可复用。
- 因此**每实体内存开销为零**，同一份值可被无限多个 chunk 使用。
#### 两步查找：值 → 索引 → chunk 分组
**前提（最容易漏）**：archetype 必须相同。两个实体即使 shared component 值一样，只要组件组合不同，就永远不同 chunk。
```
AddSharedComponent(entity, 值V) / SetSharedComponent(entity, 值V)
   │
   ├─【第 1 步】值 → 索引：查该类型在 World 级的去重值表（哈希）
   │        ├─ 有相等的值 → 复用已有 index
   │        └─ 没有        → 追加新值，分配新 index（引用计数 +1）
   │
   └─【第 2 步】索引 → chunk：在该 archetype 下按 index 找 chunk 分组
            ├─ 有该 index 的 chunk 且有空位   → 放进去
            ├─ 有但都满了                     → 新建 chunk，归入同一分组
            └─ 该 index 在此 archetype 从未出现 → 新建一个 chunk 分组
```
**第 1 步是"值层面的去重"，第 2 步是"chunk 层面的归位"**——两层不同的查找。
#### 值相同 ≠ 同一个 chunk：Segment
```
Archetype X + 材质X   →  Segment（材质X）
                         ├── Chunk #0   128 个实体（满）
                         ├── Chunk #1   128 个实体（满）
                         └── Chunk #2    37 个实体  ← 新实体进这里
```
- 官方术语 **Segment**（chunk 分组）：**Segment 数量 = 唯一值组合的数量**，chunk 数量可能更多。
- `Window > Entities > Archetypes` 窗口里的 **Segments** 就是这个数字。
#### 行为差异
| 操作 | archetype | 是否搬家 |
| --- | --- | --- |
| `AddSharedComponent`（之前没有该组件） | **变了** | **必然 memcpy** 到新 archetype 的 chunk |
| `SetSharedComponent`，新值 → **不同** index | 不变 | **搬到同 archetype 下、新 index 对应的 chunk** |
| `SetSharedComponent`，新值 → 与原值**相同** | 不变 | **完全不动**（官方明确写了这条短路） |
| 按 query **批量**设置同一个值 | 不变 | 官方 Remarks 提到这种批量方式**不需要逐个搬动实体**，远比逐实体调用便宜 |
#### 组合爆炸
**每个唯一的"值组合"至少要占一个 chunk 分组**（多个 shared component 类型时是笛卡尔积）。官方例子：
- 500 个实体、值都唯一 → **500 个 chunk**（每个只装 1 个实体）；
- 只有 10 个不同值 → **最少 10 个 chunk**。
另一个极端：10 万个各自独立的 archetype → 约 **1.5 GB** chunk 内存，大部分是空的。
**判据**：这个字段的"不同取值个数"会不会随实体数量一起增长？会 → 不要放 shared component。
#### 适用性
| 适合 | 不适合 |
|---|---|
| 材质 / Mesh / 渲染资源 | 每实体唯一的值（唯一 ID、per-instance 材质） |
| LOD 档次、阵营、波次等分类维度 | 频繁变化的值（每次变都可能搬家） |
| 一大批实体共享的只读上下文 | 需要每帧改写的状态 |
#### 写入与读取
| 用法 | API 形态 | 要点 |
|---|---|---|
| 按值筛选实体 | `query.SetSharedComponentFilter(value)` | **只遍历该值对应的 Segment**，其它值的实体一个都不碰 |
| 批量改值 | 先 filter 再整批设置 | 比逐实体 `Set` 便宜得多 |
| 读单个 chunk 的值 | `chunk.GetSharedComponent<T>()`（在 `IJobChunk` / `IJobEntityChunkBeginEnd` 中） | 每 chunk 读一次即可复用 |
| 含托管引用（`Material` / `Mesh` / `List<T>`） | 必须用 **`*Managed`** 版本（`AddSharedComponentManaged` 等） | 这类系统**不能 Burst** |

**含托管引用的额外注意**：哈希与相等性由你实现的 `IEquatable<T>` / `GetHashCode()` 决定——**不要绕开 ECS 直接修改被引用对象的内容**，否则值表里的哈希会与实际内容不一致。

---
## 4. 并行粒度就是 chunk
`ScheduleParallel` 按 **chunk** 把工作分给 worker 线程，所以：
- **某 archetype 的实体总数 ≤ 128 → 只有 1 个 chunk → 这个 Job 只跑一个线程。** 实体越多、chunk 越多，并行度才越高。
- 实体越大 → 每 chunk 装得越少 → 同实体数下 chunk 更多（并行单元更多，但每块利用率更低）。
- 想让一批实体天然分组，可用 shared component 切分（代价见 组合爆炸）。
---