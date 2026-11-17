import * as THREE from 'three';
import { H, W } from '../../../shared/layout';

/** Quy đổi toạ độ sân 2D (1080×1920) sang không gian 3D (đơn vị mét: 10.8 × 19.2). */
export const SCALE = 0.01;

export function toX(x2d: number): number {
  return (x2d - W / 2) * SCALE;
}

export function toZ(y2d: number): number {
  return (y2d - H / 2) * SCALE;
}

export function toVec3(x2d: number, y2d: number, height = 0): THREE.Vector3 {
  return new THREE.Vector3(toX(x2d), height, toZ(y2d));
}

/** Tạo CanvasTexture từ hàm vẽ 2D để làm biển hiệu / bảng chữ 3D sắc nét. */
export function makeTextTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
