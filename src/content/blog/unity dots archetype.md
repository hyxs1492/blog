---
title: 'Unity DOTS —— Archetype、Chunk、Entity'
description: '从零理解 DOTS 的三级内存结构：为什么实体本身不存数据、chunk 为什么固定 16 KiB，以及"改字段"和"增删组件"的代价差了三个数量级。'
pubDate: '2026-01-15'
category: 'Unity DOTS'
tags: ['Unity', 'DOTS', 'ECS', 'Archetype', 'Chunk']
---

刚接触 DOTS 的人最容易写出"能跑但很慢"的代码。原因通常不是不会用 API，而是不知道 API 背后在搬内存。这篇教程只讲一件事：**DOTS 把你的数据放在哪里**。搞清这一点，后面"这个写法快不快"就都能自己推导，不需要背结论。

## 速览

> - **Archetype（原型）是组件的"菜单组合"**：一个实体身上有哪几种组件，它就属于哪个 archetype。多一个组件就是另一份菜单。
> - **Chunk（块）是 16 KiB 的内存抽屉**，只放同一个 archetype 的实体，一块最多 128 个实体。
> - **chunk 内部不是"一个实体一坨结构体"，而是每种组件一条数组**。所以遍历 `Position` 是连续扫描内存，CPU 缓存极友好。
> - **改一个字段几乎不花钱；给实体增删组件非常贵**，因为要把整个实体复制到另一个 chunk。所以状态切换要用"开关"（`IEnableableComponent`）而不是增删组件。
> - **`ISharedComponentData` 是分块标签，不是每实体数据**：同一个 chunk 里所有实体必须共享同一个值，值的种类越多 chunk 就越多。

## 1. 忘掉面向对象：数据先分家

一个最朴素的玩家，在传统 Unity 里长这样：

```csharp
public class Player : MonoBehaviour   // 位置、速度、血量全捆在一个类里
{
    public Vector3 position;
    public Vector3 velocity;
    public int health;
}
```

每个实例在堆上各占一块，字段挨在一起。遍历 1000 个玩家时，CPU 每次都要跳到一块新内存，缓存几乎帮不上忙。DOTS 完全反过来：**把字段按类型分开存，把实体降级成一个编号**。

```csharp
public struct Position : IComponentData { public float x, y, z; }
public struct Velocity : IComponentData { public float x, y, z; }
public struct Health   : IComponentData { public int   value;  }
```

`IComponentData`（组件数据接口）就是"这个 struct 可以当组件用"的标记，没有任何方法要实现，只是给代码生成器和 ECS 看的一句声明。

创建实体的代码也很直白：

```csharp
var e = state.EntityManager.CreateEntity();
state.EntityManager.AddComponentData(e, new Position { x = 1 });
state.EntityManager.AddComponentData(e, new Velocity { x = 0.5f });
state.EntityManager.AddComponentData(e, new Health   { value = 100 });
```

注意：`e` 里**并没有** `position` 字段。数据跑到别处去了。

## 2. 三级结构：World → Archetype → Chunk → Entity

第一次看到这三个词会以为是三件不相干的东西，其实是**包含关系**：

```text
World（整个世界）
 ├── Archetype A   签名：Entity + Position + Velocity + Health
 │    ├── Chunk #0   16 KiB   ← 最多装 128 个"A 类"实体
 │    ├── Chunk #1   16 KiB
 │    └── ...                 （实体多了就再开一块）
 ├── Archetype B   签名：Entity + Position + Velocity   （少了 Health）
 │    └── Chunk #0
 └── ...
```

| 概念 | 一句话解释 | 关键性质 |
| --- | --- | --- |
| **Archetype** | 一张"组件菜单"，菜单完全相同的实体归为同一类 | 加/减任何一种组件 = 换菜单 = 换家 |
| **Chunk** | 分配给某个 archetype 的 16 KiB 内存抽屉 | 只装同一菜单的实体，一块最多 128 个 |
| **Entity** | 8 字节编号（4 字节 `Index` + 4 字节 `Version`） | **本身不存任何业务数据**，只是索引 |

`Version` 的作用是防悬空引用：实体销毁后槽位会被复用，但 `Version` 会自增，旧 `Entity` 值因此查不到新实体。这解释了为什么 `Entity` 不适合当业务 ID 长期存进字典。

## 3. chunk 内部长什么样

全篇最重要的一张图，请盯着看三秒：

