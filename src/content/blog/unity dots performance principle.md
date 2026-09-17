---
title: 'Unity DOTS —— 性能原理技术文档'
description: 'DOTS 是为了让"成千上万个同质对象每帧都要算一遍"这件事变得可行'
pubDate: '2026-01-15'
---

> 主题：**为什么用 DOTS**，以及 **DOTS 为什么快**（性能收益的来源拆解）
> 适用版本：Unity Entities 1.0+ / Burst 1.8+ / Collections 2.x（本文按 Entities 1.0.16 编写）
> 阅读方式：先看「速览」；想理解原理看 §2；想判断"该不该用"看 §1 与 §4；文末有「速查表」。

---

## 速览

**一句话**：DOTS 是为了让"**成千上万个同质对象每帧都要算一遍**"这件事变得可行；它快，是因为同时做对了 CPU 最在意的三件事，并且顺手干掉了 GC。

**性能的四个来源**

| # | 机制 | 解决什么 | 量级感受 |
|---|---|---|---|
| 1 | **数据连续（SoA + chunk）** | cache miss（等内存） | 地基，决定上限 |
| 2 | **批处理（系统遍历，而非逐对象回调）** | 调用开销、重复分支 | 常数级改善 |
| 3 | **Burst + SIMD** | 单次指令吞吐 | 常见数倍到十几倍 |
| 4 | **Job System 多核** | 单线程串行 | 接近核心数倍 |
| + | **零 GC（Native 容器）** | 回收尖峰、帧时间抖动 | 消除卡顿 |

**用不用它，一句话判断**：对象的**数量**和**每帧处理次数**是否成为瓶颈？
"几千个以上、每帧都要遍历" → 该用；"几十个、逻辑各不相同" → 不该用。

---

## 1. 为什么要用 DOTS

### 1.1 传统 GameObject + MonoBehaviour 的四个瓶颈

| 瓶颈 | 具体表现 |
|---|---|
| **数据分散** | 每个 MonoBehaviour 是一个托管对象，字段散落在堆上（还带对象头、引用指针）。遍历 1 万个对象 = 上万次**随机访存**（见 §2.1 附录） |
| **逐个回调** | 每个对象一次 `Update()`：虚函数调用 + 重复进入同一段代码 + 分支预测失效 |
| **托管分配** | `List`、数组、闭包、装箱 → GC 分代回收 → **尖峰卡顿** |
| **主线程串行** | 逻辑全在主线程排队执行，多核 CPU 的其它核心闲着 |

结果就是：对象数量一上去，帧率不是"慢慢变差"，而是**断崖式崩塌**——因为瓶颈从"算"变成了"等内存"，而这是一条数量级的鸿沟。

### 1.2 DOTS 的对应答案

| 传统瓶颈 | DOTS 的做法 |
|---|---|
| 数据分散、cache miss | **组件按列连续存储**（SoA），只用到的字段才进 cache |
| 逐个 `Update()` | **一个 System 处理一整批实体**，循环体内是纯数据运算 |
| 托管分配与 GC | **非托管容器**（`NativeArray` / `NativeList` / `UnsafeList`），全程零 GC |
| 主线程串行 | **Job System** 按 chunk 分给 worker 线程并行 |
| 解释执行的托管代码 | **Burst** 编译成高度优化的原生代码（自动向量化） |

### 1.3 DOTS 不只是一个东西

"DOTS"（Data-Oriented Technology Stack）是**一套技术栈**，包含四件可独立使用的部件：

| 部件 | 包 | 职责 |
|---|---|---|
| **ECS** | `com.unity.entities` | 数据组织（Entity / Component / Chunk）与执行模型（System / SystemGroup） |
| **Job System** | 引擎内置 | 安全的多线程调度与依赖管理 |
| **Burst** | `com.unity.burst` | 把 C# 子集编译成 SIMD 原生代码 |
| **数学与容器** | `com.unity.mathematics`、`com.unity.collections` | SIMD 友好的类型（`float3`/`quaternion`）与非托管容器 |

