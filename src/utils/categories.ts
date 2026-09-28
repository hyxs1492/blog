import type { CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'blog'>;

/** 按分类聚合的结果 */
export interface CategoryGroup {
  /** 由分类名 slug 化得到的片段，用作分组区块的 `id`（可 `#unity-dots` 直接定位） */
  slug: string;
  /** 展示名，取自 frontmatter 里 `category` 的原文，如 `Unity DOTS` */
  name: string;
  /** 文章数量 */
  count: number;
  /** 该分类下的文章，已按发布日期倒序 */
  posts: BlogPost[];
}

/** 分类名为空或全是符号时的兜底 slug */
const FALLBACK_SLUG = 'uncategorized';

/**
 * 把分类名转成用作锚点的片段。
 * - `Unity DOTS` → `unity-dots`（小写、空白→连字符）
 * - `性能优化` → `性能优化`（保留中日韩字符）
 * - `C# / .NET` → `c-net`
 *
 * 名字不同但 slug 相同的（例如 `Unity DOTS` 与 `unity  dots`）会被**合并**成同一个分类。
 */
export function categorySlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || FALLBACK_SLUG;
}

/**
 * 按 `category` 把文章分组，供文章列表页「按分类展示」。
 *
 * 分类只由 frontmatter 的 `category` 决定，没有任何注册表 —— 写个新值就多一个分类。
 * 返回顺序：文章多的分类在前，数量相同按名称排序；组内按发布日期倒序。
 */
export function groupPostsByCategory(posts: BlogPost[]): CategoryGroup[] {
  const groups = new Map<string, CategoryGroup>();

  for (const post of posts) {
    const name = post.data.category.trim();
    const slug = categorySlug(name);

    let group = groups.get(slug);
    if (!group) {
      group = { slug, name, count: 0, posts: [] };
      groups.set(slug, group);
    }
    group.posts.push(post);
    group.count += 1;
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
  }
  result.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
  return result;
}
