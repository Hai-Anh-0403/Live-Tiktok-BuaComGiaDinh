import * as THREE from 'three';
import {
  COUNTER, GATE, HOST_REST_SPOT, H, SEATS_PER_TABLE, STAGE, TABLE_COUNT, TABLE_RADIUS, W, seatPos, tablePos,
} from '../../../shared/layout';
import type { BondDTO, TableProgress } from '../../../shared/protocol';
import { SCALE, makeTextTexture, toX, toZ } from './coords';

const FONT = 'system-ui, "Segoe UI", Arial, sans-serif';

interface TableHud {
  sprite: THREE.Sprite;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  score: number;
  stars: number;
  progress: TableProgress | null;
}

export class Venue3D {
  readonly group = new THREE.Group();
  private lanterns: THREE.Group[] = [];
  private gateSignMat!: THREE.MeshStandardMaterial;
  private tableHuds: TableHud[] = [];
  private tableRings: THREE.Mesh[] = [];

  constructor(venueName: string) {
    this.buildGround();
    this.buildAwning();
    this.buildStage();
    this.buildCounter();
    this.buildGate(venueName);
    for (let t = 0; t < TABLE_COUNT; t++) this.buildTable(t);
  }

  private buildGround() {
    const tex = makeTextTexture(512, 512, (ctx, w, h) => {
      ctx.fillStyle = '#9b4f32';
      ctx.fillRect(0, 0, w, h);
      const bw = 64, bh = 32;
      for (let y = 0, r = 0; y < h; y += bh, r++) {
        for (let x = (r % 2) * -bw / 2; x < w; x += bw) {
          const v = ((x * 7 + y * 13) % 15) - 7;
          ctx.fillStyle = `rgb(${168 + v}, ${88 + Math.floor(v / 2)}, ${56 + Math.floor(v / 2)})`;
          ctx.fillRect(x + 2, y + 2, bw - 4, bh - 4);
        }
      }
    });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 10);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(W * SCALE + 4, H * SCALE + 4),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.group.add(floor);