辅助层还有 `com.unity.entities.graphics`（实例化渲染）、`com.unity.physics`（无状态确定性物理）。

> ⚠️ **DOTS ≠ ECS**。你可以只用 Burst + Job 而不上 ECS（例如把开销大的批处理剥出来）；也可以只用 Collections 的 Native 容器。ECS 只是这套栈里"管数据和组织执行"的那一层。

---

## 2. 为什么快（原理拆解）

### 2.1 地基：数据布局从 AoS 变成 SoA + chunk

```
传统（AoS：Array of Structures）
  [对象A: pos|vel|hp|name|…][对象B: pos|vel|hp|name|…][对象C: …]
   ↑ 每个对象是一块包含全部字段的内存，还带对象头与引用指针

ECS（SoA：Structure of Arrays）
  pos : [A][B][C][D] …     ← 连续
  vel : [A][B][C][D] …     ← 连续
  hp  : [A][B][C][D] …     ← 连续
   ↑ 每种组件一条独立数组，同一索引 i 上的各项才是"第 i 个实体"
```

**为什么快：**

1. **只用到的字段才进 cache。** 只算 `pos` 时，`name`、`mesh`、`音效引用`完全不占 cache 带宽。
2. **访问是顺序的。** 顺序访问触发 CPU 预取，cache 命中率大幅提升，而内存延迟是 CPU 性能的最大敌人。
3. **数据更小。** 值类型没有对象头、没有引用指针（64 位下每个引用 8 字节、每个托管对象还有对象头），纯数据密度更高。
4. **分组存放。** 组件组合相同的实体住在同一个 **16 KiB chunk** 里（按 archetype 分组），迭代就是在少数几页内存上扫描。

#### 附录：为什么"随机访存"很贵

> 这里的"随机"指**内存地址跳跃**，与随机数无关。

| 访存模式 | 行为 |
|---|---|
| **顺序访存** | 地址连续 → 一次搬进 cache 的数据后面用得上 → 预取器有效 → 几乎不等 |
| **随机访存** | 地址跳跃 → 每次都要跑一趟新地方 → 预取器失效 → **每次都可能 cache miss** |

三个硬件事实：

| 层级 | 典型延迟 | 换算成周期（约 3GHz） |
|---|---|---|
| L1 cache 命中 | ~1 ns | 4 |
| L2 | ~4 ns | 十几 |
| L3 | ~15 ns | 几十 |
| **主存（cache miss）** | **60~100 ns** | **200~300** |

- cache 以 **cache line**（常见 64 字节）为单位搬运：顺序访问时后续数据"搭车"进来；随机访问时那 64 字节里只有几个字节有用，其余全浪费。
- 硬件**预取器**只对连续地址有效，地址一跳就抓瞎。
- 游戏代码里的典型形态是**指针追逐**：`List<Enemy>` 存的是引用，每个引用指向堆上不同位置，遍历一次就是上千次潜在 miss。

> **结论：一次 cache miss ≈ CPU 白等几百个周期。** 内存延迟是"数量级"级别的开销，不是常数——这就是"等内存"会压垮帧率的原因。

> 这一条是所有收益的**地基**：它会放大后面所有优化（Burst 要连续数据才能向量化，多线程要数据分块才能并行）。

### 2.2 批处理：一个 System 处理一整批，而不是逐对象回调

| | 传统 | DOTS |
|---|---|---|
| 执行体 | 每个对象自己的 `Update()` | 每个 System 的 `OnUpdate` |
| 调用次数 | 对象数次虚调用 | 1 次（内部循环批处理） |
| 循环体内容 | 加载脚本状态、分支、可能的装箱 | 纯数据读写 |
| 调度 | 主线程串行 | 可 `ScheduleParallel` 交给 worker |

把"逐对象逻辑"改写成"对一批数据做同一个变换"之后，函数调用、分支预测、指令 cache 的浪费都被摊薄到接近于零。

### 2.3 Burst：把 C# 编译成 SIMD 原生代码

