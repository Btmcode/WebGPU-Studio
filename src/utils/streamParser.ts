import type { ChatMessage, MediaFileItem, WebGpuStreamEvent } from '../types/api';

/**
 * Incremental balanced-brace JSON parser.
 * Handles concatenated JSON objects (`{...}{...}`), NDJSON, SSE (`data: {...}` / `event{...}`),
 * and partial chunks split across TCP reads.
 * Also reports any non-JSON plain text segments separately.
 */
export class ConcatenatedJsonStreamParser {
  private buffer = '';

  public push(chunk: string): { events: WebGpuStreamEvent[]; plainText: string } {
    this.buffer += chunk;
    const events: WebGpuStreamEvent[] = [];
    let plainText = '';

    while (this.buffer.length > 0) {
      const startIdx = this.buffer.indexOf('{');
      if (startIdx === -1) {
        // Keep a tiny tail only if it might be part of an SSE prefix; otherwise emit plain text
        const cleaned = this.stripSseMarkers(this.buffer);
        if (cleaned) {
          plainText += cleaned;
        }
        this.buffer = '';
        break;
      }

      if (startIdx > 0) {
        const prefix = this.buffer.slice(0, startIdx);
        const cleanedPrefix = this.stripSseMarkers(prefix);
        if (cleanedPrefix) {
          plainText += cleanedPrefix;
        }
        this.buffer = this.buffer.slice(startIdx);
      }

      let depth = 0;
      let inString = false;
      let escaped = false;
      let completeEndIdx = -1;

      for (let i = 0; i < this.buffer.length; i++) {
        const ch = this.buffer[i];

        if (escaped) {
          escaped = false;
          continue;
        }

        if (ch === '\\' && inString) {
          escaped = true;
          continue;
        }

        if (ch === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (ch === '{') {
            depth++;
          } else if (ch === '}') {
            depth--;
            if (depth === 0) {
              completeEndIdx = i;
              break;
            }
          }
        }
      }

      if (completeEndIdx === -1) {
        // Wait for more bytes to close the current JSON object
        break;
      }

      const jsonText = this.buffer.slice(0, completeEndIdx + 1);
      this.buffer = this.buffer.slice(completeEndIdx + 1);

      try {
        const parsed = JSON.parse(jsonText) as WebGpuStreamEvent;
        events.push(parsed);
      } catch {
        // Not valid JSON despite balanced braces — skip safely
      }
    }

    return { events, plainText };
  }

  public flush(): { events: WebGpuStreamEvent[]; plainText: string } {
    const trimmed = this.stripSseMarkers(this.buffer).trim();
    this.buffer = '';
    if (!trimmed) return { events: [], plainText: '' };
    try {
      return { events: [JSON.parse(trimmed) as WebGpuStreamEvent], plainText: '' };
    } catch {
      return { events: [], plainText: trimmed };
    }
  }

