import type { MusicSettings, MusicTrackDTO, VoiceFx } from '../../shared/protocol';

/**
 * Âm thanh màn hình live (Web Audio + HTMLAudioElement streaming):
 *  - phát file giọng chủ tiệc, áp hiệu ứng "ông cụ" (lọc + vang), đo âm lượng để mấp máy miệng
 *  - phát nhạc nền (BGM) qua HTMLAudioElement streaming (HTTP Range 206) → hỗ trợ file > 500MB / nhiều GB không tốn RAM,
 *    kèm tự động giảm âm lượng nhạc nền (auto-ducking) khi chủ tiệc / NPC đang nói
 *  - dự phòng: đọc bằng speechSynthesis của trình duyệt khi chọn nhà cung cấp "Trình duyệt"
 */
export class PartyAudio {
  private ctx?: AudioContext;
  private voiceGain?: GainNode;
  private bgmEl?: HTMLAudioElement;
  private analyser?: AnalyserNode;
  private data?: Float32Array<ArrayBuffer>;
  private current?: AudioBufferSourceNode;
  private buffers = new Map<string, AudioBuffer>();
  private reverb?: ConvolverNode;
  private speakingUntil = 0;
  private fakeTalk = false;
  private bgmCurrentVol = 0;

  voiceVolume = 0.9;

  music: MusicSettings = { enabled: true, volume: 35, ducking: false, track: '', loop: 'all' };
  private tracks: string[] = [];
  private currentTrack = '';
  muted = false;

  /** Trình duyệt chặn tự phát tiếng → cần 1 cú bấm. (OBS / cửa sổ live đã bật cờ cho phép.) */
  get needsUnlock() { return !this.ctx || this.ctx.state !== 'running'; }

  init() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = this.voiceVolume;
    this.voiceGain.connect(ctx.destination);

