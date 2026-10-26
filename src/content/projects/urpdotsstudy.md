---
title: 'URPDOTSStudy'
description: 'Unity DOTS 实验工程：在保留 GameObject 工作流的前提下，把渲染与空间查询交给 DOTS（渲染桥 / 四叉树 / RVO / A*）。'
image: '/images/urpdotsstudy-benchmark.jpg'
github: 'https://github.com/hyxs1492/URPDOTSStudy'
tags: ['Unity', 'DOTS', 'ECS', 'Burst', 'Rendering', 'RVO']
featured: true
---

一个 Unity DOTS 的实验工程：**GameObject 的逻辑、层级、Transform、Collider 全部保留**，只把渲染（`MeshRenderer` / `LODGroup`）和空间查询交给 DOTS，用来验证「存量项目低成本接入 DOTS」这条路。

![1000 单位 benchmark](/images/urpdotsstudy-benchmark.jpg)

## 包含什么

- **运行时渲染桥**：把标记父物体下的渲染目标转成 Entities Graphics 实体，父物体变换用 `TransformAccess` 帧初读入、帧末回写；
- **空间索引**：四叉树 / 八叉树合一，支持 Bulk 与 Incremental 两种更新；
- **ORCA 局部避障**：DOTS 重写，邻居查询可来自空间索引；
- **A\* 寻路**：网格寻路 + 编辑器可视化；
- **CustomLit 着色器**：自发光、轮廓光、溶解等效果。

## 实测数据

- 1000 单位、8 种材质变体 → Frame Debugger 中合为 **1 个 Hybrid Batch Group、8 个 DrawCall**；
- 所有演示资源使用 CC0 模型（Kenney Space Kit）。

## 技术栈

Unity 2022.3 · Entities 1.4 · Entities Graphics 1.4 · Burst · URP 14

代码与文档都在 GitHub 仓库里（含 benchmark 与测试）。
