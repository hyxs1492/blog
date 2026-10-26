---
title: '自发光的原理：编译期关键字、HDR 量化与逐实例数据'
description: '自发光这一个效果背后串起了七组通用知识点：着色器关键字的编译期短路、发射项在光照方程里的位置、贴图×颜色的乘法语义、[HDR] 与颜色缓冲量化再到 Bloom 的因果链、逐实例材质属性的数据分层（含缺省值从哪来、贴图为什么不可能逐实例）、MaterialProperty 的同名映射与冲突、以及混合方程与预乘 alpha 的影响。'
pubDate: '2026-10-08'
category: 'Unity 渲染'
tags: ['Unity', 'URP', 'Shader', 'Emission', 'HDR', 'Entities Graphics', 'DOTS']
---

## 速览

>- **关键字是编译期符号，不是 uniform**：一条 `#pragma shader_feature` 让编译器产出两份独立程序；`#ifndef` 关闭变体里贴图采样指令**根本不存在**，所以关闭即零开销，也所以「把颜色调到 100 也没用」是必然 —— 不是乘 0，是根本没有那条读取指令。
>- **发射项的位置决定了它的全部行为**：在光照合成里它是 `+= emission`，而 albedo、光色、阴影、AO 全都乘在光照项上。所以自发光**不乘 albedo、不吃光照/阴影/AO**，包括黑 albedo 物体照样能发光。
>- **`[HDR]` 只允许值大于 1，存不存得住要问颜色缓冲**：8 位定点缓冲把 >1 截断到 1，相对亮度信息被抹平；Bloom 的辉光是「提取超过阈值的像素 → 模糊 → 加回」，所以辉光不是自发光的能力，而是后处理对 HDR 值的二次利用。
>- **逐实例只能改「常量缓冲里的标量/向量」**：属性值可能来自材质常量缓冲、逐实例数据流、或全零保留区。缺省值的来源与「没加组件读到 0」是数据分层的结果，不是宏的承诺；贴图是资源绑定（descriptor 槽位），因此**永远不可能逐实例**。
>- **`MaterialProperty` 的名字是唯一键**：属性名经 `Shader.PropertyToID` 变成 nameID，多个组件类型可以映射到同一个 nameID —— 于是同名冲突在批次元数据里表现为两条同名条目，读到哪条由顺序决定，且不报错。

本文借自发光这一个效果，把上面每组知识点单独讲透。每一节都自成一个知识点：**它是什么 → 取值与语义 → 底层机制 → 可观察现象与边界**，不依赖其它节的结论也能读。系列其余各篇：

| 篇 | 知识点群 |
|---|---|
| （一）[Pass、队列与渲染状态](/blog/blog/customlit-passes/) | ShaderLab 结构、LightMode、Render Queue、ZTest/ZWrite/Cull、Blend 与关键字、CBUFFER 与批处理 |
| （二）[描边的几何原理](/blog/blog/customlit-outline/) | 背面剔除、法线偏置、投影换算、深度状态组合、位置平均法线 |
| （三）[溶解与阈值裁剪](/blog/blog/customlit-dissolve/) | 标量场、`clip` 的代价、噪声阈值映射、多 Pass 同源 |
| （四）[外发光的着色原理](/blog/blog/customlit-rim-glow/) | 菲涅尔近似、幂函数整形、发射项在光照方程的位置、加性叠加 |
| **（五）本文** | 关键字短路、发射项位置、贴图×颜色、HDR 量化与 Bloom、逐实例数据分层、MaterialProperty 映射、透明与预乘 |

---

## 1. 着色器关键字与预处理：为什么「关闭」是编译期短路

### 它是什么

**着色器关键字（shader keyword）是编译期的符号，不是运行期的变量。** 它属于「变体编译」这一层：一条 `#pragma` 声明一个关键字维度，Unity 为这个维度的每种组合编译一份**独立的程序**。运行时绑定到绘制调用上的是其中一份程序，GPU 侧没有任何「开关值」可读。

与它配套的是 ShaderLab 的**属性 → 关键字**桥：`[Toggle(KEY)]`、`[KeywordEnum(A, B)]` 这类 `MaterialPropertyDrawer` 把 Inspector 上画出来的控件状态翻译成材质上的关键字集合。被装饰的那个属性（例如 `_EmissionOn`）**不需要出现在常量缓冲里，也不需要被 shader 代码读取** —— 它的唯一职责就是驱动关键字。

### 取值与语义

关键字的「取值」只有两种：**定义 / 未定义**。所有差异都来自声明方式：

| 声明 | 变体集合由谁决定 | 打包时是否保留 | 典型用途 |
|---|---|---|---|
| `#pragma shader_feature _K` | 构建里材质实际用到的关键字组合 | 没用到的**会被剥离** | 材质级开关（自发光、法线贴图） |
| `#pragma multi_compile _K` | 声明的全部组合，无论谁用 | 全部保留 | 运行时切换、管线注入（阴影、雾） |
| `#pragma shader_feature_local _K` | 同上，且关键字**不占全局关键字空间** | 同上 | 只影响本 shader 的开关 |
| `#pragma shader_feature_local_fragment _K` | 同上，且只为**片元阶段**编译差异 | 同上 | 只影响片元结果的开关 |
| `#pragma shader_feature_local _ A B C` | 多选一：`_` 是「一个都不选」的那个状态 | 同上 | 枚举型模式（方向、质量档） |

