---
title: 'URP 贴花全流程：让 Shader 接受贴花、在 Frame Debugger 里看 DBuffer、以及 Albedo Normal MAOS 到底怎么用'
description: '从"贴花本质是一张屏幕空间缓冲"讲起：Renderer 上怎么开、Surface Data 与 RT 数量怎么对应、自定义 Shader 要加哪四段代码才能接收贴花（关键字、include、调用点、DepthNormals Pass）、为什么必须是 multi_compile 而不能是 shader_feature、DBuffer 的三张 RT 各自编码了什么、预乘与"反权重"为什么由 blend state 完成、投影器为什么采样的是"远端面"、Frame Debugger 里怎么逐张看 MRT、以及 Albedo Normal MAOS 的坑：默认 Decal shader 不输出 MAOS 时 RT2 为什么全黑且无效果、要自定义 Shader Graph 时掩码该怎么接'
pubDate: '2026-10-27'
category: 'Unity 渲染'
tags: ['Unity', 'URP', 'Decal', 'DBuffer', 'Frame Debugger', 'MAOS']
---

## 速览

>- **贴花不是"往物体上贴一张图"。** URP 的 DBuffer 路线是：先把贴花画进一张**屏幕空间**的缓冲（2~3 张 MRT），再由**每一个不透明 shader** 在光照计算前采样它、就地改写自己的表面数据。所以"接受贴花"是接收方 shader 的事。
>- **接收端要加四段代码**：MRT 关键字、`DBuffer.hlsl`、光照前的 `ApplyDecalToSurfaceData`、以及一个 `DepthNormals` Pass。少了 `DepthNormals`，prepass 里没有它的深度，贴花深度测试直接失败。
>- **关键字必须是 `multi_compile_fragment`**。`_DBUFFER_MRT1/2/3` 是管线在运行时用 `SetKeyword` 全局切换的；用 `shader_feature` 会被当作"没有材质用到"而在打包时裁掉，表现为"编辑器里好好的，出包后贴花全没了"。
>- **预乘和"反权重"不是 shader 写的，是 blend state 做的**：`Blend 0 SrcAlpha OneMinusSrcAlpha, Zero OneMinusSrcAlpha`。所以贴花 shader 里输出的是普通 straight alpha，DBuffer 里存下来却自动变成 `(color·α, 1−α)`。
>- **投影器采样的是盒子的远端面**（`Cull Front + ZTest Greater`）。这意味着"盒子往物体内部伸 20cm"会把图案投在表面后方 20cm 的平面上，斜视时明显偏移；正确做法是让远端面贴着表面（本文给公式）。
>- **`Albedo Normal MAOS` 的 RT2 默认是黑的，而且没有效果。** 因为 URP 自带的 `Shader Graphs/Decal` 不输出 Metallic/Occlusion/Smoothness，MAOS 的 alpha（覆盖度）默认 0 → 写完还是黑、接收方 lerp 权重为"中性"。想用 MAOS 就得自己写 decal Shader Graph。
>- **性能上**：prepass + 全屏采样是固定成本；投影器本身只有开了 `Enable GPU Instancing` 才会 `DrawMeshInstanced` 合批（每批上限 250）。

---

## 0. 先搞清楚贴花在管线里的位置

### 0.1 三条技术路线

URP 的 Decal Renderer Feature 有三种 Technique：

| Technique | 画到哪 | 是否需要 prepass | 能否改法线 | 典型用途 |
|---|---|---|---|---|
| **DBuffer** | 写进 N 张全屏 DBuffer，接收方采样合成 | **需要 DepthNormals prepass** | ✅（Albedo Normal / MAOS） | 桌面端、需要正确光照/法线 |
| Screen Space | 在不透明物体之后，用深度重建法线，直接画在屏幕上 | 需要深度（+法线） | 只能 normal blend | 移动端 TBDR、只要颜色 |
| Automatic | 按平台自动选（DBuffer / Screen Space / GBuffer） | 视结果 | 视结果 | 不推荐：**它不会读取你配的 DBuffer 参数** |

本文只讲 **DBuffer**。

