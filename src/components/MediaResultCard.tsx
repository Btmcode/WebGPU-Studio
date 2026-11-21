import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Copy,
  Check,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Clock,
  AlertTriangle,
  Box,
  Maximize2,
  X,
  HardDrive,
  Loader2,
  CheckCircle2,
  Terminal,
  PanelRightOpen,
  Layers,
  Trash2,
  Sparkles,
} from 'lucide-react';
import { parsePromptFlags } from '../data/flags';
import type { ChatMessage, MediaFileItem } from '../types/api';
import { downloadMediaFile } from '../utils/mediaStore';
import {
  buildProxyFileUrl,
  computeGenerationProgress,
  formatBytes,
} from '../utils/streamParser';

interface MediaResultCardProps {
  message: ChatMessage;
  promptText?: string;
  simpleMode?: boolean;
  selectedPreviewUrl?: string | null;
  onSelectPreview?: (url: string) => void;
  onDeleteFile?: (messageId: string, file: MediaFileItem) => void;
  onUpscaleFile?: (
    messageId: string,
    file: MediaFileItem,
    resolution: '1080p' | '1440p' | '2160p'
  ) => Promise<void>;
  onExtendVideo?: (messageId: string, file: MediaFileItem, addSeconds: number) => void;
  onReusePrompt: (prompt: string) => void;
  onRerunPrompt: (prompt: string) => void;
}

/**
 * Renders user prompt text with inline `--flag value` syntax highlighting.
 */