- Burst 把可编译的 C# 子集 **AOT 编译成高度优化的机器码**（不是解释执行，也不是普通 IL2CPP 路径）。
- **自动向量化**：一段处理单个 `float3` 的循环，可能被改写成一条指令处理 4~8 个数据。
- 移除**边界检查、类型检查、装箱、GC 写屏障**等托管开销。
- `Unity.Mathematics` 的 `math.*` 直接映射到硬件指令，避免调用托管数学库。

**量级**：相同算法从托管 C# 换到 Burst 后，常见是**数倍到十几倍**的提升（取决于算法是否可向量化、访存是否密集）。

> 前提：**数据必须连续、类型必须 blittable**。这也是为什么 §2.1 是地基——SoA 布局正是 Burst 高效向量化的前提。

#### 附录：SIMD 是什么

**SIMD = Single Instruction, Multiple Data（单指令多数据）**：**一条指令同时处理多个数据**。相对的是标量（SISD）——一条指令一个数据。

>- 标量：add a0,b0→c0 ；add a1,b1→c1 ；…        共 4 条指令
>- SIMD：把 a0..a3 / b0..b3 各装进一个**宽寄存器**，一条指令算完

| 指令集 | 寄存器宽度 | 一次处理几个 `float` | 平台 |
|---|---|---|---|
| SSE | 128 位 | **4** | x86/x64 |
| AVX | 256 位 | **8** | x86/x64 |
| AVX-512 | 512 位 | **16** | x86/x64（较新） |
| NEON | 128 位 | **4** | ARM（手机 / Apple Silicon） |

**能向量化的前提**：数据连续、元素之间无依赖、没有分支打断（用掩码 / `math.select` 写无分支）——这正是 §2.1 的 SoA 布局要解决的问题。

⚠️ **SIMD ≠ 多线程**：

| | SIMD | 多线程 / Job |
|---|---|---|
| 并行发生在 | **同一个核心内** | **多个核心之间** |
| 比喻 | 还是一个人，**托盘变宽** | **多个人**同时搬 |
| 需要什么 | 数据连续、循环可向量化 | 任务可拆分、数据无冲突 |

两者**正交且可叠加**（每个 worker 线程内部再跑 SIMD 代码）——这是 Burst + Job 能到数量级的原因。

⚠️ **副作用**：不同指令集（SSE / AVX / NEON）的浮点舍入路径可能不同，**跨平台 bit 级一致性会因此破功**。这正是 Burst 的 `FloatMode.Deterministic` 要在 Arm/Neon 上**禁用向量化**的原因——想要确定性，就得放弃 SIMD。

#### 附录：Burst 的产物在哪、怎么验证

Burst 产出的是**原生机器码**，打包成一个独立的原生库（不是 C#，也不是 IL）：

| 场景 | 位置 |
|---|---|
| 编辑器（JIT，按需编译并缓存） | `Library/BurstCache/` |
| 构建时的中间产物 | `Temp/Burst/burst-aot*/lib_burst_generated_part_<hash>.obj`（分片编译，最后链接成一个库） |
| 随包发布 | `<Build>_Data/Plugins/<arch>/lib_burst_generated.dll`（Windows）/ `.so`（Android、Linux）/ `.bundle`（macOS） |

> 这些都在 `Library/`、`Temp/` 或构建目录里，**不属于 `Assets/`，不应进版本控制**。

**想看它到底编出了什么**：`Jobs > Burst > Open Inspector` → 选 assembly / 方法 → 切到 **Assembly 视图**（也可看优化后的 LLVM IR）。有汇编输出 = 编译成功（`float4` 运算会显示成向量指令）；显示未编译时会给出原因（含托管调用、`string`、异常处理等）。

> 别把 Burst 和 IL2CPP 混为一谈：**IL2CPP** 把整个托管程序集转成 C++ 再编进主二进制（产物在构建目录的 `il2cppOutput`）；**Burst** 只处理 `[BurstCompile]` 标记的方法，产出**单独的原生插件库**。两者是两条独立路径。

### 2.4 Job System：让所有核心一起算

