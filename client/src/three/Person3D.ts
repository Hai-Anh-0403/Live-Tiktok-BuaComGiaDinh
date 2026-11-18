import * as THREE from 'three';
import type { EmoteKind } from '../../../shared/protocol';
import { STAGE, type Pt } from '../../../shared/layout';
import type { Look } from '../objects/look';
import { toX, toZ } from './coords';

const FONT = 'system-ui, "Segoe UI", Arial, sans-serif';

// Cache Texture cho các file PNG thiết kế (host + 5 nhân vật người chơi)
const TEX_LOADER = new THREE.TextureLoader();
const SPRITE_TEX = new Map<string, THREE.Texture>();
function loadCharTex(url: string): THREE.Texture {
  let tex = SPRITE_TEX.get(url);
  if (!tex) {
    tex = TEX_LOADER.load(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    SPRITE_TEX.set(url, tex);
  }
  return tex;
}

// Cache Geometry cho NPC đặc biệt (host_old, quang, chuc)
const GEO = {
  shadow: new THREE.CircleGeometry(0.24, 16),
  ring: new THREE.RingGeometry(0.26, 0.36, 24),
  head: new THREE.SphereGeometry(0.22, 16, 14),
  torso: new THREE.CylinderGeometry(0.15, 0.18, 0.34, 12),
  arm: new THREE.CapsuleGeometry(0.055, 0.16, 4, 8),
  leg: new THREE.CapsuleGeometry(0.06, 0.14, 4, 8),
  eye: new THREE.SphereGeometry(0.025, 8, 8),
  mouth: new THREE.BoxGeometry(0.09, 0.02, 0.03),
  fedoraBrim: new THREE.CylinderGeometry(0.32, 0.32, 0.02, 16),
  fedoraTop: new THREE.CylinderGeometry(0.16, 0.18, 0.14, 14),
  sunglassLens: new THREE.BoxGeometry(0.11, 0.065, 0.03),
  sunglassBridge: new THREE.BoxGeometry(0.05, 0.015, 0.02),
  bowl: new THREE.SphereGeometry(0.09, 10, 8, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
};

const MAT_CACHE = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: number, rough = 0.65, metal = 0.05): THREE.MeshStandardMaterial {
  const k = `${color}_${rough}_${metal}`;
  let m = MAT_CACHE.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    MAT_CACHE.set(k, m);
  }
  return m;
}

export class Person3D {
  readonly root = new THREE.Group();
  private bodyPivot = new THREE.Group();
  private sprite?: THREE.Sprite;
  private spriteBaseW = 1.06;
  private spriteBaseH = 1.38;
  private facingSign = 1;

  // Cho mô hình khối (Ông cụ, Chú Quang, Chú Chực)
  private armL?: THREE.Group;
  private armR?: THREE.Group;
  private legL?: THREE.Group;
  private legR?: THREE.Group;
  private mouth?: THREE.Mesh;

  private ring: THREE.Mesh;
  private labelSprite: THREE.Sprite;
  private labelCtx: CanvasRenderingContext2D;
  private labelTex: THREE.CanvasTexture;

  anchor: number;
  seated = false;
  x2d: number;
  y2d: number;
  private path: Pt[] = [];
  private onArrive?: () => void;
  private speed: number;
  readonly sc: number;
  private isHost: boolean;
  private walkT = 0;
  private walkElapsed = 0;
  private walkExpected = 0;
  private stuckReported = false;
  private pose: 'stand' | 'sit' = 'stand';
  private highlightUntil = 0;
  private dizzyUntil = 0;
  private jumpOffset = 0;
  private vip = false;
  private rawName: string;

  onStuck?: () => void;

