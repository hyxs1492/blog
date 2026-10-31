---
title: 'Unity DOTS —— 性能原理技术文档'
description: '从一次内存访问讲起，一层层拆开 DOTS 为什么快，以及什么时候它并不值得用。'
pubDate: '2026-01-15'
category: 'Unity DOTS'
tags: ['Unity', 'DOTS', 'ECS', '性能', 'Burst', 'SIMD', 'Job System']
---

> 主题：**DOTS 为什么快**——从一次内存访问讲起，一层层拆开性能的来源，并说清每层"省掉的到底是哪笔开销"。
> 适用版本：Unity Entities 1.0+ / Burst 1.8+ / Collections 2.x（本文按 Entities 1.0.16 的行为描述）。
> 阅读方式：想先建立直觉看 §1；想理解原理顺着 §2 往下读；想判断"该不该用"看 §1.4 与 §5；文末有速查表。
> 全文的性能数字都是**硬件常识与量级推导**，不是某个项目的实测结果——你可以拿自己的机器验证。

---

## 速览

- **程序慢往往不是"算得慢"，而是"等得久"。** CPU 一次运算只要不到 1 纳秒，但去主存取一次数据要 60~100 纳秒——中间差了 200 多倍。数据放得散，CPU 大部分时间就在干等。
- **DOTS 快的根本原因是数据放得整齐**：同一种组件连续排在一起，遍历时是"顺着内存往下走"，而不是"跳到内存各处去捡"。这一步是所有其它优化的地基。
- **地基之上再叠三层**：一段代码处理一整批（省掉成千上万次函数调用）、Burst 把 C# 编成能用宽寄存器的机器码（一条指令算 4~8 个 float）、Job System 把批次分给多个核心（多核一起算）。
- **顺手干掉了 GC。** 数据放在非托管容器里自己管，不再有"一帧 new 出几千个对象 → 突然卡一下"的帧时间尖峰。
- **但它是有代价的**：结构性变更贵、调试更难、代码要改成数据导向的写法。**对象只有几十个、逻辑各不相同的时候，用它反而更慢。**

---

## 1. 先建立直觉：慢在哪

### 1.1 一次内存访问有多贵

现代 CPU 的算术快得离谱，慢的是"把数据送过来"（下表按约 3GHz 主频换算成 CPU 周期）：

| 数据在哪 | 典型延迟 | 换算成周期 |
|---|---|---|
| L1 cache（一级缓存） | ~1 ns | 约 4 |
| L2 cache | ~4 ns | 十几 |
| L3 cache | ~15 ns | 几十 |
| **主存（cache miss）** | **60~100 ns** | **200~300** |

**一次 cache miss ≈ CPU 白等几百个周期。** 在这几百个周期里它本可以完成上千次加法。所以当数据访问方式不当时，性能瓶颈就从"算"变成了"等"——而这是**数量级**级别的差距，不是常数倍。

### 1.2 为什么"跳着访问"特别贵

CPU 不是一次只搬一个字节，它按 **cache line（缓存行）** 为单位搬，常见是 **64 字节**。同时它还会**预取**：看到你在顺序往下读，就提前把后面几行也拉进来。

| 访问模式 | 会发生什么 |
|---|---|
| **顺序访问** | 地址连续 → 一次搬进来的 64 字节后面全都用得上 → 预取器有效 → 几乎不用等 |
| **随机访问** | 地址跳跃 → 每次都得跑一趟新地方 → 预取器失效 → **每次都可能 miss**，而且那 64 字节里可能只有几个字节有用 |

游戏里最典型的坏模式叫**指针追逐**：`List<Enemy>` 里存的是引用，每个引用指向堆上完全不同的位置，遍历一次就是上千次潜在 miss。

### 1.3 传统 GameObject 写法为什么天然是"跳着访问"

把 1000 个敌人写成 1000 个 `MonoBehaviour`，每个对象在托管堆上都是**独立的一块内存**（位置由堆分配决定，彼此不相邻），里面塞着它所有的字段，前面还带对象头、还夹着引用指针。

```text
[敌人A: x|y|z|速度|血量|名字引用|材质引用|…][敌人B: x|y|z|速度|…][敌人C: …]
```

