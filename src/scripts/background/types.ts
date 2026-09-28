import type * as THREE from 'three';

/** 引擎给预设的运行时环境。scene / camera 每次切换预设都会重建。 */
export interface BackgroundContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** 归一化鼠标位置，x/y ∈ [-1, 1]，y 向上 */
  mouse: { x: number; y: number };
  /** 已限幅的设备像素比（用于 gl_PointSize 换算） */
  pixelRatio: number;
}

/**
 * 一个背景预设。实现方只管自己的 scene 内容，
 * renderer / RAF 循环 / resize / 鼠标跟踪 / 页面可见性都由引擎负责。
 */
export interface BackgroundInstance {
  /** 本预设是否需要逐帧渲染。`false` 时引擎画完一帧就停下（省电）。 */
  animated?: boolean;
  /** 当前 canvas 尺寸变化时调用（可选） */
  resize?(width: number, height: number): void;
  /** 每帧调用：elapsed = 累计秒数，delta = 距上一帧秒数 */
  update(elapsed: number, delta: number): void;
  /** 释放本预设创建的 geometry / material / 监听器。scene 本身由引擎清理。 */
  dispose(): void;
}

/** 每个 `impl/*.ts` 必须导出这个函数 */
export type PresetModule = {
  create(ctx: BackgroundContext): BackgroundInstance;
};
