import * as THREE from 'three';
import type { BackgroundContext, BackgroundInstance } from '../types';
import { POINT_FRAGMENT_SHADER } from './shaders';

/** 波浪：一整片粒子构成的水平面，高度由顶点着色器里的多重正弦叠加算出 */

const SIZE = 130;
const SEGMENTS = 118;

const VERTEX_SHADER = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uPixelRatio;

varying vec3 vColor;
varying float vAlpha;

// 三重正弦叠加，得到不规则但连续的起伏
float waveHeight(vec2 p, float t) {
  return sin(p.x * 0.14 + t * 0.75) * 0.9
       + sin(p.y * 0.19 - t * 0.55) * 0.7
       + sin((p.x + p.y) * 0.09 + t * 0.32) * 0.55;
}

void main() {
  vec3 pos = position;
  float h = waveHeight(pos.xz, uTime);
  pos.y = h;

  // 低处蓝 → 中段紫 → 高处粉
  vec3 low = vec3(0.23, 0.51, 0.96);
  vec3 mid = vec3(0.66, 0.33, 0.97);
  vec3 high = vec3(0.93, 0.28, 0.60);
  float k = clamp((h + 2.15) / 4.3, 0.0, 1.0);
  vColor = k < 0.5 ? mix(low, mid, k * 2.0) : mix(mid, high, (k - 0.5) * 2.0);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float dist = max(-mv.z, 0.001);
  gl_PointSize = clamp(uSize * uPixelRatio * (170.0 / dist), 0.6, 16.0);
  vAlpha = smoothstep(125.0, 12.0, dist) * smoothstep(0.0, 5.0, dist);
}
`;

export function create(ctx: BackgroundContext): BackgroundInstance {
  ctx.camera.fov = 60;
  ctx.camera.position.set(0, 7, 26);
  ctx.camera.lookAt(0, 0, -4);
  ctx.camera.updateProjectionMatrix();

  const positions = new Float32Array((SEGMENTS + 1) * (SEGMENTS + 1) * 3);
  const step = SIZE / SEGMENTS;
  const half = SIZE / 2;

  let i = 0;
  for (let ix = 0; ix <= SEGMENTS; ix += 1) {
    for (let iz = 0; iz <= SEGMENTS; iz += 1) {
      positions[i] = -half + ix * step;
      positions[i + 1] = 0;
      positions[i + 2] = -half + iz * step;
      i += 3;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: 0.75 },
      uPixelRatio: { value: ctx.pixelRatio },
      uOpacity: { value: 0.9 },
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

      ctx.camera.position.x = ctx.mouse.x * 7;
      ctx.camera.position.y = 7 + ctx.mouse.y * 3;
      ctx.camera.lookAt(0, 0, -4);
    },

    dispose() {
      ctx.scene.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}