### 0.2 DBuffer 路线的本质

一次相机渲染大致是这样：

```text
DepthNormals prepass         ← 提供深度（以及法线）
    ↓
Clear                        ← 把 DBuffer 清成"中性"值
    ↓
DBuffer Render               ← 画所有贴花投影器（MRT 输出 2~3 张）
    ↓
Opaque / Forward             ← 每个不透明 shader 采样 DBuffer，改写自己的 albedo/normal/MAOS
    ↓
光照、后处理
```

关键认知：**贴花和接收面之间没有几何关系**。贴花 pass 只是把"某个屏幕像素上的贴花数据"写进缓冲；接收面 shader 在片元里按自己的屏幕坐标去读这张缓冲，然后把结果混进自己的表面数据。所以：

- 贴花对接收面 shader 有硬性要求（下一章）；
- 贴花 pass 只需要**深度**做深度测试，不需要接收面的其它信息；
- 一个屏幕像素被几个投影器覆盖，是**按顺序混合**进 DBuffer 的，不是叠加画在屏幕上。

---

## 1. 在 Renderer 上开启

### 1.1 步骤

1. 选中 URP 的 **Renderer Data**（`Universal Renderer Data` 资产，通常在 `Assets/Settings/` 下）；
2. Inspector 最下方 **Add Renderer Feature → Decal**；
3. 勾选 **Active**；
4. **Technique = DBuffer**（不要用 Automatic）；
5. 选 **Surface Data**（决定要几张 RT）；
6. 按需设 **Max Draw Distance**；
7. **每个质量档用到的 Renderer 都要加一遍**——质量档各自绑定一个 Renderer Data，不是共享的。

### 1.2 Surface Data 与 RT 数量

配 `DecalSurfaceData` 的枚举值直接决定分配几张颜色 RT：

```csharp
// DBufferRenderPass.cs
int dBufferCount = (int)settings.surfaceData + 1;

// Albedo            = 0 → 1 张
// AlbedoNormal      = 1 → 2 张
// AlbedoNormalMAOS  = 2 → 3 张
```

| Surface Data | 颜色 RT | 关键字 | 能改的属性 |
|---|---|---|---|
| Albedo | `_DBufferTexture0` | `_DBUFFER_MRT1` | baseColor（+ emission） |
| Albedo Normal | `_DBufferTexture0/1` | `_DBUFFER_MRT2` | + 法线 |
| Albedo Normal MAOS | `_DBufferTexture0/1/2` | `_DBUFFER_MRT3` | + metallic/occlusion/smoothness |

还有一张 **depth-only** 的 `DBufferDepth`，只用于贴花 pass 的深度测试。

### 1.3 为什么别用 Automatic

Automatic 的逻辑是"按构建平台和管线模式自己选"（`DecalRendererFeature.GetTechnique`），它**不会**读你在 `dBufferSettings` / `screenSpaceSettings` 里配的参数。你按 DBuffer 的思路调好了 Surface Data，结果它选了 Screen Space，行为就完全不一样了。想稳，就手动选 DBuffer。

---

## 2. 接收端 Shader：让一个 shader 接受贴花

这一章是重点。假设你已经有一个不透明的 URP Lit 风格 shader，结构是：

```text
Forward Pass → 采样贴图 → 构造 SurfaceData → 构造 InputData → UniversalFragmentPBR → 输出
```

要让它"吃"贴花，只需要插入四段。

### 2.1 必要条件清单

| 条件 | 原因 |
|---|---|
| **不透明**（`_SURFACE_TYPE_TRANSPARENT` 没定义） | `DBuffer.hlsl` 里 `_DBUFFER` 宏的开关条件包含 `!defined(_SURFACE_TYPE_TRANSPARENT)`；透明物体在 DBuffer 路线里不支持 |
| **有 `DepthNormals` Pass** | DBuffer 路线要求 DepthNormals prepass，物体必须出现在 prepass 里才有深度可测 |
| **Forward Pass 里声明 MRT 关键字** | 决定编译出哪几个"接收贴花"的变体 |
| **include `DBuffer.hlsl`** | 提供 `ApplyDecalToSurfaceData` 与 `_DBUFFER` 宏 |
| **光照前调用 `ApplyDecalToSurfaceData`** | 它改的是 `SurfaceData` / `InputData`，晚于光照就等于白改 |