```text
                Chunk（固定 16 KiB 数据区 + 元数据）
┌───────────────────────────────────────────────────────────────┐
│ 元数据区                                                       │
│   · Archetype 指针            （这块属于哪份菜单）              │
│   · shared component 索引     （每类型一份，见 §7）             │
│   · enableable 掩码 v128      （每类型一份，见 §6）             │
│   · Count / Capacity          （当前几个实体 / 最多几个）       │
├───────────────────────────────────────────────────────────────┤
│ 数据区（列式存储，SoA）                                         │
│   Entities : [E0][E1][E2][E3] … [En]   ← 实体编号也是一"列"     │
│   Position : [P0][P1][P2][P3] … [Pn]                           │
│   Velocity : [V0][V1][V2][V3] … [Vn]                           │
│   Health   : [H0][H1][H2][H3] … [Hn]                           │
└───────────────────────────────────────────────────────────────┘
        ↑ 同一列内下标 i 的各个值，拼起来才是"第 i 个实体"
```

"第 i 个实体"在内存里**根本不是连续的一块**，而是各列第 i 项的组合。这个术语叫 **SoA（Structure of Arrays，把结构体数组拆成若干数组）**，与之相对的 AoS 就是我们熟悉的"一个实体一坨字段"。

SoA 换来三件好事：**遍历单个组件时数据连续**（缓存命中率极高）、**可以 SIMD 向量化**（Burst 能把 4 个 `float` 一次算完）、**可以只加载用到的列**。代价是：想同时读某实体的全部字段要跨好几条数组，所以 DOTS 里"随机访问单个实体"永远是下策，"批量处理整列"才是正路。

实体在 chunk 内**紧密排列**（下标 0,1,2… 无空洞）。删除实体用的是 **swap back**（把最后一个实体搬到空出来的位置），所以**实体顺序不稳定，绝不能依赖下标**。

> 官方原文：*"一个 chunk 为每种组件类型存一个数组，另外还存一个实体 ID 数组。"*

## 4. 16 KiB 和 128 这两个数字是怎么来的

| 量 | 值 |
| --- | --- |
| Chunk 固定数据区 | **16 KiB = 16384 字节** |
| 每 chunk 实体数硬上限 | **128** |
| 单个实体的占用 | 它所有组件大小之和 **+ 8 字节**（Entity 编号）；`DynamicBuffer` 另算 |
| 实际每 chunk 实体数 | `min(16384 ÷ 单实体占用字节数, 128)` |

公式里的 `min` 是理解内存浪费的钥匙，分两种情况。

**情况一：实体很小（< 128 字节）→ 撞 128 上限，chunk 大量空着。**

假设一个实体只有 `Entity`(8) + `Position`(12) + `Velocity`(4) = 24 字节。按字节算 `16384 ÷ 24 ≈ 682` 个都放得下，但硬上限把它卡在 128 个，于是实际只用掉 `128 × 24 = 3072` 字节，利用率 `3072 ÷ 16384 ≈ 18.75%`——**八成以上的内存空着**。这不是 bug，而是为了让"实体下标能塞进一条 128 位的掩码"而定的硬规则（见 §6）。

**情况二：实体很大（> 128 字节）→ 撞 16 KiB 上限，chunk 数量膨胀。**

假设单实体 300 字节：`16384 ÷ 300 ≈ 54`，每 chunk 只装 54 个。chunk 是并行调度的最小单位（见 §8），所以这既可能带来更多并行单元，也可能带来更低的块内利用率。

动手算一算：

| 单实体占用 | 每 chunk 实体数 | 块内利用率 |
| --- | --- | --- |
| 24 字节 | 128（撞上限） | ≈ 19% |
| 128 字节 | 128（两边刚好相等） | 100% |
| 300 字节 | 54 | ≈ 99% |

规律很清晰：**实体尺寸越接近 128 字节，chunk 利用越充分**。这也是 DOTS 鼓励把大组件拆小、把只读常量搬去 shared component 的原因。

一个特殊成员：`DynamicBuffer<T>`（动态缓冲区，长度可变的组件数组）默认会把一部分容量放在 chunk 数据区内，**从而挤占同 chunk 的实体容量**，超出部分落到 chunk 外。确定 buffer 常常很大时可以显式声明 `[InternalBufferCapacity(0)]` 让它完全在 chunk 外——`IBufferElementData` 就是"这个 struct 可以当动态缓冲区元素"的标记。

## 5. 各类操作的代价：差三个数量级

把 API 和"底层搬了多少内存"对应起来：

