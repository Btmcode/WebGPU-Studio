import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const UPSTREAM_ORIGIN = 'https://webgpu.hrmn.tr';
const UPSTREAM_FILES_PREFIX = '/files/';
const CACHE_ROOT_DIR = path.join(__dirname, '.webgpu-cache');
const SEGMENTS_CACHE_DIR = path.join(CACHE_ROOT_DIR, 'segments');
const MERGED_CACHE_DIR = path.join(CACHE_ROOT_DIR, 'merged');

interface CachedFileEntry {
  buffer: Buffer;
  contentType: string;
  filename: string;
  cachedAt: number;
}

const MAX_CACHE_ENTRIES = 120;
const MAX_CACHE_BYTES = 350 * 1024 * 1024; // 350 MB bounded memory cache
const CACHE_TTL_MS = 60 * 60 * 1000; // Keep in proxy memory up to 60 mins
const fileCache = new Map<string, CachedFileEntry>();
let currentCacheBytes = 0;

function evictCacheIfNeeded(incomingSize: number): void {
  const now = Date.now();
  for (const [key, entry] of fileCache.entries()) {
    if (now - entry.cachedAt > CACHE_TTL_MS) {
      currentCacheBytes -= entry.buffer.byteLength;
      fileCache.delete(key);
    }
  }

  while (
    fileCache.size > 0 &&
    (fileCache.size >= MAX_CACHE_ENTRIES || currentCacheBytes + incomingSize > MAX_CACHE_BYTES)
  ) {
    const oldestKey = fileCache.keys().next().value;
    if (!oldestKey) break;
    const entry = fileCache.get(oldestKey);
    if (entry) {
      currentCacheBytes -= entry.buffer.byteLength;
    }
    fileCache.delete(oldestKey);
  }
}

function validateUpstreamFileUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname !== 'webgpu.hrmn.tr') return null;
    if (!parsed.pathname.startsWith(UPSTREAM_FILES_PREFIX)) return null;
    if (parsed.pathname.includes('..') || parsed.pathname.includes('\\')) return null;
    return parsed;
  } catch {
    return null;
  }
}

function sanitizeFilename(rawName: string): string {
  const cleaned = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || 'webgpu-output';
}

function sendBufferWithRangeSupport(
  req: Request,
  res: Response,
  buf: Buffer,
  contentType: string,
  filename: string,
  cacheStatus: 'HIT' | 'MISS' | 'MERGED',
  forceDownload: boolean
): void {
  const totalLength = buf.byteLength;
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Cache-Status', cacheStatus);
  res.setHeader('Cache-Control', 'private, max-age=1800');
  res.setHeader('Accept-Ranges', 'bytes');

  if (forceDownload) {
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(totalLength));
    res.send(buf);
    return;
  }

  const rangeHeader = req.headers.range;
  if (rangeHeader && typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
    const parts = rangeHeader.replace(/^bytes=/, '').split('-');
    const start = parts[0] ? parseInt(parts[0], 10) : 0;
    const end = parts[1] ? parseInt(parts[1], 10) : totalLength - 1;

    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start < 0 ||
      end >= totalLength ||
      start > end
    ) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${totalLength}`);
      res.end();
      return;
    }

    const chunk = buf.subarray(start, end + 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalLength}`);
    res.setHeader('Content-Length', String(chunk.byteLength));
    res.send(chunk);
    return;
  }

  res.setHeader('Content-Length', String(totalLength));
  res.send(buf);
}

async function ensureCacheDirs(): Promise<void> {
  await fs.mkdir(SEGMENTS_CACHE_DIR, { recursive: true });
  await fs.mkdir(MERGED_CACHE_DIR, { recursive: true });
}

let lastDiskCleanupAt = 0;
const DISK_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days persistent local cache

async function cleanupStaleDiskCache(): Promise<void> {
  const now = Date.now();
  if (now - lastDiskCleanupAt < 15 * 60 * 1000) return;
  lastDiskCleanupAt = now;

  for (const dir of [SEGMENTS_CACHE_DIR, MERGED_CACHE_DIR]) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          if (now - stat.mtimeMs > DISK_CACHE_MAX_AGE_MS) {
            await fs.unlink(fullPath).catch(() => {});
          }
        } catch {
          // Ignore individual stat errors
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }
}

function segmentDiskPath(cacheKey: string): string {
  const hash = crypto.createHash('sha256').update(cacheKey).digest('hex');
  return path.join(SEGMENTS_CACHE_DIR, `${hash}.bin`);
}

function guessContentTypeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.glb') return 'model/gltf-binary';
  return 'application/octet-stream';
}

