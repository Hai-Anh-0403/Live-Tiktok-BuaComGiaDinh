import Phaser from 'phaser';
import { H, W } from '../../shared/layout';
import type { PartyAudio } from './audio';
import { IS_PREVIEW, PartyScene } from './scenes/PartyScene';
import { Overlay3D } from './three/Overlay3D';

const params = new URLSearchParams(location.search);
const use2D = params.has('2d') || params.has('atlas-test');

let getAudio: () => PartyAudio | undefined;

if (use2D) {
  (window as any).__game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: W,
    height: H,
    backgroundColor: '#1a0f0a',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [PartyScene],
    fps: { target: 60 },
  });
  getAudio = () => ((window as any).__game?.scene?.getScene('party') as PartyScene | undefined)?.audio;
} else {
  const overlay3d = new Overlay3D(document.getElementById('game')!);
  (window as any).__overlay3d = overlay3d;
  getAudio = () => overlay3d.audio;
}

// ---------- Cửa sổ live 9:16 ----------
const sizeTag = document.getElementById('sizeTag')!;
let tagTimer = 0;
if (params.get('size')) {
  const want = Number(params.get('size')) || 720;
  const fx = outerWidth - innerWidth, fy = outerHeight - innerHeight;
  const h = Math.min(Math.round((want * 16) / 9), screen.availHeight - fy);
  const w = Math.round((h * 9) / 16);
  try { resizeTo(w + fx, h + fy); } catch { /* trình duyệt chặn thì bỏ qua */ }
  addEventListener('resize', () => {
    const ok = innerWidth === want && innerHeight === Math.round((want * 16) / 9);
    sizeTag.textContent = `${innerWidth} × ${innerHeight}${ok ? ' ✓' : ''}`;
    sizeTag.hidden = false;
    clearTimeout(tagTimer);
    tagTimer = window.setTimeout(() => (sizeTag.hidden = true), 2500);
  });
}

// ---------- Bật tiếng ----------
const unlockBtn = document.getElementById('unlock')!;
async function tryUnlock() {
  const audio = getAudio();
  if (!audio) return;
  await audio.unlock();
  unlockBtn.classList.toggle('on', audio.needsUnlock);
}
if (!IS_PREVIEW) {
  setTimeout(tryUnlock, 800);
  setTimeout(tryUnlock, 3000);
  unlockBtn.addEventListener('click', tryUnlock);
  document.addEventListener('pointerdown', () => void tryUnlock());
}