- `ScheduleParallel` 把工作**按 chunk 分给多个 worker 线程**（chunk 是天然的并行单元）。
- Job 之间用 `JobHandle` 表达**依赖关系**，框架据此保证读写安全——写错会报"并行冲突"，而不是静默给出错误结果。
- 主线程只负责调度与同步，不再把所有逻辑串行跑完。

**为什么这是刚需**：单核频率早已停滞，性能增长几乎全部来自多核；而"逐个 `Update()`"的模型天然无法利用多核。

### 2.5 零 GC：内存自己管

- 数据放在 `NativeArray` / `NativeList` / `UnsafeList` 等**非托管容器**中，由代码显式分配与释放（`Allocator`），不经过 GC。
- 避免了"一帧内 new 出几千个对象"导致的 GC 尖峰：**帧时间更平稳**。
- 与之配套的是结构体化设计（`IComponentData` 必须是非托管 struct），从源头消除了大量小对象分配。

---

## 3. 一个量化直觉

> **场景**：1 万个对象，每帧各读一次自己的位置（`float3`，12 字节）。
>
> | | 传统（托管对象数组） | DOTS（SoA 连续数组） |
> |---|---|---|
> | 内存布局 | 1 万个位置各在堆的某处，中间夹着其它字段 | 连续 120 KB |
> | 每次访问 | 大概率 cache miss，一次随机访存是数十到上百纳秒 | 顺序流式加载，几乎全命中 |
> | 数据量 | 每个对象还带对象头（16 字节级）与引用字段 | 只有 12 字节/实体 |
> | 能否 SIMD | 不能（数据不连续） | 可以，一次算多个 |
> | 能否多线程 | 要自己小心地改（对象图共享） | 天然按 chunk 并行 |
>
> 差别不在"常数因子"，而在**"等内存" vs "算数据"**这一根本性质的差别；再叠加 SIMD 与多核，就是数量级。

**开销来源对照**

| 开销 | 传统 | DOTS |
|---|---|---|
| 每次数据访问 | 随机访存（可能 miss） | 顺序访存（高命中） |
| 每次逻辑执行 | 虚调用 + 分支 | 紧循环，可向量化 |
| 每帧分配 | 托管分配 → GC | 无（Native 容器复用） |
| 并行 | 主线程串行 | 按 chunk 多核并行 |

---

## 4. 代价与边界

**DOTS 不是"免费加速器"——它是一套以限制换性能的框架。**

| 代价 | 说明 |
|---|---|
| 思维模型不同 | 数据与行为分离；不能随手 `new` 托管对象；逻辑要改写成"对一批数据做同一个变换" |
| **结构性变更昂贵** | 增删组件会让实体在 chunk 间搬迁（memcpy）；应改用可启用组件（`IEnableableComponent`）做开关 |
| 调试更难 | 数据分散在组件里；Job 内调试受限；执行顺序靠声明（`[UpdateInGroup]`/`[UpdateBefore]`） |
| 生态/互操作成本 | 与 MonoBehaviour、UI、Unity 对象交互需要显式的桥接层 |
| 确定性并非免费 | 跨平台的浮点确定性需要额外约束（定点数、串行化），不是开箱即得 |

### 什么时候**不该**用

| 场景 | 原因 |
|---|---|
| 对象只有几十个、逻辑各不相同 | 收益为负：DOTS 的固定开销（chunk 分配、系统调度）大于节省的 cache 收益 |
| 复杂单实例逻辑（管理器、状态机、存档） | 托管状态、`Dictionary`、Unity 对象天然更合适 |
| UI / 编辑器工具 / 工具链 | 与 Unity 生态耦合紧密，ECS 化得不偿失 |
| 需要大量托管对象引用（`Material`、`Mesh`、`GameObject`） | 只能放进共享组件或托管组件，等于放弃 Burst |

### 现实中的架构：混合

