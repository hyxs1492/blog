---
title: '一条 GPU 流水线读透 ShaderLab：从 Pass 声明到像素写入'
description: '按"一个像素是怎么画出来的"顺序重新组织 ShaderLab 与 URP 知识：Shader/SubShader/Pass 怎么编译、Pass 何时被选中、排到什么顺序、状态机设了哪些状态、顶点与片元怎么写、ZTest/ZWrite/Blend 各在哪一级生效、关键字与批处理又把什么挪到了 CPU 侧'
pubDate: '2026-01-07'
category: 'Unity 渲染'
tags: ['Unity', 'URP', 'ShaderLab', 'Blend', '深度测试', '关键字', 'SRP Batcher']
---

## 怎么读这篇

这篇只回答一个问题：**一个物体被画到屏幕上，中间到底发生了什么，而 shader 里的每一行又落在哪一步。**

所以顺序不是按"知识点分类"排的，而是按**运行时顺序**排的：

```text
 ①  你写下 Shader / SubShader / Pass          ← 第 1 章：这是"编译与声明"
      ↓ 编译
 ②  管线在某个渲染阶段按 LightMode 挑中你的 Pass  ← 第 2 章：Pass 何时被用
      ↓ 提交
 ③  这批东西排到什么顺序画                     ← 第 3 章：谁先谁后
      ↓ 设置状态
 ④  GPU 状态机被设成什么样（ZTest/Cull/Blend…）  ← 第 4 章：状态机
      ↓ 顶点
 ⑤  顶点着色器：坐标从哪来、到哪去               ← 第 5 章：顶点阶段
      ↓ 光栅化
 ⑥  三角形变成片元，early-Z 在这里做剔除         ← 第 6 章：光栅化
      ↓ 片元
 ⑦  片元着色器：采样、光照、clip                 ← 第 7 章：片元阶段
      ↓ 输出合并
 ⑧  ZTest → ZWrite → Blend，写出最终像素         ← 第 8 章：输出合并
      ↓
 ⑨  下一帧：这些东西有多少在 CPU 侧做完了        ← 第 9 章：关键字与批处理
```

**为什么要按这个顺序**：因为很多概念只有放回它在流水线上的位置才好理解。比如：

- `Blend` 为什么"不能修遮挡"——因为它发生在流程的最后一级（⑧），而遮挡在⑥就已经判完了；
- `clip` 为什么有性能代价——因为它在⑦，而 early-Z 的优化在⑥；
- 关键字为什么不能逐对象变——因为它在①的编译期就被展开成不同程序了。

每一章都会明确标出"**你现在在流程的第几步**"。代码片段都是通用写法，可以直接抄进自己的 shader 跑。

---

# 第 1 章（流程①）：Shader / SubShader / Pass 是怎么变成 GPU 程序的

## 1.1 三层结构的各自职责

**位置**：这是"你写的东西"和"GPU 拿到的东西"之间的编译层。理解它才能理解后面所有"为什么这样写"。

一个 `.shader` 文本的层级是：

```text
Shader "Example/Lit"
├── Properties                ← 材质面板的字段与默认值（元数据）
├── SubShader                 ← 一组针对"某类硬件/管线"的 Pass；按顺序取第一个可用的
│    ├── Tags / RenderState   ← 队列、剔除、混合等默认状态
│    ├── Pass 1               ← 一次绘制：状态 + 一段 HLSL
│    └── Pass 2 …
├── SubShader 2 …             ← 兜底用的另一套实现
└── FallBack                  ← 所有 SubShader 都不受支持时用哪个 shader
```

| 层 | 作用域 | 放什么 |
|---|---|---|
| `Shader` | 整个文件 | `Properties`、`CustomEditor`、`FallBack` |
| `SubShader` | 一组 Pass | `Tags`（`Queue`/`RenderPipeline`/`RenderType`…）、`LOD`、默认状态 |
| `Pass` | 一次绘制 | `LightMode`、状态指令、`#pragma`、HLSL 代码 |

**"编译成什么"是理解后面所有内容的前提**：

```text
.shader 文本
   ↓ ① ShaderLab 解析：状态指令、Tags、Properties 变成 shader 资产的元数据
   ↓ ② HLSL 编译：每个 Pass 的代码按关键字组合展开成 N 个变体
产物：
   · 一份"状态表"（每个 Pass 的状态、tag、队列）
   · 每个 Pass 的若干变体程序（VS/PS 字节码）
```

所以"一个 shader 文件"运行时并不存在——存在的是**很多份程序 + 一张状态表**。

## 1.2 状态指令可以写在 SubShader 层

`Blend`、`ZTest`、`Cull`、`ColorMask` 这些命令写在 `Pass` 里设置"这个 Pass"的状态，写在 `SubShader` 里则设置"这一组 Pass 的默认值"：

```shaderlab
SubShader
{
    Blend SrcAlpha OneMinusSrcAlpha   // 本 SubShader 内所有 Pass 的默认值
    Pass
    {
        Blend One Zero                // Pass 内再写就覆盖上面的
    }
}
```

**为什么允许两层**：一次绘制的状态有几十项，很多是"整批相同"的。写在高层避免重复；写在低层做精确覆盖。**查找顺序是 Pass 覆盖 SubShader**。

## 1.3 FallBack 与 CustomEditor

```shaderlab
FallBack "Hidden/Universal Render Pipeline/FallbackError"
CustomEditor "MyShaderGUI"
```

- **`FallBack`**：所有 SubShader 都不被当前设备/管线支持时，用它顶上。它同时是"兼容性探测"的机制——`Shader.isSupported` 靠它判断。
- **`CustomEditor`**：只影响 Inspector 的绘制，不影响运行时。

> 实践建议：SRP 项目里把 FallBack 指向错误材质（例如 `FallbackError`）。**看得见的错误比看不见的好**——若某条变体没生成，你会看到醒目的错误材质，而不是"莫名其妙变成了内置漫反射"。

---

# 第 2 章（流程②）：Pass 什么时候被调用——`LightMode`

## 2.1 `LightMode` 是 Pass 的"使用声明"

**位置**：编译完之后，管线要知道"我这一步该用哪个 Pass"。靠的就是这个 tag。

```shaderlab
Pass
{
    Tags { "LightMode" = "UniversalForward" }
}
```

**机制**：渲染管线在每个渲染阶段都带着**一组 tag** 去筛选场景里的 Pass，只有匹配的才被提交。可以把它理解成"统一接口"：管线不认识你的 shader，只认识 tag。

于是三个直接后果：