你想只读 `x` 字段，但为了读到它，得先跳到对象 A 那块内存（大概率 miss），处理完再跳到对象 B 那块（又 miss）……**你真正需要的 4 个字节，被裹在一大块用不到的数据里，还要为找到它付一次完整的访存代价。**

### 1.4 除此之外的三笔开销

| 开销 | 具体表现 |
|---|---|
| **逐个回调** | 每个对象一次 `Update()`：虚函数调用 + 重复进入同一段代码 + 分支预测失效 |
| **托管分配** | `List`、`new`、闭包、装箱 → GC 分代回收 → **帧时间尖峰**（平均帧率还行，体感却卡） |
| **主线程串行** | 逻辑全排在一个线程里，其它核心闲着 |

把四条合起来看：对象数量一上去，帧率往往不是"慢慢变差"，而是**断崖式下跌**——因为瓶颈从"算"变成了"等内存"。

---

## 2. 为什么快：一层一层拆

### 2.1 地基：把 AoS 换成 SoA

这是全部收益的起点。看两种布局的差别：

```text
传统（AoS：Array of Structures，结构体数组）
  [对象A: pos|vel|hp|name|…][对象B: pos|vel|hp|name|…][对象C: …]
   ↑ 每个对象一整块，包含它的全部字段

ECS（SoA：Structure of Arrays，数组的结构）
  pos : [A][B][C][D] …     ← 一条独立的连续数组
  vel : [A][B][C][D] …     ← 另一条
  hp  : [A][B][C][D] …     ← 再一条
   ↑ 每种组件一条数组；同一个索引 i 上的各项才凑成"第 i 个实体"
```

**它到底省掉了什么：**

1. **用不到的字段不再占用 cache 带宽。** 只算 `pos` 时，`name`、`mesh` 引用这些字段完全不进缓存。
2. **访问变成顺序的。** 顺序访问让预取器生效、缓存命中率大幅上升，直接消灭 §1.1 里那"等几百个周期"的开销。
3. **数据本身更小。** 值类型没有对象头、没有引用指针（64 位下每个引用 8 字节，每个托管对象还带对象头），同样的信息占更少内存，一次能放进 cache 的实体就更多。
4. **同构的实体住在一起。** 组件组合完全相同的实体被归到同一个 **archetype（原型）**，共享同一批 **chunk**（默认 16 KiB 一块）。遍历就是在少数几页内存上顺序扫描。

```csharp
// 两个纯数据组件：SoA 布局的最小例子
public struct Position : IComponentData { public float3 Value; }
public struct Velocity : IComponentData { public float3 Value; }

[BurstCompile]
public partial struct MoveSystem : ISystem
{
    [BurstCompile]
    public void OnUpdate(ref SystemState state)
    {
        float dt = SystemAPI.Time.DeltaTime;
        // 遍历时 pos 与 vel 各自都是连续内存，循环体里没有指针追逐
        foreach (var (pos, vel) in SystemAPI.Query<RefRW<Position>, RefRO<Velocity>>())
            pos.ValueRW.Value += vel.ValueRO.Value * dt;
    }
}
```

**这一条是地基，因为它会放大后面所有优化**：Burst 要有连续数据才能向量化，多线程要能把数据干净地分块才能并行。布局不对，后面三层全都用不上。

### 2.2 批处理：一次调用处理一整批

| | 传统写法 | DOTS |
|---|---|---|
| 执行体 | 每个对象自己的 `Update()` | 每个系统的 `OnUpdate` |
| 调用次数 | 对象数次虚调用 | **1 次**（内部循环批处理） |
| 循环体内容 | 加载脚本状态、判断分支、可能的装箱 | 纯数据读写 |
| 调度 | 主线程串行 | 可以 `ScheduleParallel` 交给 worker 线程 |

这一层省掉的是一堆**每次都要付的小钱**：函数调用开销、分支预测失败、指令缓存被反复冲刷。把"逐对象逻辑"改写成"对一批数据做同一个变换"之后，这些开销被摊薄到接近于零。

写起来也很直接——用 `IJobEntity` 把"对每个实体做的变换"写成 job，一行调度就交给框架：

