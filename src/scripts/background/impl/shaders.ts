/**
 * 所有「点」类预设共用的片元着色器：把方形点裁成圆形软边光点。
 *
 * 顶点着色器必须提供两个 varying：
 * - `vec3 vColor`
 * - `float vAlpha`（深度/距离衰减）
 * 以及 uniform `float uOpacity`。
 *
 * 注：three 默认的 GLSL1 前置里已把 `gl_FragColor` 映射到 WebGL2 的 `pc_fragColor`，
 * 所以这里直接写 `gl_FragColor` 是安全的。
 */
export const POINT_FRAGMENT_SHADER = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float dist = length(d);
  if (dist > 0.5) discard;
  float alpha = smoothstep(0.5, 0.05, dist) * vAlpha * uOpacity;
  gl_FragColor = vec4(vColor, alpha);
}
`;