阶段后缀还有 `_vertex` / `_geometry` / `_hull` / `_domain`；多选一语法里的 `_` 不是关键字，而是「全集都不定义」的占位（`_ A B C` 共 4 个组合），它必须写在第一位。

### 底层机制

编译一个变体时，编译器会为它**预设宏**：启用的关键字被定义为值为 1 的宏，未启用的不定义。于是 `#ifdef` / `#ifndef` / `#if` 都能正常工作，预处理阶段就会把代码剪掉。URP 的自发光采样函数正是这种写法：

```hlsl
// urp/ShaderLibrary/SurfaceInput.hlsl:53-60
half3 SampleEmission(float2 uv, half3 emissionColor, TEXTURE2D_PARAM(m, s))
{
#ifndef _EMISSION
    return 0;                 // ← 关闭变体里，下面是根本不存在的代码
#else
    return SAMPLE_TEXTURE2D(m, s, uv).rgb * emissionColor;
#endif
}
```

ShaderLab 侧只是一个开关属性加一条 pragma：

```shaderlab
// 通用示例
Properties
{
    [Toggle(_EMISSION)] _EmissionOn("Emission", Float) = 0
    [HDR] _EmissionColor("Emission Color", Color) = (0,0,0,1)
}
// …
HLSLPROGRAM
#pragma shader_feature_local_fragment _EMISSION
ENDHLSL
```

`_EmissionOn` 只驱动关键字；`#ifndef _EMISSION` 里做的处理是**编译期剪枝**，不是运行期的条件跳转。

### 可观察现象与边界

| 写法 | 关闭时会发生什么 | 语义 |
|---|---|---|
| `#ifndef _EMISSION return 0;` | 采样指令、常量读取**都不存在**；采样器与纹理绑定也不再被这条路径使用 | 编译期「有/无」 |
| `return SAMPLE(...).rgb * color * _EmissionOn;` | 采样照做、常量照读，只是结果被乘掉；带宽与指令全部保留 | 运行期「数值」，可插值、可被脚本改、可逐实例 |
| `#ifdef` 与 `#if _EMISSION` | 等价（关键字被定义成 1） | —— |

⚠️ 边界与坑：

- **变体剥离**：`shader_feature` 的变体按构建里实际使用的组合收集。编辑器里关键字是即时编译，所以永远正常；打包后若没有任何材质开过该关键字，player 里可能没有这份程序，运行时 `EnableKeyword` 会静默失效（现象：「编辑器正常、真机不亮」）。要么保证构建里有材质开过它，要么用 Shader Variant Collection / Always Included Shaders 兜底。
- **脚本改数值 ≠ 开关键字**：`[Toggle(KEY)]` 只在 Inspector 绘制该属性时同步关键字。用脚本直接改那个 Float 不会开关键字，必须显式 `material.EnableKeyword("_EMISSION")`。
- **关键字不能逐实例**：一个绘制批次绑定一份变体程序；同一批次内不可能一半实例跑「有关键字」的程序、一半跑「无关键字」的程序。要按实例区分，只能用**数值**（见第 5 节），不能用关键字。
- **变体数量是乘法**：每个关键字维度都会让程序数量翻倍，而 `multi_compile` 还会被全部保留。关键字越多，导入时间、包体与内存里的变体集合都在膨胀 —— 这正是「什么时候该用 `shader_feature`、什么时候干脆用数值」的取舍依据。

---

## 2. 发射项在光照方程里的位置

### 它是什么

自发光（emission）在 PBR 着色里是一个**独立的颜色通道**，不参与 BRDF。管线把它从表面数据搬到光照结果结构里，最后作为**加法项**加进最终颜色：

- 表面数据层：`SurfaceData.emission`（`urp/ShaderLibrary/SurfaceData.hlsl:12`，类型是 `half3`）；
- 光照合成层：`LightingData.emissionColor`（`Lighting.hlsl:143-150`）；
- 最终颜色：`CalculateLightingColor` 的最后一个加法（`Lighting.hlsl:152-189`）。

它是「光照合成」这一层的成员，而不是「BRDF / 光照计算」这一层的成员 —— 这个归属就是它全部行为的原因。

### 取值与语义

```hlsl
// Lighting.hlsl:152-189（省略 Debug 分支的写法）
half3 CalculateLightingColor(LightingData lightingData, half3 albedo)
{
    half3 lightingColor = 0;
    lightingColor += lightingData.giColor;              // 环境/烘焙 GI
    lightingColor += lightingData.mainLightColor;       // 主光
    lightingColor += lightingData.additionalLightsColor;
    lightingColor += lightingData.vertexLightingColor;
    lightingColor *= albedo;                            // ← 光照项在这里被 albedo 缩放
    lightingColor += lightingData.emissionColor;        // ← 发射项在这之后单独相加
    return lightingColor;
}
```

