import * as THREE from 'three';
import {
  COUNTER_NODE, GA_SPOT, GATE, GATE_NODE, HOST_STAGE_SPOT, H, STAGE_NODE, W, tablePos,
} from '../../../shared/layout';
import type {
  EmoteKind, EventDTO, GuestDTO, HeatDTO, NpcId, NpcTarget, ServerMsg, SettingsDTO, Speaker, StatsDTO, TopGifterDTO, VoiceFx,
} from '../../../shared/protocol';
import { PartyAudio } from '../audio';
import { Socket } from '../net/socket';
import { CHUC_LOOK, HOST_LOOK, QUANG_LOOK, decodeLook } from '../objects/look';
import { counterDest, gateDest, guestDest, hostDest, npcDest, route, stageGuestDest } from '../path';
import { Person3D } from './Person3D';
import { Venue3D } from './Venue3D';
import { toX, toZ } from './coords';

const EMOJI: Record<EmoteKind, string> = {
  eat: '🍚', chao: '🥣', cheer: '🎉', heart: '❤️', gift: '🎁', pay: '💸', wave: '👋', dizzy: '😵‍💫', beer: '🍻',
  camera: '📸', laugh: '😂', star: '⭐', think: '🤔', sleep: '💤', chicken: '🍗', sad: '😢', happy: '😋',
};
const HEAT_TEXT: Record<HeatDTO['level'], string> = { vang: 'Vắng', am: 'Ấm', dong: 'Đông', bungno: 'Bùng nổ' };
const HEAT_COLOR: Record<HeatDTO['level'], string> = { vang: '#5dade2', am: '#f5c26b', dong: '#ff8c42', bungno: '#ff3b30' };
const MAX_GUEST_BUBBLES = 6;

const params = new URLSearchParams(location.search);
export const IS_PREVIEW = params.has('preview');

type CamMode = 'auto' | 'overview' | 'host';

interface BubbleEntry {
  el: HTMLDivElement;
  person: Person3D;
  expiresAt: number;
}

interface FloatingEmoji {
  el: HTMLDivElement;
  expiresAt: number;
}

interface ConfettiPiece {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

interface FlyingGa {
  mesh: THREE.Mesh;
  start: THREE.Vector3;
  end: THREE.Vector3;
  t: number;
}

export class Overlay3D {
  readonly audio = new PartyAudio();
  private socket!: Socket;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private venue!: Venue3D;

  private stageWrap!: HTMLDivElement;
  private uiLayer!: HTMLDivElement;
  private hudCount!: HTMLDivElement;
  private hudDot!: HTMLSpanElement;
  private heatFill!: HTMLDivElement;
  private heatText!: HTMLDivElement;
  private bannerEl!: HTMLDivElement;
  private bannerTimer = 0;
  private eventPanelEl!: HTMLDivElement;
  private eventTitleEl!: HTMLDivElement;
  private eventHintEl!: HTMLDivElement;
  private eventNoteEl!: HTMLDivElement;
  private eventBarEl!: HTMLDivElement;
  private eventData: (EventDTO & { endsAt: number }) | null = null;
  private disclaimerEl!: HTMLDivElement;
  private photoEl!: HTMLDivElement;
  private flashEl!: HTMLDivElement;
  private topGiftsEl!: HTMLDivElement;
  private giftPopEl!: HTMLDivElement;
  private giftPopTimer = 0;
  private spotlightMesh!: THREE.Mesh;
  private spotlightUntil = 0;
  private shakeUntil = 0;

  private guests = new Map<string, Person3D>();
  private npcs = new Map<NpcId, Person3D>();
  private leaving = new Set<Person3D>();
  private host!: Person3D;
  private speaking: Person3D | null = null;
  private focusPerson: Person3D | null = null;
  private focusUntil = 0;
  private focusPriority = 0;
  private camMode: CamMode = 'auto';
  private camPos = new THREE.Vector3(0, 13.8, 13.4);
  private camLook = new THREE.Vector3(0, 0.2, 0.1);
  private userYaw = 0;
  private userZoom = 1;

  private bubbles = new Map<Person3D, BubbleEntry>();
  private guestBubbleOrder: Person3D[] = [];
  private emojis: FloatingEmoji[] = [];
  private confetti: ConfettiPiece[] = [];
  private gaGroup!: THREE.Group;
  private flyingGa: FlyingGa[] = [];

  private settings?: SettingsDTO;
  private heat: HeatDTO = { value: 0, level: 'vang' };
  private lastT = performance.now();
  private fpsFrames = 0;
  private fpsWindowStart = performance.now();
  private currentFps = 60;

  constructor(container: HTMLElement) {
    this.audio.muted = IS_PREVIEW;
    this.buildDom(container);
    this.buildThree();
    this.buildHost();
    this.connect();
    this.loop(performance.now());
  }

