import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  // 读取 src/content/blog/ 下的所有 Markdown / MDX 文件
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  // 校验每篇文章的 frontmatter
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    heroImage: z.string().optional(),
  }),
});

export const collections = { blog };
