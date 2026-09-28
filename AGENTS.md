# AGENTS.md — blog（GitHub Pages 博客）会话必读

> 本文件只放**每次会话都要知道**的东西。改某个文案/颜色该动哪个文件，看
> **`docs/使用与修改指南.md`**（逐项对照表，写内容前先看）。
> 冲突时**以代码和 `npm run build` / `npx astro check` 实跑为准**。
> 下列环境与基线均为 **2026-09-28 / 09-29 本机实测**。

## 1. 这是什么

**Astro 6 静态博客**（深色主题 "Darkness"），推 `main` 后由 GitHub Actions 构建并发布到 **GitHub Pages**。

- **线上地址**：<https://hyxs1492.github.io/blog/> ← 注意有 **`/blog/` 子路径**
- **仓库**：<https://github.com/hyxs1492/blog>，**本目录 `blog/` 就是仓库根**
- **技术栈**：Astro 6（static）+ Three.js 粒子背景 + Content Collections（Markdown）+ TypeScript
- **两个自研功能**（**不是**上游主题自带的，改动时优先看这两处）：
  1. **分类**：每篇文章必填 `category`，在**文章页内按分类分组展示**（没有独立的分类页，也没有「分类」导航项）
  2. **可切换的 3D 背景**：右下角切换器，5 套预设，选择存 `localStorage`（详见 §7.4）

⚠️ **父目录 `/Users/hyxs/Project/UnitGameStudy` 不是 git 仓库**。`blog/` 与同级的
`URPDOTSSample/`（Unity 工程）是**两个互不相干的独立仓库**：在 `blog/` 里 `git` 操作不会碰到 Unity 工程，
反之亦然。别把两边的改动混进同一次提交。

⚠️ 主题来自上游 **`kpab/astro-darkness`（MIT）**。`README.md` / `CHANGELOG.md` /
`docs/portal/LISTING.md` / `docs/screenshots/` 都是**上游主题的宣传物料**（里面写的是 `kpab.github.io`
和作者的 Gumroad 链接），**不是本站说明**，别照着它们操作。

## 2. 环境（2026-09-28 实测）

| 项 | 值 |
|---|---|
| Node **engines** 要求 | `>=22.0.0` |
| 实测 Node | **v26.6.0**（`/opt/homebrew/bin/node`）；另有 nvm `v24.14.0` |
| 实测 npm | **11.18.0** |
| astro / three | `6.4.8` / `0.184.0`（见 `package-lock.json`） |
| 包管理 | `package-lock.json` **已提交** → CI 用 `npm ci`；**不要换成 pnpm/yarn** |

⚠️ **`node` / `npm` 不在非交互 shell 的 PATH 上**（`command -v node` 为空）。脚本里必须先：

```bash
export PATH="/opt/homebrew/bin:$PATH"
```

## 3. 常用命令与验证基线

在 `blog/`（仓库根）下执行：

```bash
export PATH="/opt/homebrew/bin:$PATH"
export ASTRO_TELEMETRY_DISABLED=1        # 沙箱里必须，见 §7.1

npm ci --cache "$PWD/.npm-cache"         # 沙箱里必须，见 §7.1
npm run dev      # 本地预览 http://localhost:4321/blog/   ← 必须带 /blog/
npm run build    # 构建静态站点到 dist/
npx astro check  # 类型 / 诊断检查
npm run preview  # 本地预览构建结果
```

| 命令 | 2026-09-29 基线 |
|---|---|
| `npm run build` | ✓ **9 pages**，约 **2 s**，产出 `dist/` + `sitemap-index.xml` |
| `npx astro check` | **29 files：0 error / 0 warning / 0 hint** |
| 浏览器内自检（§7.5） | 切换器 **24 passed / 0 failed** |

**没有 `test`、没有 `lint` 脚本**（`astro check` 就是唯一的静态检查）。所以：