语义上一句话就能说清：**`final = Σ(带衰减的光照项，其中已含 albedo) + emission`**，发射项与所有携带光照信息的项分居 `+` 的两侧。各衰减实际乘在谁身上：

| 衰减来源 | 代码位置 | 乘在谁身上 | emission 是否受影响 |
|---|---|---|---|
| 光色 / `N·L` / 阴影 | `LightingPhysicallyBased(..., light.color, light.direction, light.distanceAttenuation * light.shadowAttenuation, ...)`（`Lighting.hlsl:75-78`） | `mainLightColor`、`additionalLightsColor` | ❌ |
| 阴影取值本身 | `light.shadowAttenuation = MainLightRealtimeShadow(...)`（`RealtimeLights.hlsl:121-128`） | 同上 | ❌ |
| 屏幕空间 AO | `GetMainLight(inputData, shadowMask, aoFactor)` → `light.color *= aoFactor.directAmbientOcclusion`（`RealtimeLights.hlsl:145`，附加光 `:289`） | 同上 | ❌ |
| GI / 材质自带的 AO | `GlobalIllumination(..., aoFactor.indirectAmbientOcclusion, ...)`（`Lighting.hlsl:290-292`） | `giColor` | ❌ |
| albedo | 由 `InitializeBRDFData` 折进 `brdfData.diffuse`（`BRDF.hlsl:86-106`）后进入各光照项 | 全部光照项 | ❌ |

### 底层机制

有三个容易读错的地方，都值得单独说明：

1. **`*= albedo` 在 PBR 路径下乘的其实是 1。** `UniversalFragmentPBR` 的收尾是 `return CalculateFinalColor(lightingData, surfaceData.alpha);`（`Lighting.hlsl:346`），而那个重载是 `CalculateLightingColor(lightingData, 1)`（`:191-196`）—— albedo 早已由 `InitializeBRDFData(surfaceData, brdfData)` 折进 `brdfData.diffuse`，随 BRDF 进入各项。所以 `*= albedo` 只是「albedo 归属」的书写位置，**发射项不在被乘的集合里**这一点不变。
2. **`if (IsLightingFeatureEnabled(...))` 不是开关。** 它的实现是（`DebuggingCommon.hlsl:146-153`）：`DEBUG_DISPLAY` 变体里读取 `_DebugLightingFeatureFlags`，否则恒 `return true`。正常渲染的变体里 `+= emissionColor` 是无条件执行的。
3. **搬运过程不做任何加工。** `lightingData.emissionColor = surfaceData.emission;`（`Lighting.hlsl:217-228`）—— 从表面数据到最终颜色之间，emission 没有经过任何 BRDF、没有乘任何衰减。

### 可观察现象与边界

- **黑 albedo 的物体照样发光**：光照项全灭，加项还在。这正是自发光被用来做灯带、屏幕、霓虹字的原因。
- **不透明物体的「亮」不等于「被照亮」**：它不随场景灯光与阴影变化，`Receive Shadows` 之类的开关对它无效。
- **想让发光受阴影影响，必须自己写**：在 PBR 收尾之后再把它加进颜色、自己乘衰减。写进 `surfaceData.emission` 通道就一定是「不受衰减」的语义。
- **⚠️ 同一通道是被共享的**：任何额外写进 `emission` 通道的效果（边缘光、溶解边缘等）都会享受同样的「不吃阴影/AO」待遇，并且彼此是**相加、无归一化**的。多个来源都可 >1 时，叠在同一个像素上会一起越过 Bloom 阈值糊白 —— 要么分工，要么各自压低强度。
- **⚠️ 雾在它之后**：常见的片元收尾是先做光照合成（含发射项）、再 `MixFog`。所以远处的自发光会被雾色拉走；若要「穿透雾」，必须把发射项加到 `MixFog` 之后，而那也意味着绕开 `surfaceData.emission` 这条通道。

---

## 3. 贴图 × 颜色：乘法语义与「默认态无贡献」

### 它是什么

自发光的数值通常由两项相乘得到：**贴图提供空间图案（掩膜），颜色提供整体强度与色相（增益）**。外面再可选地套一层关键字短路。

它位于两个不同层的交界处：`_EmissionMap` 是**纹理与采样器绑定**（资源侧），`_EmissionColor` 是**常量缓冲里的向量**（数据侧）。两者在 shader 里相乘，然后写进表面数据的 emission 通道。

### 取值与语义

```text
emission.rgb = _EmissionMap.rgb × _EmissionColor.rgb      （仅当关键字变体存在）
```

| 量 | 默认值 | 语义 | 谁能改 |
|---|---|---|---|
| `_EmissionMap` | `"black"`（1×1 黑纹理） | 采样结果 0 ⇒ 乘法归零 | 材质（贴图引用） |
| `_EmissionColor` | `(0, 0, 0, 1)` | rgb = 0 ⇒ 乘法归零（a 通常不参与运算） | 材质，或逐实例数据（若声明为逐实例属性） |
| `_EMISSION` | 关 | 变体短路 | 材质 / 变体 |

