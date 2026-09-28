import type { BackgroundInstance } from '../types';

/**
 * 极简：不创建任何 WebGL 资源，只保留 global.css 里的渐变背景。
 * 因为不 import three，选它时连 three 都不会被下载 —— 手机 / 省电场景推荐。
 */
export function create(): BackgroundInstance {
  return {
    animated: false,
    update() {
      // 静态，无需逐帧更新
    },
    dispose() {
      // 无资源可释放
    },
  };
}
