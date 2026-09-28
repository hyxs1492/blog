/**
 * 3D 背景引擎。
 *
 * 引擎负责：renderer / scene / camera 的创建与销毁、RAF 循环、resize、鼠标跟踪、
 * 页面可见性暂停、右下角切换器，以及 localStorage 持久化。
 * 每个预设（`impl/*.ts`）只实现 types.ts 里的 `BackgroundInstance`。
 *
 * 两个刻意的设计：
 * 1. `three` 是**动态 import** —— 选「极简」时一个字节都不会下载。
 * 2. 依赖 `transition:persist`（见 ThreeBackground.astro）让 canvas 跨页保留，
 *    于是同一个 WebGL 上下文和 RAF 循环贯穿整站浏览，切页时背景不重启、不闪。
 *    万一 persist 失效，`applyPreset` 检测到 canvas 换了会自行重建。
 */

import { DEFAULT_PRESET, getPresetMeta, isPresetId, STORAGE_KEY, type PresetId } from './catalog';
import type { BackgroundInstance, PresetModule } from './types';
import type * as THREE from 'three';

type ThreeModule = typeof import('three');

const FOV = 75;
const MAX_PIXEL_RATIO = 2;
/** 标签页切回来时 delta 会很大，钳一下避免动画瞬移 */
const MAX_DELTA = 0.1;

const MODULE_LOADERS: Record<PresetId, () => Promise<PresetModule>> = {
  starfield: () => import('./impl/starfield'),
  grid: () => import('./impl/grid'),
  waves: () => import('./impl/waves'),
  classic: () => import('./impl/classic'),
  minimal: () => import('./impl/minimal'),
};

interface ActiveSession {
  id: PresetId;
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  camera: THREE.PerspectiveCamera | null;
  instance: BackgroundInstance | null;
  animated: boolean;
}

let active: ActiveSession | null = null;
/** 本次会话当前生效的预设；null 表示还没决定过 */
let currentId: PresetId | null = null;
let rafId: number | null = null;
let elapsed = 0;
let lastTs = 0;
let threePromise: Promise<ThreeModule> | null = null;
let wired = false;
const mouse = { x: 0, y: 0 };

/* ------------------------------------------------------------------ 工具 */

function getPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
}

function loadThree(): Promise<ThreeModule> {
  threePromise ??= import('three');
  return threePromise;
}

function readStored(): PresetId | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isPresetId(raw) ? raw : null;
  } catch {
    // 无痕模式 / 禁用存储
    return null;
  }
}