三个默认值指向同一设计意图：**默认态即「无贡献」**，新建材质不会莫名其妙发光。`[HDR]` 只是把拾色器换成带 Intensity 的那套并允许 >1（详见第 4 节），`[NoScaleOffset]` 则声明「这个贴图不复用 `_ST` 平铺偏移」——两者都不产生 shader 分支。

### 底层机制

- **ShaderLab 的 `Properties` 与 HLSL 的声明是两套东西。** `Properties` 块只负责「这个材质存哪些值、Inspector 怎么画」；shader 代码里的 `TEXTURE2D(_EmissionMap); SAMPLER(sampler_EmissionMap);` 才是编译期可见的声明。URP 把自发光贴图的声明放在公共头文件里（`SurfaceInput.hlsl:15-16`），所以使用它的 shader 不需要（也不应该）重复声明 —— 重复声明会变成重定义错误。
- **UV 不来自贴图属性，而来自顶点阶段。** 采样用的 UV 由顶点着色器算好、插值给片元（典型写法 `output.uv = TRANSFORM_TEX(input.texcoord, _BaseMap)`）。也就是说，**自发光贴图用哪套 UV** 取决于 shader 把这个 `uv` 给了哪次采样，而不取决于贴图本身。若属性带 `[NoScaleOffset]`，材质里就没有对应的 `_EmissionMap_ST`，也就不存在按材质独立平铺的前提。
- **改平铺要动 shader，而不是动勾选。** 想让自发光贴图有独立的 Tiling/Offset，需要：把 `_EmissionMap_ST` 加进 `UnityPerMaterial` 常量缓冲（否则 SRP Batcher 的布局一致性被破坏，见 `urp/Shaders/LitInput.hlsl:14` 的注释）、去掉 `[NoScaleOffset]`、在采样前单独做一次 `TRANSFORM_TEX`。
- **`.rgb` 与 `.a` 的取舍是 shader 写死的。** URP 的 `SampleEmission(uv, color, ...)` 取贴图 `.rgb` 乘传入颜色的 `.rgb`；alpha 通道是否参与、参与在哪一步，完全由 shader 决定（有些效果会用颜色 alpha 做强度遮罩，那就要显式乘进去）。

### 可观察现象与边界

- **「勾了开关还是不亮」的两个数值原因**：贴图仍是默认黑、颜色仍是默认 0 —— 乘法里只要有一项为 0，结果就是 0，与另一项多大无关。
- **贴图与主贴图共用 UV 时的连锁现象**：改了主贴图的平铺，自发光图案会跟着变；这不是 bug，是同一次 `TRANSFORM_TEX` 的结果。
- **⚠️ 默认值「无贡献」的代价**：默认值同时也是「未设置」的哨兵值。如果某层封装用「值等于默认值就不生成覆盖数据」来省内存（很常见），就会出现**无法把参数显式覆写为默认值**的问题（例如想把颜色改回黑，却发现覆盖根本没被写进去）。数值语义与「是否设置」的语义混在一个默认值上，是这类接口的固有陷阱。

---

## 4. `[HDR]`、颜色缓冲位深与 Bloom 的因果链

### 它是什么

这一节实际涉及三个不同层的东西，常被混为一谈：

| 东西 | 所在层 | 作用 |
|---|---|---|
| `[HDR]` 属性装饰器 | ShaderLab 属性 / Inspector | 换拾色器，约定该值可以大于 1 |
| 颜色缓冲格式 | 渲染目标（GPU 资源） | 决定 >1 的值**存不存得住** |
| Bloom | 后处理（独立 pass + Volume） | 把「超过阈值的像素」提取、模糊、加回 |

### 取值与语义

- `[HDR]`：材质里存的就是普通浮点分量，`(4, 1, 0.5, 1)` 完全合法；它不产生任何 shader 分支。
- 颜色缓冲：URP 按相机的 `allowHDR` 与管线资产的 `supportsHDR` 决定是否用 HDR（`UniversalRenderPipeline.cs:1167`），格式由 `MakeRenderTextureGraphicsFormat` 挑选（`UniversalRenderPipelineCore.cs:1416-1429`）：

| 情况 | 典型格式 | 能表示 >1 吗 |
|---|---|---|
| HDR 开启、不需要 alpha | `B10G11R11_UFloatPack32` 等浮点 | ✅ |
| HDR 开启、需要 alpha | `R16G16B16A16_SFloat` | ✅ |
| HDR 关闭 | `DefaultFormat.LDR`（8 位定点，如 `R8G8B8A8`） | ❌（截断到 1） |

- Bloom 的阈值：Inspector 上默认 `0.9`（`urp/Runtime/Overrides/Bloom.cs:35`），使用前被转成线性空间（`urp/Runtime/Passes/PostProcessPass.cs:1114-1120`：`Mathf.GammaToLinearSpace(m_Bloom.threshold.value)`），比较发生在**线性空间**。

### 底层机制

