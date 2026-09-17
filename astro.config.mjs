import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://hyxs1492.github.io',
  base: '/blog',
  trailingSlash: 'always',
  integrations: [mdx(), sitemap()],
});