1. **拼错 tag 不会报错**，只是那个 Pass 永远不会被画；
2. **没写 tag** 会落到默认处理（见 2.3）；
3. **同一段效果写在错误的 tag 下** → 它在错误的时机被绘制，看起来"不生效"。

> 排查"材质不生效"，第一个看的就应该是 `LightMode`。

## 2.2 取值全表：先看 URP

URP 官方文档列出的取值：

| 取值 | 作用 | 被谁使用 |
|---|---|---|
| `UniversalForward` | 画几何并**计算全部光照** | 前向渲染路径 |
| `UniversalGBuffer` | 画几何、**不算光照**（填 G-buffer） | 延迟渲染路径 |
| `UniversalForwardOnly` | 画几何并算光照，**前向/延迟都可用** | G-buffer 装不下的材质（如清漆法线） |
| `DepthNormalsOnly` | 参与深度 + 法线预处理 | 延迟路径配 `UniversalForwardOnly` 用；缺了它 SSAO 不会在物体周围生效 |
| `Universal2D` | 计算 2D 光照 | 2D Renderer |
| `ShadowCaster` | 从**光源视角**渲染深度到阴影图 | 阴影生成 |
| `DepthOnly` | 从**相机视角**只渲染深度 | 深度贴图 / 深度预处理 |
| `DepthNormals` | 渲染深度 + 世界空间法线 | SSAO、贴花 |
| `Meta` | 仅编辑器烘焙 lightmap 时执行；**打包时被剥离** | Lightmap 烘焙 |
| `SRPDefaultUnlit` | **额外画一遍**，不参与常规光照流程 | 叠加绘制（官方举例：描边）；**没写 tag 时的默认值** |

URP 明确**不支持**这些内置管线专属取值：`Always`、`ForwardAdd`、`PrepassBase`、`PrepassFinal`、`Vertex`、`VertexLMRGBM`、`VertexLM`。

## 2.3 内置渲染管线的取值（对照）

| 取值 | 作用 |
|---|---|
| `Always` | 总会绘制，不看光照 |
| `ForwardBase` | 前向的第一个 Pass：主平行光 + 环境光 + lightmap + 阴影 |
| `ForwardAdd` | 前向的其余 Pass：**每个附加光源调用一次** |
| `Deferred` | 延迟渲染的 G-buffer 填充 |
| `ShadowCaster` | 阴影图（与 URP 同名同义） |
| `Vertex` / `VertexLMRGBM` / `VertexLM` | 旧式顶点光照变体 |
| `ShadowCollector` | 收集物体阴影到屏幕空间阴影缓冲 |

**从这张对照表能看出一段历史**：内置管线用"一光一 Pass"（`ForwardAdd` 被反复调用），URP 改成"一个 Pass 里循环所有光源"（靠关键字组合）。这就是为什么 URP 里没有 `ForwardAdd`。

## 2.4 一个关键推论：tag 是按"产出什么数据"划分的

把上面两张表放一起看，会发现取值不是按"美术效果"命名的，而是按**产出哪一路数据**：

```text
颜色缓冲   ← UniversalForward / UniversalGBuffer / UniversalForwardOnly / Universal2D
阴影图     ← ShadowCaster
深度       ← DepthOnly
深度+法线  ← DepthNormals
光照贴图   ← Meta
额外一遍   ← SRPDefaultUnlit
```

**所以**："我想加一个新效果"不等于"我要一个新的 `LightMode`"：

- 效果只改变**颜色** → 挂在颜色 Pass 里（写进 `UniversalForward` 的片元）；
- 效果改变了**另一路数据**（例如"这个物体不该投影"）→ 才需要考虑对应的 Pass（改 / 去掉 `ShadowCaster`）；
- 想要"在同一个颜色阶段多画一遍几何"（描边这类）→ 用 `SRPDefaultUnlit`。

## 2.5 一个 Pass 只有一个 tag

```shaderlab
SubShader
{
    Pass { Tags { "LightMode" = "UniversalForward" } ... }   // 主渲染
    Pass { Tags { "LightMode" = "ShadowCaster"  } ... }      // 投影
}
```

⚠️ 同一个 shader 里**不要出现两个同名 `LightMode` 的 Pass**，也不要把"未具名 Pass"和 `UniversalForward` 混用——URP 的源码注释明确写过那会让同一材质被渲染两遍。

---

# 第 3 章（流程③）：这些绘制排到什么顺序

## 3.1 Render Queue：排序的第一层

**位置**：Pass 被选中之后，管线要把"这一帧要画的所有东西"排个序。

渲染队列是一个整数，**越小越先画**：

| 队列 | 数值 | 典型用途 |
|---|---|---|
| `Background` | 1000 | 天空盒、背景 |
| `Geometry` | 2000 | 绝大多数不透明物体（默认） |
| `AlphaTest` | 2450 | 用 `clip` 的物体（植被、栅栏、镂空装饰） |
| `Transparent` | 3000 | 半透明物体 |
| `Overlay` | 4000 | 叠加效果：镜头光晕、UI、准星 |

支持相对写法，很实用：

```shaderlab
Tags { "Queue" = "Geometry+10" }     // 2010
Tags { "Queue" = "Transparent-5" }   // 2995
```

### `Queue` tag 只是默认值

```text
Shader 的 "Queue" tag   → 提供默认值
材质的 renderQueue 字段  → 真正参与排序的值
```

在 C# 里 `material.renderQueue = 3000;` 改的是后者。所以同一个 shader 的不同材质可以落在不同队列。**排查顺序问题时先看材质上的 Queue**，它可能覆盖了 shader 里的写法。

## 3.2 为什么会有"两个大区"，且排序方向相反

这是本篇里第一个"机制决定规则"的例子：

| | 不透明（`Geometry` 段） | 透明（`Transparent` 段） |
|---|---|---|
| 排序方向 | **由近到远** | **由远到近** |
| 为什么 | 让 early-Z 尽早淘汰被遮挡的片元（**性能**） | 让背景先进入缓冲、前景才能正确叠上去（**正确性**） |
| 顺序错了会怎样 | 结果一样，只是慢 | **结果就错了** |

原因在流程的第 8 章：混合是"用缓冲里已有的值做运算"，所以对透明物体来说，**顺序就是结果**（详见 §8.4）。

## 3.3 二级排序：Sorting Layer / Order

队列**相同**时，再依次比较：

```text
renderQueue  →  SortingLayer  →  SortingOrder  →  排序标准（前到后 / 后到前）
```

## 3.4 排序标准：跨渲染器怎么排

URP 不透明阶段用的排序标准（源码 `Runtime/UniversalRenderPipeline.cs:1211-1216`）：