**第一步：量化。** 8 位定点缓冲每通道只有 0..1 的表达范围，于是 `[HDR]` 给的 4.0 会被**截断到 1.0**。后果不是「暗一点」，而是**相对亮度信息被抹平**：3.0 与 10.0 变成同一个 1.0，「更亮」这个序关系消失。HDR 缓冲的意义正在于此 —— 让超出 1 的部分活着穿过光栅化，交给后处理使用。

**第二步：阈值提取。** Bloom 的 prefilter 在每像素上取通道最大值并与阈值比较（`urp/Shaders/PostProcessing/Bloom.shader:99-104`）：

```hlsl
half brightness = Max3(color.r, color.g, color.b);
half softness = clamp(brightness - Threshold + ThresholdKnee, 0.0, 2.0 * ThresholdKnee);
softness = (softness * softness) / (4.0 * ThresholdKnee + 1e-4);
half multiplier = max(brightness - Threshold, softness) / max(brightness, 1e-4);
color *= multiplier;                    // multiplier > 0 的像素才会被提取、模糊、加回
```

阈值处有一段软过渡（`ThresholdKnee`），避免亮度刚好在阈值上的像素产生硬边。提取出来的亮部进入低分辨率 mip 链做模糊，再按强度加回主画面。

**因果链**：

```text
emission(可 >1) ─▶ 颜色缓冲（HDR 才存得住 >1）─▶ 最终颜色的 max(r,g,b)
   ─▶ 与 Threshold 比较、multiplier > 0 ─▶ 提取到低分辨率 mip ─▶ 模糊 ─▶ 按强度加回
```

### 可观察现象与边界

- **「很亮」与「发光」是两件事**：不透明物体被强光照亮也能超过阈值而泛光；自发光之所以适合做灯带/屏幕，是因为它是**不受光照、阴影、AO 影响的恒定超阈值源** —— 关灯、进阴影，它依然稳定越过阈值。
- **⚠️ LDR 下所有 >1 塌成同一个白**：在 8 位缓冲里，`[HDR]` 的 Intensity 调到 2 还是 20 都只影响「是白」，不影响 Bloom 提取多少 —— 后处理拿不到那个差。
- **⚠️ 阈值比较的是「最终颜色」**：emission 只是其中最可控的那一项。
- **⚠️ HDR 不等于辉光**：相机开了 HDR、但没有 Bloom 的 Volume override，HDR 缓冲里那部分只是「亮」，不会扩散。
- **⚠️ Bloom 不会照亮别的物体**：它是屏幕空间对已有像素的模糊与加回，没有「发光材质相互照明」这件事（那属于 GI / light probe 的范畴）。

---

## 5. 逐实例材质属性的数据分层

### 它是什么

同一个「材质属性」的值，在 GPU 侧可能来自三个完全不同的地方。理解这三层，才能理解「哪些参数能逐实例改、哪些不能、没设置时读到什么」。

| 层 | 存放位置 | 谁写 | 能否逐实例 |
|---|---|---|---|
| ① 材质常量缓冲 | `CBUFFER_START(UnityPerMaterial)` 内的变量（如 `half4 _EmissionColor`，`LitInput.hlsl:15-32`） | 材质 / 批次 | ❌ |
| ② 逐实例数据 | 每批次一块实例数据缓冲（`ByteAddressBuffer`，`core/ShaderLibrary/UnityDOTSInstancing.hlsl:183`），按属性分条、SoA 排布 | 渲染框架从实体组件上传 | ✅ |
| ③ 全零保留区 | 持久缓冲偏移 0 处的 16 字节零 | 框架一次性写入 | —— |

### 取值与语义

逐实例属性的声明分两步（URP Lit 就是标准范例）：

```hlsl
// urp/Shaders/LitInput.hlsl:37-54 —— 声明哪些属性参与逐实例
#ifdef UNITY_DOTS_INSTANCING_ENABLED
UNITY_DOTS_INSTANCING_START(MaterialPropertyMetadata)
    UNITY_DOTS_INSTANCED_PROP(float4, _Color)
    UNITY_DOTS_INSTANCED_PROP(float4, _EmissionColor)
    UNITY_DOTS_INSTANCED_PROP(float , _Cutoff)
UNITY_DOTS_INSTANCING_END(MaterialPropertyMetadata)
// …
```

读取时用带缺省的访问宏：

```hlsl
// core/ShaderLibrary/UnityDOTSInstancing.hlsl:160-164（简化了中间一个 REQUIRED 分支）
#define UNITY_ACCESS_DOTS_INSTANCED_PROP_WITH_DEFAULT(type, var) \
  ( UNITY_DOTS_INSTANCED_PROP_IS_OVERRIDE_ENABLED(var) ? LoadDOTSInstancedData_##type(var, METADATA(type, var)) \
                                                       : (var) )
```

每个属性的「地址」被编码进一个 uint（`UnityDOTSInstancing.hlsl:225-226`、`:300-303`）：

| 位 | 含义 | 判据 |
|---|---|---|
| bit31 | 该属性是否走逐实例数据流 | `IsDOTSInstancedProperty(metadata) = (metadata & 0x80000000) != 0` |
| bit0-30 | 缓冲内地址 | 与地址掩码 `0x7fffffff` 相与 |