| 你写的代码 | 底层发生了什么 | 代价 |
| --- | --- | --- |
| 改组件里的一个字段 | 原地写某一列的第 i 项 | **极低**（纳秒级） |
| `SetComponentEnabled<T>(false)` | 翻 chunk 掩码里的一个 bit | **极低**（chunk 不搬） |
| `AddComponent` / `RemoveComponent` | **archetype 变了 → 整个实体 memcpy 到另一个 chunk** | **高** |
| 改 shared component 的值 | 可能搬到另一个 chunk 分组 | **高** |
| `DestroyEntity` | swap back：末位实体填补空位 | 中 |
| `Instantiate` | 复用已有 chunk 或分配新块 | 中 |
| 新增一个 archetype | 至少多占一个 16 KiB chunk | 高 |

两种写法在代码上只差一行，底层却是"改一个数字"和"搬几 KB 内存"的区别：

```csharp
// ✅ 便宜：只改一个数字
SystemAPI.SetComponent(entity, new Health { value = 50 });

// ⚠️ 昂贵：结构变了，实体要被搬到新 chunk
state.EntityManager.RemoveComponent<Health>(entity);
state.EntityManager.AddComponent<MoveEnabled>(entity);
```

**天真做法为什么不行**：很多人的第一反应是"单位死了就 `RemoveComponent<MoveEnabled>`，复活再 `AddComponent`"。逻辑没错，但在上万个实体、每帧几百次切换的场景下，每次切换都是几 KB 的 memcpy 加 chunk 重排，性能会断崖式下跌。

两条推论请务必记住：**用"开关"而不是"增删组件"表达状态切换**（这正是 `IEnableableComponent` 存在的理由）；**实体在 chunk 内的顺序不稳定**（swap back 会改位置），不要依赖下标，也不要把 `unfilteredChunkIndex` 之类的索引当业务 ID。

## 6. 用开关代替增删：IEnableableComponent

假设有个 `MoveEnabled` 标记组件，只有能被操作的单位才有。传统写法是增删这个组件，也就是上面那条"昂贵"的路。问题在于：**"可移动 / 不可移动"根本不是数据，只是一个布尔位**，为了一个 bit 搬几 KB 内存显然荒谬。

`IEnableableComponent`（可启用组件接口）就是官方为此提供的方案——它给组件加了一条**"启用位"**：

```csharp
public struct MoveEnabled : IComponentData, IEnableableComponent { }

// 关闭：改 1 个 bit，chunk 完全不动
state.EntityManager.SetComponentEnabled<MoveEnabled>(entity, false);
```

```text
普通组件        →  只有"数据列"
enableable 组件 →  数据列  +  chunk 里一条 128 位掩码
```

### 掩码的四个性质

1. **粒度是"组件类型 × chunk"**，不是每实体一份——同 chunk 内所有实体共用一条掩码，每个实体占 1 bit。
2. **固定 16 字节**（`v128` = 128 bit）。**这就是 128 实体上限的来源**：位图只有 128 位，装不下第 129 个。
3. **不参与 chunk 容量计算**。掩码属于 chunk 元数据，决定装多少实体的只有组件的**数据**字节数，所以加 `IEnableableComponent` **不会**让 chunk 装更少。
4. **有效位只到 `chunk.Count`**，其后的位恒为 0。

### 查询语义变了

| 对比项 | 普通 `IComponentData` | `IEnableableComponent` |
| --- | --- | --- |
| "关掉它"的手段 | 只能 `RemoveComponent` → 换 archetype → **搬 chunk** | `SetComponentEnabled(false)` → **改 1 bit** |
| 查询匹配条件 | 实体**有**该组件 | 实体有该组件 **且** 对应位为 1 |
| 能否在 Job 里安全切换 | ❌（结构性变更，必须走 `EntityCommandBuffer`） | ✅（无需 ECB、无同步点） |

最后一行很重要：普通组件的增删是**结构性变更**，不能在 Job 里直接做，只能录进 `EntityCommandBuffer`（实体命令缓冲区，把结构性变更延后到同步点统一执行）；enableable 开关没有这个限制。

### 常见坑：掩码是"合成"的

当查询里包含多个 enableable 组件时，`IJobChunk.Execute` 收到的 `chunkEnabledMask` 是**它们合并后的结果**——只回答"所有相关开关是否都打开"，**不告诉你是哪一个组件被关了**。

```csharp
bool on = chunk.IsComponentEnabled<MoveEnabled>(index);          // 按实体索引精确问
EnabledMask mask = chunk.GetEnabledMask(ref moveEnabledHandle);  // 该类型专属掩码，可读可写
mask[i] = false;
```