```csharp
var commonOpaqueFlags = SortingCriteria.CommonOpaque;            // 含首到后距离排序
var noFrontToBackOpaqueFlags = SortingCriteria.SortingLayer | SortingCriteria.RenderQueue
                             | SortingCriteria.OptimizeStateChanges | SortingCriteria.CanvasOrder;
bool canSkipFrontToBackSorting = (baseCamera.opaqueSortMode == OpaqueSortMode.Default && hasHSRGPU)
                              || baseCamera.opaqueSortMode == OpaqueSortMode.NoDistanceSort;
cameraData.defaultOpaqueSortFlags = canSkipFrontToBackSorting ? noFrontToBackOpaqueFlags : commonOpaqueFlags;
```

两条要记住的：

1. **它是"渲染器级"的排序**，用来喂 early-Z（性能导向）；
2. **GPU 自带 HSR / 相机设置允许时，距离排序会被跳过**——此时"谁先画"变成不确定，依赖顺序的效果会漂。

## 3.5 同一个渲染器内部的多个 Pass：由槽位决定

**这一条非常容易搞错**：排序标准排的是"物体/渲染器"，**它看不到同一个渲染器里的两个 Pass**。

真正决定 Pass 先后的是 tag 列表被装进绘制设置时的**数组下标**：

```csharp
// Runtime/RenderingUtils.cs:790-792
DrawingSettings settings = CreateDrawingSettings(shaderTagIdList[0], ref renderingData, sortingCriteria);
for (int i = 1; i < shaderTagIdList.Count; ++i)
    settings.SetShaderPassName(i, shaderTagIdList[i]);
```

URP 正向不透明阶段传入的数组顺序是（`DrawObjectsPass.cs:131-135`）：

```text
槽位 0: SRPDefaultUnlit        ← 额外叠加的 Pass（描边这类）
槽位 1: UniversalForward
槽位 2: UniversalForwardOnly
```

**结论**：同一个材质里，`SRPDefaultUnlit` 的 Pass 会**先于** `UniversalForward` 提交。这不是距离排序的功劳，是**数组顺序**。

> 实用判据：想知道"我的两个 Pass 谁先画"，去看 tag 数组下标，不要去看距离。

---

# 第 4 章（流程④）：GPU 状态机被设成什么样

**位置**：顺序定了，接下来每个 Pass 在绘制前会把一批**渲染状态**写进 GPU 状态机。这些状态不是逐像素的，而是"这一批绘制都这么办"。

先看全景——本章以及后面两章要用的状态，各自在哪一级生效：

```text
状态机设置（每个 Pass 一次）        逐顶点 / 逐片元                        输出合并
─────────────────────────       ─────────────────────────           ─────────────────
Cull / ZTest / ZWrite / Blend   顶点着色器 → 光栅化 → 片元着色器      ZTest → ZWrite → Blend
ColorMask / Offset / Stencil      （采样、光照、clip 都在这）           （写出最终像素）
```

**先记住这张图**：后面 `ZTest`、`Blend`、`clip` 的行为差异，全都来自"它们落在不同的级"。

## 4.1 `Cull`：哪些三角形不进光栅化

```shaderlab
Cull Back     // 默认：剔除背面
Cull Front    // 剔除正面
Cull Off      // 双面
```

**判定依据是"屏幕空间绕序（winding order）"，不是法线方向**：

- 屏幕上逆时针 → 正面（默认保留）；
- 屏幕上顺时针 → 背面（默认剔除）。

法线只影响光照，不参与剔除。所以模型绕序反了会出现"光照看着正常、但整个物体被剔没了"这类迷惑现象。

**代价与副作用**：

- `Cull Off` 的片元量翻倍；
- 背面朝相机时用的是背面法线算光照 → 偏暗。双面渲染通常要在片元里按 `SV_IsFrontFace` 翻转法线。

## 4.2 `Offset`：深度偏移（Depth Bias）

### 是什么

```shaderlab
Offset <factor>, <units>
```

它是**光栅化阶段的一个状态**：让 GPU 在把三角形写进深度缓冲之前，给它的深度值**加一个偏置**。

注意它的作用范围：

| 它改变 | 它不改变 |
|---|---|
| 深度测试时用的深度、写进深度缓冲的深度 | 顶点的屏幕位置、颜色、UV、法线 |
| 只对这一条 Pass 的几何生效 | 不改变物体的实际几何（所以挡不住"真的相交"） |

**为什么需要它**：深度缓冲的分辨率是有限的。当两个面**共面**（或几乎共面）时，它们在同一像素上算出的深度值可能相同或差得极小 → 深度测试无法稳定判断谁在前 → 逐像素随机胜负，就是 **z-fighting（闪烁的花纹）**。典型场景：

- 贴在墙上的贴花 / 海报 / 血迹；
- 地面上的印记、赛道线、网格辅助线；
- 两个材质拼在同一条边上的接缝；
- 阴影图里的自阴影（shadow acne）。

### 取值与语义

| 参数 | 文档范围 | 含义 |
|---|---|---|
| `factor` | −1 ~ 1 | 乘以该多边形的**最大深度斜率**（`max(|dz/dx|, |dz/dy|)`）→ 得到**随倾斜变化**的偏移 |
| `units` | −1 ~ 1 | 乘以**一单位可分辨深度**（深度缓冲里最小可分辨差值 `r`，随设备/深度格式变化）→ 得到**常数**偏移 |

**符号**（官方文档）：

```text
units 为负 → 多边形被拉近相机（更可能通过 ZTest）
units 为正 → 多边形被推远相机
```

于是"给贴花铺在地面上、让它压过地面"就是：

```shaderlab
Offset -1, -1
```

**为什么需要两个参数**：一个常数偏移（`units`）在"面几乎正对相机"时够用；但**斜视时**同一个三角形内部深度跨度很大，常数偏移无法覆盖整个斜率 → 需要 `factor` 跟着斜率放大。地面上的贴花正是最斜的情况，所以常常两个都要给。

### 底层机制

GPU 的深度偏置公式可以写成：

```text
depth' = depth + factor × maxDepthSlope + units × r
```

- `maxDepthSlope`：该多边形在屏幕空间上深度随 x/y 变化的最大斜率。**面越斜，这个值越大**——这就是"沿地面方向看时 z-fighting 更严重"的数学原因。
- `r`：该深度格式下"一个最小可分辨单位"对应的 NDC 深度差，**因设备、因深度缓冲位深而异**（16/24/32 位不同）。所以同一组 `units` 在不同机器上的**绝对效果不同**——这是它不适合当精确数值用的原因。
- 该偏置同时作用于**深度测试**与**深度写入**（被测试通过的片元，写进缓冲的也是偏移后的深度）。