> **① 改任何 `.astro` / `.ts` 后，`npx astro check` 必须 0 error，再 `npm run build` 通过。**
> **② 只改 Markdown 也至少跑一次 `npm run build`** —— frontmatter 的 zod 校验只在 build 里生效，
> 缺字段会直接构建失败。
> **③ 声称"完成"必须有上面两条的真实输出，不能只说"应该没问题"。**

## 4. 发布流程

```
本地 commit → git push origin main → GitHub Actions (.github/workflows/deploy.yml)
  → setup-node 22 + npm ci + npm run build → 上传 ./dist → deploy-pages
```

- 只有 **push `main`** 或手动 `workflow_dispatch` 才触发；**约 1 分钟**后上线。
- 发布后浏览器可能还是旧缓存 → **`Ctrl + F5`** 强制刷新。
- **构建产物不进仓库**（`dist/` / `.astro/` / `node_modules/` 都在 `.gitignore`），
  Pages 上的内容是 Actions 现场构建的，不是仓库里的文件。
- `astro.config.mjs` 的 `site: 'https://hyxs1492.github.io'` + `base: '/blog'` 是
  **线上 URL 的唯一来源**（也决定 sitemap）。改仓库名 / 想换到根路径时，必须**同时**改这两处，
  并同步 GitHub Pages 设置 —— 详见 `docs/使用与修改指南.md` §七。

## 5. 目录与路由地图

```
blog/                       ← 仓库根
├── astro.config.mjs        # site / base / trailingSlash / 集成（mdx, sitemap）
├── package.json            # 脚本：dev / start / build / preview / astro
├── tsconfig.json           # extends astro/tsconfigs/strictest
├── public/favicon.svg      # 唯一静态资源（图片放这里）
├── .github/workflows/deploy.yml
├── docs/使用与修改指南.md    # ★ 本站自己的中文使用手册（改文案查这里）
├── src/
│   ├── content.config.ts   # ★ 两个集合的 schema（内容模型的唯一真源）
│   ├── content/blog/*.md   # 文章（文件名 = slug，**category 必填**）
│   ├── content/projects/*.md
│   ├── utils/categories.ts # ★ 分类：slug 化 + 分组（文章页「按分类展示」的唯一逻辑来源）
│   ├── layouts/BaseLayout.astro      # ★ html 壳：字体、cursor、ClientRouter、背景层
│   ├── layouts/BlogPostLayout.astro  # 文章页外壳 + 正文排版 + 分类徽章
│   ├── pages/…             # 路由（见下表）
│   ├── components/…        # Navigation / Hero / Skills / BlogCard / ProjectCard / ThreeBackground
│   ├── scripts/background/ # ★ 3D 背景引擎与 5 套预设（见 §7.4）
│   └── styles/global.css   # ★ CSS 变量（颜色/字体）+ .shimmer-text
└── README.md / CHANGELOG.md / docs/portal/ / docs/screenshots/   # 上游主题物料，勿当说明书
```

| 线上 URL | 源文件 |
|---|---|
| `/blog/` | `src/pages/index.astro`（Hero + Skills + 最新 3 篇） |
| `/blog/blog/` | `src/pages/blog/index.astro`（**全部文章，按分类分段展示**） |
| `/blog/blog/<slug>/` | `src/pages/blog/[...slug].astro` → `BlogPostLayout` |
| `/blog/projects/` | `src/pages/projects.astro`（精选 / 其他） |
| `/blog/about/` | `src/pages/about.astro` |

⚠️ **文章 URL 有两层 `blog`**：`base`（`/blog`）+ 路由目录 `blog/`。
即 `unity dots archetype.md` 的实际地址是
`https://hyxs1492.github.io/blog/blog/unity-dots-archetype/`。
用 `curl` 自测时敲错一层会得到 404，别以为是路由坏了（**build 日志里的路径是相对 `base` 的**）。
`docs/使用与修改指南.md` 里已写明这一点。

## 6. 内容模型（`src/content.config.ts`，Astro 6 `glob` loader）