```csharp
[BurstCompile]
public partial struct MoveJob : IJobEntity
{
    public float DeltaTime;
    void Execute(ref Position pos, in Velocity vel) => pos.Value += vel.Value * DeltaTime;
}

public partial struct MoveSystem : ISystem
{
    public void OnUpdate(ref SystemState state)
        => new MoveJob { DeltaTime = SystemAPI.Time.DeltaTime }
            .ScheduleParallel(state.Dependency);   // 框架自动按 chunk 切开，主线程不等结果
}
```

### 2.3 Burst + SIMD：让一条指令算好几个数据

- Burst 把可编译的那部分 C# **提前编译成高度优化的机器码**，不是解释执行，也不走普通 IL 的路径。
- 它会做**自动向量化**：一段"逐个处理 `float3`"的循环，可能被改写成一条指令同时算 4~8 个数据。
- 同时**移除边界检查、类型检查、装箱、GC 写屏障**这些托管开销。
- `Unity.Mathematics` 的 `math.*` 直接映射到硬件指令，不再调托管数学库。

**量级感受：** 同一段算法，从普通托管 C# 换到 Burst，常见是**数倍到十几倍**的提升——具体多少取决于算法能不能被向量化、是不是访存密集。这个区间之所以这么宽，是因为 Burst 的收益几乎全部来自"数据连续 + 无分支"，这两点恰好是 §2.1 的地基提供的。

#### 附：SIMD 到底是什么

**SIMD = Single Instruction, Multiple Data（单指令多数据）**：一条指令同时处理多个数据。与之相对的是标量（一条指令一个数据）。

```text
标量： add a0,b0→c0 ; add a1,b1→c1 ; add a2,b2→c2 ; add a3,b3→c3   共 4 条指令
SIMD： 把 a0..a3 和 b0..b3 各装进一个宽寄存器，一条指令全部算完
```

| 指令集 | 寄存器宽度 | 一次处理几个 `float` | 常见平台 |
|---|---|---|---|
| SSE / NEON | 128 位 | **4** | x86/x64 / ARM（手机、Apple Silicon） |
| AVX | 256 位 | **8** | x86/x64 |
| AVX-512 | 512 位 | **16** | x86/x64（较新） |

**能向量化的前提**：数据连续、元素之间没有依赖、循环里没有会打断流程的分支（需要判断时用掩码或 `math.select` 写成无分支形式）——又回到 SoA 布局。**SIMD 不是多线程**：SIMD 是"同一个核心内，一个人把托盘变宽"，多线程是"多个核心，多叫几个人一起搬"，两者正交且可以叠加——每个 worker 线程内部再跑 SIMD 代码，这才是 Burst + Job 能到数量级的原因。

⚠️ **一个副作用**：不同指令集的浮点舍入路径可能不同，**跨平台的 bit 级一致性会因此破功**。Burst 为此提供了 `FloatMode.Deterministic`（按官方 API 注释：**仅 64 位平台**支持）；要做帧同步 / 回放这类依赖逐位一致的计算，就得显式选它——代价是放弃一部分浮点优化。默认的 `FloatMode` 相当于 `Strict`，而 `Fast` 会引入"代数等价但结果不同"的变换（重排、倒数代替除法、融合乘加），**不要在需要复现的地方用它**。

#### 附：Burst 编译出的东西在哪

Burst 的产物是**原生机器码**，打包成一个独立的原生库。编辑器里的按需编译缓存放在 `Library/BurstCache/`，构建中间产物在 `Temp/Burst/burst-aot*/lib_burst_generated_part_<hash>.obj`（分片编译，最后链接成一个库），随包发布时变成 `<Build>_Data/Plugins/<arch>/lib_burst_generated.dll`（Windows）/ `.so`（Android、Linux）/ `.bundle`（macOS）。这些都在 `Library/`、`Temp/` 或构建目录里，不在 `Assets/` 下，**不应该进版本控制**。

**想看它到底编出了什么**：`Jobs > Burst > Open Inspector` → 选 assembly / 方法 → 切到 **Assembly 视图**（也可以看优化后的 LLVM IR）。能看到汇编就说明编译成功了（`float4` 运算会显示成向量指令）；显示未编译时会给出原因（比如调用了托管方法、用了 `string`、有异常处理）。

