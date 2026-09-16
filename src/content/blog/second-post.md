---
title: '用 Astro 搭建个人博客'
description: '记录我用 Astro 从零搭建这个博客的过程与踩过的坑。'
pubDate: '2026-02-02'
---

这个博客是用 [Astro](https://astro.build/) 搭建的。

## 为什么选 Astro

- 默认输出纯静态 HTML，加载快
- 直接写 Markdown，写作体验好
- 想扩展时可以加入 React / Vue / Svelte 组件

## 目录结构

```text
src/
├── content/blog/     # 文章（Markdown）
├── layouts/          # 页面布局
├── pages/            # 路由页面
└── styles/           # 全局样式
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地开发预览 |
| `npm run build` | 构建静态站点到 `dist/` |
| `npm run preview` | 预览构建结果 |
