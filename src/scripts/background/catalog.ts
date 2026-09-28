/**
 * 3D 背景预设的**元数据目录**。
 *
 * ⚠️ 这个文件会被 `.astro` 的 frontmatter（服务端）导入，用来渲染切换器按钮，
 * 所以**绝不能**在这里 import three 或访问 window/document —— 否则 three 会被打进 SSR。
 * 每个预设的实现都在 `impl/` 下，由 `index.ts` 在浏览器里按需动态 import。
 */

export interface PresetMeta {
  id: PresetId;
  /** 切换器上显示的名字 */
  label: string;
  /** 一句话说明（按钮 title / 副标题） */
  hint: string;
}

export const PRESETS = [
  { id: 'starfield', label: '星野', hint: '漂浮的粒子星野，鼠标可带动视差（默认）' },
  { id: 'grid', label: '网格', hint: '赛博风格的网格地平线，向远处滚动' },
  { id: 'waves', label: '波浪', hint: '起伏的粒子波场，颜色随高度变化' },
  { id: 'classic', label: '经典', hint: '初版效果：方形粒子 + 线框圆环' },
  { id: 'minimal', label: '极简', hint: '关闭 3D，只留纯色渐变（最省电，不加载 three）' },
] as const satisfies readonly PresetMeta[];

export type PresetId = 'starfield' | 'grid' | 'waves' | 'classic' | 'minimal';

export const DEFAULT_PRESET: PresetId = 'starfield';

/** localStorage 键名 */
export const STORAGE_KEY = 'blog:bg-preset';

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === 'string' && PRESETS.some((preset) => preset.id === value);
}

export function getPresetMeta(id: PresetId): PresetMeta {
  const meta = PRESETS.find((preset) => preset.id === id);
  if (!meta) throw new Error(`未知的背景预设: ${id}`);
  return meta;
}