    const pathMat = new THREE.MeshStandardMaterial({ color: 0xcab59c, roughness: 0.95 });
    for (const ax of [60, 380, 700, 1020]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.015, 11.2), pathMat);
      m.position.set(toX(ax), 0.008, toZ(1020));
      m.receiveShadow = true;
      this.group.add(m);
    }
    for (const ay of [480, 840, 1200, 1560]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(10.2, 0.015, 0.48), pathMat);
      m.position.set(0, 0.008, toZ(ay));
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  private buildAwning() {
    const tex = makeTextTexture(512, 64, (ctx, w, h) => {
      for (let i = 0; i < 16; i++) {
        ctx.fillStyle = i % 2 ? '#f4f1ea' : '#2f6fb5';
        ctx.fillRect(i * (w / 16), 0, w / 16, h);
      }
    });
    const awning = new THREE.Mesh(
      new THREE.BoxGeometry(W * SCALE + 0.6, 0.08, 1.4),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }),
    );
    awning.position.set(0, 2.75, toZ(120));
    awning.rotation.x = 0.28;
    awning.castShadow = true;
    this.group.add(awning);

    const poleMat = new THREE.MeshStandardMaterial({ color: 0x95a5a6, metalness: 0.6, roughness: 0.35 });
    for (const px of [-5.1, 5.1]) {
      for (const pz of [-8.2, -2.5, 3.2, 8.4]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 2.9, 10), poleMat);
        pole.position.set(px, 1.45, pz);
        pole.castShadow = true;
        this.group.add(pole);
      }
    }
  }

  private buildStage() {
    const { x, y, w, h } = STAGE;
    const cx = toX(x + w / 2);
    const sw = w * SCALE;
    const sd = (h - 100) * SCALE;

    const stageDeck = new THREE.Mesh(
      new THREE.BoxGeometry(sw, 0.28, sd),
      new THREE.MeshStandardMaterial({ color: 0x6d3317, roughness: 0.75 }),
    );
    stageDeck.position.set(cx, 0.14, toZ(y + 120 + (h - 120) / 2));
    stageDeck.receiveShadow = true;
    stageDeck.castShadow = true;
    this.group.add(stageDeck);

    // Bậc bước lên sân khấu
    const step = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.14, 0.32),
      new THREE.MeshStandardMaterial({ color: 0x7a3a1f, roughness: 0.75 }),
    );
    step.position.set(cx, 0.07, toZ(y + h) + 0.16);
    step.receiveShadow = true;
    this.group.add(step);

    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(sw + 0.04, 0.06, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xf5c26b, metalness: 0.3, roughness: 0.4 }),
    );
    trim.position.set(cx, 0.27, toZ(y + h));
    this.group.add(trim);

    const backTex = makeTextTexture(1024, 256, (ctx, bw, bh) => {
      ctx.fillStyle = '#8e1b12';
      ctx.fillRect(0, 0, bw, bh);
      ctx.strokeStyle = '#f5c26b';
      ctx.lineWidth = 14;
      ctx.strokeRect(10, 10, bw - 20, bh - 20);
      ctx.font = `900 72px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = '#4a0803';
      ctx.lineWidth = 12;
      ctx.strokeText('BỮA CƠM TÌNH NGHĨA', bw / 2, bh / 2);
      ctx.fillStyle = '#ffd76a';
      ctx.fillText('BỮA CƠM TÌNH NGHĨA', bw / 2, bh / 2);
    });
    const backdrop = new THREE.Mesh(
      new THREE.BoxGeometry(sw + 0.4, 1.55, 0.12),
      new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.6 }),
    );
    backdrop.position.set(cx, 1.05, toZ(y + 90));
    backdrop.castShadow = true;
    this.group.add(backdrop);

    const podium = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.42, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x7a3a1f, roughness: 0.6 }),
    );
    podium.position.set(cx, 0.49, toZ(y + h - 38));
    podium.castShadow = true;
    this.group.add(podium);

    const podiumTop = new THREE.Mesh(
      new THREE.BoxGeometry(0.96, 0.05, 0.48),
      new THREE.MeshStandardMaterial({ color: 0xf5c26b, roughness: 0.4 }),
    );
    podiumTop.position.set(cx, 0.72, toZ(y + h - 38));
    this.group.add(podiumTop);

    // Ghế nghỉ màu đỏ của chủ tiệc
    const chairSeat = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 0.24, 0.4),
      new THREE.MeshStandardMaterial({ color: 0xd6322b, roughness: 0.5 }),
    );
    chairSeat.position.set(toX(HOST_REST_SPOT.x), 0.4, toZ(HOST_REST_SPOT.y));
    chairSeat.castShadow = true;
    this.group.add(chairSeat);

    const chairBack = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 0.34, 0.08),
      new THREE.MeshStandardMaterial({ color: 0xa82820, roughness: 0.5 }),
    );
    chairBack.position.set(toX(HOST_REST_SPOT.x), 0.62, toZ(HOST_REST_SPOT.y) - 0.16);
    chairBack.castShadow = true;
    this.group.add(chairBack);

    const lanternMat = new THREE.MeshStandardMaterial({
      color: 0xe74c3c, emissive: 0xc0392b, emissiveIntensity: 0.55, roughness: 0.4,
    });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xf5c26b, metalness: 0.4, roughness: 0.4 });
    for (let i = 0; i < 6; i++) {
      const lx = toX(x + 30 + i * ((w - 60) / 5));
      const g = new THREE.Group();
      g.position.set(lx, 2.05, toZ(y + 70));
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), lanternMat);
      body.scale.set(1, 1.25, 1);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.06, 10), capMat);
      top.position.y = 0.2;
      const bot = top.clone();
      bot.position.y = -0.2;
      g.add(body, top, bot);
      this.group.add(g);
      this.lanterns.push(g);
    }
  }

  private buildCounter() {
    const cx = toX(COUNTER.x);
    const cz = toZ(COUNTER.y);
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.65, 0.62),
      new THREE.MeshStandardMaterial({ color: 0x6d3317, roughness: 0.7 }),
    );
    body.position.set(cx, 0.325, cz);
    body.castShadow = true;
    body.receiveShadow = true;
    this.group.add(body);

    const top = new THREE.Mesh(
      new THREE.BoxGeometry(1.46, 0.08, 0.68),
      new THREE.MeshStandardMaterial({ color: 0x8a4520, roughness: 0.5 }),
    );
    top.position.set(cx, 0.68, cz);
    this.group.add(top);

    const reg = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.24, 0.24),
      new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.4 }),
    );
    reg.position.set(cx + 0.34, 0.84, cz);
    const scr = new THREE.Mesh(
      new THREE.PlaneGeometry(0.24, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x1abc9c, emissive: 0x1abc9c, emissiveIntensity: 0.6 }),
    );
    scr.position.set(cx + 0.34, 0.86, cz + 0.125);
    this.group.add(reg, scr);

    const signTex = makeTextTexture(256, 80, (ctx, w, h) => {
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#f5c26b';
      ctx.lineWidth = 6;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      ctx.fillStyle = '#fff3c4';
      ctx.font = `bold 40px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('QUẦY', w / 2, h / 2);
    });
    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.36, 0.06),
      new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.5 }),
    );
    sign.position.set(cx, 1.38, cz);
    this.group.add(sign);
  }

  private buildGate(venueName: string) {
    const gx = toX(GATE.x);
    const gz = toZ(GATE.y);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x6d3317, roughness: 0.7 });
    for (const dx of [-1.6, 1.6]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.26, 1.5, 0.26), postMat);
      post.position.set(gx + dx, 0.75, gz);
      post.castShadow = true;
      this.group.add(post);
    }
    this.gateSignMat = new THREE.MeshStandardMaterial({ roughness: 0.5 });
    this.setVenueName(venueName);
    const board = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.56, 0.14), this.gateSignMat);
    board.position.set(gx, 1.62, gz);
    board.castShadow = true;
    this.group.add(board);
  }

  setVenueName(name: string) {
    const tex = makeTextTexture(512, 96, (ctx, w, h) => {
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#f5c26b';
      ctx.lineWidth = 8;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      ctx.fillStyle = '#fff3c4';
      ctx.font = `bold 36px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name || '66B Ngõ Tình Nghĩa', w / 2, h / 2);
    });
    this.gateSignMat.map?.dispose();
    this.gateSignMat.map = tex;
    this.gateSignMat.needsUpdate = true;
  }

  private buildTable(t: number) {
    const c = tablePos(t);
    const cx = toX(c.x);
    const cz = toZ(c.y);
    const r = TABLE_RADIUS * SCALE;

    const steelMat = new THREE.MeshStandardMaterial({ color: 0xbec3c7, metalness: 0.75, roughness: 0.25 });
    const clothMat = new THREE.MeshStandardMaterial({ color: 0xf7f2e7, roughness: 0.75 });
    const skirtMat = new THREE.MeshStandardMaterial({ color: t % 2 ? 0xb8241c : 0xd4a017, roughness: 0.65, side: THREE.DoubleSide });
    const trayMat = new THREE.MeshStandardMaterial({ color: 0xd5d8dc, metalness: 0.65, roughness: 0.22 });

    // 4 chân bàn inox + vòng giằng
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.02, 0.38, 8), steelMat);
      leg.position.set(cx + Math.cos(a) * (r * 0.62), 0.19, cz + Math.sin(a) * (r * 0.62));
      leg.castShadow = true;
      this.group.add(leg);
    }
    const brace = new THREE.Mesh(new THREE.TorusGeometry(r * 0.45, 0.015, 6, 16), steelMat);
    brace.rotation.x = Math.PI / 2;
    brace.position.set(cx, 0.12, cz);
    this.group.add(brace);

    // Mặt bàn tròn + khăn trải bàn rủ viền
    const top = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.04, 28), clothMat);
    top.position.set(cx, 0.39, cz);
    top.castShadow = true;
    top.receiveShadow = true;
    this.group.add(top);

    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.005, r + 0.035, 0.12, 28, 1, true), skirtMat);
    skirt.position.set(cx, 0.33, cz);
    this.group.add(skirt);

    // Mâm inox ở giữa
    const tray = new THREE.Mesh(new THREE.CylinderGeometry(r - 0.14, r - 0.16, 0.02, 24), trayMat);
    tray.position.set(cx, 0.42, cz);
    tray.receiveShadow = true;
    this.group.add(tray);

    // Nồi lẩu/gà vàng ở tâm + các đĩa thức ăn + bát cơm + chai bia thực tế
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.1, 0.07, 14),
      new THREE.MeshStandardMaterial({ color: 0xd4a017, metalness: 0.5, roughness: 0.28 }),
    );
    pot.position.set(cx, 0.46, cz);
    pot.castShadow = true;
    this.group.add(pot);

    const foodMat = [0xe67e22, 0x27ae60, 0xc0392b, 0xf1c40f];
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.35;
      const dx = cx + Math.cos(a) * 0.27;
      const dz = cz + Math.sin(a) * 0.27;
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.07, 0.016, 14), plateMat);
      plate.position.set(dx, 0.438, dz);
      const food = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 10, 8),
        new THREE.MeshStandardMaterial({ color: foodMat[k], roughness: 0.5 }),
      );
      food.scale.set(1.2, 0.5, 1.2);
      food.position.set(dx, 0.452, dz);
      this.group.add(plate, food);
    }

    // 2 chai bia xanh lá + cốc trên bàn
    const beerMat = new THREE.MeshStandardMaterial({ color: 0x1e8449, roughness: 0.2, metalness: 0.15 });
    for (let b = 0; b < 2; b++) {
      const ba = b * Math.PI + 0.9;
      const bx = cx + Math.cos(ba) * 0.17;
      const bz = cz + Math.sin(ba) * 0.17;
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.13, 10), beerMat);
      bottle.position.set(bx, 0.495, bz);
      this.group.add(bottle);
    }

    // Bát cơm xếp quanh mép bàn
    for (let s = 0; s < SEATS_PER_TABLE; s++) {
      const a = (s / SEATS_PER_TABLE) * Math.PI * 2 - Math.PI / 2 + Math.PI / SEATS_PER_TABLE;
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.03, 0.03, 10), plateMat);
      bowl.position.set(cx + Math.cos(a) * (r - 0.09), 0.425, cz + Math.sin(a) * (r - 0.09));
      this.group.add(bowl);
    }

    // Vòng sáng hiệu ứng khi thắng/đầy tình nghĩa
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r + 0.08, r + 0.2, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cx, 0.02, cz);
    this.group.add(ring);
    this.tableRings.push(ring);

    // 8 ghế nhựa thực tế (4 chân choãi + mặt ghế + tựa lưng cong)
    const chairColor = t % 2 ? 0xd6322b : 0x2468cc;
    const chairMat = new THREE.MeshStandardMaterial({ color: chairColor, roughness: 0.45 });
    for (let s = 0; s < SEATS_PER_TABLE; s++) {
      const p = seatPos(t, s);
      const sx = toX(p.x), sz = toZ(p.y);
      const chair = new THREE.Group();
      chair.position.set(sx, 0, sz);
      chair.lookAt(cx, 0, cz);

      // Mặt ghế
      const seatTop = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.035, 0.26), chairMat);
      seatTop.position.y = 0.24;
      seatTop.castShadow = true;
      seatTop.receiveShadow = true;
      chair.add(seatTop);

      // 4 chân ghế choãi nhẹ
      for (const lx of [-0.11, 0.11]) {
        for (const lz of [-0.1, 0.1]) {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.013, 0.25, 6), chairMat);
          leg.position.set(lx, 0.12, lz);
          leg.rotation.z = lx > 0 ? 0.08 : -0.08;
          leg.rotation.x = lz > 0 ? -0.08 : 0.08;
          leg.castShadow = true;
          chair.add(leg);
        }
      }

      // Tựa lưng phía sau (-Z theo hệ local vì lookAt(+Z) hướng vào tâm bàn)
      const backLeft = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.24, 0.03), chairMat);
      backLeft.position.set(-0.11, 0.36, -0.115);
      const backRight = backLeft.clone();
      backRight.position.x = 0.11;
      const backRest = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.11, 0.03), chairMat);
      backRest.position.set(0, 0.43, -0.115);
      backRest.castShadow = true;
      chair.add(backLeft, backRight, backRest);

      this.group.add(chair);
    }

    // Bảng thông tin Mâm + Tình nghĩa
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.position.set(cx, 1.05, cz);
    sprite.scale.set(1.25, 0.47, 1);
    sprite.renderOrder = 20;
    this.group.add(sprite);

    const hud: TableHud = { sprite, ctx, tex, score: 0, stars: 0, progress: null };
    this.tableHuds.push(hud);
    this.drawTableHud(t);
  }

  private drawTableHud(t: number) {
    const h = this.tableHuds[t];
    if (!h) return;
    const { ctx, tex, score, stars, progress } = h;
    ctx.clearRect(0, 0, 256, 96);

    ctx.fillStyle = 'rgba(26, 13, 6, 0.85)';
    roundRect(ctx, 48, 4, 160, 34, 10);
    ctx.fill();
    ctx.font = `bold 22px ${FONT}`;
    ctx.fillStyle = '#ffe9b8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Mâm ${t + 1}${stars ? ` ⭐${stars}` : ''}`, 128, 22);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    roundRect(ctx, 48, 42, 160, 14, 7);
    ctx.fill();
    if (score > 0) {
      ctx.fillStyle = score >= 80 ? '#ffd76a' : '#e74c3c';
      roundRect(ctx, 50, 44, Math.max(8, (156 * Math.min(100, score)) / 100), 10, 5);
      ctx.fill();
    }

    if (progress) {
      ctx.fillStyle = 'rgba(255, 215, 106, 0.95)';
      roundRect(ctx, 64, 60, 128, 30, 8);
      ctx.fill();
      ctx.fillStyle = '#2b1408';
      ctx.font = `bold 20px ${FONT}`;
      ctx.fillText(`${progress.icon ?? '🥣'} ${progress.done}/${progress.total}`, 128, 76);
    }
    tex.needsUpdate = true;
  }

  setBond(b: BondDTO) {
    for (let t = 0; t < TABLE_COUNT; t++) {
      const h = this.tableHuds[t];
      if (!h) continue;
      h.score = b.score[t] ?? 0;
      h.stars = b.stars[t] ?? 0;
      this.drawTableHud(t);
    }
  }

  setProgress(list: (TableProgress | null)[]) {
    for (let t = 0; t < TABLE_COUNT; t++) {
      const h = this.tableHuds[t];
      if (!h) continue;
      h.progress = list[t] ?? null;
      this.drawTableHud(t);
    }
  }

  pulseTable(t: number, kind: 'celebrate' | 'win') {
    const ring = this.tableRings[t];
    if (!ring) return;
    const mat = ring.material as THREE.MeshBasicMaterial;
    mat.color.setHex(kind === 'win' ? 0x4cd37b : 0xffd76a);
    mat.opacity = 0.95;
  }

  update(tSec: number, dt: number) {
    for (let i = 0; i < this.lanterns.length; i++) {
      this.lanterns[i].rotation.z = Math.sin(tSec * 2 + i) * 0.08;
    }
    for (const r of this.tableRings) {
      const mat = r.material as THREE.MeshBasicMaterial;
      if (mat.opacity > 0) mat.opacity = Math.max(0, mat.opacity - dt * 0.65);
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.closePath();
}