  private stripSseMarkers(raw: string): string {
    return raw
      .replace(/\bdata:\s*/g, '')
      .replace(/\bevent:\s*[^\r\n]*/g, '')
      .replace(/\bevent(?=\{)/g, '')
      .replace(/\[DONE\]/g, '')
      .trim();
  }
}

/**
 * Extracts any `https://webgpu.hrmn.tr/files/...` (or `/files/...`) URLs from arbitrary text/JSON.
 */
export function extractWebGpuFileUrls(input: string): string[] {
  if (!input) return [];
  const found = new Set<string>();

  // Match full URLs (including escaped slashes `\/` if inside raw JSON string)
  const unescaped = input.replace(/\\\//g, '/');
  const fullRegex = /https?:\/\/webgpu\.hrmn\.tr\/files\/[a-zA-Z0-9._-]+/gi;
  let match: RegExpExecArray | null;
  while ((match = fullRegex.exec(unescaped)) !== null) {
    const normalized = normalizeUpstreamMediaUrl(match[0]);
    if (normalized) found.add(normalized);
  }

  // Also match relative `/files/<filename>` if not preceded by domain chars
  const relRegex = /(?:^|[\s"'(\[])(\/files\/[a-zA-Z0-9._-]+\.[a-zA-Z0-9]{2,6})/gi;
  while ((match = relRegex.exec(unescaped)) !== null) {
    const normalized = normalizeUpstreamMediaUrl(match[1]);
    if (normalized) found.add(normalized);
  }

  return Array.from(found);
}

export function inferMediaKind(urlOrName: string, reportedType?: string): MediaFileItem['mediaKind'] {
  const clean = urlOrName.split('?')[0].toLowerCase();
  if (clean.endsWith('.mp4') || clean.endsWith('.webm') || clean.endsWith('.mov')) {
    return 'video';
  }
  if (
    clean.endsWith('.png') ||
    clean.endsWith('.jpg') ||
    clean.endsWith('.jpeg') ||
    clean.endsWith('.webp') ||
    clean.endsWith('.gif')
  ) {
    return 'image';
  }
  if (clean.endsWith('.glb') || clean.endsWith('.gltf') || clean.endsWith('.obj') || clean.endsWith('.ply')) {
    return '3d';
  }
  if (reportedType === 'video' || reportedType === 'image' || reportedType === '3d') {
    return reportedType;
  }
  return 'unknown';
}

export function normalizeUpstreamMediaUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim().replace(/^http:\/\//i, 'https://');
  const candidate = trimmed.startsWith('/files/')
    ? `https://webgpu.hrmn.tr${trimmed}`
    : trimmed;
  return isValidUpstreamMediaUrl(candidate) ? candidate : null;
}

export function isValidUpstreamMediaUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && parsed.hostname === 'webgpu.hrmn.tr' && parsed.pathname.startsWith('/files/');
  } catch {
    return false;
  }
}

export function buildProxyFileUrl(originalUrl: string, download = false): string {
  if (
    originalUrl.startsWith('/api/video/merged/') ||
    originalUrl.startsWith('/api/media/cached/')
  ) {
    if (download) {
      return `${originalUrl}${originalUrl.includes('?') ? '&' : '?'}download=1`;
    }
    return originalUrl;
  }
  const params = new URLSearchParams({ url: originalUrl });
  if (download) {
    params.set('download', '1');
  }
  return `/api/file?${params.toString()}`;
}

export function extractFilename(rawUrl: string): string {
  try {
    const parsed = rawUrl.startsWith('/') ? new URL(rawUrl, 'http://localhost') : new URL(rawUrl);
    const parts = parsed.pathname.split('/');
    return parts[parts.length - 1] || 'output';
  } catch {
    return 'output';
  }
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDurationClock(seconds?: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function extractProgressPercentFromEvent(obj: Record<string, unknown>): number | undefined {
  for (const key of ['progress', 'percent', 'percentage', 'pct']) {
    const val = obj[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      if (val > 0 && val <= 1) return Math.min(99, Math.max(1, Math.round(val * 100)));
      if (val > 1 && val <= 100) return Math.min(100, Math.max(1, Math.round(val)));
    }
  }

  const stepVal =
    typeof obj.step === 'number'
      ? obj.step
      : typeof obj.current_step === 'number'
        ? obj.current_step
        : undefined;
  const totalSteps =
    typeof obj.total_steps === 'number'
      ? obj.total_steps
      : typeof obj.steps === 'number'
        ? obj.steps
        : undefined;

  if (stepVal && totalSteps && totalSteps > 0 && stepVal <= totalSteps) {
    return Math.min(99, Math.max(1, Math.round((stepVal / totalSteps) * 100)));
  }

  const msg = typeof obj.message === 'string' ? obj.message : '';
  if (msg) {
    const pctMatch = msg.match(/(\d+(?:\.\d+)?)\s*%/);
    if (pctMatch) {
      const parsed = Math.round(parseFloat(pctMatch[1]));
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
        return Math.min(99, Math.max(1, parsed));
      }
    }
    const fracMatch = msg.match(/(?:step|adım|frame|kare)?\s*(\d+)\s*\/\s*(\d+)/i);
    if (fracMatch) {
      const cur = parseInt(fracMatch[1], 10);
      const tot = parseInt(fracMatch[2], 10);
      if (tot > 0 && cur >= 0 && cur <= tot) {
        return Math.min(99, Math.max(1, Math.round((cur / tot) * 100)));
      }
    }
  }

  return undefined;
}

export interface GenerationProgressInfo {
  percent: number;
  remainingPercent: number;
  remainingSeconds?: number;
  formattedRemainingTime?: string;
  isEstimated: boolean;
  stageLabel?: string;
}

export function formatRemainingDuration(seconds?: number): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return '~1 sn';
  }
  const rounded = Math.max(1, Math.ceil(seconds));
  if (rounded < 60) {
    return `~${rounded} sn`;
  }
  const hours = Math.floor(rounded / 3600);
  const mins = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) {
    return mins > 0 ? `~${hours} sa ${mins} dk` : `~${hours} sa`;
  }
  return secs > 0 ? `~${mins} dk ${secs} sn` : `~${mins} dk`;
}