> 主流做法是**分层**而不是全盘 ECS：
>
> ```
> ECS 层     ：每帧要算上万次的模拟（移动、索敌、战斗结算、空间查询）
> 桥接层     ：一次批量回写（把 ECS 的位置/朝向写回 GameObject 的 Transform）
> 表现层     ：GameObject / MonoBehaviour / 渲染 / UI / 摄像机 / 音频
> 业务层     ：流程、状态、存档（托管代码保持简单）
> ```
>
> 判定标准很简单：**"这段逻辑一帧要被处理多少次？"** 上万次 → 放 ECS；几十次 → 留在 MonoBehaviour。

---

## 5. 常见误解

**Q1：DOTS 就是 ECS 吗？**
不是。DOTS 是技术栈（ECS + Job System + Burst + Mathematics/Collections）；ECS 只是其中管数据组织与执行模型的一层。三者可以分开使用。

**Q2：用了 DOTS 就一定快吗？**
不一定。数据布局没写对（组件太大、archetype 太多、频繁结构性变更）时，可能比 MonoBehaviour 还慢。DOTS 提供的是**性能上限**，不是自动保证。

**Q3：能不能只用 Burst + Job，不上 ECS？**
可以，而且是常见做法。把开销大的批处理（数组运算、纹理生成、寻路预处理）单独抽成 Burst Job，其余保持 MonoBehaviour，收益/成本比往往更高。

**Q4：为什么我的实体只有 100 个，反而更慢？**
因为 DOTS 有固定开销（chunk 分配、系统调度、Job 调度、依赖管理），而 100 个对象的 cache 浪费微乎其微。**规模不够时，瓶颈不是内存，而是调度本身。**

**Q5：DOTS 能替代 MonoBehaviour 吗？**
不能，也不该。UI、编辑器工具、Unity 对象生命周期、复杂的单实例业务逻辑，用 MonoBehaviour 更直接。混合架构才是常规形态。

**Q6：Burst 什么都能编译吗？**
不是。只能编译 C# 的一个**子集**：不能有托管类型、`class`、`string`、异常、`try/catch`、大多数 BCL 调用。用托管数据换性能时，注定要放弃 Burst。

**Q7：DOTS 快，是不是因为"多线程"？**
多线程只是其中之一。即使**单线程**跑，SoA 布局 + Burst 也能带来明显提升（省的是访存与指令开销）。两者叠加才构成数量级。

**Q8：SIMD 就是多线程吗？**
不是。SIMD 是"**一个核心内**用一条指令处理多个数据"（托盘变宽），多线程是"**多个核心**各干一份"（多个人）。两者正交，可叠加。

**Q9：Burst 编译出的代码在哪里？**
编辑器缓存在 `Library/BurstCache/`，构建中间产物在 `Temp/Burst/burst-aot*/`，最终链接成 Player 的 `lib_burst_generated.dll/.so/.bundle`。想看编译结果用 `Jobs > Burst > Open Inspector` 的 Assembly 视图（详见 §2.3 附录）。

---

## 6. 速查表

**性能收益的来源**

| 来源 | 一句话 | 前提 |
|---|---|---|
| 数据连续（SoA + chunk） | 少等内存 | 组件设计要精简、archetype 要少 |
| 批处理 | 减少调用与分支 | 逻辑要能表达成"对一批做同一变换" |
| Burst + SIMD | 一条指令算多个 | 数据连续 + 类型 blittable |
| Job 多核 | 所有核心一起算 | 任务能按 chunk 切分 |
| 零 GC | 帧时间平稳 | 只用 Native 容器 |

**技术栈职责**

| 部件 | 职责 | 关键 API |
|---|---|---|
| ECS | 数据组织与执行模型 | `IComponentData`、`SystemBase`/`ISystem`、`EntityQuery` |
| Job System | 并行与依赖 | `IJobEntity`、`ScheduleParallel`、`JobHandle` |
| Burst | 原生代码 + SIMD | `[BurstCompile]`、`math.*` |
| Collections | 非托管容器 | `NativeArray`/`NativeList`/`NativeParallelHashMap` |

**该不该用**

| 判断 | 结论 |
|---|---|
| 每帧处理上万次、逻辑同质 | ✅ 用 ECS |
| 只有批处理是热点（几十~几千个数据项） | ✅ 用 Burst + Job（可不上 ECS） |
| 对象几十个、逻辑各异 | ❌ 留在 MonoBehaviour |
| UI / 编辑器 / 复杂单实例业务 | ❌ 留在 MonoBehaviour |