async function resolveUpstreamFile(
  rawUrl: string
): Promise<{ buffer: Buffer; contentType: string; filename: string; cacheStatus: 'HIT' | 'MISS' }> {
  const validated = validateUpstreamFileUrl(rawUrl);
  if (!validated) {
    throw new Error('Geçersiz veya izin verilmeyen dosya URL adresi');
  }

  const cacheKey = validated.pathname;
  const cached = fileCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt <= CACHE_TTL_MS) {
    return { ...cached, cacheStatus: 'HIT' };
  }

  // Fallback to disk cache if evicted from RAM
  const rawBasename = path.posix.basename(validated.pathname);
  const filename = sanitizeFilename(rawBasename);
  const diskFile = segmentDiskPath(cacheKey);
  try {
    const diskBuf = await fs.readFile(diskFile);
    if (diskBuf.byteLength > 0) {
      const contentType = guessContentTypeFromFilename(filename);
      if (diskBuf.byteLength <= 80 * 1024 * 1024) {
        evictCacheIfNeeded(diskBuf.byteLength);
        fileCache.set(cacheKey, {
          buffer: diskBuf,
          contentType,
          filename,
          cachedAt: Date.now(),
        });
        currentCacheBytes += diskBuf.byteLength;
      }
      return { buffer: diskBuf, contentType, filename, cacheStatus: 'HIT' };
    }
  } catch {
    // Not on disk yet
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const upstream = await fetch(validated.toString(), {
      method: 'GET',
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const msg =
        upstream.status === 404 || upstream.status === 410
          ? 'Dosya süresi dolmuş (upstream 1 dk TTL)'
          : `Dosya indirilemedi (${upstream.status})`;
      const err = new Error(msg) as Error & { statusCode?: number };
      err.statusCode = upstream.status;
      throw err;
    }

    const arrayBuf = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    if (buffer.byteLength > 0) {
      await fs.writeFile(diskFile, buffer).catch(() => {});
      if (buffer.byteLength <= 80 * 1024 * 1024) {
        evictCacheIfNeeded(buffer.byteLength);
        fileCache.set(cacheKey, {
          buffer,
          contentType,
          filename,
          cachedAt: Date.now(),
        });
        currentCacheBytes += buffer.byteLength;
      }
    }

    return { buffer, contentType, filename, cacheStatus: 'MISS' };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveLocalOrUpstreamMedia(rawUrl: string): Promise<{
  buffer: Buffer;
  contentType: string;
  filename: string;
}> {
  if (
    rawUrl.startsWith('/api/video/merged/') ||
    rawUrl.startsWith('/api/media/cached/')
  ) {
    const localName = path.posix.basename(rawUrl.split('?')[0]);
    if (!/^[a-zA-Z0-9._-]+\.(mp4|png|jpg|jpeg|webp)$/i.test(localName) || localName.includes('..')) {
      throw new Error('Geçersiz yerel medya dosya adı');
    }
    const buffer = await fs.readFile(path.join(MERGED_CACHE_DIR, localName));
    return {
      buffer,
      contentType: guessContentTypeFromFilename(localName),
      filename: localName,
    };
  }
  const resolved = await resolveUpstreamFile(rawUrl);
  return {
    buffer: resolved.buffer,
    contentType: resolved.contentType,
    filename: resolved.filename,
  };
}

function parseFrameRate(rateStr?: string): number {
  if (!rateStr || !rateStr.includes('/')) {
    const n = Number(rateStr);
    return Number.isFinite(n) && n >= 10 && n <= 120 ? n : 24;
  }
  const [numStr, denStr] = rateStr.split('/');
  const num = parseFloat(numStr);
  const den = parseFloat(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 24;
  const val = num / den;
  return Number.isFinite(val) && val >= 10 && val <= 120 ? Math.round(val) : 24;
}

async function probeMediaFile(filePath: string): Promise<{
  durationSec: number;
  width?: number;
  height?: number;
  fps: number;
}> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=width,height,codec_type,r_frame_rate,avg_frame_rate',
      '-of',
      'json',
      filePath,
    ],
    { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }
  );
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
    }>;
  };
  const durationSec = parsed.format?.duration ? parseFloat(parsed.format.duration) : 0;
  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const fps = parseFrameRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate);
  return {
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
    width: videoStream?.width,
    height: videoStream?.height,
    fps,
  };
}

