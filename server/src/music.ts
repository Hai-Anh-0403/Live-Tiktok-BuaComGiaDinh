import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join, normalize as normPath } from 'node:path';
import type { MusicTrackDTO } from '../../shared/protocol.js';
import { MUSIC_DIR } from './paths.js';

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
};

/** Giới hạn tải lên tối đa 10 GB (luồng trực tiếp xuống đĩa, không giữ trong RAM) */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

export function ensureMusicDir() {
  if (!existsSync(MUSIC_DIR)) mkdirSync(MUSIC_DIR, { recursive: true });
}

export function sanitizeTrackName(raw: string): string {
  const base = basename(String(raw || '').trim()).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  const ext = extname(base).toLowerCase();
  if (!AUDIO_MIME[ext]) return '';
  return base.slice(0, 180);
}

export function listMusicTracks(): MusicTrackDTO[] {
  ensureMusicDir();
  try {
    const files = readdirSync(MUSIC_DIR);
    const out: MusicTrackDTO[] = [];
    for (const f of files) {
      const ext = extname(f).toLowerCase();
      if (!AUDIO_MIME[ext]) continue;
      try {
        const st = statSync(join(MUSIC_DIR, f));
        if (st.isFile() && st.size > 0) out.push({ name: f, sizeBytes: st.size });
      } catch { /* bỏ qua file lỗi */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    return out;
  } catch {
    return [];
  }
}

export function deleteMusicTrack(name: string): boolean {
  const clean = sanitizeTrackName(name);
  if (!clean) return false;
  const f = normPath(join(MUSIC_DIR, clean));
  if (!f.startsWith(MUSIC_DIR) || !existsSync(f)) return false;
  try {
    unlinkSync(f);
    return true;
  } catch {
    return false;
  }
}

/**
 * Phục vụ file nhạc qua HTTP Range Streaming (206 Partial Content).
 * Hỗ trợ file > 500MB / nhiều GB mà không đọc toàn bộ vào RAM, cho phép tua & phát tức thì.
 */
export function serveMusicStream(req: IncomingMessage, res: ServerResponse, rawName: string) {
  const clean = sanitizeTrackName(rawName);
  if (!clean) { res.writeHead(404); res.end(); return; }
  const filePath = normPath(join(MUSIC_DIR, clean));
  if (!filePath.startsWith(MUSIC_DIR) || !existsSync(filePath)) { res.writeHead(404); res.end(); return; }

  let stat;
  try { stat = statSync(filePath); } catch { res.writeHead(404); res.end(); return; }
  if (!stat.isFile()) { res.writeHead(404); res.end(); return; }

  const total = stat.size;
  const mime = AUDIO_MIME[extname(clean).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? Math.min(total - 1, parseInt(m[2], 10)) : total - 1;
    if (isNaN(start) || isNaN(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': mime,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(filePath, { start, end, highWaterMark: 256 * 1024 });
    req.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(filePath, { highWaterMark: 256 * 1024 });
  req.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * Nhận luồng upload trực tiếp xuống đĩa (POST /music/upload?name=...).
 * Không giới hạn 500MB — ghi theo từng chunk thẳng vào music/ nên file 1GB–5GB vẫn mượt, không tốn RAM.
 */
export function handleMusicUpload(
  req: IncomingMessage,
  res: ServerResponse,
  rawName: string,
  onDone: (trackName: string, sizeBytes: number) => void,
) {
  ensureMusicDir();
  const clean = sanitizeTrackName(rawName);
  if (!clean) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Định dạng không hỗ trợ (chỉ nhận .mp3, .wav, .flac, .m4a, .aac, .ogg, .opus, .webm)' }));
    return;
  }

  const destPath = normPath(join(MUSIC_DIR, clean));
  if (!destPath.startsWith(MUSIC_DIR)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Tên file không hợp lệ' }));
    return;
  }

  const out = createWriteStream(destPath, { highWaterMark: 512 * 1024 });
  let written = 0;
  let aborted = false;

  const fail = (code: number, msg: string) => {
    if (aborted) return;
    aborted = true;
    out.destroy();
    try { if (existsSync(destPath)) unlinkSync(destPath); } catch { /* bỏ qua */ }
    if (!res.headersSent) {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: msg }));
    }
  };

  req.on('data', (chunk: Buffer) => {
    written += chunk.length;
    if (written > MAX_UPLOAD_BYTES) {
      fail(413, 'File vượt quá giới hạn 10GB');
      req.destroy();
    }
  });

  req.on('aborted', () => fail(499, 'Đã huỷ tải lên'));
  req.on('error', (e) => fail(500, String(e?.message ?? e)));
  out.on('error', (e) => fail(500, String(e?.message ?? e)));

  out.on('finish', () => {
    if (aborted) return;
    onDone(clean, written);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, name: clean, sizeBytes: written }));
  });

  req.pipe(out);
}