### 2.2 第 1 段：MRT 关键字

```hlsl
// Forward Pass 的 HLSLPROGRAM 里
#pragma multi_compile_fragment _ _DBUFFER_MRT1 _ _DBUFFER_MRT2 _ _DBUFFER_MRT3
```

- 第一个 `_` 是空选项 → 生成"不接收贴花"的变体；
- 后面三个分别对应 Surface Data 的三档；
- `_fragment` 后缀表示只在片元阶段产生变体（顶点阶段不读 DBuffer）。

`DBuffer.hlsl` 开头就是靠这个关键字来定义 `_DBUFFER`：

```hlsl
// DBuffer.hlsl:10-12
#if (defined(_DBUFFER_MRT1) || defined(_DBUFFER_MRT2) || defined(_DBUFFER_MRT3)) && !defined(_SURFACE_TYPE_TRANSPARENT)
#define _DBUFFER
#endif
```

所以后面所有贴花代码都可以写成 `#ifdef _DBUFFER` 包起来——**不接收贴花的变体连代码都不生成**。

### 2.3 第 2 段：include

```hlsl
#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DBuffer.hlsl"   // ← 新增
```

`DBuffer.hlsl` 自己会 include `Core.hlsl`、`SurfaceData.hlsl`、`Input.hlsl`、`DecalInput.hlsl`，所以放在靠后一点更安全。

### 2.4 第 3 段：光照前的调用点

```hlsl
void Frag(Varyings input, out half4 outColor : SV_Target0)
{
    // 1) 先按你自己的材质构造 SurfaceData
    SurfaceData surfaceData = (SurfaceData)0;
    surfaceData.albedo     = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, input.uv).rgb * _BaseColor.rgb;
    surfaceData.metallic   = _Metallic;
    surfaceData.smoothness = _Smoothness;
    surfaceData.occlusion  = 1.0;
    surfaceData.alpha      = 1.0;

    // 2) 构造 InputData（与 URP Lit 的 InitializeInputData 一致）
    InputData inputData = (InputData)0;
    InitializeInputData(input, surfaceData.normalTS, inputData);

    // 3) 贴花：改 surfaceData 和 inputData，必须在光照之前
#ifdef _DBUFFER
    ApplyDecalToSurfaceData(input.positionCS, surfaceData, inputData);
#endif

    // 4) 正常走光照
    half4 color = UniversalFragmentPBR(inputData, surfaceData);
    outColor = color;
}
```

几个容易踩的点：

- **参数是 `positionCS`，不是 UV**。DBuffer 内部用 `LOAD_TEXTURE2D_X(_DBufferTexture0, int2(positionCS.xy))` 按**像素坐标**直接读，不做归一化、不用采样器。传 UV 会全错。
- **顺序**：`ApplyDecalToSurfaceData` 会改 `surfaceData.albedo`、`surfaceData.metallic/occlusion/smoothness` 和 `inputData.normalWS`。放在 `UniversalFragmentPBR` 之前才有效；放在之后只是改了没人用的变量。
- **`#ifdef _DBUFFER` 是可选的**，但建议加：不接收贴花的变体可以省掉一整段代码和纹理绑定。

### 2.5 第 4 段：DepthNormals Pass

DBuffer 路线要求 `DepthNormals` prepass，所以接收方 shader 必须有一个 `LightMode = "DepthNormals"` 的 Pass。最小写法：

