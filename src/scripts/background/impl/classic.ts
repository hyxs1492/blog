import * as THREE from 'three';
import type { BackgroundContext, BackgroundInstance } from '../types';

/**
 * 初版效果（原 ThreeBackground.astro 的场景，原样保留）：
 * 5000 个方形粒子 + 两个线框圆环。想回到最初的样子就选这个。
 */

const POINT_COUNT = 5000;

export function create(ctx: BackgroundContext): BackgroundInstance {
  ctx.camera.position.z = 5;

  // ---- 粒子 ----
  const positions = new Float32Array(POINT_COUNT * 3);
  const colors = new Float32Array(POINT_COUNT * 3);

  for (let i = 0; i < POINT_COUNT * 3; i += 3) {
    positions[i] = (Math.random() - 0.5) * 100;
    positions[i + 1] = (Math.random() - 0.5) * 100;
    positions[i + 2] = (Math.random() - 0.5) * 100;

    const colorType = Math.random();
    if (colorType < 0.33) {
      // 紫
      colors[i] = 0.66;
      colors[i + 1] = 0.33;
      colors[i + 2] = 0.97;
    } else if (colorType < 0.66) {
      // 粉
      colors[i] = 0.93;
      colors[i + 1] = 0.28;
      colors[i + 2] = 0.6;
    } else {
      // 蓝
      colors[i] = 0.23;
      colors[i + 1] = 0.51;
      colors[i + 2] = 0.96;
    }
  }

  const particlesGeometry = new THREE.BufferGeometry();
  particlesGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  particlesGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const particlesMaterial = new THREE.PointsMaterial({
    size: 0.15,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
  });

  const particles = new THREE.Points(particlesGeometry, particlesMaterial);
  ctx.scene.add(particles);

  // ---- 两个线框圆环 ----
  const torusGeometry = new THREE.TorusGeometry(10, 3, 16, 100);
  const torusMaterial = new THREE.MeshBasicMaterial({
    color: 0xa855f7,
    wireframe: true,
    transparent: true,
    opacity: 0.3,
  });
  const torus = new THREE.Mesh(torusGeometry, torusMaterial);
  ctx.scene.add(torus);

  const torus2Geometry = new THREE.TorusGeometry(15, 2, 16, 100);
  const torus2Material = new THREE.MeshBasicMaterial({
    color: 0xec4899,
    wireframe: true,
    transparent: true,
    opacity: 0.2,
  });
  const torus2 = new THREE.Mesh(torus2Geometry, torus2Material);
  torus2.rotation.x = Math.PI / 4;
  ctx.scene.add(torus2);

  return {
    update(elapsed, delta) {
      // 原实现按「帧」累加 0.001，这里换算成秒，保证不同刷新率下速度一致
      const time = elapsed * 0.06;
      // 原实现每帧的增量，换算到「每秒」（按 60fps 计）
      const perSecond = 60;

      particles.rotation.y = time * 0.3;
      particles.rotation.x = Math.sin(time) * 0.1;

      torus.rotation.x += 0.01 * perSecond * delta;
      torus.rotation.y += 0.005 * perSecond * delta;
      torus.rotation.z += 0.003 * perSecond * delta;

      torus2.rotation.x += 0.005 * perSecond * delta;
      torus2.rotation.y += 0.01 * perSecond * delta;
      torus2.rotation.z += 0.002 * perSecond * delta;

      ctx.camera.position.x = ctx.mouse.x * 2;
      ctx.camera.position.y = ctx.mouse.y * 2;
      ctx.camera.lookAt(ctx.scene.position);
    },

    dispose() {
      ctx.scene.remove(particles, torus, torus2);
      particlesGeometry.dispose();
      particlesMaterial.dispose();
      torusGeometry.dispose();
      torusMaterial.dispose();
      torus2Geometry.dispose();
      torus2Material.dispose();
    },
  };
}
