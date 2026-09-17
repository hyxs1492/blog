---
title: 'Unity DOTS —— SystemBase与ISystem'
description: 'DOTS SystemBase'
pubDate: '2026-01-15'
---

## 速览

写一个 DOTS 系统时要做的两个**互相独立**的决定：
| 决定 | 选项 | 决定了什么 |
|---|---|---|
| **系统类型** | `ISystem` / `SystemBase` | 能不能 Burst、能不能存托管数据、有没有 GC、能不能继承 |
| **迭代方式** | 惯用 `foreach`（`SystemAPI.Query`）/ `IJobEntity` / `IJobChunk` / `IJob` / `Entities.ForEach`(已弃用) | 数据怎么被批处理、并行粒度、样板代码量 |

## 1. 概念差异
- **`ISystem`**：**非托管 struct**。系统状态直接存在 World 的非托管数据里，**可被 Burst 编译**、**零 GC**、**不能存托管字段**、**不能继承**（struct 不能继承类）。
- **`SystemBase`**：**托管 class**。可以存 `List<T>`/`Dictionary<T>`/`object` 等托管字段、可以继承自定义基类、可以用 `Entities.ForEach`——代价是 GC 分配、SourceGen 编译更慢、`OnUpdate` 无法 Burst。
---
### 5.2 官方兼容性对照表
| 能力 | `ISystem` | `SystemBase` |
|---|---|---|
| `OnCreate` / `OnUpdate` / `OnDestroy` 可 Burst | ✅ | ❌ |
| 非托管内存 | ✅ | ❌ |
| 产生 GC 分配 | ❌ | ✅ |
| 系统类型里**直接存托管字段** | ❌ | ✅ |
| 惯用 `foreach` + `SystemAPI.Query` | ✅ | ✅ |
| `Entities.ForEach` / `Job.WithCode` | ❌ | ✅ |
| `IJobEntity` / `IJobChunk` | ✅ | ✅ |
| 支持继承 | ❌ | ✅ |
| `OnStartRunning` / `OnStopRunning` | 需实现 `ISystemStartStop` | 直接 `override` |
> 来源：[Systems comparison](https://docs.unity3d.com/Packages/com.unity.entities@1.3/manual/systems-comparison.html)、[ISystem overview](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-isystem.html)、[SystemBase overview](https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-systembase.html)