import * as THREE from 'three';
import type { BackgroundContext, BackgroundInstance } from '../types';
import { POINT_FRAGMENT_SHADER } from './shaders';

/** 默认预设：漂浮的粒子星野 + 鼠标视差 */

const POINT_COUNT = 4200;
/** x/y 方向半宽（世界单位） */
const FIELD = 62;
/** 粒子分布在相机前方的深度 */
const DEPTH = 95;

const VERTEX_SHADER = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;

uniform float uSize;
uniform float uPixelRatio;
uniform float uTime;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vColor = aColor;

  vec3 pos = position;
  // 极缓的漂浮，避免整片星空死板
  pos.y += sin(uTime * 0.25 + pos.x * 0.06) * 0.9;
  pos.x += cos(uTime * 0.18 + pos.z * 0.05) * 0.9;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float dist = max(-mv.z, 0.001);
  gl_PointSize = clamp(uSize * aSize * uPixelRatio * (200.0 / dist), 0.7, 52.0);
  // 太远、太近都淡出
  vAlpha = smoothstep(140.0, 20.0, dist) * smoothstep(0.0, 8.0, dist);
}
`;

const PALETTE = [
  0xa855f7, // 紫
  0xec4899, // 粉
  0x3b82f6, // 蓝
  0x06b6d4, // 青
  0xe2e8f0, // 近白（点缀）
];

export function create(ctx: BackgroundContext): BackgroundInstance {
  ctx.camera.position.set(0, 0, 6);
  ctx.camera.lookAt(0, 0, 0);

  const positions = new Float32Array(POINT_COUNT * 3);
  const colors = new Float32Array(POINT_COUNT * 3);
  const sizes = new Float32Array(POINT_COUNT);
  const color = new THREE.Color();

  for (let i = 0; i < POINT_COUNT; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * FIELD * 2;
    positions[i * 3 + 1] = (Math.random() - 0.5) * FIELD * 2;
    positions[i * 3 + 2] = -Math.random() * DEPTH;

    // 少量白星做点缀，其余用主题色
    const hex = PALETTE[Math.random() < 0.12 ? 4 : Math.floor(Math.random() * 4)] ?? 0xa855f7;
    color.setHex(hex);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;

    // 平方分布 → 多数是小点，少数是大亮点
    sizes[i] = 0.35 + Math.random() * Math.random() * 1.9;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 1.15 },
      uPixelRatio: { value: ctx.pixelRatio },
      uTime: { value: 0 },
      uOpacity: { value: 0.95 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  ctx.scene.add(points);

  return {
    update(elapsed) {
      material.uniforms.uTime!.value = elapsed;
      points.rotation.y = elapsed * 0.02;
      points.rotation.x = Math.sin(elapsed * 0.1) * 0.04;

      // 鼠标视差
      ctx.camera.position.x = ctx.mouse.x * 3;
      ctx.camera.position.y = ctx.mouse.y * 2;
      ctx.camera.lookAt(0, 0, 0);
    },

    dispose() {
      ctx.scene.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}