**一句话语义**：`IsDOTSInstancedProperty(metadata) ? 读逐实例流 : 默认表达式`。宏管的是**选址**（从哪条流读），它不承诺默认表达式里是什么。

### 底层机制

**（a）逐实例数据是 SoA 流。** 框架为每个属性分配 `NextAlignedBy16(SizeBytesGPU × numInstances)` 的连续区间（`entities.graphics/Unity.Entities.Graphics/EntitiesGraphicsSystem.cs:2438-2443`），实例 `i` 的值位于 `streamBegin + i × size`（同文件 `:2476-2479`）。这套机制只对**常量缓冲里的标量/向量**成立。

**（b）哪些属性成为逐实例流，由「图形原型」决定。** 批次按（材质、网格、组件集合）划分；一个批次的 override 列表只包含该原型**实际拥有的** `MaterialProperty` 组件（`GraphicsArchetype.cs:151-187`）。没有实体拥有某组件时，该批次根本不会为这个属性注册任何逐实例数据。

**（c）把读操作收敛到一处，是性能优化而非必需。** URP Lit 的注释把理由写得很直白（`urp/Shaders/LitInput.hlsl:56-65`）：不要写成 `#define _Color UNITY_ACCESS_DOTS_INSTANCED_PROP_WITH_DEFAULT(float4, _Color)`，否则编译器可能在每个使用点重新生成属性加载代码；改成先把值缓存进静态变量、再把属性名重定向到该静态变量：

```hlsl
// urp/Shaders/LitInput.hlsl:66-104（节选）
static float4 unity_DOTS_Sampled_EmissionColor;
void SetupDOTSMaterialPropertyCaches() {
    unity_DOTS_Sampled_EmissionColor = UNITY_ACCESS_DOTS_INSTANCED_PROP_WITH_DEFAULT(float4, _EmissionColor);
}
#undef  UNITY_SETUP_DOTS_MATERIAL_PROPERTY_CACHES
#define UNITY_SETUP_DOTS_MATERIAL_PROPERTY_CACHES() SetupDOTSMaterialPropertyCaches()
#define _EmissionColor unity_DOTS_Sampled_EmissionColor
```

这个缓存钩子挂在 `UNITY_SETUP_INSTANCE_ID` 上 —— core 包在 DOTS 开启时把它重定义为 `DEFAULT_UNITY_SETUP_INSTANCE_ID(input); SetupDOTSVisibleInstancingData(); UNITY_SETUP_DOTS_MATERIAL_PROPERTY_CACHES(); …`（`core/ShaderLibrary/UnityInstancing.hlsl:264-268`）。非 DOTS 变体里这些宏不生效，属性名仍然指向常量缓冲成员（此时 core 的 `WITH_DEFAULT` 宏直接展开为 `var`，`UnityInstancing.hlsl:284`）。

**（d）缺省值从哪来** —— 三种情形要分开看：

| 情形 | metadata | 宏走哪条分支 | 实际读到的值 |
|---|---|---|---|
| 属性被注册为逐实例，且该实例有数据 | bit31=1 + 地址 | 读逐实例流 | 逐实例数据 |
| 属性未被注册为逐实例（批次原型里没有该组件） | 0（无 bit31） | 默认表达式 | 见下方 ⚠️ |
| 解析结果落到地址 0 | 0（或指向零区） | 若判为逐实例则读地址 0 | **全零**（框架保留了零区） |

框架在持久缓冲的偏移 0 处显式保留了一块零，并断言它就是地址 0（`EntitiesGraphicsSystem.cs:1034-1045`：`// Globally allocate a single zero matrix at offset zero, so loads from zero return zero`）。官方文档对同类情形（属性声明为逐实例却没有配套的 `IComponentData`）的用词也是 **zero fill**（`entities.graphics/Documentation~/material-overrides-code.md:90`）。凡是「没有逐实例数据」的情形都落到零，**不会读到显存里的垃圾** —— 这是这一层的关键保证。

> ⚠️ **精确边界（推算，未逐变体反汇编验证）**：宏的默认分支落在调用点写的那个 token 上。URP Lit 的缓存函数写在 `#define _EmissionColor unity_DOTS_Sampled_EmissionColor`（`LitInput.hlsl:104`）**之前**（`:85`），所以那里展开的是 `UnityPerMaterial` 的属性槽位；也就是说**宏这一层理论上保留了「回落到材质值」的形态**，而「没设置就读到 0」是**数据层**（未注册 + 零填充 / 地址 0）给出的结果。两者不矛盾，但都不构成可依赖的默认值。实践规则只有一条：**要么不提供覆盖（意图是沿用材质值），要么提供就显式给初值**。

**（e）为什么贴图不可能逐实例。** per-instance 的本质是「同一缓冲的不同偏移」，而纹理是**资源绑定**（descriptor / sampler 槽位），由绘制调用在管线状态里绑定，实例 ID 无法索引它。所以：

| 参数类型 | 能否逐实例 | 逐实例 / 变化的机制 |
|---|---|---|
| 颜色、标量、向量 | ✅ | 逐实例数据流的偏移 |
| 纹理、采样器 | ❌ | 只能换材质；框架侧对应「材质/网格选择」（如 `MaterialMeshInfo` / `RenderMeshArray` 那一层），每个材质一个批次 |

