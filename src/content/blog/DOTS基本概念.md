---
title: 'DOTS基本概念'
description: 'DOTS的基本概念'
pubDate: '2026-01-15'
---

欢迎来到我的博客！这是**第一篇文章**的正文。

DOTS（Data-Oriented Technology Stack）** 是 Unity 面向数据的高性能技术栈：
| 层 | 包 | 作用 |
| --- | --- | --- |
| ECS | `com.unity.entities` | World / Entity / Component / System，把数据按内存紧凑排列批量处理 |
| 数学与容器 | `com.unity.mathematics`、`com.unity.collections` | `float3`/`quaternion`、`NativeArray`/`NativeList`/`NativeParallelHashMap`/`FixedList` |
| 编译器 | `com.unity.burst` | 把 C# 子集编译成高度优化的原生代码 |
| 渲染 / 物理 | `com.unity.entities.graphics`、`com.unity.physics` | ECS 驱动的实例化渲染、无状态物理 |

## 2. 核心概念速览与官方文档对照
| 概念 | 官方文档 |
| --- | --- |
| ECS 工作流总览 | [ecs-workflows](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/ecs-workflows.html) |
| `ISystem`（非托管、可 Burst） | [systems-isystem](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-isystem.html) |
| `SystemBase`（托管） | [systems-systembase](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-systembase.html) |
| `IJobEntity`（迭代与并行） | [iterating-data-ijobentity](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/iterating-data-ijobentity.html) |
| `IJobChunk` | [iterating-data-ijobchunk](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/iterating-data-ijobchunk.html) |
| `ComponentLookup<T>` / `BufferLookup<T>` | [API: ComponentLookup&lt;T&gt;](https://docs.unity3d.com/Packages/com.unity.entities@1.0/api/Unity.Entities.ComponentLookup-1.html) |
| `EntityCommandBuffer`（结构性变更） | [systems-entity-command-buffers](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-entity-command-buffers.html) · [自动回放与释放](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-entity-command-buffer-automatic-playback.html) |
| `IEnableableComponent`（零结构变更开关） | [components-enableable-use](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/components-enableable-use.html) |
| Baking / Baker | [baking-overview](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/baking-overview.html) · [baking-baker-overview](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/baking-baker-overview.html) |
| Blob Asset（不可变共享数据） | [blob-assets-intro](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/blob-assets-intro.html) |
| Jobs 与依赖 | [ecs-workflows](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/ecs-workflows.html) |
| Transform 桥接 | [transforms-intro](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/transforms-intro.html) |
| Entities Graphics | [entities.graphics@1.0](https://docs.unity3d.com/Packages/com.unity.entities.graphics@1.0/manual/index.html) |
| Unity Physics | [physics@1.0](https://docs.unity3d.com/Packages/com.unity.physics@1.0/manual/index.html) |
| Entities 1.0 变更点 | [what's new in 1.0](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/whats-new.html) |