```hlsl
Pass
{
    Name "DepthNormals"
    Tags { "LightMode" = "DepthNormals" }
    ZWrite On
    Cull Back

    HLSLPROGRAM
    #pragma vertex   DepthNormalsVert
    #pragma fragment DepthNormalsFrag

    #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

    struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; };
    struct Varyings   { float4 positionCS : SV_POSITION; float3 normalWS : TEXCOORD0; };

    Varyings DepthNormalsVert(Attributes v)
    {
        Varyings o;
        o.positionCS = TransformObjectToHClip(v.positionOS.xyz);
        o.normalWS  = TransformObjectToWorldNormal(v.normalOS);
        return o;
    }

    half4 DepthNormalsFrag(Varyings i) : SV_TARGET
    {
        // 与 URP 内置 DepthNormalsPass 相同的编码：八面体法线 → 888 packing
        float2 oct    = PackNormalOctQuadEncode(normalize(i.normalWS)) * 0.5 + 0.5;
        half3  packed = PackFloat2To888(oct);
        return half4(packed, 0);
    }
    ENDHLSL
}
```

> 深度不用手写：`ZWrite On` + 顶点阶段输出的 `SV_POSITION` 就够了，prepass 会用这个 Pass 同时写深度和法线。

**没有这个 Pass 会怎样**：prepass 用 `ShaderTagId("DepthNormals")` 挑物体，你的物体被跳过 → 深度缓冲里没有它 → 贴花 pass 的 `ZTest Greater` 没有可比较的表面深度 → 该物体上完全看不到贴花，而且**不会报任何错**。

### 2.6 为什么是 `multi_compile` 而不是 `shader_feature`

这是最容易出包才炸的一个点。

| | `shader_feature` | `multi_compile` |
|---|---|---|
| 保留哪些变体 | **只保留材质上实际开启过的** | 所有列出的变体都保留 |
| 关键字由谁设置 | 材质 / 材质 Inspector | 运行时 `Shader.SetKeyword` 之类的**全局**设置也行 |
| `_DBUFFER_MRT2` 的来源 | 材质上没有人开过它 | `DBufferRenderPass` 每帧全局 `SetKeyword` |

DBuffer 的关键字是管线在渲染时全局设置的（`CoreUtils.SetKeyword(cmd, ShaderKeywordStrings.DBufferMRT2, ...)`），材质上根本不会记录。用 `shader_feature` 的话，打包时"没有任何材质用到这个变体"→ 整段被裁掉 → **编辑器里（变体还没裁）正常，出包后贴花消失**。

### 2.7 变体数量

`_DBUFFER_MRT1/2/3` + 空 = 4 个片元变体。如果 Surface Data 只用 `Albedo Normal`，可以只写两档：

```hlsl
#pragma multi_compile_fragment _ _DBUFFER_MRT2
```

少一个 RT 变体，少一份片元程序和一次纹理绑定。**但要注意：如果 Renderer 上改成 MAOS，这个 shader 就收不到贴花了**（没有对应变体）。

---

## 3. 贴花侧：材质、投影器，以及 DBuffer 的"反权重"

### 3.1 材质

- Shader：`Shader Graphs/Decal`（URP 自带）；
- `Base Map`：RGB = 颜色，**A = 不透明度（0 = 完全透明，1 = 完全覆盖）**；
- `Normal Map`：切线空间法线；
- `Normal Blend`：法线混合强度；
- 建议勾 **Enable GPU Instancing**（第 6 章）。

### 3.2 投影器的几何约定

`DecalProjector` 的语义（源码 `DecalProjector.cs` / `DecalUpdateCachedSystem.cs`）：

| 属性 | 含义 |
|---|---|
| Transform 的 **+Z** | **投影方向**（箭头指向物体内部） |
| `Size.x / Size.y` | 投影面的宽 / 高（米） |
| `Size.z` | 投影盒的**深度**（米） |
| `Pivot` | 投影盒**中心**相对 Transform 原点的偏移（米） |

盒子在局部空间的 z 范围：

```text
z ∈ [ pivot.z − size.z/2 , pivot.z + size.z/2 ]        // 沿 +Z（= −表面法线）方向
```

### 3.3 关键：贴花采样的是"远端面"

DBuffer 投影器的渲染状态（`UniversalDecalSubTarget.cs`）：

```hlsl
Cull(Front)        // 只画背面
ZTest(Greater)     // 且必须在场景表面之后
ZWrite(Off)
```

也就是说：