**三种偏置途径的关系**：

| 途径 | 作用范围 | 是否改 GPU 状态 |
|---|---|---|
| `Offset`（Pass / SubShader） | 这一条 Pass 的几何 | 是 |
| `CommandBuffer.SetGlobalDepthBias` | 全场景（叠加在 per-geometry 之上） | 是 |
| 顶点里沿法线/光方向位移（如阴影的 `ApplyShadowBias`） | 真的移动了顶点 | 否（改的是几何） |
| 光照的 shadow bias / normal bias 设置 | 只影响阴影采样 | 否 |

⚠️ 最后一列很关键：**"看起来都能治 shadow acne"，但一个是改状态、一个是改几何、一个是改采样策略**。混用会得到"偏置过头"的漏光（peter-panning）。

### 怎么用：三个配方

**① 共面贴花（最常见的用法）**：单独写一个 Pass，叠在已有几何上

```shaderlab
Pass
{
    Tags { "LightMode" = "SRPDefaultUnlit" }   // 叠在主体之后画（见 §3.5 槽位顺序）
    Offset -1, -1                              // 拉近，抢在墙面之前通过 ZTest
    ZWrite Off                                 // 深度交给主体，自己不写
    ZTest LEqual
    Blend SrcAlpha OneMinusSrcAlpha
    // 片元返回贴花颜色
}
```

**② 共面接缝**：把其中一个材质稍微推远或拉近

```shaderlab
Offset 0, -1     // 这个材质拉近
```

**③ 阴影图里的自阴影**：在 `ShadowCaster` Pass 上加偏置（常规做法是优先调光照的 bias 设置，`Offset` 作为兜底）

```shaderlab
Pass
{
    Tags { "LightMode" = "ShadowCaster" }
    Offset 1, 1        // 推远投射几何，减少自阴影条纹
}
```

### 边界与常见坑

| 坑 | 说明 |
|---|---|
| **它不修"几何真的相交"** | 两个面几何上交叉，偏移只会让交叉区域整体前后移动，交线还在 |
| **它在点/线上不生效** | 深度偏置是**光栅化多边形**的状态；点、线（以及某些平台上的细分后图元）不受影响 |
| **它不能替代 near/far 的设置** | 相机近裁剪面过小会让深度精度整体崩掉；用大 `units` 硬顶只是把问题推到别处 |
| **写入 `SV_Depth` 时通常失效** | 多数图形 API 上，片元自己写深度后光栅化的深度偏置不再参与（不同后端行为需实测） |
| **符号可能因平台/反向 Z 而反直觉** | Unity 文档给的是平台无关语义（负=近、正=远），但深度约定与反向 Z 在不同图形 API 上不同；**跨平台项目先用最小例子验证一次符号** |
| **`units` 的绝对量不可移植** | 它乘的是"设备相关的最小可分辨深度"，换机器/换深度格式效果就变 |
| **别和 `ZTest Always` 一起乱用** | 偏置后的深度照样会被写入，可能把后续几何判错 |

> 排查口诀：**闪烁的是"共面"还是"真交叉"？** 共面 → `Offset`（配 `ZWrite Off`）；真交叉 → 只能改几何或加裁剪，`Offset` 救不了。

## 4.3 状态的作用域与覆盖

- 写在 `SubShader` 层 → 该组 Pass 的默认值；
- 写在 `Pass` 层 → 覆盖；
- 由**材质属性驱动**也可以：`ZWrite[_ZWrite]`、`Blend[_SrcBlend][_DstBlend]`——此时状态值来自材质，可以逐材质不同（这也是 ShaderGUI 上那些下拉框的实现方式）。

---

# 第 5 章（流程⑤）：顶点着色器——坐标从哪来、到哪去

## 5.1 顶点数据的来源：语义

顶点着色器的输入结构体用**语义**声明每个字段从哪来：

```hlsl
struct Attributes
{
    float4 positionOS : POSITION;    // 物体空间位置
    float3 normalOS   : NORMAL;
    float4 tangentOS  : TANGENT;     // .w 是副切线朝向符号
    float2 uv         : TEXCOORD0;   // 第一套 UV
    float2 uv2        : TEXCOORD1;   // 第二套 UV
    float4 color      : COLOR;       // 顶点色
};
```

**代价意识**：结构体里出现过的语义会占用顶点属性槽位，每个顶点都要传一次。用不到就别声明。

## 5.2 坐标空间与变换链

顶点着色器的核心工作是把坐标从**物体空间**送到**裁剪空间**：

```text
object space ──模型矩阵──▶ world space ──视图矩阵──▶ view space ──投影矩阵──▶ clip space
                                                                             │ 透视除法
                                                                             ▼
                                                                           NDC ──视口──▶ screen
```

常用宏（Core/URP 都提供）：

| 宏 | 作用 |
|---|---|
| `TransformObjectToWorld` | 物体 → 世界（位置） |
| `TransformObjectToWorldNormal` | 物体 → 世界（**法线**，已处理非等比缩放） |
| `TransformWorldToObject` | 世界 → 物体（逆变换） |
| `TransformWorldToHClip` / `TransformObjectToHClip` | → 裁剪空间 |
| `TransformWorldToView` / `GetWorldSpaceNormalizeViewDir` | 视图空间相关 |

**三个高频坑**：

1. **法线要用专门的函数**。法线在非等比缩放下要用"逆转置矩阵"，`TransformObjectToWorldNormal` 已经处理；拿位置矩阵直接乘法线会得到错误方向。
2. **方向向量不要带平移**：变换方向时用"w = 0"的形式或 `...Dir` 函数。
3. **空间选错会让效果跟着物体跑**：需要"图案钉在物体上"（渐变、溶解）用物体空间；需要"和光照一致"（阴影、雾）用世界空间。

## 5.3 顶点着色器的输出：插值器

顶点着色器通过 `Varyings` 把数据交给光栅化，再插值给片元：

```hlsl
struct Varyings
{
    float2 uv        : TEXCOORD0;
    float3 positionWS: TEXCOORD1;
    float3 normalWS  : TEXCOORD2;
    float4 positionCS: SV_POSITION;   // 系统语义：必须输出
};
```

**三条实践规则**：

- **插值器数量有上限**（受 `TEXCOORDn` 编号限制）；能省则省。
- **能用低精度就用低精度**：`half4` 比 `float4` 省一半带宽（但**桌面平台上 `half` 可能等同于 `float`**，不要指望它一定省）。
- **只在某阶段需要的数据用关键字条件声明**（例如只在需要裁剪时才传 UV）。