（用 `IJobEntity` 时代码生成器会按实体语义处理，通常不必关心这一点。）

### 使用建议

- 只给**确实会被频繁启停**的组件用。每个 enableable 组件都会带来每 chunk 16 字节元数据、查询时的掩码合并与逐实体枚举开销、archetype 签名上的一个类型位。
- **特例**：`IBufferElementData` 也能实现 `IEnableableComponent`，动态缓冲区同样有位图。
- **`SetComponentEnabled(false)` 不清空数据**。值仍留在数据列里，重新启用后读到的是关掉之前的值；这与 `RemoveComponent`（数据搬走、原位数值丢失）完全不同。排查行为异常时，先确认是**被禁用**还是**组件被删了**。

## 7. 用分块做分类：ISharedComponentData

渲染时常有几百个实体共用同一份材质和 Mesh。当普通组件存的话，每个实体都要重复存一份指针，白白浪费 chunk 空间。`ISharedComponentData`（共享组件接口）的思路是：**既然值都一样，就别存 N 份，只存 1 份，chunk 里记个编号。**

**核心规则：同一个 chunk 里的所有实体，shared component 的值必须相同。** 这不是优化建议，而是它的定义。因此它不是"每个实体的数据"，而是 **chunk 级的分类标签**。

```csharp
public struct MaterialShared : ISharedComponentData
{
    public int materialId;   // 用 int 演示；真实项目里这里常是 Material / Mesh 引用
}
```

### 值存在哪：World 级去重值表

```text
Chunk 元数据
  └── shared component 索引（每类型一份）
          │
          ▼
      World 级"去重值表"（按类型分表）
        ├── [0] materialId = 7   （引用计数 3）
        ├── [1] materialId = 9   （引用计数 1）
        └── ...
```

- 真值在 **World 级值表**里，**按类型分表**（不同类型的值不会互相比较）。
- 值**自动去重**：已有相等的值就复用索引，没有才追加。查找靠你实现的 `GetHashCode()` / `Equals()`（或 `IEquatable<T>`）。
- 每个索引带**引用计数**，归零后槽位可复用。
- 因此**每实体内存开销为零**，同一份值可以被任意多个 chunk 共用。

### 两步查找：值 → 索引 → chunk 分组

设置 shared component 时，ECS 内部做的是两件不同的事：

```text
AddSharedComponent(entity, 值V) / SetSharedComponent(entity, 值V)
   │
   ├─【第 1 步】值 → 索引：查该类型在 World 级的去重值表（哈希查找）
   │        ├─ 已有相等的值 → 复用已有 index
   │        └─ 没有         → 追加新值，分配新 index（引用计数 +1）
   │
   └─【第 2 步】索引 → chunk：在该 archetype 下按 index 找 chunk 分组
            ├─ 有该 index 的 chunk 且有空位    → 放进去
            ├─ 有但都满了                      → 新建 chunk，归入同一分组
            └─ 该 index 在此 archetype 没出现过 → 新建一个 chunk 分组
```

**第 1 步是"值层面的去重"，第 2 步是"chunk 层面的归位"**，两层完全独立。

⚠️ **前提最容易漏**：archetype 必须相同。两个实体即使 shared component 值一样，只要组件组合不同，就永远不在同一个 chunk。

### 值相同 ≠ 同一个 chunk：Segment

```text
Archetype X + materialId=7  →  Segment（materialId=7）
                                 ├── Chunk #0   128 个实体（满）
                                 ├── Chunk #1   128 个实体（满）
                                 └── Chunk #2    37 个实体  ← 新实体进这里
```

- 官方术语叫 **Segment**（段 / chunk 分组）：**Segment 数量 = 唯一值组合的数量**，而 chunk 数量可能更多（一个 Segment 可以包含多个 chunk）。
- Unity 的 `Window > Entities > Archetypes` 窗口里显示的 **Segments** 就是这个数字，调试内存问题时非常有用。

### 操作行为差异

| 操作 | archetype | 是否搬家 |
| --- | --- | --- |
| `AddSharedComponent`（之前没这个组件） | **变了** | **必然 memcpy** 到新 archetype 的 chunk |
| `SetSharedComponent`，新值对应**不同** index | 不变 | **搬到同 archetype 下、新 index 的 chunk** |
| `SetSharedComponent`，新值与旧值**相同** | 不变 | **完全不动**（官方明确写了这条短路） |
| 按 query **批量**设置同一个值 | 不变 | 官方 Remarks 提到它**不需要逐个搬动实体**，远比逐实体调用便宜 |