**底层概念与工具**

| 术语 / 工具 | 一句话 |
|---|---|
| 顺序访存 | 地址连续 → 预取有效 → 高命中（`§2.1`附录） |
| 随机访存 | 地址跳跃 → 预取失效 → 每次可能 miss，一次 miss 约 200~300 周期 |
| cache line | cache 的最小搬运单位（常见 64 字节），随机访存时利用率极低 |
| 指针追逐 | 跟着引用/指针一路乱跳的访问模式（传统对象数组的典型代价） |
| SIMD | 一条指令处理多个数据；SSE/NEON=4、AVX=8、AVX-512=16 个 float |
| SIMD vs 多线程 | "托盘变宽" vs "多个人"——正交，可叠加 |
| Burst 产物 | `Library/BurstCache/`（编辑器）· `Temp/Burst/`（构建中间）· `lib_burst_generated.*`（打包） |
| 查看 Burst 汇编 | `Jobs > Burst > Open Inspector` → Assembly 视图 |

---

## 附录：官方文档链接

| 主题 | 链接 |
|---|---|
| `Entities` 包手册（1.0） | [entities](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/index.html) |
| `ECS` 工作流总览 | [ecs-workflows](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/ecs-workflows.html) |
| `ISystem`（非托管、可 Burst） | [systems-isystem](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-isystem.html) |
| `SystemBase`（托管） | [systems-systembase](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-systembase.html) |
| `IJobEntity`（迭代与并行） | [iterating-data-ijobentity](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/iterating-data-ijobentity.html) |
| `IJobChunk` | [iterating-data-ijobchunk](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/iterating-data-ijobchunk.html) | 
| `ComponentLookup<T>` / `BufferLookup<T>` | [API: ComponentLookup&lt;T&gt;](https://docs.unity3d.com/Packages/com.unity.entities@1.0/api/Unity.Entities.ComponentLookup-1.html) | 
| `EntityCommandBuffer`（结构性变更） | [systems-entity-command-buffers](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-entity-command-buffers.html) · [自动回放与释放](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-entity-command-buffer-automatic-playback.html) | 
| `IEnableableComponent`（零结构变更开关） | [components-enableable-use](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/components-enableable-use.html) |
| Archetypes 概念（chunk 列式布局） | [archetypes](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/concepts-archetypes.html) |
| chunk 分配（16KB、碎片化） | [chunk](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/performance-chunk-allocations.html) | 
| Baking / Baker | [baking-overview](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/baking-overview.html) · [baking-baker-overview](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/baking-baker-overview.html) |
| Blob Asset（不可变共享数据） | [blob-assets-intro](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/blob-assets-intro.html) |
| Transform 桥接 | [transforms-intro](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/transforms-intro.html) | 
| Entities Graphics 手册 | [entities.graphics@1.0](https://docs.unity3d.com/Packages/com.unity.entities.graphics@1.0/manual/index.html) | 
| Unity Physics 手册 | [physics@1.0](https://docs.unity3d.com/Packages/com.unity.physics@1.0/manual/index.html) | 
| Burst 手册 | [burst](https://docs.unity3d.com/Packages/com.unity.burst@1.8/manual/index.html) |
| Burst：浮点精度与确定性 | [float-precision-determinism](https://docs.unity3d.com/6000.6/Documentation/Manual/burst/float-precision-determinism.html) |
| Collections 手册 | [collections](https://docs.unity3d.com/Packages/com.unity.collections@2.1/manual/index.html) |
| Mathematics 手册 | [mathematics](https://docs.unity3d.com/Packages/com.unity.mathematics@1.3/manual/index.html) |
| 官方示例仓库（Entities 101 / HelloCube） | [EntityComponentSystemSamples](https://github.com/Unity-Technologies/EntityComponentSystemSamples) |

> 中文镜像：把 `docs.unity3d.com` 换成 `docs.unity.cn` 即可。