## 5.4 顶点阶段常见操作一览

| 操作 | 说明 |
|---|---|
| 位置变换 | 上面的变换链 |
| 法线/切线变换 | 光照、法线贴图要用 |
| UV 变换 | `TRANSFORM_TEX(uv, _Tex)` 应用 Tiling/Offset |
| 顶点光照 | 逐顶点光照（`_ADDITIONAL_LIGHTS_VERTEX` 这类关键字） |
| 阴影坐标 | 有的管线在顶点算阴影坐标，减少片元开销 |
| 雾因子 | `ComputeFogFactor`（雾是距离的函数，顶点算就够） |
| 光照贴图 UV | `OUTPUT_LIGHTMAP_UV` 按通道输出 |
| 顶点位移 | 波浪、风、描边外扩等（**注意：位移后的 Pass 要在哪里求值要一致**） |

---

# 第 6 章（流程⑥）：光栅化与 early-Z

**位置**：顶点输出之后，GPU 把三角形变成片元（候选像素），并在这里做第一轮剔除。

## 6.1 光栅化做了什么

```text
三角形（屏幕空间） → 遍历覆盖的像素 → 生成片元 → 对三角形顶点数据做重心插值 → 交给片元着色器
```

这一步是**固定功能**的，你控制不了它，但你控制得了"给它什么数据"（插值器）与"哪些三角形进来"（`Cull`、裁剪空间的位置）。

## 6.2 裁剪与视锥

- 三角形完全在裁剪空间之外 → 直接丢弃（顶点着色器白跑）；
- 跨越裁剪面的 → 被裁剪。

所以"把顶点折叠到裁剪范围外"是一个**合法且零光栅化开销的"关闭"手法**（描边关闭时常用）。

## 6.3 early-Z：性能的关键，也是很多"代价"的来源

现代 GPU 会在**片元着色器执行之前**先做一次深度测试，被遮挡的片元直接不跑着色器。但有两个前提会被打破：

| 破坏者 | 为什么 |
|---|---|
| 片元里写深度（`SV_Depth`） | 提前测试时还不知道会写成什么深度 |
| 使用 `clip` / `discard` | 提前测试时不知道这个片元会不会被丢弃 |

> 这就解释了两件事：为什么**透明/裁剪类材质的开销高于同像素量的不透明材质**；以及为什么 `Blend` 一开启就会削弱优化（官方文档明确写了：启用混合会关闭部分 HSR/Early-Z 优化）。

---

# 第 7 章（流程⑦）：片元着色器——一个像素的颜色怎么算出来

## 7.1 片元阶段能做的事

按"写代码时实际会做的顺序"列一遍：

| 步骤 | 常用手段 |
|---|---|
| 采样贴图 | `SAMPLE_TEXTURE2D`（用纹理+采样器对） |
| 解包数据 | 法线贴图用 `UnpackNormalScale`，金属粗糙度常打包在一张贴图的通道里 |
| 组装表面数据 | 基础色、法线（切线空间）、金属度、光滑度、AO、自发光 |
| 求光照 | 主光 + 附加光 + 间接光（GI/lightmap）+ 高光 |
| 附加效果 | 菲涅尔边缘光、溶解、描边颜色等 |
| 应用雾 | `MixFog` |
| 丢弃像素 | `clip` / `discard` |
| 输出 | 返回颜色，或写入多个渲染目标（MRT） |

## 7.2 `clip` / `discard`：片元级"否决权"

```hlsl
clip(threshold - value);   // 参数 < 0 时丢弃该片元
```

**机制**：它是片元着色器内部的一个**终止指令**——这个片元之后的代码不执行，也不写出任何缓冲。

**三条必须知道的代价**：

1. 它**只影响这一级**：不会让几何消失、不会让阴影消失、不会让深度 pass 里的几何消失（见 7.3）；
2. 它**破坏 early-Z**（见 6.3）；
3. 它在某些平台上代价高于纯混合。

## 7.3 为什么"一个 Pass 里丢弃"不会传播

因为流程是**每条 Pass 各自跑一遍**：

```text
同一个三角形
 ├── Pass A（颜色）：片元判断 → clip 掉 → 没有颜色
 ├── Pass B（阴影）：又跑一遍顶点+光栅化+自己的片元 → 它不知道 A 做了什么
 └── Pass C（深度）：同上
```

**所以要"物体整体消失"，必须在每个会重新生成几何的阶段都执行同样的判断。** 这不是约定，是流程结构决定的：**Pass 之间不共享片元级结果**。

## 7.4 输出到多个目标（MRT）

片元着色器可以有多个输出参数，写进多张渲染目标：

```hlsl
void frag(..., out half4 outColor : SV_Target0
              , out float4 outNormal : SV_Target1) { ... }
```

用途：延迟渲染的 G-buffer、法线缓冲、光照层掩码。代价是**带宽**——所以能压就压（例如法线用八面体编码压进 24 位，而不是占满 RGBA）。

## 7.5 MRT 与逐通道写入（`ColorMask`）

```shaderlab
ColorMask RGBA    // 默认
ColorMask R       // 只写红色通道
ColorMask 0       // 不写颜色
```

它控制**输出合并阶段的颜色写入掩码**。典型用法：

| 写法 | 场景 |
|---|---|
| `ColorMask 0` | 阴影投射、纯深度 Pass：只要深度 |
| `ColorMask R` | 只需要一个通道的深度预处理 |

⚠️ `ColorMask` **不影响深度写入**：写在 `ColorMask 0` 的 Pass 里，深度照样按 `ZWrite` 写。

---

# 第 8 章（流程⑧）：输出合并——ZTest 与 Blend 在这里生效

**位置**：片元着色器返回颜色之后，硬件依次做三件事：**深度测试 → 深度写入 → 混合**。这是全流程唯一能真正"决定像素最终值"的地方。

## 8.1 `ZTest`：这一级的第一道闸门

```shaderlab
ZTest LEqual    // 默认
```

| 取值 | 通过条件 | 典型用途 |
|---|---|---|
| `Disabled` | 关掉测试，全部通过 | 极端情况 |
| `Never` | 全部不通过 | 调试 |
| `Less` | 更近 | 严格更近 |
| `Equal` | 深度相同 | 贴在已有几何上的叠加 |
| `LEqual` | 更近或相同 | **默认** |
| `Greater` | 更远 | 遮挡轮廓、X 光 |
| `GEqual` | 更远或相同 | 少见 |
| `NotEqual` | 不相同 | 少见 |
| `Always` | 全部通过 | 无视遮挡的叠加绘制 |