export function computeGenerationProgress(
  message: ChatMessage,
  nowMs: number
): GenerationProgressInfo {
  if (message.status === 'completed') {
    return {
      percent: 100,
      remainingPercent: 0,
      remainingSeconds: 0,
      formattedRemainingTime: '0 sn',
      isEstimated: false,
      stageLabel: 'Tamamlandı',
    };
  }

  const stepsParam = Number(message.params?.steps);
  const framesParam = Number(message.params?.frames);
  const modeParam = typeof message.params?.mode === 'string' ? message.params.mode.toLowerCase() : '';
  const isVideo =
    message.outputType === 'video' ||
    Boolean(message.videoChain) ||
    message.model.toLowerCase().includes('minimax') ||
    message.model.toLowerCase().includes('h3');

  let expectedClipSec = isVideo ? 14 : message.outputType === '3d' ? 24 : 7;
  if (isVideo) {
    if (modeParam === 'fast' || (Number.isFinite(stepsParam) && stepsParam > 0 && stepsParam <= 4)) {
      expectedClipSec = 10;
    } else if (Number.isFinite(stepsParam) && stepsParam >= 16) {
      expectedClipSec = 30;
    } else if (modeParam === 'hq') {
      expectedClipSec = 28;
    } else if (Number.isFinite(stepsParam) && stepsParam >= 8) {
      expectedClipSec = 18;
    }
    if (Number.isFinite(framesParam) && framesParam > 130) expectedClipSec *= 1.25;
  }

  if (message.videoChain) {
    const chain = message.videoChain;
    if (chain.stage === 'completed') {
      return {
        percent: 100,
        remainingPercent: 0,
        remainingSeconds: 0,
        formattedRemainingTime: '0 sn',
        isEstimated: false,
        stageLabel: 'Tamamlandı',
      };
    }

    const hasUpscale = Boolean(chain.upscaleResolution && chain.upscaleResolution !== 'original');
    const genWeight = hasUpscale ? 0.78 : 0.88;
    const mergeWeight = hasUpscale ? 0.1 : 0.12;
    const upscaleWeight = hasUpscale ? 0.12 : 0;

    const target = Math.max(1, chain.targetDurationSec);
    const completedRatio = Math.min(1, chain.accumulatedDurationSec / target);
    const isFinalPhase = chain.accumulatedDurationSec >= target - 0.1;

    const wallSamples = chain.clipWallSeconds && chain.clipWallSeconds.length > 0
      ? chain.clipWallSeconds
      : null;
    const measuredAvgClipWall = wallSamples
      ? wallSamples.reduce((sum, v) => sum + v, 0) / wallSamples.length
      : expectedClipSec;

    const estimatedFinalMergeSec = Math.max(3, Math.round(chain.estimatedTotalClips * 1.4));
    const estimatedUpscaleSec = hasUpscale
      ? Math.max(6, Math.round(chain.targetDurationSec * 0.45))
      : 0;

    if (chain.stage === 'upscaling') {
      const upRatio =
        typeof chain.upscaleProgressPct === 'number'
          ? Math.min(1, Math.max(0, chain.upscaleProgressPct / 100))
          : 0.25;
      const rawPct = Math.round((genWeight + mergeWeight + upRatio * upscaleWeight) * 100);
      const percent = Math.min(99, Math.max(Math.round((genWeight + mergeWeight) * 100), rawPct));
      const upElapsed = chain.upscaleStartedAt
        ? Math.max(0.5, (nowMs - chain.upscaleStartedAt) / 1000)
        : 0;
      const upPct = chain.upscaleProgressPct ?? 0;
      const remSec =
        upPct >= 5 && upElapsed >= 1
          ? (upElapsed * (100 - upPct)) / Math.max(1, upPct)
          : Math.max(2, estimatedUpscaleSec - upElapsed);
      return {
        percent,
        remainingPercent: Math.max(0, 100 - percent),
        remainingSeconds: remSec,
        formattedRemainingTime: formatRemainingDuration(remSec),
        isEstimated: typeof chain.upscaleProgressPct !== 'number',
        stageLabel: chain.statusNote || 'Çözünürlük yükseltiliyor...',
      };
    }

    if (chain.stage === 'merging' && isFinalPhase) {
      const mergeRatio =
        typeof chain.mergeProgressPct === 'number'
          ? Math.min(1, Math.max(0, chain.mergeProgressPct / 100))
          : 0.35;
      const rawPct = Math.round((genWeight + mergeRatio * mergeWeight) * 100);
      const percent = Math.min(
        hasUpscale ? Math.round((genWeight + mergeWeight) * 100) : 99,
        Math.max(Math.round(genWeight * 100), rawPct)
      );
      const mergeElapsed = chain.mergeStartedAt
        ? Math.max(0.5, (nowMs - chain.mergeStartedAt) / 1000)
        : 0;
      const mergePct = chain.mergeProgressPct ?? 0;
      const mergeRem =
        mergePct >= 8 && mergeElapsed >= 1
          ? (mergeElapsed * (100 - mergePct)) / Math.max(1, mergePct)
          : Math.max(2, estimatedFinalMergeSec - mergeElapsed);
      const totalRem = mergeRem + estimatedUpscaleSec;
      return {
        percent,
        remainingPercent: Math.max(0, 100 - percent),
        remainingSeconds: totalRem,
        formattedRemainingTime: formatRemainingDuration(totalRem),
        isEstimated: typeof chain.mergeProgressPct !== 'number',
        stageLabel: chain.statusNote || 'Video kesintisiz birleştiriliyor...',
      };
    }

    // Clip generation (or mid-chain intermediate preview merge: stay monotonic!)
    const clipWeight = 1 / Math.max(1, chain.estimatedTotalClips);
    let inClipRatio = 0;
    let isEstimated = false;
    const clipElapsedSec = chain.currentClipStartedAt
      ? Math.max(0, (nowMs - chain.currentClipStartedAt) / 1000)
      : 0;

    if (chain.stage === 'merging') {
      inClipRatio = 0.05;
      isEstimated = typeof chain.mergeProgressPct !== 'number';
    } else if (typeof chain.currentClipProgressPct === 'number') {
      inClipRatio = Math.min(0.98, Math.max(0, chain.currentClipProgressPct / 100));
    } else if (chain.currentClipStartedAt) {
      inClipRatio = Math.min(0.95, 1 - Math.exp(-clipElapsedSec / measuredAvgClipWall));
      isEstimated = true;
    }

    const totalClipProgress = Math.min(1, completedRatio + inClipRatio * clipWeight);
    const rawPct = Math.round(totalClipProgress * genWeight * 100);
    const percent = Math.min(Math.round(genWeight * 100), Math.max(1, rawPct));

    const completedClipsCount = chain.clips.filter((c) => c.status === 'completed').length;
    const remainingClipsAfterCurrent = Math.max(
      0,
      chain.estimatedTotalClips - Math.max(chain.currentClipIndex, completedClipsCount)
    );
    const currentClipRem =
      chain.stage === 'merging'
        ? 3
        : typeof chain.currentClipProgressPct === 'number' &&
            chain.currentClipProgressPct >= 10 &&
            clipElapsedSec >= 1.5
          ? (clipElapsedSec * (100 - chain.currentClipProgressPct)) /
            Math.max(1, chain.currentClipProgressPct)
          : Math.max(1.5, measuredAvgClipWall - clipElapsedSec);

    const totalRemainingSec =
      currentClipRem +
      remainingClipsAfterCurrent * measuredAvgClipWall +
      estimatedFinalMergeSec +
      estimatedUpscaleSec;

    return {
      percent,
      remainingPercent: Math.max(0, 100 - percent),
      remainingSeconds: totalRemainingSec,
      formattedRemainingTime: formatRemainingDuration(totalRemainingSec),
      isEstimated,
      stageLabel: chain.statusNote,
    };
  }

  // Single clip / image / 3D (optionally with integrated upscaling phase)
  const hasSingleUpscale = Boolean(message.upscaleTarget && message.upscaleTarget !== 'original');
  const genMaxPct = hasSingleUpscale ? 65 : 99;
  const estSingleUpscaleSec = hasSingleUpscale ? (isVideo ? 6 : 2) : 0;

  if (hasSingleUpscale && message.pipelineStage === 'upscaling') {
    const upPct =
      typeof message.upscaleProgressPct === 'number'
        ? Math.min(100, Math.max(0, message.upscaleProgressPct))
        : 20;
    const mapped = Math.round(65 + (upPct / 100) * 34);
    const percent = Math.min(99, Math.max(66, mapped));
    const upElapsed = message.upscaleStartedAt
      ? Math.max(0.5, (nowMs - message.upscaleStartedAt) / 1000)
      : 1;
    const remSec =
      upPct >= 10 && upElapsed >= 1
        ? (upElapsed * (100 - upPct)) / Math.max(1, upPct)
        : Math.max(1.5, estSingleUpscaleSec - upElapsed);
    return {
      percent,
      remainingPercent: Math.max(0, 100 - percent),
      remainingSeconds: remSec,
      formattedRemainingTime: formatRemainingDuration(remSec),
      isEstimated: typeof message.upscaleProgressPct !== 'number',
      stageLabel: message.pipelineLabel || 'Çözünürlük yükseltiliyor...',
    };
  }

  const elapsedSec = Math.max(message.elapsed ?? 0, (nowMs - message.createdAt) / 1000);

  if (typeof message.progressPct === 'number' && message.progressPct > 0) {
    const raw = Math.min(99, Math.max(1, Math.round(message.progressPct)));
    const percent = hasSingleUpscale ? Math.max(1, Math.round((raw / 100) * genMaxPct)) : raw;
    const blendWeight = Math.min(1, Math.max(0, (raw - 5) / 35));
    const observedRem = (elapsedSec * (100 - raw)) / Math.max(1, raw);
    const baselineRem = Math.max(1, expectedClipSec - elapsedSec);
    const genRem = blendWeight * observedRem + (1 - blendWeight) * baselineRem;
    const totalRem = Math.max(1, genRem + estSingleUpscaleSec);
    return {
      percent,
      remainingPercent: Math.max(0, 100 - percent),
      remainingSeconds: totalRem,
      formattedRemainingTime: formatRemainingDuration(totalRem),
      isEstimated: false,
      stageLabel: message.pipelineLabel,
    };
  }

  const rawEstimated = Math.min(
    95,
    Math.max(1, Math.round(96 * (1 - Math.exp(-elapsedSec / expectedClipSec))))
  );
  const percent = hasSingleUpscale
    ? Math.max(1, Math.round((rawEstimated / 100) * genMaxPct))
    : rawEstimated;
  const estGenRem = Math.max(2, expectedClipSec - elapsedSec);
  const totalRem = Math.max(1, estGenRem + estSingleUpscaleSec);
  return {
    percent,
    remainingPercent: Math.max(0, 100 - percent),
    remainingSeconds: totalRem,
    formattedRemainingTime: formatRemainingDuration(totalRem),
    isEstimated: true,
    stageLabel: message.pipelineLabel,
  };
}