1. 盒子朝向相机的那一面（近端面）被**剔除**；
2. 真正被光栅化的是盒子**背向相机的那一面（远端面）**；
3. `ZTest Greater` 保证它只出现在场景表面**之后**——于是"表面必须落在盒子的深度范围里"。

这解释了两个实践问题：

**① 贴花会"偏移"**。如果把盒子从表面向物体内部延伸（`pivot.z = size.z/2`），远端面就在表面**后方 `size.z`** 处。贴图的 UV 来自远端面，斜着看时图案会按视差平移，离屏幕中心越远偏移越大。正确做法是让远端面**贴着表面**，只内嵌一点点：

```hlsl
// 让远端面落在表面内侧 epsilon 处（epsilon 取 2~8mm）
projector.size  = new Vector3(diameter, diameter, depth);
projector.pivot = new Vector3(0f, 0f, epsilon - depth * 0.5f);

// 校验：远端面 = pivot.z + depth/2 = epsilon ✓
```

**② 边缘会被深度裁掉**。远端面是一个平面，而曲面会往外弯；曲面离切平面超过 `epsilon` 的部分就在"表面之前"，`ZTest Greater` 失败 → 边缘被切。曲面越弯，`epsilon` 要越大（代价是轻微视差），平坦表面可以取很小。

### 3.4 DBuffer 的"反权重"：blend state 帮你做了预乘

贴花 Pass 的混合状态是一整串：

```hlsl
Blend 0 SrcAlpha OneMinusSrcAlpha, Zero OneMinusSrcAlpha
Blend 1 SrcAlpha OneMinusSrcAlpha, Zero OneMinusSrcAlpha
Blend 2 SrcAlpha OneMinusSrcAlpha, Zero OneMinusSrcAlpha
```

对每个 RT 来说：

```text
RGB   = src.rgb * src.a + dst.rgb * (1 − src.a)
Alpha = 0       * src.a + dst.a   * (1 − src.a)  =  dst.a * (1 − src.a)
```

贴花 shader 输出的是 **straight alpha**：`src.rgb = color`、`src.a = α`。清屏值是 `(0,0,0,1)`，于是混合后的 RT0 是：

```text
RT0.rgb = color·α
RT0.a   = 1 − α          // 注意：不是 α，是 1−α
```

接收方读到的就是：

```hlsl
// DBuffer.hlsl
baseColor.xyz = baseColor.xyz * decal.baseColor.w + decal.baseColor.xyz;
//            = baseColor * (1−α) + color·α        → 标准 alpha 混合
```

**这就是为什么 DBuffer 里存的是"预乘颜色 + 反向 alpha"，而 shader 里却写普通 alpha**——预乘和取反都是硬件 blend 顺手做的，不需要你在 shader 里写。三张 RT 都是同一套规则：

| RT | 清屏值 | 贴花片段输出 | 混合后（接收方读到） |
|---|---|---|---|
| RT0 | `(0,0,0,1)` | `(color, α)` | `(color·α, 1−α)` |
| RT1 | `(0.5,0.5,0.5,1)` | `(n·0.5+0.5, α)` | `(n·0.5+0.5)·α + 0.5·(1−α)`，`1−α` |
| RT2 | `(0,0,0,1)` | `(m, ao, s, α)` | `(m·α, ao·α, s·α)`，`1−α` |

接收方再用 `1−α` 当"中性权重"去做 lerp（`DBuffer.hlsl` 的注释原话：**mean weight of 1 is neutral**）。

---

## 4. Frame Debugger 里看 DBuffer

### 4.1 事件在哪

`Window > Analysis > Frame Debugger → Enable`，在事件树里（`Render Camera` 下、Prepass 之后）找这两个 sampler 名：

```text
Clear                 ← Blitter 清 DBuffer，写 (0,0,0,1) / (0.5,0.5,0.5,1)
DBuffer Render        ← SetRenderTarget(MRT) + 画贴花
```

`DBufferRenderPass` 的 `renderPassEvent = AfterRenderingPrePasses + 1`，所以位置在 prepass 之后、不透明物体之前。

### 4.2 三张 RT 长什么样