**关键认知**：`ZTest` 是"读深度、决定画不画"，它**不改深度缓冲**。改深度的是下一节。

## 8.2 `ZWrite`：这一级的第二道闸门

```shaderlab
ZWrite On     // 默认：把深度写进缓冲
ZWrite Off    // 只测不写
```

**半透明物体通常 `ZWrite Off`**，两个原因：

1. **正确性**：半透明物体如果写深度，后面更远的半透明物体就会被深度测试直接拒绝——而它本该参与混合（"透过近处玻璃看到远处的东西"）；
2. **性能/一致性**：不透明的绘制顺序优化（前到后 + early-Z）会被这些"没写深度"的像素打乱。

**关掉之后的三个副作用**（都是这一级造成的）：

- 它之后画的**不透明**物体都会以"更近"的身份盖过它，哪怕几何上它更近；
- 它和别的透明物体之间只由顺序决定，不由几何决定；
- 如果后续有"以深度等于远平面为条件"的背景/天空盒绘制，这些没写过深度的像素会被背景重新覆盖一遍。

> 排查技巧：效果"只剩一部分"或"被背景吃掉" → 先检查有没有写深度。

## 8.3 混合方程：这一级的第三个动作

混合发生在**深度测试之后**。GPU 做的是一个代数运算：

```text
finalValue = sourceFactor × sourceValue   operation   destinationFactor × destinationValue
```

| 符号 | 含义 |
|---|---|
| `sourceValue` | 片元着色器输出的颜色（源） |
| `destinationValue` | 渲染目标里**已经存在**的值（目标） |
| `sourceFactor` / `destinationFactor` | `Blend` 命令给出的两个因子 |
| `operation` | `BlendOp` 给出的运算，默认 `Add` |

对 RGBA 四个通道**分别**做。

### `Blend` 的完整语法

```shaderlab
Blend Off                                        // 关闭（默认）
Blend <srcFactor> <dstFactor>                    // 为 RGBA 设因子
Blend <srcRGB> <dstRGB>, <srcA> <dstA>           // RGB 与 Alpha 分开
Blend <rt> <srcFactor> <dstFactor>               // 指定渲染目标 0..7
Blend <rt> <srcRGB> <dstRGB>, <srcA> <dstA>      // 组合
```

限制：指定渲染目标需要 OpenGL 4.0+ / `GL_ARB_draw_buffers_blend` / GLES 3.2；RGB/Alpha 分开混合不能与高级 OpenGL 混合运算共用。

### 省写规则（最常见的误解）

| 你写的 | 展开成 |
|---|---|
| `Blend SrcAlpha` | `Blend SrcAlpha OneMinusSrcAlpha` |
| `Blend OneMinusDstColor` | `Blend OneMinusDstColor OneMinusDstColor` |
| `Blend DstColor` | `Blend DstColor DstColor` |

⚠️ 规则是"**同一个因子用两次**"，不是"第二个自动取 `OneMinusX`"。只有 `Blend SrcAlpha` 这种恰好符合直觉。想写清楚就两个因子都写。

## 8.4 因子与运算全表

**源因子 / 目标因子**：

| 因子 | 乘数 |
|---|---|
| `One` | `1` |
| `Zero` | `0` |
| `SrcColor` / `SrcAlpha` | 源的 RGB / A |
| `SrcAlphaSaturate` | `min(srcA, 1 − dstA)` |
| `DstColor` / `DstAlpha` | 目标的 RGB / A |
| `OneMinusSrcColor` / `OneMinusSrcAlpha` | `1 − 源RGB` / `1 − 源A` |
| `OneMinusDstColor` / `OneMinusDstAlpha` | `1 − 目标RGB` / `1 − 目标A` |

> `SrcAlphaSaturate` 值得单独记：它把"源 alpha + 目标 alpha 超过 1"的情况钳住，多层半透明叠加（粒子、多层玻璃）时比 `OneMinusSrcAlpha` 更稳。

**`BlendOp`**：

| 运算 | 含义 | 备注 |
|---|---|---|
| `Add` | `src + dst` | 默认 |
| `Sub` / `RevSub` | `src − dst` / `dst − src` | |
| `Min` / `Max` | 取小 / 取大 | |
| `Logical*` | 逐位逻辑运算 | 需要 DX 11.1+ 或 Vulkan |
| 高级混合（`Multiply`/`Screen`/`Overlay`/`Darken`/`Lighten`/`ColorDodge`…） | Photoshop 风格 | 需要 GLES3.1 AEP+ 等；**不能**与 RGB/Alpha 分开混合共用 |

⚠️ **平台静默差异**：官方文档明确写了——遇到不支持的混合运算时，**GL 会跳过该运算，Vulkan/Metal 会回退成 `Add`**。同一份 shader 在不同后端出不同画面，先怀疑这里。

**六种常见组合**（官方给出的）：

| 写法 | 方程 | 观感 |
|---|---|---|
| `Blend SrcAlpha OneMinusSrcAlpha` | `src·a + dst·(1−a)` | 传统透明 |
| `Blend One OneMinusSrcAlpha` | `src + dst·(1−a)` | 预乘 alpha 透明 |
| `Blend One One` | `src + dst` | 加性：只更亮，永不遮挡 |
| `Blend OneMinusDstColor One` | `src·(1−dst) + dst` | 软加性 |
| `Blend DstColor Zero` | `src·dst` | 乘性：只更暗 |
| `Blend DstColor SrcColor` | `src·dst·2` | 2× 乘性（软阴影常用） |

## 8.5 预乘 alpha：为什么会有两种写法

```text
straight alpha:       RGB 与 A 独立，混合时靠 SrcAlpha 提供权重
premultiplied alpha:  RGB 已含 A 的影响，混合时源因子用 One
```

```shaderlab
Blend SrcAlpha OneMinusSrcAlpha   // straight
Blend One      OneMinusSrcAlpha   // premultiplied
```

**为什么用预乘**：

- 对 straight alpha 的 RGB 做插值/滤波会把透明区域的"垃圾颜色"混进来（经典的黑边问题），预乘能避免；
- 叠加多次时不必反复乘 alpha；
- "高光是否也跟着 alpha 衰减"这类需求更容易表达。

⚠️ 用预乘时，**片元里必须自己乘**，因为混合单元只会按因子取用：

```hlsl
color.rgb *= color.a;
return color;
```

> 很多 ShaderGUI 上的"保持高光（Preserve Specular）"就是这个原理：切换成预乘形态 + 在片元里只对非高光部分乘 alpha。**它不是某个神秘特性，而是"改混合状态 + 挪动乘法位置"。**