推论：想让不同实例用不同贴图，代价是**批次数量上升**（每多一个材质就少一分合批收益），这也是「用顶点色 / 参数化图案 / 图集 + UV 偏移来替代多材质」这类做法的动机。

### 可观察现象与边界

- **「没提供覆盖数据」= 0，而不是材质面板上的值**：这是最常见的一类「预览里好好的，批量渲染后一片黑」的原因（颜色类参数表现为纯黑，标量类参数表现为 0）。
- **⚠️ 类型与顺序必须与声明一致**：逐实例数据的布局是按声明顺序与类型大小排的；类型对不上（例如声明 `float4` 却按 `float` 上传）会让缓冲布局错位，现象是整批参数错乱而非编译报错。
- **⚠️ 便利封装的陷阱**：若封装层用「值等于默认值就不生成覆盖」来省内存，那么「显式覆写为 0/黑」这件事就做不到 —— 与第 3 节末尾同源；需要「每实例不同贴图」时也必须走拆材质 / 图集，而不是继续找某个逐实例属性。

---

## 6. `MaterialProperty` 与同名属性映射

### 它是什么

`[MaterialProperty("_Name")]` 是渲染框架提供的**绑定机制**：给一个 `IComponentData` 结构体打上这个特性，就把「实体上的该组件」映射到「shader 里名为 `_Name` 的属性」，从而走上第 5 节里的逐实例数据流。

它的关键在一句话：**属性名是唯一键**。名字通过 `Shader.PropertyToID(name)` 变成一个整数 nameID，注册表记的是「组件类型 → 属性名」，而反查表记的是「nameID → 属性」。

### 取值与语义

| 约束 | 内容 |
|---|---|
| 名字 | 字符串必须与 shader 里的属性名**逐字一致**（含下划线） |
| 类型 | 一个组件类型只能绑一个属性名；**多个组件类型可以绑同一个属性名**（注册表注释原文：`Several types can override one property, but not the other way around`，`EntitiesGraphicsSystem.cs:1180-1182`） |
| 数据布局 | 组件的字段大小必须与 shader 侧声明的类型一致 |
| 预算 | 每个声明为材质属性的组件类型都占用类型预算（`ComponentTypeCache.cs:82`：`kMaxTypes = 128`），**与实体是否使用无关** |

URP 的内置映射是现成例子：`Unity.Rendering.URPMaterialPropertyEmissionColor` 就映射到 `_EmissionColor`（`URPMaterialPropertyEmissionColorAuthoring.cs:8-12`），并带 `[ColorUsage(true, true)]` 的 HDR 拾色器。

### 底层机制

1. **注册**：类型 → 名字写进一张 `Dictionary<Type, NamedPropertyMapping>`（`EntitiesGraphicsSystem.cs:1171-1197`）。同名不是错误 —— 注释明确允许。
2. **建表**：初始化时遍历所有注册类型，把「类型索引 → 属性」与「nameID → 属性」两张表都填上；后者是 **`NativeParallelMultiHashMap`**（`:1234-1235`、`:921`），即一个 nameID 可以挂多条记录。
3. **生成逐实例流**：图形原型收集自己拥有的材质属性组件时，只按 `NameID` 记录（`GraphicsArchetype.cs:161-167`）。
4. **提交**：批次的元数据数组按属性逐条给出 `NameID + 地址`（`EntitiesGraphicsSystem.cs:2481-2496`）。若两个组件类型同名、且同一实例同时拥有它们，这个数组里就会出现**两条 NameID 相同、地址不同**的条目 —— 而 shader 里只有一个 `_EmissionColor` 可读。

### 可观察现象与边界

- **⚠️ 静默冲突**：同一实体挂两个映射到同一属性的组件时，读到哪一条取决于元数据数组的顺序（也就是类型注册/枚举顺序）。按上述数据结构推算，这一步**不会报错**，只会静默取其中一个 —— 开发期几乎不可见，只在画面差异上暴露。此结论为推算，未实跑验证框架对重名条目的具体取舍。
- **代价不止是取值**：两个类型各占一份 128 类型预算；如果两者 GPU 侧大小不一致，批次的实例数据布局也会随之变化。
- **实用规则**：同一属性使用**一个**映射来源（要么用管线自带的那套组件，要么自定义一套），不要混用。
- **预算意识**：`kMaxTypes = 128` 是硬上限，声明得多就占得多 —— 只把运行时真会逐实例变化的参数做成材质属性组件，静态参数留在材质上；拼错属性名同样不报错，只会因「未注册」而缺省为零，现象与「组件没加」一样。

---

## 7. 透明与预乘 alpha 对发射项的影响

### 它是什么

透明不是「把颜色变淡」，而是**输出合并阶段的一次硬件混合**。理解它需要三个概念：混合方程、混合因子、以及预乘 alpha。发射项的特殊之处在于：它在 shader 里已经被加进最终颜色，所以混合阶段的一切都会作用在它身上。

### 取值与语义