| 集合 | 目录 | 必填 | 可选 |
|---|---|---|---|
| `blog` | `src/content/blog/` | `title`, `description`, `pubDate`, **`category`** | `updatedDate`, `heroImage`, `tags` |
| `projects` | `src/content/projects/` | `title`, `description` | `image`, `link`, `github`, `tags`, `featured`（默认 `false`） |

- **`category` 是本站自研的分类功能，必填**（`z.string().min(1)`）。**同一个字符串 = 同一个分类**，
  分组逻辑在 `groupPostsByCategory()`（`src/utils/categories.ts`）。大小写/空格不同但 slug 相同的
  （`Unity DOTS` 与 `unity  dots`）会被**合并**成一个分组。
- **分类没有注册表，也没有独立的分类页**：写个新值就多一个分组，文章页（`/blog/blog/`）自动按分类
  分段显示（分类名 + 篇数 + 该分类的卡片）。slug 只用作分段区块的 `id`（可 `#unity-dots` 定位）。
- ⚠️ 目前**只有 1 个分类**（`Unity DOTS`，5 篇文章确实都是 DOTS）。想拆细只需给各篇写不同的 `category`。
- **新建 `.md` 不用注册**，`glob` loader 自动收录；**缺必填字段 → build 直接失败**（zod）。
- **文件名就是 slug**，且 Astro 会**规范化**：实测 `unity dots archetype.md`
  → `/blog/blog/unity-dots-archetype/`（空格→连字符、并转小写）。
  中文文件名能用，但 URL 会变成百分号编码；**改名 = 换 URL，没有重定向**，老链接直接 404。
- `featured: true` → 「精选项目」区，否则落进「其他项目」。
- `image` 放 `public/` 后写 `/xxx.png`；`ProjectCard` 会自动补 `base`。
- ⚠️ **两个项目条目仍是主题占位内容**：`darkness-theme.md` 的 `github` 还指向
  `yourusername`，`particle-playground.md` 是虚构项目。
- ⚠️ `heroImage` 在 schema 里声明了，但**全站没有任何地方渲染它**（写了也不显示）。

## 7. 不能破的前提 / 踩过的坑

### 7.1 沙箱里跑 npm / astro 的三个 EPERM（实测）

文件沙箱只允许写工作区时，npm 和 Astro 都会去写**工作区外**的目录而失败：

| 症状 | 原因 | 解决 |
|---|---|---|
| `npm error … sudo chown -R 501:20 "/Users/hyxs/.npm"` | 写 `~/.npm` 被拒 | `npm ci --cache "$PWD/.npm-cache"` |
| `EPERM: mkdir '/Users/hyxs/Library/Preferences/astro'` | Astro telemetry 写家目录 | `export ASTRO_TELEMETRY_DISABLED=1` |
| `sh: astro: command not found` | `node_modules/` 不存在 / PATH 没有 node | 先 `npm ci`，并 `export PATH="/opt/homebrew/bin:$PATH"` |

在**普通终端**（非沙箱）里这两条都不是问题，可以直接 `npm ci && npm run dev`。

⚠️ `--cache "$PWD/.npm-cache"` 会**在工作区留下 `.npm-cache/`，而它没有被 `.gitignore` 忽略** ——
`git add -A` 会把这个上百 MB 的缓存提交进去。**用完删掉**，或先加进 `.gitignore`。

### 7.2 硬性代码前提

1. **内部链接一律用 `import.meta.env.BASE_URL` 拼**，禁止硬编码 `/xxx`。
   每个 `.astro` 顶部都是 `const base = import.meta.env.BASE_URL;`，然后
   `` href={`${base}blog/`} ``。硬编码会导致本地 / 线上二选一必坏。
2. **`trailingSlash: 'always'`** → 所有站内链接**必须带结尾 `/`**（`BlogCard` 拼的是
   `` `${base}blog/${slug}/` ``）。