> 别把 Burst 和 IL2CPP 混起来：**IL2CPP** 是把整个托管程序集转成 C++ 再编进主二进制；**Burst** 只处理标了 `[BurstCompile]` 的方法，产出**单独的原生插件库**。两条独立路径。

### 2.4 Job System：让所有核心一起算

- `ScheduleParallel` 把工作**按 chunk 分给多个 worker 线程**——chunk 是天然的并行单元，不需要你自己切割数据。
- Job 之间用 `JobHandle` 表达**依赖关系**，框架据此保证读写安全。写错了会明确报"并行冲突"，而不是安静地给出错误结果。
- 主线程只负责调度和最后的同步，不再把所有逻辑串行跑完。

**为什么这是刚需：** 单核频率早已停止增长，这些年性能的提升几乎全部来自"核变多"。而"每个对象一个 `Update()`"的模型天然没办法利用多核——你没法把一个对象拆到两个核上跑。批量化的数据才拆得开。

这一层省掉的是**时间**：本来要 8 秒的循环，分给 8 个核心理论上 1 秒出结果（实际会有调度、同步、内存带宽的损耗，拿不到满额）。

### 2.5 零 GC：内存自己管

- 数据放在 `NativeArray` / `NativeList` / `UnsafeList` 等**非托管容器**里，由代码显式分配释放（`Allocator` 决定生命周期），完全不经过 GC。
- 于是"一帧内 new 出几千个对象 → 若干帧后 GC 来收 → 画面卡一下"这种**帧时间尖峰**消失了。
- 配套的是结构体化设计：`IComponentData` 必须是非托管 struct，从源头就消灭了大量小对象分配。

这一层省掉的是**抖动**，不是平均耗时。玩家的体感对"99% 的帧很快、1% 的帧很慢"非常敏感——这正是 GC 尖峰的杀伤方式。

```csharp
// 显式管理生命周期：Temp 给本次 OnUpdate 用，Persistent 存活到手动 Dispose
var temp = new NativeArray<float3>(16, Allocator.Temp);          // 函数返回时自动回收
var cache = new NativeArray<int>(256, Allocator.Persistent);     // 必须自己 Dispose
// … 用完以后 …
cache.Dispose();
```

---

## 3. 一个可手算的量化直觉

不引用任何实测数据，只用上面的常识推一遍。

> **设定**：场上 1 万个对象，每帧各读一次自己的位置（`float3`，12 字节），然后写回去。
>
> **传统写法（托管对象数组）**：每个对象的位置散落在堆上某处，你跟着 1 万个引用一路跳。即使只有 10% 的访问真的 miss，那也是 1000 次 miss，每次按 200 个周期算 → **约 20 万个周期**纯粹在等内存。另外每个对象还额外背着对象头与引用字段，数据密度低；数据不连续 → 不能向量化，对象图互相引用 → 想并行得自己小心改。
>
> **DOTS 写法（SoA 连续数组）**：1 万个位置就是连续的一块 120 KB 内存。顺序流式读取，cache line 的 64 字节每次几乎都被用满（64 / 12 ≈ 一次拉进 5 个实体的位置），预取器全程有效，miss 数量大幅下降。每个实体只占 12 字节、没有对象头；数据连续 → 能向量化（一次算 4~8 个），按 chunk 切分 → 能直接多核并行。

差别不在"常数因子"，而在**"等内存"变成"算数据"**这一根本性质的变化；再叠加 SIMD 与多核，才构成数量级。

**开销来源对照表**

| 开销 | 传统写法 | DOTS |
|---|---|---|
| 每次数据访问 | 随机访存（可能 miss，等几百周期） | 顺序访存（高命中，预取有效） |
| 每次逻辑执行 | 虚调用 + 分支 | 紧循环，可向量化 |
| 每帧分配 | 托管分配 → GC 尖峰 | 无（Native 容器复用） |
| 并行 | 主线程串行 | 按 chunk 多核并行 |

---

## 4. DOTS 不只是一个东西