混合方程（每个像素、每个通道独立计算）：

```text
Result = SrcFactor × Src  (BlendOp)  DstFactor × Dst
```

| `BlendOp` | 含义 |
|---|---|
| `Add`（默认） | `Src×F + Dst×F` |
| `Sub` | `Src×F − Dst×F` |
| `RevSub` | `Dst×F − Src×F` |
| `Min` / `Max` | 逐通道取小 / 取大（因子在 Min/Max 下被忽略） |

常用因子（`SrcFactor` / `DstFactor` 各自取值）：

| 因子 | 值 |
|---|---|
| `One` / `Zero` | 1 / 0（`Zero` 用于「不透明」与「只写目标」） |
| `SrcColor` / `OneMinusSrcColor` | 源颜色 / `1 − 源颜色` |
| `DstColor` / `OneMinusDstColor` | 目标颜色 / `1 − 目标颜色`（乘法混合用它） |
| `SrcAlpha` / `OneMinusSrcAlpha` | 源 alpha / `1 − 源 alpha`（常规透明） |
| `DstAlpha` / `OneMinusDstAlpha` | 目标 alpha 通道 |
| `SrcAlphaSaturate` | `min(src.a, 1 − dst.a)`（加法混合用于叠加时不溢出） |

ShaderLab 语法上，颜色与 alpha 可以**分开指定**：`Blend SrcAlpha OneMinusSrcAlpha, One OneMinusSrcAlpha`（逗号前是 RGB、逗号后是 alpha）。常见组合与它们的效果：

| 意图 | 写法 | 效果 |
|---|---|---|
| 不透明 | `Blend One Zero` | 直接覆盖 |
| 常规透明 | `Blend SrcAlpha OneMinusSrcAlpha` | 结果被源 alpha 线性插值 |
| **预乘** | `Blend One OneMinusSrcAlpha` + shader 里 `color.rgb *= color.a` | 同上，但 ×alpha 在 shader 里做 |
| 加法发光 | `Blend SrcAlpha One` | 叠加到目标上，不会变暗 |
| 乘法变暗 | `Blend DstColor Zero` | 结果 = 目标 × 源 |

### 底层机制

- **混合发生在光栅化输出合并（ROP / OM）阶段**，输入是片元着色器写出的 `SV_Target` 与当前渲染目标的内容。所以同一像素的最终结果**取决于绘制顺序** —— 混合不可交换，`Add` 也不满足交换律，这正是透明队列必须**从远到近**绘制的原因（见[第一篇](/blog/blog/customlit-passes/)的 Render Queue 与排序）。
- **预乘 alpha 是把一次乘法从硬件搬到 shader。** 常规透明用 `SrcAlpha` 因子让硬件做 `×a`；预乘则让 shader 先输出 `rgb×a`，硬件用 `One`。为什么值得搬？因为 shader 之后的**所有加性环节**（加法混合、Bloom、雾）作用的对象变了：预乘后的颜色已经缩过一次，不会被重复乘 alpha，也让加法混合的语义更直观。
- **发射项的位置决定了它必然被缩放。** 片元收尾是「光照合成（含 emission）→ 预乘（如启用）→ 雾」：

```hlsl
// 通用写法
half4 color = UniversalFragmentPBR(inputData, surfaceData);   // emission 已在 color 里
#if defined(_ALPHAPREMULTIPLY_ON)
    color.rgb *= color.a;                                     // ← 这一刀切在含 emission 的颜色上
#endif
color.rgb = MixFog(color.rgb, inputData.fogCoord);
```

### 可观察现象与边界

- **半透明材质的自发光比预期暗**：预乘模式下被 `×a` 缩放过。即使走「常规透明」模式（shader 里不乘），硬件的 `SrcAlpha` 因子同样让最终贡献被 alpha 缩放 —— 视觉相近，但**进入 Bloom 与雾的量不同**（预乘后的颜色更小，可能掉到 Bloom 阈值以下）。
- **加法混合里「发光叠加」的行为被改写**：`Blend SrcAlpha One` 时源颜色乘的是 alpha；若同时又开了预乘，alpha 会被乘两遍（这是「明明写了预乘却更暗」的常见原因）。二者选一。
- **⚠️ 透明物体通常不写深度**（否则自身互相遮挡），这会让后续依赖深度测试的效果与预测不同；深度状态的完整取值见第一篇。
- **⚠️ 雾在发射项之后**：想要「穿透雾的灯光」必须把发射项加到 `MixFog` 之后。
- **⚠️ 顺序即正确性**：透明物体之间、透明与不透明之间的绘制顺序由队列与排序决定；自发光强度、Bloom 阈值这些参数都无法弥补错误的绘制顺序。

---

**把七节收成一句**：自发光这个效果之所以「简单」，是因为它只做加法；而它之所以容易出错，是因为那一个加项同时穿过四条彼此独立的机制 —— **编译期**（关键字决定它存不存在）、**光照合成**（位置决定它不吃衰减）、**颜色缓冲与后处理**（位深决定它亮不亮得起来）、**数据分层与混合状态**（决定谁能改它、以及最终有多少进入画面）。