3. **已开启 View Transitions**（`BaseLayout.astro` 里的 `<ClientRouter />`）→
   客户端脚本**不能只跑一次**：初始化必须挂在 `astro:page-load` 上（首屏也会触发，所以它是幂等的）。
   事件监听用**事件委托绑在 `document` 上只绑一次**，否则每次导航都要重绑。
   `#bg-layer` 用了 `transition:persist`，**切页时 canvas 与切换器 DOM 是同一个节点**，
   所以背景引擎**不要**在 `astro:before-preparation` 里拆除重建（会白白闪一下）。详见 §7.4。
4. **样式只有一份真源**：`src/styles/global.css` 的 `:root`（`--color-*` / `--font-*` /
   `--nav-height`）。不要在组件里另起一套色值；共用类有 `.shimmer-text`。
   字体（Space Grotesk + DM Sans）在 `BaseLayout.astro` 用 Google Fonts 引入。
5. **TypeScript 用 `astro/tsconfigs/strictest`**，`astro check` 必须 0 error。
6. 组件里的注释混杂**日文**（`ThreeBackground` / `Navigation` / `BaseLayout` 的上游残留），
   页面文案是**中文**；改文案时别被日文注释误导。

### 7.3 其它已知坑

- **`@astrojs/rss` 装了但完全没用**：`src/pages/` 里**没有任何 rss 路由** → 别以为站点有 RSS。
  同理 `docs/portal/`、`docs/screenshots/` 只是上游物料。
- **死代码**：`src/components/Features.astro` + `Card.astro` **全站无人 import**
  （`Features` → `Card` 是唯一引用），是英文主题残留；改文案时无视它们。
- **没有 `src/pages/404.astro`** → 404 由 GitHub Pages 自带页面接管。
- **`npm run build` 会先清空 `dist/`** → 手工塞进 `dist/` 的临时文件（自测页之类）每次构建都会消失，
  要验证就先 build 再放。
- **`three` 是动态 import 的**（见 §7.4）：首屏 HTML 里只有引擎那个 ~6 KB 的 chunk，
  `three.core` + `three.module`（合计约 740 KB 未压缩）是切到 WebGL 预设后才拉的。
  改背景时**不要**在 `catalog.ts` 或 `.astro` 的 frontmatter 里直接 `import three`，否则会毁掉这个拆分。
- **`git log` 里能看到一个被整体替换掉的旧主题**（Darkness 之前还有别的版本）。
  历史里的文件内容不代表现状，**以工作区代码为准**。
- `docs/使用与修改指南.md` 已按本次改动补过，但**以代码为准**；发现不一致时顺手改正。

### 7.4 3D 背景预设系统（`src/scripts/background/`）

```
src/scripts/background/
├── catalog.ts        # 预设元数据（id / 名称 / 说明）+ localStorage 键名（★ 纯数据，不许 import three）
├── types.ts          # BackgroundContext / BackgroundInstance 接口
├── index.ts          # 引擎：renderer/scene/camera、RAF、resize、鼠标、可见性、切换器、持久化
└── impl/
    ├── shaders.ts    # 点状预设共用的圆形软边片元着色器
    ├── starfield.ts  # 星野（默认）
    ├── grid.ts       # 赛博网格地平线
    ├── waves.ts      # 粒子波场
    ├── classic.ts    # 初版效果（方形粒子 + 线框圆环）
    └── minimal.ts    # 极简：不建 WebGL，只留 CSS 渐变（**不 import three**）
```

**布局与分工**：`ThreeBackground.astro` 只负责 canvas 容器 + 切换器标记/样式；
`#bg-layer` 带 `transition:persist`，所以切页时 canvas 不重建，WebGL 上下文与 RAF 全程只有一个。

**加一套新预设**（三步）：
1. `impl/<id>.ts` 导出 `create(ctx: BackgroundContext): BackgroundInstance`（实现 `update` / `dispose`，
   需要时实现 `resize`；`animated: false` 表示画一帧就停）。