| FD 里的 RT | RTHandle 名 | 格式 | 内容 |
|---|---|---|---|
| RT0 | `_DBufferTexture0` | RGBA8_SRGB | 预乘颜色 + `1−α` |
| RT1 | `_DBufferTexture1` | RGBA8_UNorm | 编码后的法线 + `1−α` |
| RT2 | `_DBufferTexture2` | RGBA8_UNorm | `(metallic, occlusion, smoothness) · α` + `1−α` |
| depth | `DBufferDepth` | depth-only | 深度 |

**RT2 只有在 Surface Data = Albedo Normal MAOS 时才存在**；选 Albedo Normal 时根本没有第三张。

### 4.3 逐张看 MRT

选中 `DBuffer Render` 事件后，右侧 **Render Target** 预览上方通常有一个 attachment 下拉（RT0/RT1/RT2）。如果没有这个切换（部分版本只显示第一张），用 RenderDoc 抓帧看 Texture Viewer 更直接。

几个正常的、容易被误判的现象：

| 现象 | 解释 |
|---|---|
| **`Clear` 事件里 RT2 全黑** | 清屏值就是 `(0,0,0,1)`，黑是对的 |
| **`DBuffer Render` 里 RT2 还是黑** | 贴花 shader 没输出 MAOS（见第 5 章） |
| **RT1 看起来是紫/蓝色块** | 法线是编码过的（`n·0.5+0.5`），不是"彩色贴图" |
| **`Clear` 之后 RT1/RT2 有残留** | URP 目前只对 RT0 做 Blitter clear（源码里有 TODO），判断内容要看 `DBuffer Render` 事件 |
| **为什么 RT0 是 sRGB、RT1/RT2 是 UNorm** | 颜色要按 sRGB 存；法线和 MAOS 是数据，不能有 gamma 变换 |

### 4.4 怎么确认"贴花真的生效了"

按顺序看四个地方：

1. **事件存在**：`Clear` + `DBuffer Render` 都在（没有的话：相机视野里没有可见贴花 / Feature 没启用 / Technique 不是 DBuffer）；
2. **关键字**：`DBuffer Render` 事件的 Keywords 里应该有 `_DBUFFER_MRT2`（或 MRT1/MRT3）；
3. **RT0 内容**：能看到你自己那张贴图（颜色被 `α` 预乘过，所以透明区域是黑的）；
4. **贴花 draw call**：`Draw Mesh (instanced)` 说明材质开了 GPU Instancing；否则是每个投影器一个 `Draw Mesh`。

如果贴花 pass 正常、但画面上没有：问题在接收方 shader（关键字被裁掉、缺 `DepthNormals`、在透明队列、或者调用位置在光照之后）。

---

## 5. Albedo Normal MAOS 怎么用

### 5.1 MAOS 是什么

MAOS = **M**etallic / **A**mbient **O**cclusion / **S**moothness。开启后，贴花可以在投影范围内改这三个属性：

- 弹孔：metallic 变 0、smoothness 变低（露出的粗糙底层）；
- 锈迹：metallic 降低；
- 水洼/湿润：smoothness 提高；
- 凹痕：AO 降低，增加立体感。

### 5.2 RT2 的布局与混合

```hlsl
// 贴花 shader 输出（straight）
outDBuffer2 = half4(metallic, occlusion, smoothness, MAOSAlpha);

// 接收方解码（DBuffer.hlsl）
surfaceData.metallic   = inDBuffer2.x;
surfaceData.occlusion  = inDBuffer2.y;
surfaceData.smoothness = inDBuffer2.z;
surfaceData.MAOSAlpha  = inDBuffer2.w;     // 混合权重（1 = 中性）

// 合成
metallic   = metallic   * MAOSAlpha + decalMetallic;
occlusion  = occlusion  * MAOSAlpha + decalOcclusion;
smoothness = smoothness * MAOSAlpha + decalSmoothness;
```

注意 `MAOSAlpha` 是**整个贴花共享一个**（不是各通道独立权重），这就是文档里说的"all properties are blended with a single common alpha value"。