"DOTS"（Data-Oriented Technology Stack，数据导向技术栈）是**一套可以拆开用的技术栈**，包含四个部件：

| 部件 | 包 | 职责 |
|---|---|---|
| **ECS** | `com.unity.entities` | 数据的组织（Entity / Component / Chunk）与执行模型（System / SystemGroup） |
| **Job System** | 引擎内置 | 安全的多线程调度与依赖管理 |
| **Burst** | `com.unity.burst` | 把 C# 子集编译成带 SIMD 的原生代码 |
| **数学与容器** | `com.unity.mathematics`、`com.unity.collections` | SIMD 友好的类型（`float3` / `quaternion`）与非托管容器 |

辅助层还有 `com.unity.entities.graphics`（实例化渲染）和 `com.unity.physics`（无状态物理）。

> ⚠️ **DOTS ≠ ECS。** 你完全可以只用 Burst + Job，不上 ECS——比如把一段开销大的批处理（数组运算、程序化纹理生成、路径预处理）单独剥出来做成 Burst Job，其余代码保持 MonoBehaviour。这种"局部 DOTS"往往性价比最高。

---

## 5. 代价与边界

**DOTS 不是免费加速器，它是一套"用限制换性能"的框架。**

| 代价 | 说明 |
|---|---|
| 思维模型不同 | 数据与行为分离；不能随手 `new` 托管对象；逻辑要改写成"对一批数据做同一个变换" |
| **结构性变更昂贵** | 增删组件会让实体在 chunk 之间搬家（memcpy）。需要频繁开关时，改用可启用组件 `IEnableableComponent`，它只翻转一个 bit，不移动数据 |
| 调试更难 | 数据分散在各种组件里；Job 内部调试受限；执行顺序靠声明（`[UpdateInGroup]` / `[UpdateBefore]`）而不是"看代码从上往下读" |
| 互操作有成本 | 和 MonoBehaviour、UI、Unity 对象打交道需要显式的桥接层 |
| 确定性不免费 | 跨平台的浮点确定性需要额外约束（定点数、串行化），不是开箱即得 |

### 什么时候**不该**用

| 场景 | 为什么 |
|---|---|
| 对象只有几十个、逻辑各不相同 | 收益为负：chunk 分配、系统调度这些**固定开销**大于省下的 cache 收益 |
| 复杂单实例逻辑（管理器、状态机、存档） | 托管状态、`Dictionary`、Unity 对象天然更合适 |
| UI / 编辑器工具 / 工具链 | 与 Unity 生态耦合紧密，ECS 化得不偿失 |
| 需要大量托管对象引用（`Material`、`Mesh`、`GameObject`） | 只能塞进共享组件或托管组件，等于放弃 Burst |

### 现实中的架构：混合

> 主流做法是**分层**，而不是全盘 ECS：
>
> ```text
> ECS 层  ：每帧要算上万次的模拟（移动、索敌、战斗结算、空间查询）
> 桥接层  ：一次批量回写（把 ECS 的位置 / 朝向写回 GameObject 的 Transform）
> 表现层  ：GameObject / MonoBehaviour / 渲染 / UI / 摄像机 / 音频
> 业务层  ：流程、状态、存档（托管代码保持简单）
> ```
>
> 判定标准只有一句：**"这段逻辑一帧要被处理多少次？"** 上万次 → 放 ECS；几十次 → 留在 MonoBehaviour。

---

## 6. 常见误解

**Q1：DOTS 就是 ECS 吗？**
不是。DOTS 是技术栈（ECS + Job System + Burst + Mathematics/Collections），ECS 只是其中管数据组织与执行模型的一层。四个部件可以分开使用。

**Q2：用了 DOTS 就一定快吗？**
不一定。数据布局没写对（组件太大、archetype 太多、频繁结构性变更）时，可能比 MonoBehaviour 还慢。DOTS 提供的是**性能上限**，不是自动保证。

**Q3：能不能只用 Burst + Job，不上 ECS？**
可以，而且很常见。把开销大的批处理单独抽成 Burst Job，其余保持 MonoBehaviour，收益/成本比往往更高。