## 8.6 为什么混合必须"由远到近"

因为方程里的 `destinationValue` 是"**此刻**缓冲里的值"：

```text
A 叠 B:  result = A·aA + B·(1 − aA)
B 叠 A:  result = B·aB + A·(1 − aB)
```

只要 `aA ≠ aB` 就不相等 → **不可交换** → 顺序就是结果。

三个实践推论：

1. 透明队列按距离**从远到近**排序是管线保证的（§3.2）；
2. 透明通常 `ZWrite Off`（§8.2）；
3. **相互穿插的透明几何无法用单一顺序解决**——这不是 bug，是"逐片元排序"在硬件上做不到的结果。工程手段是拆层、写深度、或深度剥离。

## 8.7 把本章和前面串起来：三个常见困惑的答案

| 困惑 | 答案（它在流程的哪一级） |
|---|---|
| "为什么 `Blend` 不能修遮挡问题？" | 遮挡在⑥（early-Z）和⑧前半段（ZTest）就判完了，混合是⑧的最后一步 |
| "为什么 `clip` 不能让物体整体消失？" | `clip` 在⑦，属于"这一条 Pass 的这一个片元"；阴影/深度是别的 Pass |
| "为什么 `ZTest Always` 不一定是'画在最上面'？" | 它只是通过测试；是否在最上面还取决于顺序与 `ZWrite` |

---

# 第 9 章（流程⑨）：哪些事在 CPU 侧、编译期就做完了

前面八章讲的是"每帧在 GPU 上发生的事"。最后这一章讲**另外三件事**：它们在更早的时候就把结果定下来了——**关键字与变体（编译期）**、**常量缓冲与批处理（CPU 提交期）**。理解它们才能理解"为什么有些写法看起来多余，其实是必须的"。

## 9.1 关键字：编译期展开，不是运行时开关

### 机制

```text
.shader 源码
   ↓ 编译期：按 #pragma 声明做关键字组合的笛卡尔积
N 份独立程序（变体），每份里被选中的关键字变成 #define
   ↓ 运行时：按材质/管线的关键字集合选一份绑定
```

所以运行时视角里，**没有"开关"，只有"选了哪份程序"**。

### 三条推论

1. **`#if` 没有运行时开销**：代码在或不在，不是分支判断；
2. **关键字不能逐对象变**：逐对象能变的只有数据（常量缓冲、顶点属性），而"选哪份程序"是批次/材质级的；
3. **变体数量组合爆炸**：`n` 个独立两态关键字 → 最多 `2ⁿ` 份程序。

### 关键字从哪来

| 来源 | 例子 |
|---|---|
| 材质属性 | `[Toggle(_FOO)]` 这类抽屉；勾选即切换 |
| 脚本 | `Material.EnableKeyword` / `Shader.EnableKeyword` |
| 渲染管线 | `_MAIN_LIGHT_SHADOWS`、`_ADDITIONAL_LIGHTS`、`_FORWARD_PLUS` |
| Unity 其它系统 | `LIGHTMAP_ON`、`multi_compile_fog`、`SHADOWS_SHADOWMASK` |

## 9.2 `shader_feature` 与 `multi_compile`

| | `shader_feature` | `multi_compile` |
|---|---|---|
| 变体集合 | 按**构建时用到的材质关键字**收集 | 无条件全部生成 |
| 未用到的变体 | **打包时被剥离** | 始终存在 |
| 适合 | 材质开关（有没有法线贴图、开不开某效果） | 环境状态（阴影方案、雾、lightmap、渲染路径） |
| 运行时切换 | 仅当变体被保留 | 可以 |

```hlsl
#pragma shader_feature _NORMALMAP
#pragma shader_feature_fragment _EMISSION
#pragma multi_compile _ LIGHTMAP_ON
#pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE _MAIN_LIGHT_SHADOWS_SCREEN
#pragma multi_compile_fog
```

> ⚠️ **最典型的静默失败**：`shader_feature` 的变体在编辑器里永远即时编译，开发期一切正常；打包后若没有材质用过该关键字，变体被剥离，真机上就不亮。
> 口诀：**"编辑器正常、真机不正常 → 先怀疑变体被剥离。"**

## 9.3 `_local` 与作用域配对

| | 全局关键字 | 本地关键字（`_local`） |
|---|---|---|
| 声明 | `#pragma multi_compile _ _FOO` | `#pragma multi_compile_local _ _FOO` |
| 作用域 | 全局命名空间，所有 shader 可见 | 仅本 shader |
| 数量限制 | **有硬上限** | 不占全局名额 |
| 冲突 | 可能与其他 shader 撞名 | 不会 |

启用时要配对：

```csharp
material.EnableKeyword("_LOCAL_KEY");   // 材质自身的本地关键字集合
Shader.EnableKeyword("_GLOBAL_KEY");    // 该 shader 的所有材质
```

⚠️ 用全局 API 去开本地关键字，可能"看起来能用"（变体恰好还在），换机器或打包后就不对了。

## 9.4 阶段后缀与多选一

```hlsl
#pragma shader_feature_fragment _EMISSION                 // 只影响片元
#pragma multi_compile_vertex _ _CASTING_PUNCTUAL_LIGHT_SHADOW
#pragma shader_feature _ _MODE_A _MODE_B _MODE_C          // 四选一（含"都不定义"）
```

- **后缀**表示"只影响这个阶段"，能省变体。判断标准：**该关键字是否被顶点阶段用到**。
- **多选一语法里的 `_`** 是"一个都不定义"的空选项，生成**互斥**变体，不是多个布尔量。

> 由此得到一条常被忽略的事实：**关键字只能表达"枚举"，不能表达"数值"**。如果材质上有个 `0..3` 的整数属性，shader 里不能靠读它选分支——必须由 C#/GUI 把数值**翻译成恰好一个关键字**。

### 变体预算

| 独立两态关键字数 | 理论上限 |
|---|---|
| 5 | 32 |
| 10 | 1024 |
| 15 | 32768 |
| 20 | 1048576 |

**能合并就合并**（N 个互斥状态用一条多选一关键字 = `N+1` 个变体，而不是 `2^N`），**只影响某阶段的一定加后缀**。其它手段：Shader Variant Collection、按平台/质量裁剪。

## 9.5 `CBUFFER`：材质参数住在哪

```hlsl
CBUFFER_START(UnityPerMaterial)
    float4 _BaseMap_ST;
    half4  _BaseColor;
    half   _Cutoff;
CBUFFER_END
```

`UnityPerMaterial` 是"每个材质一份、一次绘制内不变"的常量缓冲。两条硬规则：

