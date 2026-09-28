import * as THREE from 'three';
import type { BackgroundContext, BackgroundInstance } from '../types';

/** 赛博网格地平线：向观察者滚动的线框地面 */

const SIZE = 400;
const DIVISIONS = 80;
const CELL = SIZE / DIVISIONS;
/** 每秒前进多少世界单位 */
const SPEED = 14;

/**
 * ⚠️ 关键约束：沿 Z 方向的线必须**终止在相机前方**（相机在 z = 18）。
 *
 * 如果一条线的两个端点分居相机平面两侧（一个在相机背后），它在 SwiftShader 等光栅化器上
 * 会被**整条丢弃** —— 实测终止于 z=+200 时，81 条 Z 向线一条都画不出来，画面上只剩横向条纹。
 * 收在 z=10 之后，端点始终在相机前方；配合 0..CELL 的滚动，近端又始终落在画面下缘之外，
 * 所以看不出线在哪里断掉。
 */
const NEAR_END = 10;

const VERTEX_SHADER = /* glsl */ `
uniform float uNear;
uniform float uFar;

varying float vFade;
varying float vDist;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  float dist = max(-mv.z, 0.0);
  vDist = dist;
  // 近处清晰、远处淡出，避免看到网格的硬边界
  vFade = smoothstep(uFar, uNear, dist);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uAccent;
uniform float uOpacity;

varying float vFade;
varying float vDist;

void main() {
  // 近处偏粉、远处偏紫
  vec3 color = mix(uAccent, uColor, clamp(vDist / 70.0, 0.0, 1.0));
  gl_FragColor = vec4(color, vFade * uOpacity);
}
`;

export function create(ctx: BackgroundContext): BackgroundInstance {
  ctx.camera.fov = 68;
  // 机位抬高到约 1.4 格，才能看出「地面向远处收拢」的透视
  ctx.camera.position.set(0, 7, 18);
  ctx.camera.lookAt(0, 0, -30);
  ctx.camera.updateProjectionMatrix();

  const half = SIZE / 2;
  const vertices: number[] = [];

  // 沿 X 的线（横向），z 覆盖「远景 → 相机前方少许」
  const crossCount = Math.ceil((NEAR_END + CELL + half) / CELL);
  for (let i = 0; i <= crossCount; i += 1) {
    const z = -half + i * CELL;
    vertices.push(-half, 0, z, half, 0, z);
  }

  // 沿 Z 的线（纵向，构成消失点），一律收在 NEAR_END
  for (let i = 0; i <= DIVISIONS; i += 1) {
    const x = -half + i * CELL;
    vertices.push(x, 0, -half, x, 0, NEAR_END);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x8b5cf6) },
      uAccent: { value: new THREE.Color(0xf472b6) },
      uOpacity: { value: 0.72 },
      uNear: { value: 6 },
      uFar: { value: 170 },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const grid = new THREE.LineSegments(geometry, material);
  ctx.scene.add(grid);

  return {
    update(elapsed) {
      // 按一格的整数倍回绕 → 看起来无限向前滚
      grid.position.z = (elapsed * SPEED) % CELL;

      ctx.camera.position.x = ctx.mouse.x * 4;
      ctx.camera.position.y = 7 + ctx.mouse.y * 1.5;
      ctx.camera.lookAt(ctx.mouse.x * 2, 0, -30);
    },

    dispose() {
      ctx.scene.remove(grid);
      geometry.dispose();
      material.dispose();
    },
  };
}