### 组合爆炸：唯一的判据

**每个唯一的"值组合"至少要占一个 chunk 分组**；多个 shared component 类型时，分组数量是它们的**笛卡尔积**。500 个实体若值两两不同，就是 500 个 Segment、每个只装 1 个实体，也就是 500 个几乎全空的 16 KiB chunk；若只有 10 种不同的值，最少 10 个 Segment 就能塞满。极端情况是"每个实体一个独立 archetype"：十万个各不相同的 archetype，光 chunk 内存就是 GB 量级，而且大部分是空的。

**判据只有一句：这个字段的"不同取值个数"会不会随实体数量一起增长？** 会（唯一 ID、per-instance 材质、每帧变化的血量）→ **不要放 shared component**；不增长且有大量实体共享 → 适合，典型是材质 / Mesh / 渲染资源、LOD 档次与阵营 / 波次这类分类维度、一大批实体共享的只读上下文。

### 读取与写入

| 用法 | API 形态 | 要点 |
| --- | --- | --- |
| 按值筛选实体 | `query.SetSharedComponentFilter(value)` | **只遍历该值对应的 Segment**，其它值的实体一个都不碰 |
| 批量改值 | 先 filter 再整批 `SetSharedComponent` | 比逐实体 `Set` 便宜得多 |
| 读单个 chunk 的值 | `chunk.GetSharedComponent<T>()`（在 `IJobChunk` / `IJobEntityChunkBeginEnd` 中） | 每 chunk 读一次即可复用 |
| 含托管引用（`Material` / `Mesh` / `List<T>`） | 必须用 **`*Managed`** 版本（如 `AddSharedComponentManaged`） | 这类系统**不能 Burst** |

含托管引用时还有一条：哈希与相等性由你实现的 `IEquatable<T>` / `GetHashCode()` 决定，所以**不要绕开 ECS 直接修改被引用对象的内容**，否则值表的哈希会和实际内容对不上，去重逻辑静默出错。

## 8. 并行粒度就是 chunk

很多人第一次写 `ScheduleParallel` 都会困惑：为什么改成 8 个线程，帧率没变？因为 **`ScheduleParallel` 是按 chunk 把工作分给 worker 线程的**：

```text
某 archetype 共 600 个实体
  ├── Chunk #0  128 个  ──► 线程 1
  ├── Chunk #1  128 个  ──► 线程 2
  ├── Chunk #2  128 个  ──► 线程 3
  ├── Chunk #3  128 个  ──► 线程 4
  └── Chunk #4   88 个  ──► 线程 5
                            线程 6/7/8 无事可做
```

由此得到三条推论：**实体总数 ≤ 128 → 只有 1 个 chunk → 这个 Job 只跑一个线程**（实体太少时并行毫无意义，甚至因调度开销更慢）；**实体越大 → 每 chunk 装得越少 → 同实体数下 chunk 更多**，并行单元更多但每块利用率更低，这是"并行度"与"内存利用率"的直接权衡；想让一批实体天然按类别分开，就用 shared component 切分，代价见上一节的组合爆炸。

所以看到"并行没提速"时先问自己：**这个 archetype 有多少个 chunk？** 答案是 1 的话，问题不在线程配置，而在数据规模或分块方式。

## 9. 小结

| 你想做的事 | 该用什么 | 为什么 |
| --- | --- | --- |
| 改一个数值 | 直接写组件字段 | 原地写一列的一项，最便宜 |
| 暂停 / 恢复某个行为 | `IEnableableComponent` + `SetComponentEnabled` | 翻一个 bit，chunk 不搬 |
| 给一批实体打分类标签 | `ISharedComponentData` | 零每实体开销，天然按 chunk 分组 |
| 按类别筛选实体 | `query.SetSharedComponentFilter` | 只遍历目标 Segment |
| 提高并行度 | 增加实体数 / 调整分块 | 并行粒度是 chunk，不是实体 |

至于"这些数据结构怎么被系统读到"，那是下一篇的主题：**系统类型（`ISystem` / `SystemBase`）和迭代方式（`SystemAPI.Query` / `IJobEntity` / `IJobChunk`）**。
## 参考资料

- [Archetypes and chunks](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/concepts-archetypes.html)
- [Enableable components](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/components-enableable.html)
- [Shared components](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/components-shared.html)
- [Dynamic buffer components](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/components-buffer.html)