1. **所有材质属性放在同一个 CBUFFER 里**（分开放会削弱批处理效率）；
2. **不能用 `#ifdef` 改变它的成员**：

```hlsl
// NOTE: Do not ifdef the properties here as SRP batcher can not handle different layouts.
```

⚠️ 原因：两个批处理机制都要求**布局固定**——

- **SRP Batcher** 靠"布局一致"才能只换一个缓冲指针；
- **逐实例数据**靠"偏移固定"才能定位每个对象的参数。

一旦布局随变体变，SRP Batcher 直接放弃这类材质（**不报错，只是悄悄变慢**）。所以材质属性要"**永远声明，用不用再说**"。

## 9.6 SRP Batcher 的原理与边界

传统路径下，每绘制一个物体 CPU 都要设置一整套 uniform；参数越多，切换越贵。

SRP Batcher 把"每个材质一份"的常量放进统一缓冲：

```text
传统：       [绑定材质 A 的全部 uniform] → draw → [绑定材质 B 的全部 uniform] → draw
SRP Batcher: [指向 A 的缓冲] → draw → [指向 B 的缓冲] → draw
```

**前提就是 9.5 的两条规则。** ⚠️ 它**不减少 draw call**，降低的是"每次绘制的 CPU 属性设置成本"。

## 9.7 GPU Instancing 与逐实例数据

要让"同一网格、同一材质"的多个对象一次画完，就要有"**逐实例数据**"这条路：每个实例的差异放在另一块缓冲里。

```hlsl
struct Attributes { float4 positionOS : POSITION; UNITY_VERTEX_INPUT_INSTANCE_ID };
struct Varyings   { float4 positionCS : SV_POSITION; UNITY_VERTEX_INPUT_INSTANCE_ID };

Varyings vert(Attributes input)
{
    Varyings o;
    UNITY_SETUP_INSTANCE_ID(input);          // 取出实例 ID
    UNITY_TRANSFER_INSTANCE_ID(input, o);    // 片元也要用就传下去
    ...
}
```

配合 `#pragma multi_compile_instancing` 与材质上的 `Enable GPU Instancing`。

**批量渲染（BatchRendererGroup）把这条路推到极致**：CPU 侧按"批次 + 偏移"写数据，GPU 侧按声明读：

```hlsl
// ① 声明哪些属性参与逐实例
UNITY_DOTS_INSTANCING_START(MaterialPropertyMetadata)
    UNITY_DOTS_INSTANCED_PROP(float4, _BaseColor)
UNITY_DOTS_INSTANCING_END(MaterialPropertyMetadata)

// ② 读取：有逐实例数据就用它，否则用默认值
float4 c = UNITY_ACCESS_DOTS_INSTANCED_PROP_WITH_DEFAULT(float4, _BaseColor);

// ③ 缓存：在入口读一次，之后重定向（避免每个使用点都生成加载代码）
static float4 unity_DOTS_Sampled_BaseColor;
```

**两条必须知道的机制**：

- **元数据块里的顺序必须与 CBUFFER 的成员顺序对齐**（CPU 按偏移写、GPU 按成员顺序读）。错位的报错常常伪装成"变体没生成"。
- **`WITH_DEFAULT` 的语义是"选址"，不是"保证默认值"**：它回答"从哪条流读"。而"没有逐实例数据的对象读到什么"取决于数据侧填充（常见实现指向一块全零区域）→ **经验结论：漏填的对象通常读到 0**。

**反推的设计约束**：既然"漏填 = 0"，所有**效果类**属性的默认值都应该设计成"无贡献"状态（颜色 `(0,0,0,0)`、强度 `0`），否则漏填的对象会自动多出一个突兀的效果。

**为什么贴图不能逐实例**：贴图是**资源绑定**（descriptor / bindless 槽位），不是常量缓冲里的标量。想"逐对象换贴图"走的是另一条路（材质数组 / `MaterialMeshInfo` 这类"选择哪套资源"）。

---

# 附：一条时间线，把九章串起来

```text
【离线/编译期】
  写 .shader                                          §1
  关键字展开 → N 个变体                                §9.1–9.4
【每帧 CPU】
  管线按 LightMode 挑 Pass                             §2
  排序（队列 → 层 → 距离 → 渲染器）                     §3
  绑定常量缓冲 / 逐实例数据（批处理）                    §9.5–9.7
  提交 draw call
【GPU：每个 Pass 一遍】
  设置状态机（Cull / ZTest / ZWrite / Blend…）          §4
  顶点着色器：变换 + 输出插值器                         §5
  光栅化 + early-Z                                     §6
  片元着色器：采样 / 光照 / clip                        §7
  输出合并：ZTest → ZWrite → Blend                      §8
【下一帧重复】
```

# 附：症状 → 先去哪一章看

| 症状 | 章节 |
|---|---|
| 材质完全不生效、某个效果永远不出现 | §2（`LightMode`） |
| 透明物体互相穿插、被更远的物体挡住 | §3.2、§8.2、§8.6 |
| 两个 Pass 的执行顺序和预期相反 | §3.5（槽位，不是距离） |
| 效果"只剩一部分"或被背景吃掉 | §8.2（没写深度） |
| 表面上出现闪烁的花纹/条纹（z-fighting） | §4.2（`Offset`；先分清"共面"还是"真交叉"） |
| 编辑器正常、真机不亮/变黑 | §9.2（变体被剥离） |
| 调一个参数影响到另一个参数 | §9.5（CBUFFER/元数据错位） |
| 修改深度相关的代码后性能骤降 | §6.3（early-Z 被破坏） |
| 同一个 shader 在不同平台画面不同 | §4.2、§8.4（混合运算的平台差异）、§5.2（Z 约定） |

# 参考

- Unity Manual：`ShaderLab command: Blend` / `BlendOp` / `ZTest` / `ZWrite` / `Cull` / `ColorMask` / `Offset`；`ShaderLab: Pass tags`
- URP 文档：`URP ShaderLab Pass tags`（`LightMode` 与 `UniversalMaterialType` 取值表、不支持的 tag 列表）
- URP 源码：`Runtime/RenderingUtils.cs:790-792`（按槽位写 shader pass 名）、`Runtime/Passes/DrawObjectsPass.cs:131-135`（tag 数组顺序）、`Runtime/UniversalRenderPipeline.cs:1211-1216`（不透明排序标准）
- Core SRP：`CBUFFER` 与 SRP Batcher、`UNITY_DOTS_INSTANCED_PROP` 系列宏

> 本篇是知识点整理，不绑定任何具体工程；代码片段都是通用写法。
