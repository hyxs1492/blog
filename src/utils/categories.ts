import { getCollection, type CollectionEntry } from 'astro:content';

/** 分类聚合结果 */
export interface CategoryGroup {
  /** URL 片段，如 `unity-dots`（由分类名 slug 化得到） */
  slug: string;
  /** 展示名，取自 frontmatter 里 `category` 的原文，如 `Unity DOTS` */
  name: string;
  /** 分类简介（可选，在 CATEGORY_DESCRIPTIONS 里按 slug 补充） */
  description?: string | undefined;
  /** 文章数量 */
  count: number;
  /** 该分类下的文章，已按发布日期倒序 */
  posts: BlogPost[];
}

export type BlogPost = CollectionEntry<'blog'>;

/**
 * 分类简介。**可选**：不写则分类页不显示简介段。
 * 键是 slug（分类名 slug 化后的结果），用 `npm run build` 或分类页 URL 可以确认 slug。
 */
const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  'unity-dots':
    'Unity DOTS（ECS 架构、Job System、Burst）的概念梳理与实践笔记：数据布局、系统生命周期与性能原理。',
};

/** 分类名为空或全是符号时的兜底 slug */
const FALLBACK_SLUG = 'uncategorized';

/**
 * 把分类名转成 URL 片段。
 * - `Unity DOTS` → `unity-dots`（小写、空白→连字符）
 * - `性能优化` → `性能优化`（保留中日韩字符，URL 里会百分号编码）
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
 * 按 `category` 把文章分组。传入的数组可以是全量，也可以是筛过的子集。
 * 返回顺序：文章多的在前，数量相同按名称排序。
 */
export function groupPostsByCategory(posts: BlogPost[]): CategoryGroup[] {
  const groups = new Map<string, CategoryGroup>();

  for (const post of posts) {
    const name = post.data.category.trim();
    const slug = categorySlug(name);

    let group = groups.get(slug);
    if (!group) {
      group = {
        slug,
        name,
        description: CATEGORY_DESCRIPTIONS[slug],
        count: 0,
        posts: [],
      };
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

/** 全部分类（按文章量倒序） */
export async function getAllCategories(): Promise<CategoryGroup[]> {
  const posts = await getCollection('blog');
  return groupPostsByCategory(posts);
}

/** 全部分类的「slug → 展示名」映射，供文章页把 category 转成链接与徽章 */
export function categoryHref(slug: string, base: string): string {
  return `${base}blog/category/${slug}/`;
}