**Q4：为什么我的实体只有 100 个，反而更慢？**
因为 DOTS 有固定开销（chunk 分配、系统调度、Job 调度、依赖管理），而 100 个对象的 cache 浪费微乎其微。**规模不够时，瓶颈不是内存，而是调度本身。**

**Q5：DOTS 能替代 MonoBehaviour 吗？**
不能，也不该。UI、编辑器工具、Unity 对象生命周期、复杂单实例业务逻辑，用 MonoBehaviour 更直接。混合架构才是常态。

**Q6：Burst 什么都能编译吗？**
不是。它只能编译 C# 的一个**子集**：不能有托管类型、`class`、`string`、异常、`try/catch`，以及大多数 BCL 调用。用托管数据换性能时，注定要放弃 Burst。

**Q7：DOTS 快，是不是全靠多线程？**
不是。即使**单线程**跑，SoA 布局 + Burst 也能带来明显提升（省的是访存与指令开销）。多线程是叠加在上面的一层。

**Q8：SIMD 就是多线程吗？**
不是。SIMD 是"一个核心内用一条指令处理多个数据"（托盘变宽），多线程是"多个核心各干一份"（多个人）。两者正交，可以叠加。

**Q9：Burst 编译出的代码在哪里？**
编辑器缓存在 `Library/BurstCache/`，构建中间产物在 `Temp/Burst/burst-aot*/`，最终链接成 Player 的 `lib_burst_generated.dll/.so/.bundle`。想看编译结果用 `Jobs > Burst > Open Inspector` 的 Assembly 视图。

**Q10：为什么"数据布局"被反复强调？**
因为它是地基：Burst 要连续数据才能向量化，Job 要分块数据才能并行，cache 要顺序访问才能命中。布局错了，上面三层优化全都用不上。

---

## 7. 速查表

**性能收益的来源（每一层省掉什么）**

| 来源 | 省掉的开销 | 前提 |
|---|---|---|
| 数据连续（SoA + chunk） | 等内存（cache miss、预取失效） | 组件设计精简、archetype 少 |
| 批处理 | 逐对象的调用、分支、指令缓存冲刷 | 逻辑能表达成"对一批做同一变换" |
| Burst + SIMD | 单次指令的吞吐（一条算 4~8 个） | 数据连续 + 类型 blittable |
| Job 多核 | 单线程串行的时间 | 任务能按 chunk 切分 |
| 零 GC | 帧时间尖峰（抖动） | 只用 Native 容器 |

**技术栈职责**

| 部件 | 职责 | 关键 API |
|---|---|---|
| ECS | 数据组织与执行模型 | `IComponentData`、`ISystem` / `SystemBase`、`EntityQuery` |
| Job System | 并行与依赖 | `IJobEntity`、`ScheduleParallel`、`JobHandle` |
| Burst | 原生代码 + SIMD | `[BurstCompile]`、`math.*` |
| Collections | 非托管容器 | `NativeArray` / `NativeList` / `NativeParallelHashMap` |

**该不该用**

| 判断 | 结论 |
|---|---|
| 每帧处理上万次、逻辑同质 | ✅ 用 ECS |
| 只有批处理是热点（几十~几千个数据项） | ✅ 用 Burst + Job，可以不上 ECS |
| 对象几十个、逻辑各异 | ❌ 留在 MonoBehaviour |
| UI / 编辑器 / 复杂单实例业务 | ❌ 留在 MonoBehaviour |

**底层概念与工具**

| 术语 / 工具 | 一句话 |
|---|---|
| 顺序访存 | 地址连续 → 预取有效 → 高命中 |
| 随机访存 | 地址跳跃 → 预取失效 → 每次可能 miss，一次约 200~300 周期 |
| cache line | cache 的最小搬运单位（常见 64 字节）；随机访存时利用率极低 |
| 指针追逐 | 跟着引用一路乱跳的访问模式，传统对象数组的典型代价 |
| archetype / chunk | 组件组合相同的实体归入同一 archetype，共享同一批 chunk（默认 16 KiB） |
| SIMD | 一条指令处理多个数据；SSE / NEON = 4、AVX = 8、AVX-512 = 16 个 `float` |
| SIMD vs 多线程 | "托盘变宽" vs "多叫几个人"——正交，可叠加 |
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