async function startServer(): Promise<void> {
  await ensureCacheDirs();
  void cleanupStaleDiskCache();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '15mb' }));

  // Proxy GET /v1/models
  app.get('/api/v1/models', async (_req: Request, res: Response) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const upstream = await fetch(`${UPSTREAM_ORIGIN}/v1/models`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      const bodyText = await upstream.text();
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
      res.send(bodyText);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upstream /v1/models isteği başarısız';
      res.status(502).json({ error: { message } });
    } finally {
      clearTimeout(timeout);
    }
  });

  // Proxy POST /v1/chat/completions with real-time unbuffered streaming
  app.post('/api/v1/chat/completions', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: { message: 'Geçersiz JSON gövdesi' } });
      return;
    }

    if (typeof body.model !== 'string' || body.model.trim().length === 0) {
      res.status(400).json({ error: { message: 'model alanı zorunludur' } });
      return;
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ error: { message: 'messages dizisi boş olamaz' } });
      return;
    }

    const abortController = new AbortController();
    let clientDisconnected = false;

    res.on('close', () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
        abortController.abort();
      }
    });

    try {
      const upstream = await fetch(`${UPSTREAM_ORIGIN}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/x-ndjson, application/json',
        },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      res.status(upstream.status);
      const upstreamContentType =
        upstream.headers.get('content-type') || 'application/x-ndjson; charset=utf-8';
      res.setHeader('Content-Type', upstreamContentType);
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      if (!upstream.body) {
        const text = await upstream.text();
        res.end(text);
        return;
      }

      const reader = upstream.body.getReader();
      const seenPrefetchUrls = new Set<string>();
      const streamDecoder = new TextDecoder('utf-8');
      let streamRollingTail = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (clientDisconnected) break;
          if (value && value.byteLength > 0) {
            const buf = Buffer.from(value);
            res.write(buf);

            // Proactively capture upstream /files/... into persistent disk cache before 1-min upstream TTL expires
            const decoded = streamRollingTail + streamDecoder.decode(value, { stream: true });
            const unescaped = decoded.replace(/\\\//g, '/');
            const matches = unescaped.match(/https?:\/\/webgpu\.hrmn\.tr\/files\/[a-zA-Z0-9._-]+/gi);
            if (matches) {
              for (const rawMatch of matches) {
                const normalized = rawMatch.replace(/^http:\/\//i, 'https://');
                if (!seenPrefetchUrls.has(normalized)) {
                  seenPrefetchUrls.add(normalized);
                  void resolveUpstreamFile(normalized).catch(() => {});
                }
              }
            }
            streamRollingTail = decoded.slice(-160);
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!res.writableEnded) {
        res.end();
      }
    } catch (err) {
      if (clientDisconnected) return;
      const message = err instanceof Error ? err.message : 'Akış bağlantısı kesildi';
      if (!res.headersSent) {
        res.status(502).json({ error: { message } });
      } else if (!res.writableEnded) {
        res.write(JSON.stringify({ event: 'error', status: 'error', message }));
        res.end();
      }
    }
  });

  // Safe file proxy + cache for 60s-expiring generated files (with HTTP Range support for video seeking)
  app.get('/api/file', async (req: Request, res: Response) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
    const forceDownload = req.query.download === '1';

    try {
      const resolved = await resolveUpstreamFile(rawUrl);
      sendBufferWithRangeSupport(
        req,
        res,
        resolved.buffer,
        resolved.contentType,
        resolved.filename,
        resolved.cacheStatus,
        forceDownload
      );
    } catch (err) {
      const status =
        err instanceof Error && 'statusCode' in err && typeof err.statusCode === 'number'
          ? err.statusCode
          : err instanceof Error && err.message.includes('Geçersiz')
            ? 400
            : 502;
      const message = err instanceof Error ? err.message : 'Dosya proxy hatası';
      res.status(status).json({ error: { message } });
    }
  });

  // Inspect a cached/upstream video (duration, width, height, fps) and optionally extract its EXACT final frame
  app.post('/api/video/probe', async (req: Request, res: Response) => {
    const body = req.body as { url?: unknown; extractLastFrame?: unknown } | undefined;
    const rawUrl = typeof body?.url === 'string' ? body.url : '';
    const extractLastFrame = body?.extractLastFrame === true;

    if (!rawUrl) {
      res.status(400).json({ error: { message: 'url alanı zorunludur' } });
      return;
    }

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webgpu-probe-'));
    try {
      const resolved = await resolveLocalOrUpstreamMedia(rawUrl);
      const inputPath = path.join(workDir, 'clip.mp4');
      await fs.writeFile(inputPath, resolved.buffer);

      const meta = await probeMediaFile(inputPath);
      let lastFrameDataUrl: string | undefined;

      if (extractLastFrame) {
        const framePath = path.join(workDir, 'last_frame.jpg');
        try {
          // -sseof -0.35 + -update 1 overwrites with the exact very last frame of the clip
          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-sseof',
              '-0.35',
              '-i',
              inputPath,
              '-update',
              '1',
              '-q:v',
              '1',
              framePath,
            ],
            { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }
          );
        } catch {
          // Fallback for ultra-short clips (< 0.35s)
          await execFileAsync(
            'ffmpeg',
            ['-y', '-i', inputPath, '-update', '1', '-q:v', '1', framePath],
            { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }
          ).catch(() => {});
        }

        try {
          const frameBuf = await fs.readFile(framePath);
          if (frameBuf.byteLength > 0) {
            lastFrameDataUrl = `data:image/jpeg;base64,${frameBuf.toString('base64')}`;
          }
        } catch {
          // Last frame extraction is best-effort
        }
      }

      res.json({
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        sizeBytes: resolved.buffer.byteLength,
        lastFrameDataUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Video analiz edilemedi';
      res.status(500).json({ error: { message } });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  const runFfmpegWithProgress = (
    args: string[],
    totalDurationSec: number,
    onPercent?: (pct: number) => void,
    signal?: AbortSignal,
    timeoutMs = 30 * 60 * 1000
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('İşlem kullanıcı tarafından durduruldu'));
        return;
      }

      const fullArgs = ['-y', ...args.slice(0, -1), '-progress', 'pipe:1', '-nostats', args[args.length - 1]];
      const child = spawn('ffmpeg', fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderrTail = '';
      let stdoutBuf = '';
      let lastPct = 0;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          reject(new Error('FFmpeg işlem süresi zaman aşımına uğradı'));
        }
      }, timeoutMs);

      const onAbort = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill('SIGTERM');
          reject(new Error('İşlem iptal edildi'));
        }
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('out_time_us=')) {
            const us = parseInt(trimmed.slice('out_time_us='.length), 10);
            if (Number.isFinite(us) && us >= 0 && totalDurationSec > 0) {
              const outSec = us / 1_000_000;
              const pct = Math.min(99, Math.max(1, Math.round((outSec / totalDurationSec) * 100)));
              if (pct > lastPct) {
                lastPct = pct;
                onPercent?.(pct);
              }
            }
          } else if (trimmed === 'progress=end') {
            if (lastPct < 100) {
              lastPct = 100;
              onPercent?.(100);
            }
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-3000);
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg hatası (kod ${code ?? -1}): ${stderrTail.trim().slice(-240)}`));
        }
      });
    });
  };

  const mergeSegmentBatchWithXfade = async (opts: {
    segmentPaths: string[];
    durations: number[];
    outputPath: string;
    targetWidth: number;
    targetHeight: number;
    targetFps: number;
    fadeDurationSec: number;
    trimJoinFrames: number;
    trimToSeconds?: number;
    crf: number;
    preset?: 'ultrafast' | 'superfast' | 'veryfast';
    onPercent?: (pct: number) => void;
    signal?: AbortSignal;
  }): Promise<void> => {
    const {
      segmentPaths,
      durations,
      outputPath,
      targetWidth,
      targetHeight,
      targetFps,
      fadeDurationSec,
      trimJoinFrames,
      trimToSeconds,
      crf,
      preset = 'veryfast',
      onPercent,
      signal,
    } = opts;

    const inputs: string[] = [];
    const filters: string[] = [];

    for (let i = 0; i < segmentPaths.length; i++) {
      inputs.push('-i', segmentPaths[i]);
      const baseChain = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${targetFps},settb=AVTB,format=yuv420p`;
      const shouldTrim = i > 0 && trimJoinFrames > 0 && durations[i] > 0.6;
      if (shouldTrim) {
        filters.push(
          `[${i}:v]trim=start_frame=${trimJoinFrames},setpts=PTS-STARTPTS,${baseChain}[v${i}]`
        );
      } else {
        filters.push(`[${i}:v]${baseChain}[v${i}]`);
      }
    }

    const trimSec = trimJoinFrames / targetFps;
    let accDur = Math.max(0.2, durations[0] || 5.0);
    let prevLabel = '[v0]';

    for (let i = 1; i < segmentPaths.length; i++) {
      const rawCurDur = Math.max(0.2, durations[i] || 5.0);
      const trimmedCurDur =
        trimJoinFrames > 0 && rawCurDur > 0.6 ? Math.max(0.2, rawCurDur - trimSec) : rawCurDur;
      const effectiveFade = Math.min(
        fadeDurationSec,
        Math.max(0.08, Math.min(accDur, trimmedCurDur) * 0.25)
      );
      const offset = Math.max(0.05, accDur - effectiveFade);
      const outLabel = i === segmentPaths.length - 1 ? '[outv]' : `[xf${i}]`;
      filters.push(
        `${prevLabel}[v${i}]xfade=transition=fade:duration=${effectiveFade.toFixed(
          3
        )}:offset=${offset.toFixed(3)}${outLabel}`
      );
      prevLabel = outLabel;
      accDur = offset + trimmedCurDur;
    }

    const expectedOutDur = trimToSeconds ? Math.min(accDur, trimToSeconds) : accDur;
    const trimArgs = trimToSeconds ? ['-t', trimToSeconds.toFixed(3)] : [];

    await runFfmpegWithProgress(
      [
        ...inputs,
        '-filter_complex',
        filters.join(';'),
        '-map',
        '[outv]',
        ...trimArgs,
        '-c:v',
        'libx264',
        '-preset',
        preset,
        '-crf',
        String(crf),
        '-threads',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      Math.max(0.5, expectedOutDur),
      onPercent,
      signal
    );
  };

  // Seamlessly merge multiple generated MP4 clips with duplicate-frame trimming + micro-xfade blending + recursive chunking (supports 12+ min videos)
  app.post('/api/video/merge', async (req: Request, res: Response) => {
    void cleanupStaleDiskCache();
    const body = req.body as
      | {
          urls?: unknown;
          trimToSeconds?: unknown;
          continuityEnabled?: unknown;
          outputName?: unknown;
          streamProgress?: unknown;
        }
      | undefined;
    const urls = Array.isArray(body?.urls)
      ? body.urls.filter((u): u is string => typeof u === 'string' && u.length > 0)
      : [];
    const trimToSeconds =
      typeof body?.trimToSeconds === 'number' &&
      Number.isFinite(body.trimToSeconds) &&
      body.trimToSeconds > 0
        ? body.trimToSeconds
        : undefined;
    const continuityEnabled = body?.continuityEnabled !== false;
    const streamProgress = body?.streamProgress === true;

    if (urls.length === 0) {
      res.status(400).json({ error: { message: 'Birleştirilecek video URL listesi boş' } });
      return;
    }

    const abortController = new AbortController();
    let clientClosed = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientClosed = true;
        abortController.abort();
      }
    });

    const emitNdjson = (payload: Record<string, unknown>) => {
      if (!streamProgress || clientClosed || res.writableEnded) return;
      res.write(`${JSON.stringify(payload)}\n`);
    };

    if (streamProgress) {
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    }

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webgpu-merge-'));
    try {
      const segmentPaths: string[] = [];
      const segmentDurations: number[] = [];
      let targetWidth = 0;
      let targetHeight = 0;
      let targetFps = 24;

      for (let i = 0; i < urls.length; i++) {
        if (abortController.signal.aborted) throw new Error('İşlem iptal edildi');
        const resolved = await resolveLocalOrUpstreamMedia(urls[i]);
        const segPath = path.join(workDir, `seg_${String(i).padStart(4, '0')}.mp4`);
        await fs.writeFile(segPath, resolved.buffer);
        const meta = await probeMediaFile(segPath);
        segmentPaths.push(segPath);
        segmentDurations.push(meta.durationSec > 0 ? meta.durationSec : 5.0);
        if (i === 0) {
          targetWidth = meta.width ? Math.max(2, Math.floor(meta.width / 2) * 2) : 544;
          targetHeight = meta.height ? Math.max(2, Math.floor(meta.height / 2) * 2) : 544;
          targetFps = meta.fps || 24;
        }
        if (streamProgress) {
          const prepPct = Math.max(1, Math.min(18, Math.round(((i + 1) / urls.length) * 18)));
          emitNdjson({
            event: 'progress',
            percent: prepPct,
            message: `Klipler hazırlanıyor (${i + 1}/${urls.length})...`,
          });
        }
      }

      const rawId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const baseName =
        typeof body?.outputName === 'string' && body.outputName.trim()
          ? sanitizeFilename(body.outputName.trim().replace(/\.mp4$/i, ''))
          : 'merged_video';
      const outputFilename = `${baseName}_${rawId}.mp4`;
      const outputPath = path.join(MERGED_CACHE_DIR, outputFilename);

      if (segmentPaths.length === 1) {
        if (trimToSeconds) {
          await runFfmpegWithProgress(
            [
              '-i',
              segmentPaths[0],
              '-t',
              trimToSeconds.toFixed(3),
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-crf',
              '17',
              '-pix_fmt',
              'yuv420p',
              '-movflags',
              '+faststart',
              outputPath,
            ],
            trimToSeconds,
            (pct) => {
              emitNdjson({
                event: 'progress',
                percent: Math.max(18, Math.min(99, Math.round(18 + pct * 0.81))),
                message: 'Video düzenleniyor...',
              });
            },
            abortController.signal
          );
        } else {
          await fs.copyFile(segmentPaths[0], outputPath);
          emitNdjson({ event: 'progress', percent: 99, message: 'Tamamlanıyor...' });
        }
      } else {
        const fadeSec = 0.28;
        const trimJoinFrames = continuityEnabled ? 2 : 0;

        try {
          let currentPaths = segmentPaths;
          let currentDurations = segmentDurations;
          let passIdx = 0;

          // Estimate total merge steps for accurate 18% -> 99% progress
          const CHUNK_SIZE = 5;
          let totalChunksToRun = 1;
          let simCount = currentPaths.length;
          while (simCount > CHUNK_SIZE) {
            const batches = Math.ceil(simCount / CHUNK_SIZE);
            totalChunksToRun += batches;
            simCount = batches;
          }
          let completedChunks = 0;

          const reportChunkProgress = (localPct: number) => {
            const overall =
              18 + ((completedChunks + localPct / 100) / Math.max(1, totalChunksToRun)) * 81;
            emitNdjson({
              event: 'progress',
              percent: Math.min(99, Math.max(18, Math.round(overall))),
              message: `Klipler kesintisiz birleştiriliyor (${Math.min(99, Math.round(overall))}%)...`,
            });
          };

          // Recursive hierarchical xfade keeps memory low even for 12+ minute (150+ clip) merges
          while (currentPaths.length > CHUNK_SIZE) {
            passIdx += 1;
            const nextPaths: string[] = [];
            const nextDurations: number[] = [];

            for (let start = 0; start < currentPaths.length; start += CHUNK_SIZE) {
              if (abortController.signal.aborted) throw new Error('İşlem iptal edildi');
              const slicePaths = currentPaths.slice(start, start + CHUNK_SIZE);
              const sliceDurs = currentDurations.slice(start, start + CHUNK_SIZE);

              if (slicePaths.length === 1) {
                nextPaths.push(slicePaths[0]);
                nextDurations.push(sliceDurs[0]);
                completedChunks += 1;
              } else {
                const chunkOut = path.join(workDir, `pass${passIdx}_chunk_${nextPaths.length}.mp4`);
                await mergeSegmentBatchWithXfade({
                  segmentPaths: slicePaths,
                  durations: sliceDurs,
                  outputPath: chunkOut,
                  targetWidth,
                  targetHeight,
                  targetFps,
                  fadeDurationSec: fadeSec,
                  trimJoinFrames,
                  crf: 15,
                  preset: 'ultrafast',
                  onPercent: reportChunkProgress,
                  signal: abortController.signal,
                });
                const chunkMeta = await probeMediaFile(chunkOut);
                nextPaths.push(chunkOut);
                nextDurations.push(
                  chunkMeta.durationSec > 0
                    ? chunkMeta.durationSec
                    : sliceDurs.reduce((a, b) => a + b, 0)
                );
                completedChunks += 1;
              }
            }

            currentPaths = nextPaths;
            currentDurations = nextDurations;
          }

          await mergeSegmentBatchWithXfade({
            segmentPaths: currentPaths,
            durations: currentDurations,
            outputPath,
            targetWidth,
            targetHeight,
            targetFps,
            fadeDurationSec: fadeSec,
            trimJoinFrames,
            trimToSeconds,
            crf: 17,
            onPercent: reportChunkProgress,
            signal: abortController.signal,
          });
        } catch (err) {
          if (abortController.signal.aborted) throw err;
          // Safe fallback to normalized concat re-encode if any unexpected segment format error occurs
          const concatListPath = path.join(workDir, 'concat.txt');
          const concatLines = segmentPaths
            .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
            .join('\n');
          await fs.writeFile(concatListPath, concatLines, 'utf8');
          const totalDur =
            trimToSeconds ?? segmentDurations.reduce((acc, d) => acc + Math.max(0.5, d), 0);
          const trimArgs = trimToSeconds ? ['-t', trimToSeconds.toFixed(3)] : [];

          await runFfmpegWithProgress(
            [
              '-f',
              'concat',
              '-safe',
              '0',
              '-i',
              concatListPath,
              ...trimArgs,
              '-vf',
              `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${targetFps},format=yuv420p`,
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-crf',
              '18',
              '-pix_fmt',
              'yuv420p',
              '-an',
              '-movflags',
              '+faststart',
              outputPath,
            ],
            Math.max(1, totalDur),
            (pct) => {
              emitNdjson({
                event: 'progress',
                percent: Math.min(99, Math.max(18, Math.round(18 + pct * 0.81))),
                message: 'Video birleştiriliyor...',
              });
            },
            abortController.signal
          );
        }
      }

      const stat = await fs.stat(outputPath);
      const meta = await probeMediaFile(outputPath);
      const resultPayload = {
        mergedUrl: `/api/video/merged/${outputFilename}`,
        filename: outputFilename,
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        sizeBytes: stat.size,
      };

      if (streamProgress) {
        emitNdjson({ event: 'done', data: resultPayload });
        if (!res.writableEnded) res.end();
      } else {
        res.json(resultPayload);
      }
    } catch (err) {
      if (clientClosed) return;
      const message = err instanceof Error ? err.message : 'Videolar birleştirilemedi';
      if (streamProgress) {
        emitNdjson({ event: 'error', message });
        if (!res.writableEnded) res.end();
      } else {
        res.status(500).json({ error: { message } });
      }
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  type UpscaleMethodType = 'game-cas' | 'retro-xbr';

  const resolveUpscaleShortSide = (resolution: unknown): number | null => {
    if (resolution === '1080p' || resolution === '1k' || resolution === '1K') return 1080;
    if (resolution === '1440p' || resolution === '2k' || resolution === '2K') return 1440;
    if (resolution === '2160p' || resolution === '4k' || resolution === '4K') return 2160;
    return null;
  };

  const resolveUpscaleMethod = (method: unknown): UpscaleMethodType => {
    if (method === 'retro-xbr') return 'retro-xbr';
    return 'game-cas';
  };

  /**
   * Classic Game-Dev Low-Res -> 2K/4K Upscaling Pipeline:
   * - `game-cas`: Deblock + HQ Denoise + Deband -> Lanczos -> FidelityFX CAS + Luma Unsharp -> Micro-Contrast + Perceptual Film Grain (tricks the eye into crisp 2K/4K detail from 250px!)
   * - `retro-xbr`: Classic xBR 4x rule-based edge scaler (when source <= 720px) -> Lanczos -> CAS + subtle grain
   */
  const buildUpscaleFilterGraph = (
    targetShortSide: number,
    method: UpscaleMethodType,
    isImage: boolean,
    srcMaxDim?: number
  ): string => {
    const imgSquareDim = targetShortSide === 1080 ? 1440 : targetShortSide === 1440 ? 2048 : 3840;
    const scaleExpr = isImage
      ? `scale='if(gt(iw,ih),-2,if(lt(iw,ih),${targetShortSide},${imgSquareDim}))':'if(gt(iw,ih),${targetShortSide},if(lt(iw,ih),-2,${imgSquareDim}))'`
      : `scale='if(gte(iw,ih),-2,${targetShortSide})':'if(gte(iw,ih),${targetShortSide},-2)'`;

    const grainFilter = isImage ? 'noise=alls=3:allf=u' : 'noise=alls=3:allf=t+u';

    if (method === 'retro-xbr' && (!srcMaxDim || srcMaxDim <= 800)) {
      return [
        'xbr=4',
        `${scaleExpr}:flags=lanczos+accurate_rnd+full_chroma_int`,
        'setsar=1',
        'cas=strength=0.52',
        'unsharp=3:3:0.25:3:3:0.0',
        isImage ? 'noise=alls=2:allf=u' : 'noise=alls=2:allf=t+u',
      ].join(',');
    }

    return [
      'deblock=filter=weak:block=4',
      'hqdn3d=1.1:1.1:2.2:2.2',
      'deband',
      `${scaleExpr}:flags=lanczos+accurate_rnd+full_chroma_int`,
      'setsar=1',
      'cas=strength=0.65',
      'unsharp=3:3:0.35:3:3:0.0',
      'eq=contrast=1.03:saturation=1.04',
      grainFilter,
    ].join(',');
  };

  const runVideoUpscale = async (
    inputPath: string,
    outputPath: string,
    targetShortSide: number,
    method: UpscaleMethodType,
    onPercent?: (pct: number) => void,
    signal?: AbortSignal
  ): Promise<void> => {
    const meta = await probeMediaFile(inputPath).catch(() => ({
      durationSec: 5,
      width: undefined,
      height: undefined,
      fps: 24,
    }));
    const maxDim =
      meta.width && meta.height ? Math.max(meta.width, meta.height) : undefined;
    const vf = buildUpscaleFilterGraph(targetShortSide, method, false, maxDim);

    await runFfmpegWithProgress(
      [
        '-i',
        inputPath,
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '16',
        '-threads',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      Math.max(1, meta.durationSec || 5),
      onPercent,
      signal
    );
  };

  const runImageUpscale = async (
    inputPath: string,
    outputPath: string,
    targetShortSide: number,
    method: UpscaleMethodType
  ): Promise<void> => {
    const meta = await probeMediaFile(inputPath).catch(() => ({
      durationSec: 0,
      width: undefined,
      height: undefined,
      fps: 24,
    }));
    const maxDim =
      meta.width && meta.height ? Math.max(meta.width, meta.height) : undefined;
    const vf = buildUpscaleFilterGraph(targetShortSide, method, true, maxDim);

    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', inputPath, '-vf', vf, '-frames:v', '1', outputPath],
      { maxBuffer: 25 * 1024 * 1024, timeout: 60_000 }
    );
  };

  // Upscale a cached or upstream video to 1080p (1K), 1440p (2K), or 2160p (4K) with optional NDJSON progress stream
  app.post('/api/video/upscale', async (req: Request, res: Response) => {
    void cleanupStaleDiskCache();
    const body = req.body as
      | {
          url?: unknown;
          resolution?: unknown;
          method?: unknown;
          outputName?: unknown;
          streamProgress?: unknown;
        }
      | undefined;
    const rawUrl = typeof body?.url === 'string' ? body.url : '';
    const targetShortSide = resolveUpscaleShortSide(body?.resolution);
    const method = resolveUpscaleMethod(body?.method);
    const streamProgress = body?.streamProgress === true;

    if (!rawUrl || !targetShortSide) {
      res
        .status(400)
        .json({ error: { message: 'Geçerli url ve resolution (1080p/1440p/2160p) gereklidir' } });
      return;
    }

    const abortController = new AbortController();
    let clientClosed = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientClosed = true;
        abortController.abort();
      }
    });

    const emitNdjson = (payload: Record<string, unknown>) => {
      if (!streamProgress || clientClosed || res.writableEnded) return;
      res.write(`${JSON.stringify(payload)}\n`);
    };

    if (streamProgress) {
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    }

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webgpu-upscale-'));
    try {
      emitNdjson({ event: 'progress', percent: 2, message: 'Video yükleniyor...' });
      const resolved = await resolveLocalOrUpstreamMedia(rawUrl);
      const inputPath = path.join(workDir, 'input.mp4');
      await fs.writeFile(inputPath, resolved.buffer);

      const rawId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const baseName =
        typeof body?.outputName === 'string' && body.outputName.trim()
          ? sanitizeFilename(body.outputName.trim().replace(/\.mp4$/i, ''))
          : 'upscaled';
      const resLabel = targetShortSide === 1080 ? '1080p' : targetShortSide === 1440 ? '2K' : '4K';
      const outputFilename = `${baseName}_${resLabel}_${rawId}.mp4`;
      const outputPath = path.join(MERGED_CACHE_DIR, outputFilename);

      await runVideoUpscale(
        inputPath,
        outputPath,
        targetShortSide,
        method,
        (pct) => {
          emitNdjson({
            event: 'progress',
            percent: Math.min(99, Math.max(3, pct)),
            message: `${resLabel} netliğe yükseltiliyor (%${Math.min(99, pct)})...`,
          });
        },
        abortController.signal
      );
      const stat = await fs.stat(outputPath);
      const meta = await probeMediaFile(outputPath);

      const resultPayload = {
        upscaledUrl: `/api/video/merged/${outputFilename}`,
        filename: outputFilename,
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        sizeBytes: stat.size,
        resolutionLabel: resLabel,
        method,
      };

      if (streamProgress) {
        emitNdjson({ event: 'done', data: resultPayload });
        if (!res.writableEnded) res.end();
      } else {
        res.json(resultPayload);
      }
    } catch (err) {
      if (clientClosed) return;
      const message = err instanceof Error ? err.message : 'Video yükseltilemedi';
      const status =
        err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 404
          : 500;
      if (streamProgress) {
        emitNdjson({ event: 'error', message, status });
        if (!res.writableEnded) res.end();
      } else {
        res.status(status).json({ error: { message } });
      }
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Fallback video upscale endpoint when uploaded directly from browser IndexedDB cache
  app.post(
    '/api/video/upscale-blob',
    express.raw({ type: 'video/*', limit: '500mb' }),
    async (req: Request, res: Response) => {
      const targetShortSide = resolveUpscaleShortSide(req.query.resolution);
      const method = resolveUpscaleMethod(req.query.method);
      const rawName = typeof req.query.filename === 'string' ? req.query.filename : 'video';
      const streamProgress = req.query.streamProgress === '1';
      const videoBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      if (!targetShortSide || videoBuffer.byteLength === 0) {
        res.status(400).json({ error: { message: 'Geçersiz video verisi veya çözünürlük' } });
        return;
      }

      const abortController = new AbortController();
      let clientClosed = false;
      res.on('close', () => {
        if (!res.writableEnded) {
          clientClosed = true;
          abortController.abort();
        }
      });

      const emitNdjson = (payload: Record<string, unknown>) => {
        if (!streamProgress || clientClosed || res.writableEnded) return;
        res.write(`${JSON.stringify(payload)}\n`);
      };

      if (streamProgress) {
        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }

      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webgpu-upscale-blob-'));
      try {
        const inputPath = path.join(workDir, 'input.mp4');
        await fs.writeFile(inputPath, videoBuffer);

        const rawId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const baseName = sanitizeFilename(rawName.replace(/\.mp4$/i, ''));
        const resLabel =
          targetShortSide === 1080 ? '1080p' : targetShortSide === 1440 ? '2K' : '4K';
        const outputFilename = `${baseName}_${resLabel}_${rawId}.mp4`;
        const outputPath = path.join(MERGED_CACHE_DIR, outputFilename);

        await runVideoUpscale(
          inputPath,
          outputPath,
          targetShortSide,
          method,
          (pct) => {
            emitNdjson({
              event: 'progress',
              percent: Math.min(99, Math.max(3, pct)),
              message: `${resLabel} netliğe yükseltiliyor (%${Math.min(99, pct)})...`,
            });
          },
          abortController.signal
        );
        const stat = await fs.stat(outputPath);
        const meta = await probeMediaFile(outputPath);

        const resultPayload = {
          upscaledUrl: `/api/video/merged/${outputFilename}`,
          filename: outputFilename,
          durationSec: meta.durationSec,
          width: meta.width,
          height: meta.height,
          sizeBytes: stat.size,
          resolutionLabel: resLabel,
          method,
        };

        if (streamProgress) {
          emitNdjson({ event: 'done', data: resultPayload });
          if (!res.writableEnded) res.end();
        } else {
          res.json(resultPayload);
        }
      } catch (err) {
        if (clientClosed) return;
        const message = err instanceof Error ? err.message : 'Video yükseltilemedi';
        if (streamProgress) {
          emitNdjson({ event: 'error', message });
          if (!res.writableEnded) res.end();
        } else {
          res.status(500).json({ error: { message } });
        }
      } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  );

  // Upscale a cached or upstream image (e.g. 250px -> 2000px+ 2K / 4K) using Game-Dev CAS+Grain or xBR4x
  app.post('/api/image/upscale', async (req: Request, res: Response) => {
    void cleanupStaleDiskCache();
    const body = req.body as
      | { url?: unknown; resolution?: unknown; method?: unknown; outputName?: unknown }
      | undefined;
    const rawUrl = typeof body?.url === 'string' ? body.url : '';
    const targetShortSide = resolveUpscaleShortSide(body?.resolution);
    const method = resolveUpscaleMethod(body?.method);

    if (!rawUrl || !targetShortSide) {
      res
        .status(400)
        .json({ error: { message: 'Geçerli url ve resolution (1080p/1440p/2160p) gereklidir' } });
      return;
    }

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webgpu-img-upscale-'));
    try {
      const resolved = await resolveLocalOrUpstreamMedia(rawUrl);
      const ext = path.extname(resolved.filename) || '.png';
      const inputPath = path.join(workDir, `input${ext}`);
      await fs.writeFile(inputPath, resolved.buffer);

      const rawId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const baseName =
        typeof body?.outputName === 'string' && body.outputName.trim()
          ? sanitizeFilename(body.outputName.trim().replace(/\.[a-z0-9]+$/i, ''))
          : 'upscaled_img';
      const resLabel = targetShortSide === 1080 ? '1080p' : targetShortSide === 1440 ? '2K' : '4K';
      const outputFilename = `${baseName}_${resLabel}_${rawId}.png`;
      const outputPath = path.join(MERGED_CACHE_DIR, outputFilename);

      await runImageUpscale(inputPath, outputPath, targetShortSide, method);
      const stat = await fs.stat(outputPath);
      const meta = await probeMediaFile(outputPath);

      res.json({
        upscaledUrl: `/api/media/cached/${outputFilename}`,
        filename: outputFilename,
        width: meta.width,
        height: meta.height,
        sizeBytes: stat.size,
        resolutionLabel: resLabel,
        method,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Görsel yükseltilemedi';
      const status =
        err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 404
          : 500;
      res.status(status).json({ error: { message } });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Fallback image upscale endpoint when uploaded directly from browser IndexedDB cache
  app.post(
    '/api/image/upscale-blob',
    express.raw({ type: 'image/*', limit: '50mb' }),
    async (req: Request, res: Response) => {
      const targetShortSide = resolveUpscaleShortSide(req.query.resolution);
      const method = resolveUpscaleMethod(req.query.method);
      const rawName = typeof req.query.filename === 'string' ? req.query.filename : 'image';
      const imgBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      if (!targetShortSide || imgBuffer.byteLength === 0) {
        res.status(400).json({ error: { message: 'Geçersiz görsel verisi veya çözünürlük' } });
        return;
      }

      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webgpu-img-upscale-blob-'));
      try {
        const inputPath = path.join(workDir, 'input.img');
        await fs.writeFile(inputPath, imgBuffer);

        const rawId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const baseName = sanitizeFilename(rawName.replace(/\.[a-z0-9]+$/i, ''));
        const resLabel =
          targetShortSide === 1080 ? '1080p' : targetShortSide === 1440 ? '2K' : '4K';
        const outputFilename = `${baseName}_${resLabel}_${rawId}.png`;
        const outputPath = path.join(MERGED_CACHE_DIR, outputFilename);

        await runImageUpscale(inputPath, outputPath, targetShortSide, method);
        const stat = await fs.stat(outputPath);
        const meta = await probeMediaFile(outputPath);

        res.json({
          upscaledUrl: `/api/media/cached/${outputFilename}`,
          filename: outputFilename,
          width: meta.width,
          height: meta.height,
          sizeBytes: stat.size,
          resolutionLabel: resLabel,
          method,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Görsel yükseltilemedi';
        res.status(500).json({ error: { message } });
      } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  );

  // Serve merged & upscaled MP4/PNG files with HTTP Range support
  const serveCachedMedia = async (req: Request, res: Response) => {
    const rawName = typeof req.params.filename === 'string' ? req.params.filename : '';
    if (!/^[a-zA-Z0-9._-]+\.(mp4|png|jpg|jpeg|webp)$/i.test(rawName) || rawName.includes('..')) {
      res.status(400).json({ error: { message: 'Geçersiz dosya adı' } });
      return;
    }

    const filePath = path.join(MERGED_CACHE_DIR, rawName);
    try {
      const buffer = await fs.readFile(filePath);
      const forceDownload = req.query.download === '1';
      sendBufferWithRangeSupport(
        req,
        res,
        buffer,
        guessContentTypeFromFilename(rawName),
        rawName,
        'MERGED',
        forceDownload
      );
    } catch {
      res.status(404).json({ error: { message: 'Medya dosyası bulunamadı' } });
    }
  };

  app.get('/api/video/merged/:filename', serveCachedMedia);
  app.get('/api/media/cached/:filename', serveCachedMedia);

  const deleteCachedMedia = async (req: Request, res: Response) => {
    const rawName = typeof req.params.filename === 'string' ? req.params.filename : '';
    if (!/^[a-zA-Z0-9._-]+\.(mp4|png|jpg|jpeg|webp)$/i.test(rawName) || rawName.includes('..')) {
      res.status(400).json({ error: { message: 'Geçersiz dosya adı' } });
      return;
    }

    const filePath = path.join(MERGED_CACHE_DIR, rawName);
    try {
      await fs.unlink(filePath);
    } catch {
      // File might already be evicted or only exist in browser IndexedDB
    }
    res.json({ deleted: true, filename: rawName });
  };

  app.delete('/api/video/merged/:filename', deleteCachedMedia);
  app.delete('/api/media/cached/:filename', deleteCachedMedia);

  const runVideoExport = async (
    inputPath: string,
    outputPath: string,
    format: 'mp4' | 'webm' | 'gif',
    signal?: AbortSignal
  ): Promise<{ contentType: string; ext: string }> => {
    const meta = await probeMediaFile(inputPath).catch(() => ({
      durationSec: 5,
      width: undefined,
      height: undefined,
      fps: 24,
    }));

    if (format === 'mp4') {
      await fs.copyFile(inputPath, outputPath);
      return { contentType: 'video/mp4', ext: 'mp4' };
    }

    if (format === 'webm') {
      await runFfmpegWithProgress(
        [
          '-i',
          inputPath,
          '-c:v',
          'libvpx',
          '-deadline',
          'realtime',
          '-cpu-used',
          '5',
          '-crf',
          '22',
          '-b:v',
          '0',
          '-threads',
          '0',
          '-an',
          outputPath,
        ],
        Math.max(1, meta.durationSec || 5),
        undefined,
        signal,
        15 * 60 * 1000
      );
      return { contentType: 'video/webm', ext: 'webm' };
    }

    // GIF with crisp 2-stage palettegen + paletteuse
    await runFfmpegWithProgress(
      [
        '-i',
        inputPath,
        '-vf',
        "fps=15,scale='min(640,iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3",
        '-loop',
        '0',
        outputPath,
      ],
      Math.max(1, meta.durationSec || 5),
      undefined,
      signal,
      15 * 60 * 1000
    );
    return { contentType: 'image/gif', ext: 'gif' };
  };

  // Multi-format video export (MP4, WebM, GIF) from cached or upstream URL
  app.post('/api/video/export', async (req: Request, res: Response) => {
    const body = req.body as { url?: unknown; format?: unknown; filename?: unknown } | undefined;
    const rawUrl = typeof body?.url === 'string' ? body.url : '';
    const rawFormat = typeof body?.format === 'string' ? body.format.toLowerCase() : 'mp4';
    const format: 'mp4' | 'webm' | 'gif' =
      rawFormat === 'webm' ? 'webm' : rawFormat === 'gif' ? 'gif' : 'mp4';

    if (!rawUrl) {
      res.status(400).json({ error: { message: 'url alanı zorunludur' } });
      return;
    }

    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webgpu-export-'));
    try {
      const resolved = await resolveLocalOrUpstreamMedia(rawUrl);
      const inputPath = path.join(workDir, 'input.mp4');
      await fs.writeFile(inputPath, resolved.buffer);

      const baseName =
        typeof body?.filename === 'string' && body.filename.trim()
          ? sanitizeFilename(body.filename.trim().replace(/\.[a-z0-9]+$/i, ''))
          : 'webgpu_video';
      const outPath = path.join(workDir, `${baseName}.${format}`);
      const { contentType, ext } = await runVideoExport(
        inputPath,
        outPath,
        format,
        abortController.signal
      );

      const outBuffer = await fs.readFile(outPath);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${baseName}.${ext}"`);
      res.setHeader('Content-Length', String(outBuffer.byteLength));
      res.send(outBuffer);
    } catch (err) {
      if (abortController.signal.aborted) return;
      const message = err instanceof Error ? err.message : 'Video dışa aktarılamadı';
      const status =
        err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 404
          : 500;
      res.status(status).json({ error: { message } });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Fallback multi-format video export when uploaded directly from browser IndexedDB cache
  app.post(
    '/api/video/export-blob',
    express.raw({ type: 'video/*', limit: '500mb' }),
    async (req: Request, res: Response) => {
      const rawFormat = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : 'mp4';
      const format: 'mp4' | 'webm' | 'gif' =
        rawFormat === 'webm' ? 'webm' : rawFormat === 'gif' ? 'gif' : 'mp4';
      const rawName = typeof req.query.filename === 'string' ? req.query.filename : 'webgpu_video';
      const videoBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      if (videoBuffer.byteLength === 0) {
        res.status(400).json({ error: { message: 'Geçersiz video verisi' } });
        return;
      }

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
      });

      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webgpu-export-blob-'));
      try {
        const inputPath = path.join(workDir, 'input.mp4');
        await fs.writeFile(inputPath, videoBuffer);

        const baseName = sanitizeFilename(rawName.replace(/\.[a-z0-9]+$/i, ''));
        const outPath = path.join(workDir, `${baseName}.${format}`);
        const { contentType, ext } = await runVideoExport(
          inputPath,
          outPath,
          format,
          abortController.signal
        );

        const outBuffer = await fs.readFile(outPath);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.${ext}"`);
        res.setHeader('Content-Length', String(outBuffer.byteLength));
        res.send(outBuffer);
      } catch (err) {
        if (abortController.signal.aborted) return;
        const message = err instanceof Error ? err.message : 'Video dışa aktarılamadı';
        res.status(500).json({ error: { message } });
      } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  );

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`WebGPU Inference Studio server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