function writeStored(id: PresetId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // 存不了就算了，本次会话仍然生效
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ------------------------------------------------------------- RAF 循环 */

function stopLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function startLoop(): void {
  if (rafId !== null) return;
  lastTs = performance.now();

  const tick = (ts: number): void => {
    const session = active;
    if (!session?.instance || !session.camera || !session.renderer || !session.scene) {
      rafId = null;
      return;
    }

    const delta = Math.min(Math.max((ts - lastTs) / 1000, 0), MAX_DELTA);
    lastTs = ts;
    elapsed += delta;

    session.instance.update(elapsed, delta);
    session.renderer.render(session.scene, session.camera);
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
}

/* --------------------------------------------------------------- 切换器 */

function isPanelOpen(): boolean {
  return document.getElementById('bg-panel')?.classList.contains('open') ?? false;
}

function setPanelOpen(open: boolean): void {
  const panel = document.getElementById('bg-panel');
  const toggle = document.getElementById('bg-toggle');
  if (!panel || !toggle) return;
  panel.classList.toggle('open', open);
  toggle.setAttribute('aria-expanded', String(open));
}

function syncSwitcher(id: PresetId): void {
  document.querySelectorAll<HTMLElement>('[data-bg-preset]').forEach((button) => {
    const isActive = button.dataset.bgPreset === id;
    button.classList.toggle('active', isActive);
    // 与 ThreeBackground.astro 里的标记保持一致：普通按钮 + aria-pressed
    button.setAttribute('aria-pressed', String(isActive));
  });

  const toggle = document.getElementById('bg-toggle');
  if (toggle) {
    const { label } = getPresetMeta(id);
    toggle.setAttribute('title', `背景风格：${label}`);
    toggle.setAttribute('aria-label', `切换背景风格（当前：${label}）`);
  }
}

/* ----------------------------------------------------------------- 引擎 */

async function applyPreset(id: PresetId): Promise<void> {
  const canvas = document.getElementById('three-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;

  // canvas 与预设都没变（跨页导航）→ 动画继续跑，只需同步一下 UI
  if (active && active.canvas === canvas && active.id === id) {
    syncSwitcher(id);
    return;
  }

  stopLoop();

  const previous = active;
  const sameCanvas = previous?.canvas === canvas;
  if (previous) {
    try {
      previous.instance?.dispose();
    } catch (error) {
      console.warn('[bg] 释放上一个预设时出错', error);
    }
    previous.scene?.clear();
    // canvas 真的被换掉了（persist 没生效），旧上下文才可以安全丢弃
    if (!sameCanvas && previous.renderer) {
      try {
        previous.renderer.dispose();
      } catch {
        /* 忽略 */
      }
    }
  }

  currentId = id;

  // ---- 极简：清一次画面收工，完全不碰 three ----
  if (id === 'minimal') {
    if (sameCanvas && previous?.renderer) {
      previous.renderer.setClearColor(0x000000, 0);
      previous.renderer.clear();
    }
    active = {
      id,
      canvas,
      renderer: sameCanvas ? (previous?.renderer ?? null) : null,
      scene: null,
      camera: null,
      instance: null,
      animated: false,
    };
    syncSwitcher(id);
    return;
  }

  // ---- 需要 WebGL 的预设 ----
  const THREE = await loadThree();

  const renderer = sameCanvas && previous?.renderer ? previous.renderer : new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  const pixelRatio = getPixelRatio();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 3000);
  camera.position.set(0, 0, 5);

  const module = await MODULE_LOADERS[id]();
  const instance = module.create({ scene, camera, renderer, mouse, pixelRatio });
  const animated = instance.animated !== false;

  active = { id, canvas, renderer, scene, camera, instance, animated };
  elapsed = 0;
  syncSwitcher(id);

  if (animated) startLoop();
  else renderer.render(scene, camera);
}

/* --------------------------------------------------------------- 事件 */

function handleResize(): void {
  const session = active;
  if (!session?.renderer || !session.camera) return;

  const width = window.innerWidth;
  const height = window.innerHeight;
  session.camera.aspect = width / height;
  session.camera.updateProjectionMatrix();
  session.renderer.setPixelRatio(getPixelRatio());
  session.renderer.setSize(width, height, false);
  session.instance?.resize?.(width, height);
}

function handlePointerMove(event: PointerEvent): void {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -((event.clientY / window.innerHeight) * 2 - 1);
}

function handleVisibility(): void {
  if (document.hidden) stopLoop();
  else if (active?.animated) startLoop();
}

function handleClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;

  if (target.closest('#bg-toggle')) {
    setPanelOpen(!isPanelOpen());
    return;
  }

  const option = target.closest<HTMLElement>('[data-bg-preset]');
  const presetId = option?.dataset.bgPreset;
  if (presetId !== undefined && isPresetId(presetId)) {
    writeStored(presetId);
    setPanelOpen(false);
    void applyPreset(presetId);
    return;
  }

  // 点面板以外的地方收起
  if (isPanelOpen() && !target.closest('#bg-panel')) setPanelOpen(false);
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') setPanelOpen(false);
}

function wireOnce(): void {
  if (wired) return;
  wired = true;

  window.addEventListener('resize', handleResize, { passive: true });
  window.addEventListener('pointermove', handlePointerMove, { passive: true });
  document.addEventListener('visibilitychange', handleVisibility);
  document.addEventListener('click', handleClick);
  document.addEventListener('keydown', handleKeydown);
}

/* ------------------------------------------------------------------ API */

/** 每次 `astro:page-load` 调用；幂等。 */
export function initBackground(): void {
  wireOnce();

  const id =
    currentId ?? readStored() ?? (prefersReducedMotion() ? 'minimal' : DEFAULT_PRESET);

  void applyPreset(id);
}

/** 真正离开页面（含 bfcache）时释放 WebGL 上下文。 */
export function teardownBackground(): void {
  stopLoop();
  if (!active) return;

  try {
    active.instance?.dispose();
  } catch {
    /* 忽略 */
  }
  active.scene?.clear();
  try {
    active.renderer?.dispose();
  } catch {
    /* 忽略 */
  }

  active = null;
  currentId = null;
}