### 5.3 坑：默认 Decal shader 用 MAOS = 白开一张 RT

URP 自带的 `Shader Graphs/Decal` 的片元输出只有：

```text
BaseColor / NormalTS / NormalAlpha / Alpha
```

**没有 Metallic / Occlusion / Smoothness / MAOSAlpha**。于是 `GetSurfaceData` 里：

```csharp
// DecalPass.template
surfaceData.occlusion = half(1.0);     // 默认值
surfaceData.smoothness = half(0);
// ZERO_INITIALIZE → metallic = 0, MAOSAlpha = 0
```

- `MAOSAlpha = 0`（覆盖度 0）→ 混合权重是"中性"→ **对画面没有任何影响**；
- 贴花片段输出的 RT2 = `(0,0,0,0)`，和清屏的 `(0,0,0,1)` 混合后 → `(0,0,0,1)` → **仍然全黑**。

所以你看到的现象是对的：**RT2 黑 + 画面无变化**。这不是 bug，是"你选了 MAOS 但 decal shader 不写 MAOS"。

纯浪费的地方：

| 成本 | 量级 |
|---|---|
| 多一张全屏 RGBA8 | 1920×1080×4B ≈ **8.3MB** 的写 + 读 |
| 接收方多一个 `_DBUFFER_MRT3` 变体 | 片元程序更大，多一次纹理绑定 |
| 贴花 Pass 多一个 MRT 输出 | 带宽 |

**所以：不需要改 MAOS 时，Surface Data 就选 `Albedo Normal`**（或者只要颜色就选 `Albedo`）。

### 5.4 正确姿势：自定义 Decal Shader Graph

要让 MAOS 真正生效，得自己写 decal shader：

1. 新建 Shader Graph，把 **Material → Decal**（Graph Inspector 的 Material 选项）；
2. 在 Graph Settings 里勾上 **Affect MAOS**（会多出 Metallic / Occlusion / Smoothness / MAOSAlpha 四个 Block）；
3. 接线（以弹孔为例）：

```text
Base Map (RGBA) ──► BaseColor
                 └► Alpha            // 覆盖度：孔内 1，孔外 0

Normal Map ──────► NormalTS
Base Map.A ──────► NormalAlpha       // 或乘以 Normal Blend 参数

常量 0      ──────► Metallic
常量 0.15   ──────► Smoothness
常量 0.35   ──────► Occlusion
Base Map.A  ──────► MAOSAlpha        // 关键：让权重跟着覆盖度走
```

4. 如果要做"湿润/锈迹"这类整片效果，用一张 mask 图分配通道（文档推荐做法）：

| 通道 | 用途 |
|---|---|
| R | Ambient Occlusion |
| G | Smoothness |
| B | Emission |
| A | MAOSAlpha（整片权重） |

**`MAOSAlpha` 必须接"覆盖度"**：如果它恒为 1（或者你把 AO 的值接进去），整个投影盒范围内都会被当成"完全覆盖"，透明处也会改材质 —— 表现为一个方形色块。

### 5.5 选择建议

| 需求 | 选择 |
|---|---|
| 只是贴图案/污渍/血迹 | **Albedo**（1 张 RT，最省） |
| 弹孔、裂纹、凹凸，需要正确受光 | **Albedo Normal**（2 张） |
| 水洼、湿润、锈迹、要改粗糙度/金属度 | **Albedo Normal MAOS** + 自定义 decal shader |
| 移动端 TBDR | 考虑 Screen Space（改不了法线，但没有 prepass） |

---

## 6. 性能：prepass、带宽、合批

### 6.1 固定成本（与贴花数量无关）

| 项 | 说明 |
|---|---|
| **DepthNormals prepass** | 不透明几何再提交一遍，TBDR 上尤其贵；这是 DBuffer 的固有代价 |
| **Clear** | 一次全屏 Blit 清 DBuffer |
| **接收方采样** | 每个不透明像素读 1~3 张 DBuffer（`LOAD_TEXTURE2D_X`，无采样器开销但有带宽） |
| **全屏带宽** | `Albedo Normal` 两张 RGBA8：1080p ≈ 16.6MB/帧 的读写 |