function renderHighlightedPrompt(text: string): React.ReactNode {
  const tokens = parsePromptFlags(text);
  if (tokens.length === 0) {
    return <span>{text}</span>;
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;

  tokens.forEach((tok, idx) => {
    if (tok.startIndex > cursor) {
      parts.push(<span key={`txt-${idx}`}>{text.slice(cursor, tok.startIndex)}</span>);
    }
    parts.push(
      <span
        key={`flg-${idx}`}
        className="inline-block font-mono text-[13px] text-blue-300 bg-blue-500/10 border border-blue-500/20 rounded px-1.5 py-0.5 mx-0.5 align-baseline"
      >
        {tok.raw}
      </span>
    );
    cursor = tok.endIndex;
  });

  if (cursor < text.length) {
    parts.push(<span key="txt-end">{text.slice(cursor)}</span>);
  }

  return <>{parts}</>;
}

function formatParamsSummary(params?: Record<string, string | number | boolean>): string {
  if (!params) return '';
  const w = params.width;
  const h = params.height;
  const parts: string[] = [];
  if (w && h) {
    parts.push(`${w}×${h}`);
  }
  for (const [k, v] of Object.entries(params)) {
    if ((k === 'width' || k === 'height') && w && h) continue;
    parts.push(`${k}: ${String(v)}`);
  }
  return parts.join(' · ');
}

interface MediaFileViewProps {
  file: MediaFileItem;
  messageId: string;
  nowMs: number;
  simpleMode?: boolean;
  isStreamingMessage?: boolean;
  isSelectedPreview?: boolean;
  onSelectPreview?: (url: string) => void;
  onDeleteFile?: (messageId: string, file: MediaFileItem) => void;
  onUpscaleFile?: (
    messageId: string,
    file: MediaFileItem,
    resolution: '1080p' | '1440p' | '2160p'
  ) => Promise<void>;
  onExtendVideo?: (messageId: string, file: MediaFileItem, addSeconds: number) => void;
}

const MediaFileView: React.FC<MediaFileViewProps> = ({
  file,
  messageId,
  nowMs,
  simpleMode = false,
  isStreamingMessage = false,
  isSelectedPreview,
  onSelectPreview,
  onDeleteFile,
  onUpscaleFile,
  onExtendVideo,
}) => {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [upscaling, setUpscaling] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [mediaLoadFailed, setMediaLoadFailed] = useState(false);

  const remainingSec = Math.max(0, Math.ceil((file.expiresAt - nowMs) / 1000));
  const isUpstreamExpired = !file.isMerged && remainingSec <= 0;

  // Use a stable media src immediately on `done` so the file appears instantly without waiting for a spinner,
  // and upgrade cleanly when `blobUrl` hydrates from IndexedDB or finishes caching if needed.
  const [stableSrc, setStableSrc] = useState<string>(() => {
    if (file.blobUrl) return file.blobUrl;
    if (file.status === 'expired') return '';
    return buildProxyFileUrl(file.originalUrl, false);
  });

  useEffect(() => {
    if (file.blobUrl) {
      setMediaLoadFailed(false);
      setStableSrc(file.blobUrl);
    } else if (file.status === 'expired') {
      setStableSrc('');
    } else if (!stableSrc) {
      setStableSrc(buildProxyFileUrl(file.originalUrl, false));
    }
  }, [file.blobUrl, file.status, file.originalUrl, stableSrc]);

  const effectiveSrc = stableSrc || file.blobUrl || '';

  const handleCopyUrl = async () => {
    try {
      const target = file.originalUrl.startsWith('/')
        ? `${window.location.origin}${file.originalUrl}`
        : file.originalUrl;
      await navigator.clipboard.writeText(target);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked
    }
  };

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadMediaFile(file);
    } catch {
      // Fallback error handled silently or via status
    } finally {
      setDownloading(false);
    }
  };

  const handleQuickUpscale = async () => {
    if (!onUpscaleFile || upscaling) return;
    setUpscaling(true);
    try {
      await onUpscaleFile(messageId, file, '1440p');
    } catch {
      // Error surfaced if needed
    } finally {
      setUpscaling(false);
    }
  };

  return (
    <div className="space-y-2.5">
      {mediaLoadFailed || (file.status === 'expired' && !effectiveSrc) ? (
        <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
          <span>{file.errorText || 'Medya dosyası yerel önbellekte bulunamadı.'}</span>
        </div>
      ) : file.mediaKind === 'video' && effectiveSrc ? (
        <div className="relative rounded-lg overflow-hidden border border-white/10 bg-black">
          <video
            src={effectiveSrc}
            controls
            autoPlay
            loop
            muted
            playsInline
            onError={() => setMediaLoadFailed(true)}
            className="w-full max-h-[480px] object-contain mx-auto block"
          />
        </div>
      ) : file.mediaKind === 'image' && effectiveSrc ? (
        <div className="relative group rounded-lg overflow-hidden border border-white/10 bg-[#0D1015]">
          <img
            src={effectiveSrc}
            alt={file.filename}
            referrerPolicy="no-referrer"
            onClick={() => setLightboxOpen(true)}
            onError={() => setMediaLoadFailed(true)}
            className="w-full max-h-[480px] object-contain mx-auto block cursor-zoom-in"
          />
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            aria-label="Görseli büyüt"
            className="absolute top-2.5 right-2.5 p-1.5 rounded-lg bg-black/70 text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      ) : file.mediaKind === '3d' ? (
        <div className="flex items-center justify-between gap-4 p-4 rounded-lg border border-white/10 bg-[#0D1015]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center shrink-0">
              <Box className="w-5 h-5 text-amber-400" />
            </div>
            <div className="min-w-0">
              <div className="font-mono text-sm text-slate-100 truncate">{file.filename}</div>
              <div className="text-xs text-slate-400">
                3D Mesh Dosyası {file.sizeBytes ? `· ${formatBytes(file.sizeBytes)}` : ''}
              </div>
            </div>
          </div>
          {effectiveSrc && (
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {downloading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>Modeli İndir</span>
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2.5 h-48 rounded-lg border border-white/8 bg-[#0D1015] text-xs text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
          <span>Dosya yükleniyor...</span>
        </div>
      )}

      {/* Metadata, Cache & Actions Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-slate-400">
          {!simpleMode ? (
            <>
              <span className="font-mono text-slate-300 truncate max-w-[200px]">
                {file.isMerged ? `Birleştirilmiş (${file.clipCount || 1} klip)` : file.filename}
              </span>
              {file.width && file.height && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-slate-300">
                    {file.width}×{file.height}
                  </span>
                </>
              )}
              {file.upscaleLabel && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-emerald-400">{file.upscaleLabel}</span>
                </>
              )}
              {typeof file.durationSec === 'number' && file.durationSec > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums text-slate-300">
                    {file.durationSec.toFixed(1)} sn
                  </span>
                </>
              )}
              {file.sizeBytes ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{formatBytes(file.sizeBytes)}</span>
                </>
              ) : null}
              {!file.isMerged && file.status !== 'cached' && !file.blobUrl && (
                <>
                  <span aria-hidden="true">·</span>
                  {isUpstreamExpired ? (
                    <span className="inline-flex items-center gap-1 text-amber-400 tabular-nums">
                      <Clock className="w-3.5 h-3.5" />
                      <span>Önbelleğe aktarılıyor</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-amber-300 tabular-nums">
                      <Clock className="w-3.5 h-3.5" />
                      <span>URL TTL: {remainingSec}s</span>
                    </span>
                  )}
                </>
              )}
              {(file.status === 'cached' || Boolean(file.blobUrl)) && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 text-emerald-400">
                    <HardDrive className="w-3.5 h-3.5" />
                    <span>Önbellekte</span>
                  </span>
                </>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
              <span className="font-medium text-slate-200">
                {file.mediaKind === 'video'
                  ? 'Hazır Video'
                  : file.mediaKind === '3d'
                    ? '3D Model'
                    : 'Hazır Resim'}
              </span>
              {typeof file.durationSec === 'number' && file.durationSec > 0 && (
                <>
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span className="tabular-nums">{Math.round(file.durationSec)} saniye</span>
                </>
              )}
              {file.upscaleLabel && (
                <>
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span className="text-emerald-400 font-medium">Çok Net ({file.upscaleLabel})</span>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {onSelectPreview && (
            <button
              type="button"
              onClick={() => onSelectPreview(file.originalUrl)}
              className={`inline-flex items-center gap-1.5 rounded-lg border transition-colors cursor-pointer whitespace-nowrap ${
                simpleMode ? 'px-3.5 py-2 text-sm font-medium' : 'px-2.5 py-1.5 text-xs rounded-md'
              } ${
                isSelectedPreview
                  ? 'border-blue-500/45 bg-blue-500/15 text-blue-200'
                  : 'border-white/10 bg-[#181C24] text-slate-300 hover:text-white hover:border-white/20'
              }`}
            >
              <PanelRightOpen className={simpleMode ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
              <span>{simpleMode ? 'Büyük İzle' : 'Önizle'}</span>
            </button>
          )}

          {!simpleMode && (
            <button
              type="button"
              onClick={handleCopyUrl}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-white/10 bg-[#181C24] text-xs text-slate-300 hover:text-white hover:border-white/20 transition-colors cursor-pointer whitespace-nowrap"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Kopyalandı</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>URL Kopyala</span>
                </>
              )}
            </button>
          )}

          {simpleMode &&
            onExtendVideo &&
            file.mediaKind === 'video' &&
            !isStreamingMessage &&
            effectiveSrc &&
            !mediaLoadFailed && (
              <button
                type="button"
                onClick={() => onExtendVideo(messageId, file, 120)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/15 bg-[#181C24] hover:border-[#D4FF2A]/60 text-sm font-medium text-slate-100 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Layers className="w-4 h-4 text-[#D4FF2A]" />
                <span>Süreyi Uzat (+2 dk)</span>
              </button>
            )}

          {simpleMode &&
            onUpscaleFile &&
            (file.mediaKind === 'video' || file.mediaKind === 'image') &&
            !file.upscaleLabel &&
            !isStreamingMessage &&
            effectiveSrc &&
            !mediaLoadFailed && (
              <button
                type="button"
                onClick={handleQuickUpscale}
                disabled={upscaling}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/15 bg-[#181C24] hover:border-blue-400/60 text-sm font-medium text-slate-100 transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
              >
                {upscaling ? (
                  <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                ) : (
                  <Sparkles className="w-4 h-4 text-blue-400" />
                )}
                <span>{upscaling ? 'Netleştiriliyor...' : 'Netleştir (2K)'}</span>
              </button>
            )}

          {effectiveSrc && !mediaLoadFailed && (
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              className={`inline-flex items-center gap-2 rounded-lg disabled:opacity-50 font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                simpleMode
                  ? 'px-4 py-2 text-sm bg-[#D4FF2A] hover:bg-[#e1ff66] text-[#08090C]'
                  : 'px-3 py-1.5 text-xs rounded-md bg-blue-600 hover:bg-blue-500 text-white'
              }`}
            >
              {downloading ? (
                <Loader2 className={simpleMode ? 'w-4 h-4 animate-spin' : 'w-3.5 h-3.5 animate-spin'} />
              ) : (
                <Download className={simpleMode ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
              )}
              <span>{downloading ? 'İndiriliyor...' : simpleMode ? 'İndir (Kaydet)' : 'İndir'}</span>
            </button>
          )}

          {onDeleteFile && (
            confirmDelete ? (
              <div className="inline-flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDelete(false);
                    onDeleteFile(messageId, file);
                  }}
                  className={`inline-flex items-center gap-1 rounded-lg bg-rose-600 hover:bg-rose-500 font-medium text-white transition-colors cursor-pointer whitespace-nowrap ${
                    simpleMode ? 'px-3.5 py-2 text-sm' : 'px-2.5 py-1.5 text-xs rounded-md'
                  }`}
                >
                  <span>Evet, Sil</span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className={`inline-flex items-center rounded-lg border border-white/15 bg-[#181C24] hover:text-white text-slate-300 transition-colors cursor-pointer whitespace-nowrap ${
                    simpleMode ? 'px-3 py-2 text-sm' : 'px-2 py-1.5 text-xs rounded-md'
                  }`}
                >
                  <span>Vazgeç</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className={`inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 hover:text-rose-200 transition-colors cursor-pointer whitespace-nowrap ${
                  simpleMode ? 'px-3.5 py-2 text-sm font-medium' : 'px-2.5 py-1.5 text-xs rounded-md'
                }`}
              >
                <Trash2 className={simpleMode ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
                <span>Sil</span>
              </button>
            )
          )}
        </div>
      </div>

      {/* Image Lightbox */}
      {lightboxOpen && effectiveSrc && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setLightboxOpen(false)}
        >
          <button
            type="button"
            onClick={() => setLightboxOpen(false)}
            aria-label="Önizlemeyi kapat"
            className="absolute top-4 right-4 p-2 rounded-lg bg-white/10 text-white hover:bg-white/20 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={effectiveSrc}
            alt={file.filename}
            referrerPolicy="no-referrer"
            className="max-w-full max-h-[90vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
};

export const MediaResultCard: React.FC<MediaResultCardProps> = ({
  message,
  promptText,
  simpleMode = false,
  selectedPreviewUrl,
  onSelectPreview,
  onDeleteFile,
  onUpscaleFile,
  onExtendVideo,
  onReusePrompt,
  onRerunPrompt,
}) => {
  // "Thinking"-style timeline is expanded while streaming, and auto-collapses when completed!
  const [timelineExpanded, setTimelineExpanded] = useState(message.status === 'streaming');
  const [showRawJson, setShowRawJson] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const prevStatusRef = useRef(message.status);

  useEffect(() => {
    if (prevStatusRef.current === 'streaming' && message.status !== 'streaming') {
      setTimelineExpanded(false);
    } else if (message.status === 'streaming') {
      setTimelineExpanded(true);
    }
    prevStatusRef.current = message.status;
  }, [message.status]);

  // Tick every 200ms while streaming for smooth "thinking" timer, every 1s for TTL countdown
  const hasActiveCountdown = (message.files || []).some((f) => f.expiresAt > nowMs);

  useEffect(() => {
    if (message.status === 'streaming') {
      const timer = setInterval(() => setNowMs(Date.now()), 200);
      return () => clearInterval(timer);
    }
    if (hasActiveCountdown) {
      const timer = setInterval(() => setNowMs(Date.now()), 1000);
      return () => clearInterval(timer);
    }
  }, [message.status, hasActiveCountdown]);

  const timelineSteps = useMemo(() => {
    const events = message.streamEvents || [];
    return events.map((ev, idx) => {
      const obj = ev as Record<string, unknown>;
      const type = typeof obj.event === 'string' ? obj.event : 'event';
      if (type === 'start') {
        const p = obj.params as Record<string, string | number | boolean> | undefined;
        const pStr = formatParamsSummary(p);
        return {
          key: idx,
          label: 'Başlatıldı',
          detail: pStr || `${String(obj.model || message.model)} · ${String(obj.type || '')}`,
          elapsed: undefined as number | undefined,
        };
      }
      if (type === 'progress') {
        return {
          key: idx,
          label: 'İşleniyor',
          detail: typeof obj.message === 'string' ? obj.message : 'Çıkarım adımı devam ediyor',
          elapsed: typeof obj.elapsed === 'number' ? obj.elapsed : undefined,
        };
      }
      if (type === 'done') {
        return {
          key: idx,
          label: 'Tamamlandı',
          detail:
            Array.isArray(obj.files) && obj.files.length > 0
              ? `${obj.files.length} dosya oluşturuldu`
              : 'İşlem tamamlandı',
          elapsed: typeof obj.elapsed === 'number' ? obj.elapsed : undefined,
        };
      }
      return {
        key: idx,
        label: type,
        detail: JSON.stringify(obj),
        elapsed: undefined as number | undefined,
      };
    });
  }, [message.streamEvents, message.model]);

  if (message.role === 'user') {
    const plainPrompt = message.content.replace(/--[a-zA-Z0-9_-]+(?:\s+(?:"[^"]*"|'[^']*'|[^\s]+))?/g, '').trim();
    return (
      <div className="flex justify-end">
        <div className="max-w-2xl rounded-xl border border-white/10 bg-[#181C25] px-4 py-3 text-sm sm:text-[15px] text-slate-100">
          {message.attachedImageUrl && !simpleMode && (
            <div className="mb-2 text-xs font-mono text-slate-400 truncate">
              Referans: {message.attachedImageUrl}
            </div>
          )}
          <div className="leading-relaxed break-words">
            {simpleMode ? plainPrompt || message.content : renderHighlightedPrompt(message.content)}
          </div>
          <div className="mt-2 pt-2 border-t border-white/8 flex items-center justify-between gap-4 text-xs text-slate-400">
            <span className={simpleMode ? '' : 'font-mono text-[11px] text-slate-500'}>
              {simpleMode ? 'İsteğiniz' : message.model}
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => onReusePrompt(simpleMode ? plainPrompt || message.content : message.content)}
                className="hover:text-slate-100 transition-colors cursor-pointer"
              >
                Düzenle
              </button>
              <button
                type="button"
                onClick={() => onRerunPrompt(message.content)}
                className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors cursor-pointer font-medium"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Tekrar Yap</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const liveElapsed =
    message.status === 'streaming'
      ? Math.max(message.elapsed ?? 0, (nowMs - message.createdAt) / 1000)
      : message.elapsed;

  const progressInfo = useMemo(
    () => computeGenerationProgress(message, nowMs),
    [message, nowMs]
  );

  const paramsSummary = formatParamsSummary(message.params);

  // Compute aspect ratio for live streaming skeleton preview
  const widthParam = Number(message.params?.width);
  const heightParam = Number(message.params?.height);
  const previewAspectRatio =
    Number.isFinite(widthParam) && Number.isFinite(heightParam) && widthParam > 0 && heightParam > 0
      ? `${widthParam} / ${heightParam}`
      : '16 / 9';

  const cleanPromptTitle = (promptText || '')
    .replace(/--[a-zA-Z0-9_-]+(?:\s+(?:"[^"]*"|'[^']*'|[^\s]+))?/g, '')
    .trim();

  if (simpleMode) {
    const simpleStageTitle =
      message.status === 'streaming'
        ? message.pipelineStage === 'upscaling' || message.videoChain?.stage === 'upscaling'
          ? 'Görüntü yüksek netliğe yükseltiliyor...'
          : message.pipelineStage === 'merging' || message.videoChain?.stage === 'merging'
            ? 'Video parçaları kesintisiz birleştiriliyor...'
            : message.videoChain
              ? `Uzun video hazırlanıyor (${Math.round(
                  message.videoChain.accumulatedDurationSec
                )} / ${message.videoChain.targetDurationSec} sn)...`
              : message.outputType === 'image'
                ? 'Resminiz çiziliyor...'
                : message.outputType === '3d'
                  ? '3D modeliniz hazırlanıyor...'
                  : 'Videonuz hazırlanıyor...'
        : message.status === 'completed'
          ? 'Hazır'
          : message.status === 'aborted'
            ? 'Durduruldu'
            : 'Bir sorun oluştu';

    return (
      <div className="rounded-2xl border border-white/10 bg-[#111318] overflow-hidden">
        {/* Cinema Card Prompt Header */}
        {cleanPromptTitle && (
          <div className="px-4 sm:px-5 py-3.5 border-b border-white/8 flex items-center justify-between gap-3">
            <p className="text-sm sm:text-base font-medium text-slate-100 leading-snug line-clamp-2">
              {cleanPromptTitle}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onReusePrompt(cleanPromptTitle)}
                className="px-2.5 py-1.5 rounded-lg border border-white/10 bg-[#181B22] hover:text-white text-xs text-slate-300 transition-colors cursor-pointer whitespace-nowrap"
              >
                Düzenle
              </button>
              <button
                type="button"
                onClick={() => onRerunPrompt(promptText || cleanPromptTitle)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/10 bg-[#181B22] hover:border-[#D4FF2A]/50 text-xs font-medium text-slate-200 hover:text-white transition-colors cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Tekrar Yap</span>
              </button>
            </div>
          </div>
        )}

        <div className="p-4 sm:p-5 space-y-4">
          {/* Unified Progress Banner (Generation + Merging + Upscaling) */}
          {message.status === 'streaming' && (
            <div className="p-4 rounded-xl border border-white/10 bg-[#0B0D11] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Loader2 className="w-4 h-4 animate-spin text-[#D4FF2A] shrink-0" />
                  <span className="text-sm sm:text-base font-medium text-slate-100 truncate">
                    {progressInfo.stageLabel || simpleStageTitle}
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono text-xs sm:text-sm tabular-nums shrink-0">
                  <span className="text-[#D4FF2A] font-bold">%{progressInfo.percent}</span>
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span className="text-slate-300">Kalan: %{progressInfo.remainingPercent}</span>
                  {progressInfo.formattedRemainingTime && (
                    <>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className="inline-flex items-center gap-1 text-slate-200 font-medium">
                        <Clock className="w-3.5 h-3.5 text-[#D4FF2A]" />
                        <span>Kalan Süre: {progressInfo.formattedRemainingTime}</span>
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="h-2.5 w-full rounded-full bg-white/[0.08] overflow-hidden">
                <div
                  className="h-full bg-[#D4FF2A] transition-all duration-300"
                  style={{ width: `${progressInfo.percent}%` }}
                />
              </div>

              {(message.videoChain ||
                (message.upscaleTarget && message.upscaleTarget !== 'original')) && (
                <div className="flex flex-wrap items-center gap-2 text-xs pt-0.5">
                  {(() => {
                    const currentStage =
                      message.videoChain?.stage === 'upscaling' ||
                      message.pipelineStage === 'upscaling'
                        ? 'upscaling'
                        : message.videoChain?.stage === 'merging' ||
                            message.pipelineStage === 'merging'
                          ? 'merging'
                          : 'generating';
                    const steps: Array<{ id: string; label: string }> = [
                      { id: 'generating', label: '1. Üretim' },
                    ];
                    if (message.videoChain) {
                      steps.push({ id: 'merging', label: '2. Birleştirme' });
                    }
                    if (message.upscaleTarget && message.upscaleTarget !== 'original') {
                      steps.push({
                        id: 'upscaling',
                        label: `${message.videoChain ? '3' : '2'}. Netleştirme`,
                      });
                    }
                    const currentIdx = steps.findIndex((s) => s.id === currentStage);
                    return steps.map((step, idx) => {
                      const isDone = idx < currentIdx;
                      const isActive = idx === currentIdx;
                      return (
                        <React.Fragment key={step.id}>
                          {idx > 0 && (
                            <span aria-hidden="true" className="text-slate-600">
                              →
                            </span>
                          )}
                          <span
                            className={
                              isActive
                                ? 'text-[#D4FF2A] font-semibold'
                                : isDone
                                  ? 'text-emerald-400'
                                  : 'text-slate-500'
                            }
                          >
                            {step.label}
                          </span>
                        </React.Fragment>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Error / Warning */}
          {message.errorMessage && (
            <div className="p-3.5 rounded-xl border border-rose-500/30 bg-rose-500/10 text-sm text-rose-200 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <div className="break-words">{message.errorMessage}</div>
            </div>
          )}

          {message.nonFatalWarning && !message.errorMessage && (
            <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
              <div className="break-words">{message.nonFatalWarning}</div>
            </div>
          )}

          {/* Generated Media Output(s) */}
          {message.files && message.files.length > 0 ? (
            <div className="space-y-4">
              {message.files.map((file) => (
                <MediaFileView
                  key={file.originalUrl}
                  file={file}
                  messageId={message.id}
                  nowMs={nowMs}
                  simpleMode
                  isStreamingMessage={message.status === 'streaming'}
                  isSelectedPreview={selectedPreviewUrl === file.originalUrl}
                  onSelectPreview={onSelectPreview}
                  onDeleteFile={onDeleteFile}
                  onUpscaleFile={onUpscaleFile}
                  onExtendVideo={onExtendVideo}
                />
              ))}
            </div>
          ) : message.status === 'streaming' ? (
            <div
              style={{ aspectRatio: previewAspectRatio }}
              className="w-full max-h-[360px] rounded-xl border border-white/8 bg-[#090B0E] flex flex-col items-center justify-center gap-2.5 px-6 text-center"
            >
              <div className="font-mono text-3xl sm:text-4xl font-bold text-[#D4FF2A] tabular-nums">
                %{progressInfo.percent}
              </div>
              <div className="text-sm text-slate-300">
                {progressInfo.stageLabel || simpleStageTitle}
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 text-xs font-mono text-slate-400 tabular-nums">
                <span>Kalan: %{progressInfo.remainingPercent}</span>
                {progressInfo.formattedRemainingTime && (
                  <>
                    <span aria-hidden="true" className="text-slate-600">·</span>
                    <span className="text-slate-200 font-medium">
                      Kalan Süre: {progressInfo.formattedRemainingTime}
                    </span>
                  </>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-[#12151B] p-4 space-y-3">
      {/* Thinking-style Collapsible Generation Process Block */}
      <div className="rounded-lg border border-white/8 bg-[#0E1117] overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
          <button
            type="button"
            onClick={() => setTimelineExpanded((prev) => !prev)}
            className="flex-1 flex items-center gap-2.5 text-left min-w-0 cursor-pointer"
          >
            {message.status === 'streaming' ? (
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
            ) : message.status === 'completed' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle
                className={`w-4 h-4 shrink-0 ${
                  message.status === 'aborted' ? 'text-amber-400' : 'text-rose-400'
                }`}
              />
            )}

            <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm min-w-0">
              <span className="font-medium text-slate-100">
                {message.status === 'streaming'
                  ? progressInfo.stageLabel || 'Oluşturuluyor...'
                  : message.status === 'completed'
                    ? 'Tamamlandı'
                    : message.status === 'aborted'
                      ? 'Durduruldu'
                      : 'Bir sorun oluştu'}
              </span>

              {message.status === 'streaming' && (
                <>
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span className="font-mono tabular-nums font-medium text-blue-300">
                    %{progressInfo.percent}
                  </span>
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span className="font-mono tabular-nums text-slate-400">
                    Kalan: %{progressInfo.remainingPercent}
                  </span>
                  {progressInfo.formattedRemainingTime && (
                    <>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className="font-mono tabular-nums text-slate-200">
                        Kalan Süre: {progressInfo.formattedRemainingTime}
                      </span>
                    </>
                  )}
                </>
              )}

              {typeof liveElapsed === 'number' && (
                <>
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span className="font-mono tabular-nums text-slate-300">
                    {liveElapsed.toFixed(1)}s
                  </span>
                </>
              )}

              <>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span className="font-mono text-slate-400 truncate">{message.model}</span>
              </>

              {message.outputType && (
                <>
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span className="text-slate-400">{message.outputType}</span>
                </>
              )}

              {paramsSummary && (
                <>
                  <span aria-hidden="true" className="text-slate-600 hidden sm:inline">·</span>
                  <span className="font-mono text-slate-500 hidden sm:inline truncate">
                    {paramsSummary}
                  </span>
                </>
              )}
            </div>

            <span className="text-slate-500 shrink-0 ml-auto">
              {timelineExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </span>
          </button>

          {message.streamEvents && message.streamEvents.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setShowRawJson((prev) => !prev);
                setTimelineExpanded(true);
              }}
              title="Ham JSON Akışını Göster"
              className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono transition-colors cursor-pointer shrink-0 ${
                showRawJson
                  ? 'bg-blue-500/15 text-blue-300'
                  : 'text-slate-500 hover:text-slate-200'
              }`}
            >
              <Terminal className="w-3 h-3" />
              <span>JSON</span>
            </button>
          )}
        </div>

        {/* Expanded Thinking Steps & Parameters */}
        {timelineExpanded && (
          <div className="px-3.5 pb-3 pt-1 border-t border-white/6 space-y-2">
            {timelineSteps.length === 0 ? (
              <div className="text-xs text-slate-400 py-1">
                Sunucuya bağlanılıyor, ilk akış olayı bekleniyor...
              </div>
            ) : (
              <div className="space-y-1.5 pt-1">
                {timelineSteps.map((step) => (
                  <div
                    key={step.key}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-slate-300 font-medium shrink-0">{step.label}</span>
                      <span className="text-slate-500 truncate font-mono text-[11px]">
                        {step.detail}
                      </span>
                    </div>
                    {typeof step.elapsed === 'number' && (
                      <span className="font-mono text-[11px] tabular-nums text-slate-400 shrink-0">
                        {step.elapsed}s
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {showRawJson && message.streamEvents && (
              <pre className="mt-2 p-2.5 rounded-md bg-[#090B0F] border border-white/8 text-[11px] font-mono text-slate-300 overflow-x-auto max-h-48 overflow-y-auto leading-relaxed">
                {message.streamEvents.map((ev) => JSON.stringify(ev)).join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Multi-clip Long Video Chain Progress & Segment Strip */}
      {message.videoChain && (
        <div className="rounded-lg border border-white/10 bg-[#0E1117] p-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span className="font-medium text-slate-200">
                Uzun Video Zinciri ({message.videoChain.clips.filter((c) => c.status === 'completed').length} / ~
                {message.videoChain.estimatedTotalClips} klip)
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums text-slate-300">
              {(message.videoChain.stage === 'generating' ||
                message.videoChain.stage === 'merging' ||
                message.videoChain.stage === 'upscaling' ||
                message.videoChain.stage === 'completed') && (
                <>
                  <span className="text-blue-300 font-semibold">%{progressInfo.percent}</span>
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span className="text-slate-400">
                    Kalan: %{progressInfo.remainingPercent}
                  </span>
                  {message.videoChain.stage !== 'completed' && progressInfo.formattedRemainingTime && (
                    <>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className="text-slate-200">
                        Kalan Süre: {progressInfo.formattedRemainingTime}
                      </span>
                    </>
                  )}
                  <span aria-hidden="true" className="text-slate-600">·</span>
                </>
              )}
              <span>
                {message.videoChain.accumulatedDurationSec.toFixed(1)}s /{' '}
                {message.videoChain.targetDurationSec}s
              </span>
            </div>
          </div>

          <div className="h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                message.videoChain.stage === 'completed'
                  ? 'bg-emerald-500'
                  : message.videoChain.stage === 'aborted'
                    ? 'bg-amber-500'
                    : message.videoChain.stage === 'error'
                      ? 'bg-rose-500'
                      : 'bg-blue-500'
              }`}
              style={{
                width: `${
                  message.videoChain.stage === 'aborted' || message.videoChain.stage === 'error'
                    ? Math.min(
                        100,
                        Math.round(
                          (message.videoChain.accumulatedDurationSec /
                            Math.max(1, message.videoChain.targetDurationSec)) *
                            100
                        )
                      )
                    : progressInfo.percent
                }%`,
              }}
            />
          </div>

          {message.videoChain.statusNote && (
            <div className="text-[11px] text-slate-400">{message.videoChain.statusNote}</div>
          )}

          {message.videoChain.clips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {message.videoChain.clips.map((clip) => (
                <button
                  key={clip.index}
                  type="button"
                  disabled={!clip.url || !onSelectPreview}
                  onClick={() => {
                    if (clip.url && onSelectPreview) onSelectPreview(clip.url);
                  }}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-mono tabular-nums transition-colors ${
                    clip.url && selectedPreviewUrl === clip.url
                      ? 'border-blue-500/50 bg-blue-500/15 text-blue-200'
                      : clip.status === 'completed'
                        ? 'border-white/10 bg-[#141821] text-slate-300 hover:border-white/25 cursor-pointer'
                        : clip.status === 'error'
                          ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                          : 'border-blue-500/30 bg-blue-500/10 text-blue-300'
                  }`}
                >
                  <span>#{clip.index}</span>
                  {clip.status === 'completed' ? (
                    <span className="text-slate-400">{clip.durationSec.toFixed(1)}s</span>
                  ) : clip.status === 'streaming' || clip.status === 'probing' ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <span>Hata</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Live Proportional Placeholder Frame while Streaming (only if no output file yet) */}
      {message.status === 'streaming' && (!message.files || message.files.length === 0) && (
        <div
          style={{ aspectRatio: previewAspectRatio }}
          className="w-full max-h-[380px] rounded-lg border border-white/8 bg-[#0D1015] flex flex-col items-center justify-center gap-3 px-6 text-xs text-slate-400"
        >
          <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
          <span className="font-medium text-slate-200">
            {progressInfo.stageLabel ||
              (message.outputType === 'video'
                ? 'Video kareleri oluşturuluyor...'
                : message.outputType === '3d'
                  ? '3D model oluşturuluyor...'
                  : 'Görsel oluşturuluyor...')}
          </span>

          <div className="w-full max-w-xs space-y-1.5">
            <div className="flex items-center justify-between font-mono text-xs tabular-nums">
              <span className="text-blue-300 font-semibold">%{progressInfo.percent}</span>
              <span className="text-slate-400">Kalan: %{progressInfo.remainingPercent}</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-white/[0.08] overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${progressInfo.percent}%` }}
              />
            </div>
          </div>

          <span className="font-mono text-[11px] tabular-nums text-slate-400">
            {progressInfo.formattedRemainingTime
              ? `Kalan Süre: ${progressInfo.formattedRemainingTime} · `
              : ''}
            {paramsSummary ? `${paramsSummary} · ` : ''}
            {typeof liveElapsed === 'number' ? `${liveElapsed.toFixed(1)}s` : '0.0s'}
          </span>
        </div>
      )}

      {/* Error Message */}
      {message.errorMessage && (
        <div className="p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
          <div className="break-words">{message.errorMessage}</div>
        </div>
      )}

      {/* Non-fatal Warning (e.g. auto-upscale fallback warning) */}
      {message.nonFatalWarning && !message.errorMessage && (
        <div className="p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <div className="break-words">{message.nonFatalWarning}</div>
        </div>
      )}

      {/* Automatically Displayed Generated Files on Completion */}
      {message.files && message.files.length > 0 && (
        <div className="space-y-4">
          {message.files.map((file) => (
            <MediaFileView
              key={file.originalUrl}
              file={file}
              messageId={message.id}
              nowMs={nowMs}
              simpleMode={false}
              isStreamingMessage={message.status === 'streaming'}
              isSelectedPreview={selectedPreviewUrl === file.originalUrl}
              onSelectPreview={onSelectPreview}
              onDeleteFile={onDeleteFile}
              onUpscaleFile={onUpscaleFile}
              onExtendVideo={onExtendVideo}
            />
          ))}
        </div>
      )}

      {/* Text / Inference Telemetry Summary from Done Event */}
      {message.textSummary && (
        <div className="pt-2 border-t border-white/8 text-xs font-mono text-slate-400 leading-relaxed break-words">
          {message.textSummary}
        </div>
      )}
    </div>
  );
};
