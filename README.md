# 我的博客

基于 [Astro](https://astro.build/) 的静态博客，可免费部署到 GitHub Pages。

## 快速开始

```bash
npm install      # 安装依赖
npm run dev      # 启动本地开发服务器（默认 http://localhost:4321）
npm run build    # 构建静态站点到 dist/
npm run preview  # 本地预览构建结果
```

## 目录结构

```text
.
├── public/                 # 原样拷贝到站点根目录的静态资源（favicon 等）
├── src/
│   ├── components/         # 可复用的 UI 组件（页头、页脚）
│   ├── content/
│   │   └── blog/           # 文章，均为 Markdown 文件
│   ├── layouts/            # 页面布局
│   ├── pages/              # 路由：每个文件对应一个 URL
│   │   ├── index.astro         -> /
│   │   ├── about.astro         -> /about/
│   │   ├── blog/index.astro    -> /blog/
│   │   ├── blog/[...slug].astro -> /blog/<文章名>/
│   │   └── rss.xml.js          -> /rss.xml
│   ├── styles/global.css   # 全局样式
│   └── content.config.ts   # 内容集合（文章字段）定义
├── astro.config.mjs        # Astro 配置（记得改 site）
└── package.json
```

## 写一篇新文章

在 `src/content/blog/` 新建一个 `.md` 文件，例如 `hello.md`：

```markdown
---
title: '文章标题'
description: '一句话摘要，会显示在列表里。'
pubDate: '2026-04-01'
---

正文用 Markdown 编写。
```

文件名（去掉 `.md`）就是这篇文章的网址：`/blog/hello/`。

## 部署到 GitHub Pages（免费）

1. 在 GitHub 新建一个仓库，把本项目推送上去：

   ```bash
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git branch -M main
   git push -u origin main
   ```

2. 打开仓库 **Settings → Pages**，把 **Source** 设置为 **GitHub Actions**。

3. 仓库里的 `.github/workflows/deploy.yml` 会自动构建并发布。之后每次
   `git push` 到 `main` 分支，网站就会自动更新。

4. 如果站点地址是 `https://<用户名>.github.io/<仓库名>/`，请把
   `astro.config.mjs` 里的 `site` 和 `base` 改成对应值：

   ```js
   export default defineConfig({
     site: 'https://<用户名>.github.io',
     base: '/<仓库名>',
   });
   ```

   如果用的是用户主页仓库（仓库名就叫 `<用户名>.github.io`），则不需要 `base`。

> 提示：以上命令里把 `<用户名>`、`<仓库名>` 换成你自己的即可。