2. `catalog.ts` 的 `PRESETS` 里加 `{ id, label, hint }`，并把它加进 `PresetId` 联合类型。
3. `index.ts` 的 `MODULE_LOADERS` 里加一行 `id: () => import('./impl/<id>')`。

**约束 / 坑**（都是实测踩过的）：
1. **`catalog.ts` 绝不能被 three 污染**：它会被 `.astro` 的 frontmatter（服务端）导入以渲染切换器按钮。
2. **不要让任何一条线/面跨越相机平面**：一个端点跑到相机背后的线段，会被 SwiftShader 之类的
   光栅化器**整条丢掉**（不是裁剪，是整条不画）。网格预设的注释里写了细节：81 条纵向线因此一条都没出现。
3. `ShaderMaterial` 里用 `gl_FragColor` / `attribute` / `varying` 是安全的（three 会自动加 GLSL1→WebGL2 的
   前置宏），但 `uniforms` 是索引签名类型，`strictest` 下写 `uniforms.uTime!.value` 才过类型检查。
4. **切换预设**走的是 `dispose()` 旧实例 → 复用同一个 renderer → 新建 scene/camera。
   `minimal` 只清一次画面，不销毁 renderer（避免反复创建 WebGL 上下文）。
5. `prefers-reduced-motion: reduce` 且用户没选过时，默认落到 `minimal`；用户一旦显式选择就以用户为准。
6. 标签页隐藏时停 RAF；`delta` 钳在 0.1s，避免切回来动画瞬移。

### 7.5 怎么在本地实跑验证（截图）

没有单测，**视觉效果只能靠真浏览器**。本机可用 Playwright 缓存的 headless shell
（比 `Google Chrome --headless=new` 稳，后者在这个沙箱里会 SIGTRAP / 挂住）：

```bash
HS=~/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell
"$HS" --no-sandbox --disable-dev-shm-usage --enable-unsafe-swiftshader \
  --user-data-dir=/tmp/cp --window-size=1280,900 \
  --virtual-time-budget=4000 --run-all-compositor-stages-before-draw \
  --screenshot=/tmp/out.png "http://127.0.0.1:4321/blog/blog/"
```

- **`--no-sandbox` 必需**（否则 Chrome 自己的沙箱初始化失败）。
- **`--virtual-time-budget` 必需**：页面加载事件后立刻截图会截到还没渲染的 WebGL 画面（一片渐变），
  加了它才会等到动画跑起来。
- **要交互（点切换器 / 翻页）就用一个同源 harness 页**：父页面用 iframe 载入站点，
  直接 `iframe.contentDocument` 点按钮、读 `localStorage`、把断言结果**画成文字**，再截图看结果。
  这类自测页记得放 `dist/` 外面（build 会清空 `dist/`）。
  `astro preview`（默认 4321）能直接服务 `dist/` 里的任意文件。
- 已验证的基线：切换器自检 **24 passed / 0 failed**（点选、aria、面板开合、跨页 canvas 复用、
  localStorage 记忆、切到 minimal）。

## 8. 详尽资料去哪找

| 想知道 | 去哪 |
|---|---|
| 改某个文案 / 颜色该动哪个文件（逐项对照表） | **`docs/使用与修改指南.md`** |
| 分类怎么工作、怎么加分类 | `src/utils/categories.ts` + 本文 §6 |
| 背景预设怎么加、为什么这么写 | 本文 §7.4 + `src/scripts/background/` |
| 怎么截图实跑验证 | 本文 §7.5 |
| 上游主题的宣传、截图、门户上架文案 | `README.md` / `CHANGELOG.md` / `docs/portal/LISTING.md` / `docs/screenshots/` |
| 内容字段的权威定义 | `src/content.config.ts` |
| 线上 URL / base 路径 | `astro.config.mjs` + `.github/workflows/deploy.yml` |
| 当前进度 / 还剩什么 | **`git log`** |