### 6.2 投影器合批

`DecalDrawSystem` 只有在下面条件满足时才走 **`DrawMeshInstanced`**：

```csharp
if (SystemInfo.supportsInstancing && material.enableInstancing)
    DrawInstanced(...);   // 一批画多个
else
    Draw(...);            // 每个贴花一次 cmd.DrawMesh
```

- 开关是**材质**上的 **Enable GPU Instancing**（`m_EnableInstancingVariants`）；
- 每批上限 `MaxBatchSize = 250`；
- 同一材质的贴花在同一个 chunk，`ceil(n / 250)` 个 instanced call；
- 大小/朝向不同不影响合批（都是实例数据）；
- 不同材质会分 chunk → 不同批次。

**想让多种弹孔共用一批**：用一张 atlas + 每个 Projector 的 `uvScale/uvBias`（这也是实例数据），而不是每张图一个材质。

### 6.3 优化清单

- 不需要法线就选 `Albedo`（省一张 RT + prepass 的法线写入）；
- 不需要 MAOS 就别选（见 5.3）；
- `Max Draw Distance` 按需调小；
- 投影器材质开 GPU Instancing；
- 大量重复贴花考虑合并成 decal mesh / 对象池，减少 GameObject 与 entity 更新。

---

## 7. 排错表

| 现象 | 优先检查 |
|---|---|
| 完全看不到贴花 | Feature 的 Active / Technique 是不是 DBuffer / 材质是不是 `Shader Graphs/Decal` / `Max Draw Distance` |
| 编辑器正常，出包消失 | 接收方用了 `shader_feature`，变体被裁；改成 `multi_compile_fragment` |
| 有的物体上有、有的没有 | 缺 `DepthNormals` Pass；或该物体透明 / 粒子 / 地形细节（不支持） |
| 贴花位置相对点击点偏移 | `pivot.z` 用了 `size.z/2`（盒子向内延伸）→ 改成 `epsilon − size.z/2`，让远端面贴表面 |
| 曲面边缘被切掉一块 | `epsilon` 太小，远端面被深度裁；加大到 6~8mm |
| 贴花是黑方块 | 贴图 A 在不该实的地方是 1（A=1 表示完全覆盖），或者 RGB 没预乘/颜色全黑 |
| 法线没效果 | Surface Data 没开 Normal；材质的 `Normal_Blend` = 0；或者接收方只写了 `_DBUFFER_MRT1` 变体 |
| RT2 全黑 | 正常：清屏就是黑；若贴花 shader 不输出 MAOS，它整个 RT 都没用（见第 5 章） |
| Frame Debugger 里没有 DBuffer 事件 | 相机视野内没有可见贴花 / Feature 没启用 / 当前质量档用的不是这个 Renderer |

---

## 8. 小结

把整条链路压缩成一句话：

```text
Renderer 开 DBuffer
  → 贴花投影器把 (颜色, α) 用 blend 写成 (预乘颜色, 1−α) 存进 2~3 张全屏 RT
    → 每个不透明 shader 用 positionCS 读这些 RT，在光照前做 base·(1−α) + color·α
      → 法线/MAOS 同理，权重都是 1−α
```

对应的检查清单：

- [ ] Renderer 上有 Decal Feature，Technique = DBuffer，Surface Data 选对档位
- [ ] 接收方 shader：`multi_compile_fragment _ _DBUFFER_MRT*` + `DBuffer.hlsl` + 光照前 `ApplyDecalToSurfaceData` + `DepthNormals` Pass
- [ ] 接收方不透明（不能被 `_SURFACE_TYPE_TRANSPARENT` 定义）
- [ ] 投影器 pivot 让远端面贴表面（`pivot.z = ε − size.z/2`）
- [ ] 材质开 GPU Instancing
- [ ] 用 Frame Debugger 确认 `Clear`/`DBuffer Render`、MRT 内容、`Draw Mesh (instanced)`
- [ ] 选了 MAOS 的话，确认 decal shader 真的输出 MAOS 且 `MAOSAlpha` 接了覆盖度
