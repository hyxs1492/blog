---
title: '部署到 GitHub Pages'
description: '把构建好的静态站点免费发布到 GitHub Pages 的简要步骤。'
pubDate: '2026-03-10'
---

写完文章后，我们一起把它发布到互联网上。

## 大致步骤

1. 把代码推送到 GitHub 仓库
2. 在仓库的 **Settings → Pages** 里，把 Source 设为 **GitHub Actions**
3. 添加一个 Astro 的部署工作流（`.github/workflows/deploy.yml`）
4. 每次 `git push`，GitHub 会自动构建并发布

## 别忘了改 site

在 `astro.config.mjs` 里把 `site` 改成你的正式网址，否则 RSS、sitemap 里的链接会不对。

祝部署顺利 🎉