  private buildDom(container: HTMLElement) {
    container.innerHTML = '';
    container.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:#120804;overflow:hidden;';

    const wrap = document.createElement('div');
    wrap.className = 'o3d-wrap';
    wrap.style.cssText = 'position:relative;aspect-ratio:9/16;height:100%;max-width:100%;max-height:100%;overflow:hidden;box-shadow:0 0 60px #000c;';
    container.appendChild(wrap);
    this.stageWrap = wrap;

    const style = document.createElement('style');
    style.textContent = `
      .o3d-ui { position:absolute; inset:0; pointer-events:none; font-family:system-ui,"Segoe UI",Arial,sans-serif; container-type:inline-size; }
      .o3d-hud { position:absolute; left:2%; right:2%; top:1%; padding:1.3% 2.6%; border-radius:16px;
        background:rgba(43,18,10,0.9); border:2px solid #f5c26b; color:#fbe9d0; display:flex; justify-content:space-between; align-items:center; gap:8px; }
      .o3d-hud-title { font-size:3.2cqw; font-weight:900; color:#ffd76a; line-height:1.15; }
      .o3d-hud-sub { font-size:2.2cqw; opacity:.95; margin-top:3px; }
      .o3d-hud-right { display:flex; flex-direction:column; align-items:flex-end; gap:5px; }
      .o3d-heat-top { display:flex; align-items:center; gap:6px; font-size:2cqw; font-weight:700; }
      .o3d-dot { width:10px; height:10px; border-radius:50%; background:#e74c3c; display:inline-block; }
      .o3d-heat-bar { width:16cqw; height:10px; background:rgba(0,0,0,0.55); border-radius:6px; overflow:hidden; }
      .o3d-heat-bar > div { height:100%; width:10%; background:#5dade2; border-radius:6px; transition:width .5s, background .5s; }
      .o3d-bottom { position:absolute; left:2%; right:2%; top:8.6%; padding:0.9% 2%; border-radius:14px;
        background:rgba(43,18,10,0.92); text-align:center; color:#ffe9b8; border:1px solid #f5c26b55; }
      .o3d-bottom-hint { font-size:2.05cqw; font-weight:700; }
      .o3d-bottom-disc { font-size:1.6cqw; color:#e8cfb4; margin-top:2px; }
      .o3d-banner { position:absolute; left:50%; top:14.2%; transform:translateX(-50%); max-width:86%; padding:1% 3%;
        border-radius:999px; background:#ffd76a; border:2.5px solid #8e1b12; color:#2b1408; font-weight:800; font-size:2.4cqw;
        text-align:center; box-shadow:0 8px 24px #0007; opacity:0; transition:opacity .25s, top .25s; }
      .o3d-banner.on { opacity:1; top:14.8%; }
      .o3d-ev { position:absolute; left:50%; top:19.8%; transform:translateX(-50%); width:82%; padding:1.4% 2.6%;
        border-radius:14px; background:rgba(58,10,6,0.9); border:2px solid #ffd76a; color:#fff; text-align:center; display:none; }
      .o3d-ev.on { display:block; }
      .o3d-ev-title { font-size:2.6cqw; font-weight:900; color:#ffd76a; }
      .o3d-ev-hint { font-size:2cqw; color:#ffe9b8; margin-top:2px; }
      .o3d-ev-note { font-size:1.9cqw; color:#9fe8b0; margin-top:2px; font-weight:700; }
      .o3d-ev-bar { height:6px; background:rgba(0,0,0,0.55); border-radius:4px; margin-top:6px; overflow:hidden; }
      .o3d-ev-bar > div { height:100%; background:#ffd76a; width:100%; }
      .o3d-top-gifts { position:absolute; right:2%; top:14.8%; padding:1% 2%; border-radius:12px;
        background:rgba(26,13,6,0.82); border:1px solid #f5c26b88; color:#ffe9b8; font-size:1.85cqw; line-height:1.45;
        display:none; z-index:30; text-align:right; box-shadow:0 6px 20px #0006; }
      .o3d-top-gifts.on { display:block; }
      .o3d-top-gifts b { color:#ffd76a; display:block; font-size:1.9cqw; margin-bottom:2px; }
      .o3d-gift-pop { position:absolute; left:50%; top:34%; transform:translate(-50%,-50%) scale(0.5); width:82%; padding:3% 4%;
        border-radius:22px; text-align:center; opacity:0; pointer-events:none; z-index:52;
        transition:transform .35s cubic-bezier(.18,1.3,.4,1), opacity .3s; }
      .o3d-gift-pop.on { opacity:1; transform:translate(-50%,-50%) scale(1); }
      .o3d-gift-pop.medium { background:linear-gradient(135deg, rgba(22,60,108,0.94), rgba(14,32,64,0.95));
        border:3px solid #5dade2; box-shadow:0 0 40px rgba(93,173,226,0.6), 0 18px 40px #000a; color:#fff; }
      .o3d-gift-pop.big { background:linear-gradient(135deg, rgba(162,24,14,0.95), rgba(74,10,4,0.97));
        border:4px solid #ffd76a; box-shadow:0 0 70px rgba(255,215,106,0.85), 0 22px 60px #000c; color:#fff; }
      .o3d-gp-icon { font-size:11cqw; line-height:1.05; filter:drop-shadow(0 6px 12px #0008); animation:o3dPulse .7s ease-in-out infinite alternate; }
      .o3d-gp-tag { display:inline-block; padding:2px 12px; border-radius:999px; background:#ffd76a; color:#2b1408;
        font-size:2cqw; font-weight:900; letter-spacing:1px; margin-top:4px; }
      .o3d-gp-nick { font-size:4.4cqw; font-weight:900; color:#ffd76a; margin-top:4px; text-shadow:0 3px 10px #000a; }
      .o3d-gp-sub { font-size:2.6cqw; font-weight:700; color:#ffe9b8; margin-top:3px; }
      @keyframes o3dPulse { from { transform:scale(1); } to { transform:scale(1.12); } }
      .o3d-cam-bar { position:absolute; right:2.5%; bottom:1.6%; display:flex; gap:6px; pointer-events:auto; opacity:0.35; transition:opacity .2s; z-index:45; }
      .o3d-wrap:hover .o3d-cam-bar { opacity:0.95; }
      .o3d-cam-bar button { padding:4px 9px; border-radius:999px; border:1px solid #f5c26b; background:rgba(26,13,6,0.85);
        color:#ffe9b8; font-size:11px; font-weight:700; cursor:pointer; }
      .o3d-cam-bar button.active { background:#8e1b12; color:#ffd76a; }
      .o3d-bubble { position:absolute; transform:translate(-50%,-100%); max-width:38cqw; padding:6px 11px; border-radius:12px;
        background:#fffdf7; color:#2b1408; border:2px solid #8e1b12; font-size:2.1cqw; font-weight:700; line-height:1.28;
        box-shadow:0 4px 14px #0006; text-align:center; word-break:break-word; z-index:25; }
      .o3d-bubble::after { content:''; position:absolute; left:50%; bottom:-8px; transform:translateX(-50%);
        border-left:7px solid transparent; border-right:7px solid transparent; border-top:8px solid #8e1b12; }
      .o3d-bubble.host { max-width:52cqw; background:#fff4cc; border-color:#d48806; font-size:2.4cqw; padding:8px 14px; z-index:40; }
      .o3d-bubble.host::after { border-top-color:#d48806; }
      .o3d-emoji { position:absolute; transform:translate(-50%,-50%); font-size:3.6cqw; pointer-events:none;
        animation:o3dFloat 1.25s ease-out forwards; z-index:35; }
      @keyframes o3dFloat { 0% { opacity:1; margin-top:0; } 100% { opacity:0; margin-top:-60px; } }
      .o3d-flash { position:absolute; inset:0; background:#fff; opacity:0; pointer-events:none; transition:opacity .25s; z-index:60; }
      .o3d-photo { position:absolute; left:50%; top:46%; transform:translate(-50%,-50%) rotate(-3deg); width:76%; padding:3.5% 3.5% 5%;
        background:#fffdf7; border-radius:8px; box-shadow:0 20px 60px #000b; color:#2b1408; text-align:center; display:none; z-index:55; }
      .o3d-photo.on { display:block; }
      .o3d-photo-box { background:#3a1a0c; color:#ffd76a; padding:6% 4%; border-radius:4px; font-size:2.1cqw; line-height:1.5; }
      .o3d-photo-cap { margin-top:3%; font-weight:800; font-size:2.5cqw; }
    `;
    wrap.appendChild(style);

    const ui = document.createElement('div');
    ui.className = 'o3d-ui';
    wrap.appendChild(ui);
    this.uiLayer = ui;

    ui.innerHTML = `
      <div class="o3d-hud">
        <div>
          <div class="o3d-hud-title">🍚 BỮA CƠM TÌNH NGHĨA · 3D</div>
          <div class="o3d-hud-sub" id="o3dCount">Đang kết nối…</div>
        </div>
        <div class="o3d-hud-right">
          <div class="o3d-heat-top"><span id="o3dHeatText">🔥 Vắng</span><span class="o3d-dot" id="o3dDot"></span></div>
          <div class="o3d-heat-bar"><div id="o3dHeatFill"></div></div>
        </div>
      </div>
      <div class="o3d-banner" id="o3dBanner"></div>
      <div class="o3d-ev" id="o3dEv">
        <div class="o3d-ev-title" id="o3dEvTitle"></div>
        <div class="o3d-ev-hint" id="o3dEvHint"></div>
        <div class="o3d-ev-note" id="o3dEvNote"></div>
        <div class="o3d-ev-bar"><div id="o3dEvBar"></div></div>
      </div>
      <div class="o3d-top-gifts" id="o3dTopGifts"></div>
      <div class="o3d-gift-pop" id="o3dGiftPop"></div>
      <div class="o3d-cam-bar" id="o3dCamBar">
        <button data-cam="auto" class="active" title="Tự lia cận cảnh khi nhân vật nói">🎥 Tự động</button>
        <button data-cam="overview" title="Toàn cảnh sân tiệc">🏠 Toàn sân</button>
        <button data-cam="host" title="Quay gần Chủ tiệc">🎙 Cận Chủ tiệc</button>
      </div>
      <div class="o3d-bottom">
        <div class="o3d-bottom-hint">Chat "nhập tiệc" để vào sân  ·  "mâm 1–9" để đổi bàn  ·  "ra về"</div>
        <div class="o3d-bottom-disc" id="o3dDisc"></div>
      </div>
      <div class="o3d-photo" id="o3dPhoto">
        <div class="o3d-photo-box" id="o3dPhotoNames"></div>
        <div class="o3d-photo-cap" id="o3dPhotoCap"></div>
      </div>
      <div class="o3d-flash" id="o3dFlash"></div>
    `;

    this.hudCount = ui.querySelector('#o3dCount')!;
    this.hudDot = ui.querySelector('#o3dDot')!;
    this.heatFill = ui.querySelector('#o3dHeatFill')!;
    this.heatText = ui.querySelector('#o3dHeatText')!;
    this.bannerEl = ui.querySelector('#o3dBanner')!;
    this.eventPanelEl = ui.querySelector('#o3dEv')!;
    this.eventTitleEl = ui.querySelector('#o3dEvTitle')!;
    this.eventHintEl = ui.querySelector('#o3dEvHint')!;
    this.eventNoteEl = ui.querySelector('#o3dEvNote')!;
    this.eventBarEl = ui.querySelector('#o3dEvBar')!;
    this.disclaimerEl = ui.querySelector('#o3dDisc')!;
    this.photoEl = ui.querySelector('#o3dPhoto')!;
    this.flashEl = ui.querySelector('#o3dFlash')!;
    this.topGiftsEl = ui.querySelector('#o3dTopGifts')!;
    this.giftPopEl = ui.querySelector('#o3dGiftPop')!;

    const camBar = ui.querySelector('#o3dCamBar') as HTMLDivElement;
    if (IS_PREVIEW) camBar.style.display = 'none';
    camBar.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        this.camMode = btn.dataset.cam as CamMode;
        this.userYaw = 0;
        this.userZoom = 1;
        camBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      };
    });
  }

  private buildThree() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;cursor:grab;';
    this.stageWrap.prepend(this.renderer.domElement);

    // Kéo chuột xoay nhẹ góc nhìn + cuộn chuột zoom gần/xa
    let dragging = false, lastX = 0;
    this.renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; });
    window.addEventListener('pointerup', () => { dragging = false; });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.userYaw = Math.max(-0.55, Math.min(0.55, this.userYaw + (e.clientX - lastX) * 0.004));
      lastX = e.clientX;
    });
    this.renderer.domElement.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.userZoom = Math.max(0.45, Math.min(1.35, this.userZoom + e.deltaY * 0.0008));
    }, { passive: false });

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b0e08);
    this.scene.fog = new THREE.FogExp2(0x1b0e08, 0.013);

    this.camera = new THREE.PerspectiveCamera(52, W / H, 0.2, 80);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    const hemi = new THREE.HemisphereLight(0xfff0d6, 0x5c2c16, 1.0);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff1d0, 1.35);
    sun.position.set(6, 16, 9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 2;
    sun.shadow.camera.far = 36;
    sun.shadow.camera.left = -8;
    sun.shadow.camera.right = 8;
    sun.shadow.camera.top = 12;
    sun.shadow.camera.bottom = -12;
    this.scene.add(sun);

    const stageLight = new THREE.PointLight(0xffb84d, 1.8, 12);
    stageLight.position.set(0, 3.2, toZ(320));
    this.scene.add(stageLight);

    this.venue = new Venue3D('66B Ngõ Tình Nghĩa');
    this.scene.add(this.venue.group);

    this.gaGroup = new THREE.Group();
    this.gaGroup.position.set(toX(GA_SPOT.x), 0.34, toZ(GA_SPOT.y));
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.26, 0.04, 16),
      new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.3 }),
    );
    const chicken = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xf1b238, roughness: 0.45 }),
    );
    chicken.scale.set(1.2, 0.8, 0.95);
    chicken.position.y = 0.14;
    this.gaGroup.add(plate, chicken);
    this.gaGroup.visible = false;
    this.scene.add(this.gaGroup);

    // Cột sáng Spotlight 3D chiếu xuống người tặng quà lớn/vừa
    this.spotlightMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.95, 7.5, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.spotlightMesh.visible = false;
    this.scene.add(this.spotlightMesh);

    const resize = () => {
      const r = this.stageWrap.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        this.renderer.setSize(r.width, r.height, false);
        this.camera.aspect = r.width / r.height;
        this.camera.updateProjectionMatrix();
      }
    };
    window.addEventListener('resize', resize);
    resize();
  }

  private buildHost() {
    this.host = new Person3D(HOST_STAGE_SPOT.x, HOST_STAGE_SPOT.y, STAGE_NODE, HOST_LOOK, 'Anh Trường', { host: true });
    this.host.onStuck = () => this.reportStuck('host');
    this.scene.add(this.host.root);
  }

  private connect() {
    this.socket = new Socket(IS_PREVIEW ? 'preview' : 'overlay');
    (window as any).__socket = this.socket;
    this.socket.onStatus((up) => { this.hudDot.style.background = up ? '#2ecc71' : '#e74c3c'; });
    this.socket.onMessage((m) => this.onMsg(m));

    if (!IS_PREVIEW) {
      window.setInterval(() => this.socket.send({ t: 'perf', fps: Math.round(this.currentFps) }), 10000);
    }
  }

  private reportStuck(who: 'guest' | 'host') {
    if (!IS_PREVIEW) this.socket.send({ t: 'stuck', who });
  }

  private onMsg(m: ServerMsg) {
    switch (m.t) {
      case 'snapshot': return this.applySnapshot(m);
      case 'join': return this.spawnGuest(m.g, true);
      case 'move': return this.moveGuest(m.id, m.table, m.seat);
      case 'guest_goto': return m.spot === 'stage' ? this.guestToStage(m.id) : this.guestToCounter(m.id, m.index);
      case 'leave': return this.removeGuest(m.id);
      case 'emote': {
        const p = this.guests.get(m.id);
        if (p) { p.triggerEmote(m.kind); this.spawnEmoji(p, m.kind); }
        return;
      }
      case 'chat': return this.guestChat(m.id, m.text);
      case 'host_goto': return this.hostGoto(m.target, m.token);
      case 'host_emote': this.host.triggerEmote(m.kind); this.spawnEmoji(this.host, m.kind); return;
      case 'say': return this.hostSay(m.text, m.ms, m.audioUrl, m.lookAt, m.fx ?? 'normal', m.speaker ?? 'host');
      case 'event_note': this.eventNoteEl.textContent = m.text; return;
      case 'host_costume': this.spawnEmoji(this.host, 'star'); return;
      case 'banner': return this.showBanner(m.text, m.ms);
      case 'stats': return this.updateStats(m.stats);
      case 'settings': return this.applySettings(m.settings);
      case 'bond': return this.venue.setBond(m.bond);
      case 'table_fx': this.venue.pulseTable(m.table, m.kind); this.spawnConfetti(toX(tablePos(m.table).x), toZ(tablePos(m.table).y)); return;
      case 'event': return this.setEvent(m.event);
      case 'event_progress': return this.venue.setProgress(m.tables);
      case 'photo': return this.showPhoto(m.names, m.caption, m.ms);
      case 'host_pose': this.host.setPose(m.pose); return;
      case 'npc': return this.npcAction(m.id, m.action, m.target, m.token, m.name);
      case 'npc_emote': {
        const p = this.npcs.get(m.id);
        if (p) { p.triggerEmote(m.kind); this.spawnEmoji(p, m.kind); }
        return;
      }
      case 'heat': return this.setHeat(m.heat);
      case 'prop': this.gaGroup.visible = m.show; this.gaGroup.scale.setScalar(0.5 + 0.5 * Math.min(1, m.amount / 24)); return;
      case 'ga_piece': return this.flyGaPiece(m.table, m.left);
      case 'music_list': return this.audio.setMusicTracks(m.tracks);
      case 'music_ctl': return this.audio.musicControl(m.action);
      case 'gift_fx': return this.onGiftFx(m);
      case 'top_gifters': return this.setTopGifters(m.list);
    }
  }

  private applySnapshot(m: Extract<ServerMsg, { t: 'snapshot' }>) {
    this.applySettings(m.settings);
    for (const p of this.guests.values()) this.removePerson(p);
    this.guests.clear();
    for (const p of this.leaving) this.removePerson(p);
    this.leaving.clear();
    for (const g of m.guests) this.spawnGuest(g, false);
    const hd = hostDest(m.host);
    this.host.setPosition2D(hd.pos.x, hd.pos.y);
    this.host.anchor = hd.anchor;
    this.host.setPose(m.hostPose);
    this.updateStats(m.stats);
    this.venue.setBond(m.bond);
    this.setEvent(m.event);
    this.setHeat(m.heat);
    this.setTopGifters(m.topGifters ?? []);
    for (const p of this.npcs.values()) this.removePerson(p);
    this.npcs.clear();
    for (const n of m.npcs) {
      const nd = npcDest(n.target);
      const p = new Person3D(nd.pos.x, nd.pos.y, nd.anchor, n.id === 'quang' ? QUANG_LOOK : CHUC_LOOK, n.name, { npc: true });
      this.scene.add(p.root);
      this.npcs.set(n.id, p);
    }
  }

  private applySettings(s: SettingsDTO) {
    this.settings = s;
    this.venue.setVenueName(s.venueName);
    this.host.setLabel(s.hostName, '#ffe08a');
    this.disclaimerEl.textContent = s.disclaimer.text;
    this.disclaimerEl.style.display = s.disclaimer.show ? '' : 'none';
    this.audio.setVolumes(s.voiceVolume / 100);
    if (s.music) this.audio.setMusic(s.music);
  }

  private spawnGuest(g: GuestDTO, walkIn: boolean) {
    const ex = this.guests.get(g.id);
    if (ex) { ex.highlight(); return; }
    const look = decodeLook(g.look);
    const dest = guestDest(g.table, g.seat);
    if (!walkIn) {
      const p = new Person3D(dest.pos.x, dest.pos.y, dest.anchor, look, g.nick);
      p.seated = g.table >= 0;
      if (g.vip) p.setVip(true);
      if (g.table >= 0) { const c = tablePos(g.table); p.face(c.x, c.y); }
      p.onStuck = () => this.reportStuck('guest');
      this.scene.add(p.root);
      this.guests.set(g.id, p);
      return;
    }
    const p = new Person3D(GATE.x + (Math.random() - 0.5) * 120, 1960, GATE_NODE, look, g.nick);
    if (g.vip) p.setVip(true);
    p.onStuck = () => this.reportStuck('guest');
    this.scene.add(p.root);
    this.guests.set(g.id, p);
    p.highlight(3000);
    p.walk(route(GATE_NODE, dest), () => {
      p.anchor = dest.anchor;
      p.seated = g.table >= 0;
      if (g.table >= 0) { const c = tablePos(g.table); p.face(c.x, c.y); }
    });
  }

  private moveGuest(id: string, table: number, seat: number) {
    const p = this.guests.get(id);
    if (!p) return;
    const dest = guestDest(table, seat);
    p.walk(route(p.anchor, dest), () => {
      p.anchor = dest.anchor;
      p.seated = table >= 0;
      if (table >= 0) { const c = tablePos(table); p.face(c.x, c.y); }
    });
    p.anchor = dest.anchor;
  }

  private guestToCounter(id: string, index: number) {
    const p = this.guests.get(id);
    if (!p) return;
    const dest = counterDest(index);
    p.highlight(2500);
    p.walk(route(p.anchor, dest), () => p.face(W, p.y2d));
    p.anchor = COUNTER_NODE;
  }

  private guestToStage(id: string) {
    const p = this.guests.get(id);
    if (!p) return;
    p.highlight(5000);
    p.walk(route(p.anchor, stageGuestDest), () => { p.face(p.x2d, p.y2d + 100); p.triggerEmote('star'); this.spawnEmoji(p, 'star'); });
    p.anchor = stageGuestDest.anchor;
  }

  private removeGuest(id: string) {
    const p = this.guests.get(id);
    if (!p) return;
    this.guests.delete(id);
    this.walkOut(p);
  }

  private walkOut(p: Person3D) {
    if (this.speaking === p) this.speaking = null;
    if (this.focusPerson === p) this.focusPerson = null;
    this.leaving.add(p);
    p.triggerEmote('wave');
    this.spawnEmoji(p, 'wave');
    p.walk(route(p.anchor, gateDest), () => {
      this.leaving.delete(p);
      this.removePerson(p);
    });
  }

  private removePerson(p: Person3D) {
    this.scene.remove(p.root);
    const b = this.bubbles.get(p);
    if (b) { b.el.remove(); this.bubbles.delete(p); }
    this.guestBubbleOrder = this.guestBubbleOrder.filter((x) => x !== p);
  }

  private setFocus(person: Person3D, ms: number, priority: number) {
    const now = Date.now();
    if (now < this.focusUntil && priority < this.focusPriority) return;
    this.focusPerson = person;
    this.focusUntil = now + ms;
    this.focusPriority = priority;
  }

  private hostGoto(target: Extract<ServerMsg, { t: 'host_goto' }>['target'], token: number) {
    const d = hostDest(target);
    this.host.walk(route(this.host.anchor, d), () => {
      this.host.anchor = d.anchor;
      if (target.kind === 'stage') this.host.face(this.host.x2d, this.host.y2d + 100);
      else if (target.kind === 'counter') this.host.face(W, this.host.y2d);
      else if (target.kind === 'table') { const c = tablePos(target.table); this.host.face(c.x, c.y); }
      this.socket.send({ t: 'host_arrived', token });
    });
    this.host.anchor = d.anchor;
  }

  private npcAction(id: NpcId, action: 'spawn' | 'goto' | 'leave', target: NpcTarget, token: number, name: string) {
    let p = this.npcs.get(id);
    if (action === 'leave') {
      if (!p) return;
      this.npcs.delete(id);
      this.walkOut(p);
      return;
    }
    if (!p) {
      p = new Person3D(GATE.x + 80, 1960, GATE_NODE, id === 'quang' ? QUANG_LOOK : CHUC_LOOK, name, { npc: true });
      p.onStuck = () => this.reportStuck('guest');
      this.scene.add(p.root);
      this.npcs.set(id, p);
    }
    const d = npcDest(target);
    const person = p;
    person.walk(route(person.anchor, d), () => {
      person.anchor = d.anchor;
      if (target.kind === 'stage') person.face(person.x2d, person.y2d + 100);
      else if (target.kind === 'table') { const c = tablePos(target.table); person.face(c.x, c.y); }
      this.socket.send({ t: 'npc_arrived', id, token });
    });
    person.anchor = d.anchor;
  }

  private guestChat(id: string, text: string) {
    const p = this.guests.get(id);
    if (!p) return;
    this.showBubble(p, text, 3200, false);
    this.guestBubbleOrder = this.guestBubbleOrder.filter((b) => b !== p);
    this.guestBubbleOrder.push(p);
    const max = this.heat.level === 'dong' || this.heat.level === 'bungno' ? 3 : MAX_GUEST_BUBBLES;
    while (this.guestBubbleOrder.length > max) {
      const old = this.guestBubbleOrder.shift()!;
      const b = this.bubbles.get(old);
      if (b) { b.el.remove(); this.bubbles.delete(old); }
    }
  }

  private hostSay(text: string, ms: number, audioUrl: string | undefined, lookAt: string | undefined, fx: VoiceFx, speaker: Speaker) {
    const who = speaker === 'host' ? this.host
      : typeof speaker === 'object' ? (this.guests.get(speaker.guest) ?? this.host)
      : (this.npcs.get(speaker) ?? this.host);
    this.speaking = who;
    // Chỉ focus nhẹ vào Chủ tiệc khi đang có sự kiện, không đi theo NPC hay cắt ngang lúc đang focus người tặng quà
    if (who === this.host && this.eventData) {
      this.setFocus(who, ms + 800, 1);
    }
    this.showBubble(who, text, ms + 600, true);
    if (lookAt) {
      const g = this.guests.get(lookAt);
      if (g) { who.face(g.x2d, g.y2d); g.highlight(Math.min(ms, 4000)); }
    }
    if (IS_PREVIEW) { this.audio.talkFor(ms); return; }
    if (audioUrl) {
      void this.audio.playVoice(audioUrl, fx).then((played) => { if (!played) this.audio.talkFor(ms); });
    } else if (this.settings?.tts.provider === 'browser' || params.get('voice') === '1') {
      this.audio.speakBrowser(text, fx);
    } else {
      this.audio.talkFor(ms);
    }
  }

  private showBubble(person: Person3D, text: string, ms: number, hostStyle: boolean) {
    let b = this.bubbles.get(person);
    if (!b) {
      const el = document.createElement('div');
      this.uiLayer.appendChild(el);
      b = { el, person, expiresAt: 0 };
      this.bubbles.set(person, b);
    }
    b.el.className = hostStyle ? 'o3d-bubble host' : 'o3d-bubble';
    b.el.textContent = text;
    b.expiresAt = Date.now() + ms;
  }

  private spawnEmoji(person: Person3D, kind: EmoteKind) {
    this.camera.updateMatrixWorld();
    const pt = this.projectHead(person);
    if (!pt) return;
    const el = document.createElement('div');
    el.className = 'o3d-emoji';
    el.textContent = EMOJI[kind] ?? '✨';
    el.style.left = `${pt.x}%`;
    el.style.top = `${pt.y}%`;
    this.uiLayer.appendChild(el);
    this.emojis.push({ el, expiresAt: Date.now() + 1250 });
  }

  private spawnConfetti(cx: number, cz: number, count = 28, burstHeight = 3.5) {
    const colors = [0xffd76a, 0xff4d4d, 0x4cd37b, 0x5dade2, 0xff9fd0, 0xffffff];
    const geo = new THREE.BoxGeometry(0.14, 0.14, 0.04);
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colors[i % colors.length] }));
      mesh.position.set(cx + (Math.random() - 0.5) * 0.6, 0.8 + Math.random() * 0.8, cz + (Math.random() - 0.5) * 0.6);
      this.scene.add(mesh);
      const a = Math.random() * Math.PI * 2;
      const spd = 1.4 + Math.random() * 3.2;
      this.confetti.push({
        mesh,
        vx: Math.cos(a) * spd,
        vy: burstHeight + Math.random() * 3.5,
        vz: Math.sin(a) * spd,
        life: 2.2 + Math.random() * 0.8,
      });
    }
  }

  private flyGaPiece(table: number, left: number) {
    this.gaGroup.scale.setScalar(0.5 + 0.5 * Math.min(1, left / 24));
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xf1b238, roughness: 0.4 }),
    );
    const start = this.gaGroup.position.clone().add(new THREE.Vector3(0, 0.2, 0));
    const tp = tablePos(table);
    const end = new THREE.Vector3(toX(tp.x), 0.55, toZ(tp.y));
    mesh.position.copy(start);
    this.scene.add(mesh);
    this.flyingGa.push({ mesh, start, end, t: 0 });
  }

  private showBanner(text: string, ms: number) {
    this.bannerEl.textContent = text;
    this.bannerEl.classList.add('on');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.bannerEl.classList.remove('on'), ms);
  }

  private setEvent(e: EventDTO | null) {
    this.eventData = e ? { ...e, endsAt: Date.now() + e.remainingMs } : null;
    if (!e) {
      this.eventPanelEl.classList.remove('on');
      this.eventNoteEl.textContent = '';
      return;
    }
    this.eventTitleEl.textContent = e.title;
    this.eventHintEl.textContent = e.hint;
    this.eventPanelEl.classList.add('on');
  }

  private showPhoto(names: string[], caption: string, ms: number) {
    this.flashEl.style.opacity = '0.9';
    setTimeout(() => { this.flashEl.style.opacity = '0'; }, 120);
    this.uiLayer.querySelector('#o3dPhotoNames')!.textContent = names.slice(0, 24).join(' · ') || 'Cả sân tiệc';
    this.uiLayer.querySelector('#o3dPhotoCap')!.textContent = caption;
    this.photoEl.classList.add('on');
    setTimeout(() => this.photoEl.classList.remove('on'), ms);
  }

  private setHeat(h: HeatDTO) {
    this.heat = h;
    this.heatFill.style.width = `${Math.max(8, h.value)}%`;
    this.heatFill.style.background = HEAT_COLOR[h.level];
    this.heatText.textContent = `🔥 ${HEAT_TEXT[h.level]}`;
  }

  private setTopGifters(list: TopGifterDTO[]) {
    if (!list.length) {
      this.topGiftsEl.classList.remove('on');
      this.topGiftsEl.innerHTML = '';
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    this.topGiftsEl.innerHTML = `<b>👑 MẠNH THƯỜNG QUÂN</b>` + list.map((g, i) =>
      `<div>${medals[i] ?? '🎁'} ${escHtml(g.nick)} · ${g.coins} xu</div>`,
    ).join('');
    this.topGiftsEl.classList.add('on');
  }

  private onGiftFx(m: Extract<ServerMsg, { t: 'gift_fx' }>) {
    this.audio.playGiftSfx(m.tier);
    const p = this.guests.get(m.id);
    if (p) p.highlight(m.tier === 'big' ? 8000 : m.tier === 'medium' ? 5000 : 2500);
    if (m.tier === 'small') return;

    const fxX = m.table >= 0 ? toX(tablePos(m.table).x) : (p?.root.position.x ?? 0);
    const fxZ = m.table >= 0 ? toZ(tablePos(m.table).y) : (p?.root.position.z ?? 0);

    // Chiếu cột sáng Spotlight xuống người tặng / mâm
    this.spotlightMesh.position.set(p ? p.root.position.x : fxX, 3.75, p ? p.root.position.z : fxZ);
    (this.spotlightMesh.material as THREE.MeshBasicMaterial).color.setHex(m.tier === 'big' ? 0xffd76a : 0x5dade2);
    this.spotlightMesh.visible = true;
    this.spotlightUntil = Date.now() + (m.tier === 'big' ? 5500 : 3800);

    // Hiện Popup Vinh Danh giữa màn hình
    this.giftPopEl.className = `o3d-gift-pop ${m.tier} on`;
    this.giftPopEl.innerHTML = m.tier === 'big'
      ? `<div class="o3d-gp-icon">👑</div><div class="o3d-gp-tag">NỔ HŨ BÀN NHẬU · +${m.coins} XU</div><div class="o3d-gp-nick">${escHtml(m.nick)}</div><div class="o3d-gp-sub">Vừa tặng ${escHtml(m.giftName)}!</div>`
      : `<div class="o3d-gp-icon">🍺</div><div class="o3d-gp-tag">KHAO CẢ MÂM · +${m.coins} XU</div><div class="o3d-gp-nick">${escHtml(m.nick)}</div><div class="o3d-gp-sub">Gửi tặng ${escHtml(m.giftName)}!</div>`;
    clearTimeout(this.giftPopTimer);
    this.giftPopTimer = window.setTimeout(() => this.giftPopEl.classList.remove('on'), m.tier === 'big' ? 4600 : 3200);

    if (p) {
      this.setFocus(p, m.tier === 'big' ? 6000 : 4200, 2);
    }
    if (m.table >= 0) this.venue.pulseTable(m.table, 'win');
    this.spawnConfetti(fxX, fxZ, m.tier === 'big' ? 55 : 35, m.tier === 'big' ? 5.2 : 3.8);

    if (m.tier === 'big') {
      p?.setVip(true);
      this.shakeUntil = Date.now() + 650;
      this.flashEl.style.background = '#ffd76a';
      this.flashEl.style.opacity = '0.45';
      setTimeout(() => { this.flashEl.style.opacity = '0'; this.flashEl.style.background = '#fff'; }, 220);

      // Bắn pháo hoa nhiều đợt khắp sân
      this.spawnConfetti(0, toZ(380), 45, 5.5);
      setTimeout(() => this.spawnConfetti(fxX, fxZ, 45, 5.5), 450);
      setTimeout(() => this.spawnConfetti(-2.5, 0, 35, 5), 850);
      setTimeout(() => this.spawnConfetti(2.5, 0, 35, 5), 1150);

      let count = 0;
      for (const g of this.guests.values()) {
        g.triggerEmote('cheer');
        if (count++ < 22) this.spawnEmoji(g, count % 2 ? 'cheer' : 'star');
      }
      this.host.triggerEmote('cheer');
      this.spawnEmoji(this.host, 'heart');
    }
  }

  private updateStats(s: StatsDTO) {
    const src = s.live.status === 'connected' ? `LIVE @${s.live.uniqueId}` : s.sim > 0 ? 'Giả lập' : 'Chưa kết nối live';
    this.hudCount.textContent = `Khách: ${s.guests - s.waiting}/${s.capacity}${s.waiting ? ` · Chờ: ${s.waiting}` : ''} · ${src}`;
  }

  private updateCamera(dt: number, now: number) {
    const targetPos = new THREE.Vector3(0, 13.8, 13.4);
    const targetLook = new THREE.Vector3(0, 0.2, 0.1);

    let focus: Person3D | null = null;
    if (this.focusPerson && now < this.focusUntil && (this.camMode === 'auto' || this.focusPriority >= 2)) {
      focus = this.focusPerson;
    } else if (this.camMode === 'host') {
      focus = this.host;
    }

    if (focus) {
      const p = focus.root.position;
      targetPos.set(p.x, p.y + 3.2, p.z + 5.6);
      targetLook.set(p.x, p.y + 0.9, p.z - 0.3);
    }

    // Áp dụng xoay/zoom nhẹ từ thao tác chuột
    const offset = targetPos.clone().sub(targetLook).multiplyScalar(this.userZoom);
    if (this.userYaw !== 0) {
      const cos = Math.cos(this.userYaw), sin = Math.sin(this.userYaw);
      const rx = offset.x * cos - offset.z * sin;
      const rz = offset.x * sin + offset.z * cos;
      offset.x = rx;
      offset.z = rz;
    }
    targetPos.copy(targetLook).add(offset);

    const k = 1 - Math.exp(-3.2 * dt);
    this.camPos.lerp(targetPos, k);
    this.camLook.lerp(targetLook, k);
    this.camera.position.copy(this.camPos);
    if (now < this.shakeUntil) {
      this.camera.position.x += (Math.random() - 0.5) * 0.25;
      this.camera.position.y += (Math.random() - 0.5) * 0.25;
    }
    this.camera.lookAt(this.camLook);
    this.camera.updateMatrixWorld();

    // Cập nhật cột sáng Spotlight 3D
    if (now < this.spotlightUntil) {
      const leftRatio = Math.min(1, (this.spotlightUntil - now) / 800);
      (this.spotlightMesh.material as THREE.MeshBasicMaterial).opacity = 0.26 * leftRatio;
      this.spotlightMesh.rotation.y += dt * 1.5;
    } else if (this.spotlightMesh.visible) {
      this.spotlightMesh.visible = false;
    }
  }

  private projectHead(p: Person3D): { x: number; y: number } | null {
    const v = p.headWorldPos();
    v.project(this.camera);
    if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return null;
    return {
      x: (v.x * 0.5 + 0.5) * 100,
      y: (-v.y * 0.5 + 0.5) * 100,
    };
  }

  private loop = (nowMs: number) => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (nowMs - this.lastT) / 1000);
    this.lastT = nowMs;

    this.fpsFrames++;
    if (nowMs - this.fpsWindowStart >= 1000) {
      this.currentFps = (this.fpsFrames * 1000) / (nowMs - this.fpsWindowStart);
      this.fpsFrames = 0;
      this.fpsWindowStart = nowMs;
    }

    const now = Date.now();
    this.venue.update(nowMs / 1000, dt);

    const lvl = this.audio.level();
    this.host.update(dt, now);
    this.host.setMouth(this.speaking === this.host ? lvl : 0);
    for (const n of this.npcs.values()) { n.update(dt, now); n.setMouth(this.speaking === n ? lvl : 0); }
    for (const p of this.guests.values()) p.update(dt, now);
    for (const p of this.leaving) p.update(dt, now);

    this.updateCamera(dt, now);

    for (const [person, b] of this.bubbles) {
      if (now > b.expiresAt) {
        b.el.remove();
        this.bubbles.delete(person);
        continue;
      }
      const pt = this.projectHead(person);
      if (pt) {
        b.el.style.left = `${Math.max(18, Math.min(82, pt.x))}%`;
        b.el.style.top = `${Math.max(14, Math.min(90, pt.y))}%`;
        b.el.style.display = '';
      } else {
        b.el.style.display = 'none';
      }
    }

    for (let i = this.emojis.length - 1; i >= 0; i--) {
      if (now > this.emojis[i].expiresAt) {
        this.emojis[i].el.remove();
        this.emojis.splice(i, 1);
      }
    }

    for (let i = this.confetti.length - 1; i >= 0; i--) {
      const c = this.confetti[i];
      c.life -= dt;
      if (c.life <= 0) {
        this.scene.remove(c.mesh);
        this.confetti.splice(i, 1);
        continue;
      }
      c.vy -= 7.5 * dt;
      c.mesh.position.x += c.vx * dt;
      c.mesh.position.y = Math.max(0.02, c.mesh.position.y + c.vy * dt);
      c.mesh.position.z += c.vz * dt;
      c.mesh.rotation.x += 5 * dt;
      c.mesh.rotation.y += 4 * dt;
    }

    for (let i = this.flyingGa.length - 1; i >= 0; i--) {
      const f = this.flyingGa[i];
      f.t += dt * 1.8;
      if (f.t >= 1) {
        this.scene.remove(f.mesh);
        this.flyingGa.splice(i, 1);
        continue;
      }
      f.mesh.position.lerpVectors(f.start, f.end, f.t);
      f.mesh.position.y += Math.sin(f.t * Math.PI) * 1.6;
    }

    if (this.eventData) {
      const left = Math.max(0, this.eventData.endsAt - now);
      this.eventBarEl.style.width = `${(left / this.eventData.durationMs) * 100}%`;
    }

    this.renderer.render(this.scene, this.camera);
  };
}

function escHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