  constructor(
    x2d: number,
    y2d: number,
    anchor: number,
    look: Look,
    name: string,
    opts: { host?: boolean; npc?: boolean } = {},
  ) {
    this.x2d = x2d;
    this.y2d = y2d;
    this.anchor = anchor;
    this.rawName = name;
    this.isHost = !!opts.host || !!opts.npc;
    this.sc = opts.host ? 1.38 : opts.npc ? 1.2 : 1.0;
    this.speed = opts.host ? 190 : opts.npc ? 200 : 230 + Math.random() * 60;

    this.setPosition2D(x2d, y2d);

    const shadow = new THREE.Mesh(GEO.shadow, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.015;
    shadow.scale.setScalar(this.sc);
    this.root.add(shadow);

    this.ring = new THREE.Mesh(GEO.ring, new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.025;
    this.ring.scale.setScalar(this.sc);
    this.root.add(this.ring);

    this.bodyPivot.scale.setScalar(this.sc);
    this.root.add(this.bodyPivot);

    this.buildVisual(look);

    // Nhãn tên ngay trên đầu nhân vật
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 56;
    this.labelCtx = canvas.getContext('2d')!;
    this.labelTex = new THREE.CanvasTexture(canvas);
    this.labelTex.colorSpace = THREE.SRGBColorSpace;
    this.labelSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.labelTex, transparent: true, depthTest: false }));
    this.labelSprite.position.set(0, 1.26 * this.sc, 0);
    this.labelSprite.scale.set(1.15, 0.25, 1);
    this.labelSprite.renderOrder = 30;
    this.root.add(this.labelSprite);
    this.setLabel(opts.host || opts.npc ? name : shortName(name), opts.host ? '#ffe08a' : opts.npc ? '#9fe0ff' : '#ffffff');
  }

  private buildVisual(l: Look) {
    this.bodyPivot.clear();
    this.sprite = undefined;
    this.armL = this.armR = this.legL = this.legR = this.mouth = undefined;

    // Dùng trực tiếp ảnh thiết kế tách nền cho Chủ tiệc, Chú Quang, Chú Chực và 5 nhân vật người chơi
    const imgUrl = l.special === 'host'
      ? '/assets/host.png'
      : l.special === 'quang'
        ? '/assets/quang.png'
        : l.special === 'chuc'
          ? '/assets/chuc.png'
          : (!l.special && l.guestSprite !== undefined)
            ? `/assets/guest_${l.guestSprite}.png`
            : '';

    if (imgUrl) {
      const tex = loadCharTex(imgUrl);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.08 }));
      // Khung PNG 256x336, gốc chân ở y=288/336 (~0.14 tính từ đáy lên)
      sp.center.set(0.5, 0.14);
      sp.scale.set(this.spriteBaseW * this.facingSign, this.spriteBaseH, 1);
      sp.position.y = 0.06;
      sp.renderOrder = 15;
      this.sprite = sp;
      this.bodyPivot.add(sp);
      return;
    }

    // NPC đặc biệt (host_old, quang, chuc) dùng khối 3D
    let skin = l.skin, shirt = l.shirt, pants = l.pants, hair = l.hair;
    let glasses: 'sun' | 'round' | undefined = l.accessory === 3 ? 'sun' : l.accessory === 1 ? 'round' : undefined;
    let fedora = l.hairStyle === 4;

    if (l.special === 'host_old') {
      skin = 0xe0ac7e; shirt = 0x8d6e63; pants = 0x3e2723; hair = 0xe8e8e8; glasses = 'round'; fedora = false;
    } else if (l.special === 'quang') {
      skin = 0xe0ac7e; shirt = 0x2f6fb5; pants = 0x3e3e3e; hair = 0x5d4037; glasses = 'sun'; fedora = true;
    } else if (l.special === 'chuc') {
      skin = 0xc68a5e; shirt = 0xf4f4f4; pants = 0x5d4037; hair = 0x1b1b1b;
    }

    this.legL = new THREE.Group();
    this.legL.position.set(-0.08, 0.24, 0);
    const lmL = new THREE.Mesh(GEO.leg, mat(pants, 0.8)); lmL.position.y = -0.1; lmL.castShadow = true;
    this.legL.add(lmL);

    this.legR = new THREE.Group();
    this.legR.position.set(0.08, 0.24, 0);
    const lmR = new THREE.Mesh(GEO.leg, mat(pants, 0.8)); lmR.position.y = -0.1; lmR.castShadow = true;
    this.legR.add(lmR);
    this.bodyPivot.add(this.legL, this.legR);

    const torso = new THREE.Mesh(GEO.torso, mat(shirt, 0.7));
    torso.position.y = 0.4; torso.castShadow = true;
    this.bodyPivot.add(torso);

    this.armL = new THREE.Group();
    this.armL.position.set(-0.2, 0.52, 0);
    const amL = new THREE.Mesh(GEO.arm, mat(skin, 0.65)); amL.position.y = -0.11; amL.castShadow = true;
    this.armL.add(amL);

    this.armR = new THREE.Group();
    this.armR.position.set(0.2, 0.52, 0);
    const amR = new THREE.Mesh(GEO.arm, mat(skin, 0.65)); amR.position.y = -0.11; amR.castShadow = true;
    this.armR.add(amR);
    if (l.accessory === 4) {
      const bowl = new THREE.Mesh(GEO.bowl, mat(0xffffff, 0.3));
      bowl.position.set(0, -0.22, 0.08);
      this.armR.add(bowl);
    }
    this.bodyPivot.add(this.armL, this.armR);

    const head = new THREE.Mesh(GEO.head, mat(skin, 0.6));
    head.position.y = 0.74; head.castShadow = true;
    this.bodyPivot.add(head);

    const eyeL = new THREE.Mesh(GEO.eye, mat(0x1b1b1b, 0.3));
    eyeL.position.set(-0.075, 0.75, 0.2);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.075;
    this.bodyPivot.add(eyeL, eyeR);

    if (this.isHost) {
      this.mouth = new THREE.Mesh(GEO.mouth, mat(0x5a1a10, 0.5));
      this.mouth.position.set(0, 0.65, 0.205);
      this.mouth.visible = false;
      this.bodyPivot.add(this.mouth);
    }

    if (l.beard) {
      const beard = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.18, 8), mat(0xf0f0f0, 0.8));
      beard.rotation.x = Math.PI; beard.position.set(0, 0.57, 0.16);
      this.bodyPivot.add(beard);
    }

    if (glasses === 'sun') {
      const lensMat = mat(0x11151c, 0.2, 0.6);
      const l1 = new THREE.Mesh(GEO.sunglassLens, lensMat); l1.position.set(-0.08, 0.755, 0.215);
      const l2 = l1.clone(); l2.position.x = 0.08;
      const br = new THREE.Mesh(GEO.sunglassBridge, mat(0xd4af37, 0.3, 0.8)); br.position.set(0, 0.765, 0.218);
      this.bodyPivot.add(l1, l2, br);
    } else if (glasses === 'round') {
      const rimMat = mat(0x333333, 0.3, 0.8);
      const g1 = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.008, 6, 16), rimMat); g1.position.set(-0.075, 0.755, 0.212);
      const g2 = g1.clone(); g2.position.x = 0.075;
      this.bodyPivot.add(g1, g2);
    }

    if (fedora) {
      const brim = new THREE.Mesh(GEO.fedoraBrim, mat(0x3e2723, 0.6)); brim.position.y = 0.9;
      const top = new THREE.Mesh(GEO.fedoraTop, mat(0x3e2723, 0.6)); top.position.y = 0.98;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.175, 0.175, 0.03, 14), mat(0xc0392b, 0.5)); band.position.y = 0.92;
      this.bodyPivot.add(brim, top, band);
    } else {
      const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(hair, 0.8));
      hairCap.position.y = 0.765; hairCap.rotation.x = -0.15;
      this.bodyPivot.add(hairCap);
    }
  }

  setLabel(text: string, color = '#ffe08a') {
    const ctx = this.labelCtx;
    ctx.clearRect(0, 0, 256, 56);
    ctx.font = `bold 28px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#1a0d06';
    ctx.lineWidth = 7;
    ctx.strokeText(text, 128, 28);
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 28);
    this.labelTex.needsUpdate = true;
  }

  setLook(look: Look) {
    this.buildVisual(look);
  }

  setMouth(level: number) {
    if (this.mouth) {
      if (level <= 0.04) { this.mouth.visible = false; }
      else { this.mouth.visible = true; this.mouth.scale.y = 1 + level * 3.5; }
    }
    // Khi nhân vật sprite đang nói thì nhún nhẹ miệng/đầu cho sinh động
    if (this.sprite && level > 0.05) {
      this.sprite.scale.y = this.spriteBaseH * (1 + level * 0.04);
    }
  }

  setPose(pose: 'stand' | 'sit') {
    this.pose = pose;
    this.applySitPose();
  }

  private applySitPose() {
    const sit = this.pose === 'sit' || this.seated;
    if (this.sprite) {
      this.sprite.scale.set(this.spriteBaseW * this.facingSign, this.spriteBaseH * (sit ? 0.88 : 1), 1);
      this.bodyPivot.position.y = (sit ? 0.04 : 0) + this.jumpOffset;
      return;
    }
    this.bodyPivot.position.y = (sit ? -0.1 : 0) + this.jumpOffset;
    if (this.legL && this.legR && this.armL && this.armR) {
      this.legL.rotation.x = sit ? -1.15 : 0;
      this.legR.rotation.x = sit ? -1.15 : 0;
      if (sit) {
        this.armL.rotation.x = -0.45;
        this.armR.rotation.x = -0.45;
      } else if (!this.path.length) {
        this.armL.rotation.x = 0;
        this.armR.rotation.x = 0;
      }
    }
  }

  walk(points: Pt[], onArrive?: () => void) {
    this.path = points.slice();
    this.onArrive = onArrive;
    this.seated = false;
    this.pose = 'stand';
    this.applySitPose();
    let len = 0, px = this.x2d, py = this.y2d;
    for (const p of this.path) { len += Math.hypot(p.x - px, p.y - py); px = p.x; py = p.y; }
    this.walkExpected = len / this.speed;
    this.walkElapsed = 0;
    this.stuckReported = false;
  }

  setPosition2D(x2d: number, y2d: number) {
    this.x2d = x2d;
    this.y2d = y2d;
    const onStage = x2d >= STAGE.x - 10 && x2d <= STAGE.x + STAGE.w + 10 && y2d >= STAGE.y + 100 && y2d <= STAGE.y + STAGE.h + 10;
    const baseY = onStage ? 0.28 : 0;
    this.root.position.set(toX(x2d), baseY, toZ(y2d));
  }

  face(x2d: number, y2d = this.y2d + 50) {
    const dx = x2d - this.x2d;
    const dz = y2d - this.y2d;
    if (this.sprite) {
      if (Math.abs(dx) > 2) {
        this.facingSign = dx < 0 ? -1 : 1;
        this.sprite.scale.x = this.spriteBaseW * this.facingSign;
      }
      return;
    }
    if (Math.hypot(dx, dz) > 0.5) {
      this.bodyPivot.rotation.y = Math.atan2(dx, dz);
    }
  }

  highlight(ms = 2500) {
    this.highlightUntil = Date.now() + ms;
  }

  setVip(on: boolean) {
    if (this.vip === on) return;
    this.vip = on;
    if (on) this.setLabel(`👑 ${shortName(this.rawName)}`, '#ffd76a');
  }

  triggerEmote(kind: EmoteKind) {
    if (kind === 'dizzy') this.dizzyUntil = Date.now() + 1600;
    else this.jumpOffset = 0.2;
  }

  get moving() { return this.path.length > 0; }

  update(dt: number, now: number) {
    const ringMat = this.ring.material as THREE.MeshBasicMaterial;
    if (this.vip || now < this.highlightUntil) {
      ringMat.opacity = this.vip ? (0.65 + 0.35 * Math.sin(now * 0.008)) : (0.5 + 0.5 * Math.sin(now * 0.015));
    } else if (ringMat.opacity > 0) {
      ringMat.opacity = 0;
    }

    if (this.jumpOffset > 0) this.jumpOffset = Math.max(0, this.jumpOffset - dt * 1.1);

    if (now < this.dizzyUntil) {
      this.bodyPivot.rotation.z = Math.sin(now * 0.03) * 0.2;
    } else {
      this.bodyPivot.rotation.z = 0;
    }

    if (!this.path.length) {
      this.applySitPose();
      return;
    }

    this.walkElapsed += dt;
    if (!this.stuckReported && this.walkElapsed > this.walkExpected * 1.5 + 3) {
      this.stuckReported = true;
      this.onStuck?.();
    }

    const tgt = this.path[0];
    const dx = tgt.x - this.x2d, dy = tgt.y - this.y2d;
    const d = Math.hypot(dx, dy);
    const step = this.speed * dt;
    if (d <= step) {
      this.setPosition2D(tgt.x, tgt.y);
      this.path.shift();
      if (!this.path.length) {
        if (this.armL && this.armR && this.legL && this.legR) {
          this.armL.rotation.x = this.armR.rotation.x = 0;
          this.legL.rotation.x = this.legR.rotation.x = 0;
        }
        this.bodyPivot.position.y = 0;
        const cb = this.onArrive;
        this.onArrive = undefined;
        cb?.();
        return;
      }
    } else {
      this.setPosition2D(this.x2d + (dx / d) * step, this.y2d + (dy / d) * step);
      if (this.sprite) {
        if (Math.abs(dx) > 1) {
          this.facingSign = dx < 0 ? -1 : 1;
          this.sprite.scale.x = this.spriteBaseW * this.facingSign;
        }
      } else {
        this.bodyPivot.rotation.y = Math.atan2(dx, dy);
      }
    }

    this.walkT += dt * 14;
    if (this.sprite) {
      this.bodyPivot.position.y = Math.abs(Math.sin(this.walkT)) * 0.08 + this.jumpOffset;
      this.bodyPivot.rotation.z = Math.sin(this.walkT * 0.5) * 0.04;
    } else if (this.armL && this.armR && this.legL && this.legR) {
      const swing = Math.sin(this.walkT) * 0.65;
      this.armL.rotation.x = swing;
      this.armR.rotation.x = -swing;
      this.legL.rotation.x = -swing * 0.85;
      this.legR.rotation.x = swing * 0.85;
      this.bodyPivot.position.y = Math.abs(Math.sin(this.walkT)) * 0.05 + this.jumpOffset;
    }
  }

  /** Toạ độ phía trên nhãn tên trong không gian 3D để đặt bong bóng thoại không bị che tên. */
  headWorldPos(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.root.position.x, this.root.position.y + 1.56 * this.sc, this.root.position.z);
  }
}

function shortName(n: string) { return n.length > 11 ? n.slice(0, 10) + '…' : n; }