    this.ensureBgmEl();

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(this.voiceGain);
    this.data = new Float32Array(this.analyser.fftSize);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulse(ctx, 1.6, 2.5);
    this.applyMusic();
  }

  /**
   * Tạo HTMLAudioElement phát nhạc nền trực tiếp (không đi qua createMediaElementSource)
   * để tránh lỗi mất tiếng do CORS/suspended AudioContext khi stream file lớn > 500MB.
   */
  private ensureBgmEl() {
    if (this.bgmEl || this.muted) return;
    const el = new Audio();
    el.preload = 'metadata';
    el.volume = Math.max(0, Math.min(1, this.music.volume / 100));
    this.bgmCurrentVol = el.volume;
    el.addEventListener('ended', () => this.onBgmEnded());
    el.addEventListener('error', () => {
      window.setTimeout(() => { if (this.music.enabled && this.tracks.length > 1) this.stepTrack(1); }, 2000);
    });
    this.bgmEl = el;
  }

  async unlock() {
    this.init();
    await this.ctx!.resume().catch(() => {});
    this.applyMusic();
  }

  setVolumes(voice: number) {
    this.voiceVolume = voice;
    if (this.voiceGain) this.voiceGain.gain.value = voice;
  }

  setMusic(cfg: MusicSettings) {
    const prevTrack = this.music.track;
    this.music = { ...cfg };
    if (!this.muted) this.ensureBgmEl();
    this.applyMusic(prevTrack !== cfg.track);
  }

  setMusicTracks(list: MusicTrackDTO[]) {
    this.tracks = list.map((t) => t.name);
    if (!this.muted) this.ensureBgmEl();
    this.applyMusic();
  }

  musicControl(action: 'next' | 'prev' | 'restart') {
    if (this.muted || !this.tracks.length) return;
    this.ensureBgmEl();
    if (action === 'restart') {
      if (this.bgmEl) {
        this.bgmEl.currentTime = 0;
        if (this.music.enabled) void this.bgmEl.play().catch(() => {});
      }
      return;
    }
    this.stepTrack(action === 'next' ? 1 : -1);
  }

  /** Mức âm lượng giọng hiện tại 0..1 (để vẽ miệng) + cập nhật auto-ducking nhạc nền. */
  level(): number {
    this.updateDucking();
    if (this.fakeTalk) return Date.now() < this.speakingUntil ? 0.35 + 0.35 * Math.abs(Math.sin(Date.now() / 90)) : 0;
    if (!this.analyser || !this.data || Date.now() > this.speakingUntil) return 0;
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) sum += this.data[i] * this.data[i];
    return Math.min(1, Math.sqrt(sum / this.data.length) * 6);
  }

  /** Phát file giọng; trả về thời lượng (ms) hoặc 0 nếu lỗi. */
  async playVoice(url: string, fx: VoiceFx): Promise<number> {
    this.init();
    const ctx = this.ctx!;
    try {
      let buf = this.buffers.get(url);
      if (!buf) {
        const res = await fetch(url);
        buf = await ctx.decodeAudioData(await res.arrayBuffer());
        this.buffers.set(url, buf);
        if (this.buffers.size > 60) this.buffers.delete(this.buffers.keys().next().value!);
      }
      try { this.current?.stop(); } catch { /* đã dừng */ }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (fx === 'old') {
        // ông cụ: chậm & trầm thêm chút, cắt bớt tần thấp/cao, thêm vang phòng
        src.playbackRate.value = 0.94;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 160;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
        const wet = ctx.createGain(); wet.gain.value = 0.32;
        src.connect(hp).connect(lp);
        lp.connect(this.analyser!);
        lp.connect(this.reverb!); this.reverb!.connect(wet).connect(this.analyser!);
        src.onended = () => { try { this.reverb!.disconnect(); } catch { /* bỏ qua */ } };
      } else {
        src.connect(this.analyser!);
      }
      src.start();
      this.current = src;
      this.fakeTalk = false;
      const ms = (buf.duration / src.playbackRate.value) * 1000;
      this.speakingUntil = Date.now() + ms;
      this.updateDucking(true);
      return ms;
    } catch {
      return 0;
    }
  }

  /** Dự phòng: giọng có sẵn của Windows/trình duyệt. */
  speakBrowser(text: string, fx: VoiceFx) {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'vi-VN';
    u.rate = fx === 'old' ? 0.85 : 1.0;
    u.pitch = fx === 'old' ? 0.6 : 0.85;
    u.volume = this.voiceVolume;
    const vi = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('vi'));
    if (vi) u.voice = vi;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    this.talkFor(Math.max(1500, text.split(/\s+/).length * 260));
  }

  /** Mấp máy miệng giả khi không có âm thanh phân tích được. */
  talkFor(ms: number) {
    this.fakeTalk = true;
    this.speakingUntil = Date.now() + ms;
    this.updateDucking(true);
  }

  // ---------- nhạc nền (BGM streaming > 500MB) ----------
  private applyMusic(forceSwitch = false) {
    if (this.muted || !this.bgmEl) return;
    const on = this.music.enabled && this.tracks.length > 0;
    this.updateDucking(true);
    if (!on) {
      if (!this.bgmEl.paused) this.bgmEl.pause();
      return;
    }
    let want = this.music.track && this.tracks.includes(this.music.track) ? this.music.track : '';
    if (!want) {
      if (this.currentTrack && this.tracks.includes(this.currentTrack)) want = this.currentTrack;
      else want = this.music.loop === 'shuffle' ? this.tracks[Math.floor(Math.random() * this.tracks.length)] : this.tracks[0];
    }
    if (!want) return;
    if (forceSwitch || this.currentTrack !== want || !this.bgmEl.src) {
      this.playTrack(want);
    } else if (this.bgmEl.paused) {
      void this.bgmEl.play().catch(() => {});
    }
  }

  private playTrack(name: string) {
    if (!this.bgmEl) return;
    this.currentTrack = name;
    this.bgmEl.src = `/music/${encodeURIComponent(name)}`;
    if (this.music.enabled) {
      void this.bgmEl.play().catch(() => {});
    }
  }

  private onBgmEnded() {
    if (!this.music.enabled || !this.tracks.length || !this.bgmEl) return;
    if (this.music.loop === 'one' || this.tracks.length === 1) {
      this.bgmEl.currentTime = 0;
      void this.bgmEl.play().catch(() => {});
      return;
    }
    this.stepTrack(1);
  }

  private stepTrack(dir: 1 | -1) {
    if (!this.tracks.length) return;
    if (this.music.loop === 'shuffle' && this.tracks.length > 1) {
      const others = this.tracks.filter((t) => t !== this.currentTrack);
      this.playTrack(others[Math.floor(Math.random() * others.length)]);
      return;
    }
    const idx = Math.max(0, this.tracks.indexOf(this.currentTrack));
    const next = (idx + dir + this.tracks.length) % this.tracks.length;
    this.playTrack(this.tracks[next]);
  }

  private updateDucking(immediate = false) {
    if (!this.bgmEl) return;
    const baseVol = this.music.enabled ? Math.max(0, Math.min(1, this.music.volume / 100)) : 0;
    const speaking = Date.now() < this.speakingUntil;
    const ducked = this.music.ducking && speaking;
    const target = ducked ? baseVol * 0.25 : baseVol;
    if (immediate) {
      this.bgmCurrentVol = target;
    } else {
      const rate = ducked ? 0.25 : 0.08;
      this.bgmCurrentVol += (target - this.bgmCurrentVol) * rate;
    }
    if (Math.abs(this.bgmEl.volume - this.bgmCurrentVol) > 0.002) {
      this.bgmEl.volume = Math.max(0, Math.min(1, this.bgmCurrentVol));
    }
  }
}

function impulse(ctx: AudioContext, seconds: number, decay: number) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}
