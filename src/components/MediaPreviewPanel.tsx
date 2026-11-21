import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Repeat,
  Download,
  Maximize2,
  X,
  Film,
  Image as ImageIcon,
  Box,
  Check,
  Copy,
  Loader2,
  HardDrive,
  Clock,
  AlertTriangle,
  Layers,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type {
  ChatMessage,
  MediaFileItem,
  UpscaleMethod,
  VideoExportFormat,
} from '../types/api';
import { exportMediaFile } from '../utils/mediaStore';
import {
  buildProxyFileUrl,
  computeGenerationProgress,
  formatBytes,
  formatDurationClock,
} from '../utils/streamParser';

export interface PreviewEntry {
  messageId: string;
  prompt: string;
  model: string;
  createdAt: number;
  file: MediaFileItem;
  isActiveStreaming?: boolean;
}

interface MediaPreviewPanelProps {
  entries: PreviewEntry[];
  simpleMode?: boolean;
  selectedUrl: string | null;
  onSelectUrl: (url: string) => void;
  onDeleteFile?: (messageId: string, file: MediaFileItem) => void;
  onUpscaleMedia?: (
    messageId: string,
    file: MediaFileItem,
    resolution: '1080p' | '1440p' | '2160p',
    method: UpscaleMethod
  ) => Promise<void>;
  activeStreamingMessage?: ChatMessage | null;
  onClosePanel?: () => void;
  isMobileOverlay?: boolean;
}

const PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const;

export const MediaPreviewPanel: React.FC<MediaPreviewPanelProps> = ({
  entries,
  simpleMode = false,
  selectedUrl,
  onSelectUrl,
  onDeleteFile,
  onUpscaleMedia,
  activeStreamingMessage,
  onClosePanel,
  isMobileOverlay = false,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const theaterVideoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isMuted, setIsMuted] = useState(true);
  const [isLooping, setIsLooping] = useState(true);
  const [playbackRateIdx, setPlaybackRateIdx] = useState(1); // 1x
  const [exportFormat, setExportFormat] = useState<VideoExportFormat>('mp4');
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoDimensions, setVideoDimensions] = useState<{ w: number; h: number } | null>(null);
  const [mediaLoadError, setMediaLoadError] = useState(false);

  const [downloading, setDownloading] = useState(false);
  const [downloadedDone, setDownloadedDone] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [upscalingTarget, setUpscalingTarget] = useState<'1080p' | '1440p' | '2160p' | null>(null);
  const [selectedUpscaleMethod, setSelectedUpscaleMethod] = useState<UpscaleMethod>('game-cas');
  const [upscaleError, setUpscaleError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [confirmDeleteActive, setConfirmDeleteActive] = useState(false);
  const [confirmDeleteListUrl, setConfirmDeleteListUrl] = useState<string | null>(null);
  const [theaterOpen, setTheaterOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const activeEntry =
    entries.find((e) => e.file.originalUrl === selectedUrl) ||
    entries[entries.length - 1] ||
    null;

  const activeFile = activeEntry?.file || null;
  const activeFileUrl = activeFile?.originalUrl || '';

  // Stable media src: prefer blobUrl if already hydrated, else proxy URL; upgrade cleanly when blobUrl arrives if needed
  const [stableSrc, setStableSrc] = useState('');

  useEffect(() => {
    setMediaLoadError(false);
    setDownloadError(null);
    setDownloadedDone(false);
    setUpscaleError(null);
    setConfirmDeleteActive(false);
    setCurrentTime(0);
    setVideoDuration(activeFile?.durationSec || 0);
    setVideoDimensions(
      activeFile?.width && activeFile?.height
        ? { w: activeFile.width, h: activeFile.height }
        : null
    );

    if (!activeFile) {
      setStableSrc('');
      return;
    }

    if (activeFile.blobUrl) {
      setStableSrc(activeFile.blobUrl);
    } else if (activeFile.status === 'expired') {
      setStableSrc('');
    } else {
      setStableSrc(buildProxyFileUrl(activeFile.originalUrl, false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileUrl]);

  // If blobUrl finishes loading after mount (or hydrates from IndexedDB / server cache), attach cleanly
  useEffect(() => {
    if (activeFile?.blobUrl) {
      setMediaLoadError(false);
      setStableSrc(activeFile.blobUrl);
    } else if (activeFile?.status === 'expired') {
      setStableSrc('');
    }
  }, [activeFile?.blobUrl, activeFile?.status]);

  // Sync playbackRate to inline & theater video elements
  useEffect(() => {
    const rate = PLAYBACK_RATES[playbackRateIdx];
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
    if (theaterVideoRef.current) {
      theaterVideoRef.current.playbackRate = rate;
    }
  }, [playbackRateIdx, stableSrc, theaterOpen]);

  // Reset export format to mp4 when switching to non-video files
  useEffect(() => {
    if (activeFile && activeFile.mediaKind !== 'video' && exportFormat !== 'mp4') {
      setExportFormat('mp4');
    }
  }, [activeFile, exportFormat]);

  const isStreamingActive = Boolean(activeStreamingMessage);

  // Tick every 200ms while streaming so live percentage updates smoothly
  useEffect(() => {
    if (!isStreamingActive) return;
    const id = setInterval(() => setNowMs(Date.now()), 200);
    return () => clearInterval(id);
  }, [isStreamingActive]);

  // Countdown tick for active TTL
  useEffect(() => {
    if (isStreamingActive) return;
    if (!activeFile || activeFile.expiresAt <= nowMs || activeFile.isMerged) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreamingActive, activeFile, nowMs]);

  const togglePlay = () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      void vid.play();
      setIsPlaying(true);
    } else {
      vid.pause();
      setIsPlaying(false);
    }
  };

  const toggleMute = () => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.muted = !vid.muted;
    setIsMuted(vid.muted);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const vid = videoRef.current;
    const nextTime = Number(e.target.value);
    setCurrentTime(nextTime);
    if (vid && Number.isFinite(nextTime)) {
      vid.currentTime = nextTime;
    }
  };

  const handleDownload = async () => {
    if (!activeFile || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    setDownloadedDone(false);
    try {
      const targetFormat: VideoExportFormat =
        activeFile.mediaKind === 'video' ? exportFormat : 'mp4';
      await exportMediaFile(activeFile, targetFormat);
      setDownloadedDone(true);
      setTimeout(() => setDownloadedDone(false), 2500);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'İndirme başarısız');
    } finally {
      setDownloading(false);
    }
  };

  const handleUpscale = async (res: '1080p' | '1440p' | '2160p') => {
    if (!activeEntry || !activeFile || !onUpscaleMedia || upscalingTarget) return;
    setUpscalingTarget(res);
    setUpscaleError(null);
    try {
      await onUpscaleMedia(activeEntry.messageId, activeFile, res, selectedUpscaleMethod);
    } catch (err) {
      setUpscaleError(err instanceof Error ? err.message : 'Yükseltme başarısız');
    } finally {
      setUpscalingTarget(null);
    }
  };

  const handleCopyUrl = async () => {
    if (!activeFile) return;
    try {
      const textToCopy = activeFile.originalUrl.startsWith('/')
        ? `${window.location.origin}${activeFile.originalUrl}`
        : activeFile.originalUrl;
      await navigator.clipboard.writeText(textToCopy);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      // Clipboard blocked
    }
  };

  const chainState = activeStreamingMessage?.videoChain;
  const streamingProgress = useMemo(
    () =>
      activeStreamingMessage ? computeGenerationProgress(activeStreamingMessage, nowMs) : null,
    [activeStreamingMessage, nowMs]
  );
  const streamingElapsedSec = activeStreamingMessage
    ? Math.max(
        activeStreamingMessage.elapsed ?? 0,
        (nowMs - activeStreamingMessage.createdAt) / 1000
      )
    : 0;
  const remainingTtl = activeFile ? Math.max(0, Math.ceil((activeFile.expiresAt - nowMs) / 1000)) : 0;
  const effectiveDuration = videoDuration || activeFile?.durationSec || 0;

  return (
    <div className="flex flex-col h-full bg-[#0F1218] text-slate-100 select-none">
      {/* Panel Header */}
      <div className="h-14 shrink-0 px-4 border-b border-white/8 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-sm font-semibold text-slate-100 whitespace-nowrap truncate">
            {simpleMode ? 'Videolarım ve İndirme' : 'Önizleme ve İndirme Alanı'}
          </h2>
          <p className="text-[11px] text-slate-500 whitespace-nowrap truncate tabular-nums">
            {entries.length > 0
              ? `${entries.length} ${simpleMode ? 'kayıt hazır' : 'çıktı hazır'}`
              : 'Üretilen video ve medya dosyaları'}
          </p>
        </div>

        {onClosePanel && (
          <button
            type="button"
            onClick={onClosePanel}
            aria-label="Önizleme alanını kapat"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Live Progress Banner for Single Generation, Merge & Upscale */}
        {activeStreamingMessage && streamingProgress && (
          <div
            className={`p-3.5 rounded-xl border space-y-2.5 ${
              simpleMode
                ? 'border-white/12 bg-[#14171F]'
                : 'border-blue-500/25 bg-blue-500/10'
            }`}
          >
            <div className="flex items-center justify-between gap-2 text-xs">
              <div
                className={`flex items-center gap-2 font-medium min-w-0 ${
                  simpleMode ? 'text-slate-100' : 'text-blue-200'
                }`}
              >
                <Loader2
                  className={`w-3.5 h-3.5 animate-spin shrink-0 ${
                    simpleMode ? 'text-[#D4FF2A]' : 'text-blue-400'
                  }`}
                />
                <span className="truncate">
                  {streamingProgress.stageLabel ||
                    (chainState
                      ? chainState.stage === 'upscaling'
                        ? 'Çözünürlük yükseltiliyor...'
                        : chainState.stage === 'merging'
                          ? 'Klipler birleştiriliyor...'
                          : `Klip ${chainState.currentClipIndex} / ~${chainState.estimatedTotalClips} üretiliyor`
                      : activeStreamingMessage.outputType === '3d'
                        ? '3D model oluşturuluyor...'
                        : activeStreamingMessage.outputType === 'image'
                          ? 'Görsel oluşturuluyor...'
                          : 'Video üretiliyor...')}
                </span>
              </div>
              <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums shrink-0">
                <span className={simpleMode ? 'text-[#D4FF2A] font-semibold' : 'text-blue-200 font-semibold'}>
                  %{streamingProgress.percent}
                </span>
                <span aria-hidden="true" className="text-slate-500">·</span>
                <span className="text-slate-300">Kalan: %{streamingProgress.remainingPercent}</span>
              </div>
            </div>

            <div className="h-1.5 w-full rounded-full bg-black/40 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  simpleMode ? 'bg-[#D4FF2A]' : 'bg-blue-500'
                }`}
                style={{ width: `${streamingProgress.percent}%` }}
              />
            </div>

            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-300">
              <span className="truncate">
                {chainState?.statusNote ||
                  activeStreamingMessage.pipelineLabel ||
                  (simpleMode ? 'İşlem devam ediyor' : `${activeStreamingMessage.model} işleniyor`)}
              </span>
              <span className="font-mono tabular-nums text-slate-300 shrink-0">
                {streamingProgress.formattedRemainingTime
                  ? `Kalan Süre: ${streamingProgress.formattedRemainingTime} · `
                  : ''}
                {chainState
                  ? `${chainState.accumulatedDurationSec.toFixed(1)}s / ${chainState.targetDurationSec}s`
                  : `${streamingElapsedSec.toFixed(1)}s`}
              </span>
            </div>
          </div>
        )}

        {/* Active Stage */}
        {activeFile ? (
          <div className="space-y-3.5">
            {/* Media Viewport */}
            {mediaLoadError || (activeFile.status === 'expired' && !stableSrc) ? (
              <div className="p-5 rounded-xl border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200 flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
                <div className="space-y-1">
                  <div className="font-medium">Önizleme dosyasına erişilemedi</div>
                  <div className="text-amber-200/80">
                    {activeFile.errorText || 'Dosya süresi dolmuş olabilir.'}
                  </div>
                </div>
              </div>
            ) : activeFile.mediaKind === 'video' && stableSrc ? (
              <div className="rounded-xl border border-white/10 bg-black overflow-hidden">
                <div className="relative bg-black flex items-center justify-center">
                  <video
                    ref={videoRef}
                    src={stableSrc}
                    autoPlay
                    loop={isLooping}
                    muted={isMuted}
                    playsInline
                    onClick={togglePlay}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    onLoadedMetadata={(e) => {
                      const vid = e.currentTarget;
                      if (Number.isFinite(vid.duration) && vid.duration > 0) {
                        setVideoDuration(vid.duration);
                      }
                      if (vid.videoWidth > 0 && vid.videoHeight > 0) {
                        setVideoDimensions({ w: vid.videoWidth, h: vid.videoHeight });
                      }
                      vid.playbackRate = PLAYBACK_RATES[playbackRateIdx];
                    }}
                    onError={() => setMediaLoadError(true)}
                    className="w-full max-h-[340px] object-contain cursor-pointer block"
                  />

                  <button
                    type="button"
                    onClick={() => setTheaterOpen(true)}
                    aria-label="Tam ekran önizleme"
                    title="Geniş Önizleme"
                    className="absolute top-2.5 right-2.5 p-1.5 rounded-lg bg-black/70 text-slate-200 hover:bg-black/90 hover:text-white transition-colors cursor-pointer"
                  >
                    <Maximize2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Dedicated Video Scrubber & Transport Controls */}
                <div className="px-3 py-2.5 bg-[#12161E] border-t border-white/8 space-y-2">
                  <div className="flex items-center gap-2.5">
                    <span className="font-mono text-[11px] tabular-nums text-slate-300 w-10">
                      {formatDurationClock(currentTime)}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={effectiveDuration > 0 ? effectiveDuration : 1}
                      step={0.05}
                      value={Math.min(currentTime, effectiveDuration || 1)}
                      onChange={handleSeek}
                      aria-label="Video zaman çubuğu"
                      className="flex-1 h-1.5 accent-blue-500 cursor-pointer bg-slate-700 rounded-lg"
                    />
                    <span className="font-mono text-[11px] tabular-nums text-slate-400 w-10 text-right">
                      {formatDurationClock(effectiveDuration)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={togglePlay}
                        aria-label={isPlaying ? 'Duraklat' : 'Oynat'}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-xs text-slate-100 transition-colors cursor-pointer whitespace-nowrap"
                      >
                        {isPlaying ? (
                          <>
                            <Pause className="w-3.5 h-3.5" />
                            <span>Duraklat</span>
                          </>
                        ) : (
                          <>
                            <Play className="w-3.5 h-3.5" />
                            <span>Oynat</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={toggleMute}
                        aria-label={isMuted ? 'Sesi aç' : 'Sessize al'}
                        title={isMuted ? 'Sesi aç' : 'Sessize al'}
                        className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
                      >
                        {isMuted ? (
                          <VolumeX className="w-3.5 h-3.5" />
                        ) : (
                          <Volume2 className="w-3.5 h-3.5 text-blue-400" />
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => setIsLooping((prev) => !prev)}
                        title="Döngüde oynat"
                        className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                          isLooping
                            ? 'text-blue-400 bg-blue-500/15'
                            : 'text-slate-400 hover:text-white hover:bg-white/[0.06]'
                        }`}
                      >
                        <Repeat className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Explicit Playback Speed Segmented Control (0.5x, 1x, 1.5x, 2x) */}
                    <div
                      role="group"
                      aria-label="Oynatma hızı"
                      className="inline-flex items-center rounded-md border border-white/10 bg-[#0D1016] p-0.5 gap-0.5"
                    >
                      <span className="text-[10px] text-slate-500 px-1.5 hidden sm:inline">
                        Hız
                      </span>
                      {PLAYBACK_RATES.map((rate, idx) => {
                        const active = playbackRateIdx === idx;
                        return (
                          <button
                            key={rate}
                            type="button"
                            onClick={() => setPlaybackRateIdx(idx)}
                            className={`px-1.5 py-0.5 rounded font-mono text-[11px] tabular-nums transition-colors cursor-pointer whitespace-nowrap ${
                              active
                                ? simpleMode
                                  ? 'bg-[#D4FF2A] text-[#08090C] font-semibold'
                                  : 'bg-blue-600 text-white font-semibold'
                                : 'text-slate-400 hover:text-white'
                            }`}
                          >
                            {rate}x
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            ) : activeFile.mediaKind === 'image' && stableSrc ? (
              <div className="relative group rounded-xl overflow-hidden border border-white/10 bg-[#0B0D10]">
                <img
                  src={stableSrc}
                  alt={activeFile.filename}
                  referrerPolicy="no-referrer"
                  onClick={() => setTheaterOpen(true)}
                  onError={() => setMediaLoadError(true)}
                  className="w-full max-h-[340px] object-contain mx-auto block cursor-zoom-in"
                />
                <button
                  type="button"
                  onClick={() => setTheaterOpen(true)}
                  aria-label="Görseli büyüt"
                  className="absolute top-2.5 right-2.5 p-1.5 rounded-lg bg-black/70 text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <Maximize2 className="w-4 h-4" />
                </button>
              </div>
            ) : activeFile.mediaKind === '3d' ? (
              <div className="p-5 rounded-xl border border-white/10 bg-[#131720] flex items-center gap-3">
                <div className="w-11 h-11 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center shrink-0">
                  <Box className="w-5 h-5 text-amber-400" />
                </div>
                <div className="min-w-0">
                  <div className="font-mono text-sm text-slate-100 truncate">
                    {activeFile.filename}
                  </div>
                  <div className="text-xs text-slate-400">
                    3D Mesh Çıktısı {activeFile.sizeBytes ? `· ${formatBytes(activeFile.sizeBytes)}` : ''}
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-48 rounded-xl border border-white/8 bg-[#12161E] flex flex-col items-center justify-center gap-2 text-xs text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
                <span>Önizleme hazırlanıyor...</span>
              </div>
            )}

            {/* Primary Download, Multi-Format Export & Copy Action Row */}
            <div className="space-y-2">
              {activeFile.mediaKind === 'video' && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-white/8 bg-[#12161E]">
                  <span className="text-xs font-medium text-slate-400 whitespace-nowrap">
                    Dışa Aktarma Formatı:
                  </span>
                  <div
                    role="group"
                    aria-label="Video dışa aktarma formatı"
                    className="inline-flex items-center p-0.5 rounded-lg bg-[#0B0D11] border border-white/10 gap-0.5"
                  >
                    {(
                      [
                        { id: 'mp4', label: 'MP4' },
                        { id: 'webm', label: 'WebM' },
                        { id: 'gif', label: 'GIF' },
                      ] as const
                    ).map((fmt) => (
                      <button
                        key={fmt.id}
                        type="button"
                        disabled={downloading}
                        onClick={() => setExportFormat(fmt.id)}
                        className={`px-2.5 py-1 rounded-md font-mono text-xs transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap ${
                          exportFormat === fmt.id
                            ? simpleMode
                              ? 'bg-[#D4FF2A] text-[#08090C] font-semibold'
                              : 'bg-blue-600 text-white font-semibold'
                            : 'text-slate-300 hover:text-white'
                        }`}
                      >
                        {fmt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={handleDownload}
                disabled={downloading || mediaLoadError || (activeFile.status === 'expired' && !stableSrc)}
                className={`w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl disabled:bg-slate-800 disabled:text-slate-500 text-sm font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed whitespace-nowrap ${
                  simpleMode
                    ? 'bg-[#D4FF2A] hover:bg-[#e1ff66] text-[#08090C]'
                    : 'bg-blue-600 hover:bg-blue-500 text-white'
                }`}
              >
                {downloading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>
                      {activeFile.mediaKind === 'video' && exportFormat !== 'mp4'
                        ? `${exportFormat.toUpperCase()} dönüştürülüyor...`
                        : 'İndiriliyor...'}
                    </span>
                  </>
                ) : downloadedDone ? (
                  <>
                    <Check className="w-4 h-4" />
                    <span>İndirildi (.{activeFile.mediaKind === 'video' ? exportFormat : 'dosya'})</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    <span>
                      {activeFile.mediaKind === 'video'
                        ? exportFormat === 'mp4'
                          ? activeFile.isMerged
                            ? 'Birleştirilmiş Videoyu İndir (.mp4)'
                            : 'Videoyu İndir (.mp4)'
                          : `${exportFormat.toUpperCase()} Olarak İndir (.${exportFormat})`
                        : activeFile.mediaKind === '3d'
                          ? '3D Modeli İndir'
                          : 'Görseli İndir'}
                    </span>
                  </>
                )}
              </button>

              {downloadError && (
                <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
                  {downloadError}
                </div>
              )}

              <div className={`grid gap-2 ${simpleMode && onDeleteFile ? 'grid-cols-2' : !simpleMode ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {!simpleMode && (
                  <button
                    type="button"
                    onClick={handleCopyUrl}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-white/10 bg-[#151922] hover:border-white/20 text-xs text-slate-300 hover:text-white transition-colors cursor-pointer whitespace-nowrap"
                  >
                    {copiedUrl ? (
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

                <button
                  type="button"
                  onClick={() => setTheaterOpen(true)}
                  disabled={!stableSrc || mediaLoadError}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-white/10 bg-[#151922] hover:border-white/20 disabled:opacity-40 text-xs text-slate-300 hover:text-white transition-colors cursor-pointer disabled:cursor-not-allowed whitespace-nowrap"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                  <span>{simpleMode ? 'Büyük İzle' : 'Geniş Önizleme'}</span>
                </button>

                {simpleMode && onDeleteFile && activeEntry && (
                  confirmDeleteActive ? (
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDeleteActive(false);
                          onDeleteFile(activeEntry.messageId, activeFile);
                        }}
                        className="px-2 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-medium text-white transition-colors cursor-pointer whitespace-nowrap"
                      >
                        Evet, Sil
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteActive(false)}
                        className="px-2 py-2 rounded-lg border border-white/15 bg-[#151922] text-xs text-slate-300 hover:text-white transition-colors cursor-pointer whitespace-nowrap"
                      >
                        İptal
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteActive(true)}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-xs font-medium text-rose-300 hover:text-rose-200 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Videoyu Sil</span>
                    </button>
                  )
                )}
              </div>

              {!simpleMode && onDeleteFile && activeEntry && (
                <div>
                  {confirmDeleteActive ? (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDeleteActive(false);
                          onDeleteFile(activeEntry.messageId, activeFile);
                        }}
                        className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-medium text-white transition-colors cursor-pointer whitespace-nowrap"
                      >
                        Evet, Kalıcı Olarak Sil
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteActive(false)}
                        className="px-3 py-2 rounded-lg border border-white/10 bg-[#151922] text-xs text-slate-300 hover:text-white transition-colors cursor-pointer whitespace-nowrap"
                      >
                        Vazgeç
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteActive(true)}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-rose-500/25 bg-rose-500/10 hover:bg-rose-500/20 text-xs font-medium text-rose-300 hover:text-rose-200 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Bu Çıktıyı Sil</span>
                    </button>
                  )}
                </div>
              )}

              {/* On-demand Game-Dev 1K / 2K (2000px+) / 4K Upscaling & Detail Synthesis for Video & Image */}
              {(activeFile.mediaKind === 'video' || activeFile.mediaKind === 'image') &&
                onUpscaleMedia &&
                !mediaLoadError && (
                  <div className="pt-2 border-t border-white/8 space-y-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="inline-flex items-center gap-1.5 text-slate-300 font-medium">
                        <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                        <span>
                          {simpleMode ? 'Görüntüyü Netleştir' : 'Oyun Motoru Çözünürlük Yükseltme'}
                        </span>
                      </span>
                      {activeFile.upscaleLabel && (
                        <span className="font-mono text-[11px] text-emerald-400">
                          {activeFile.upscaleLabel}
                          {!simpleMode &&
                            (activeFile.upscaleMethod === 'retro-xbr' ? ' · xBR4x' : ' · CAS')}
                        </span>
                      )}
                    </div>

                    {/* Technique Selector (Advanced mode only) */}
                    {!simpleMode && (
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          disabled={Boolean(upscalingTarget)}
                          onClick={() => setSelectedUpscaleMethod('game-cas')}
                          className={`px-2 py-1.5 rounded-lg border text-[11px] font-mono transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap ${
                            selectedUpscaleMethod === 'game-cas'
                              ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-200'
                              : 'border-white/8 bg-[#151922] text-slate-400 hover:text-white'
                          }`}
                        >
                          CAS + Mikro Doku
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(upscalingTarget)}
                          onClick={() => setSelectedUpscaleMethod('retro-xbr')}
                          className={`px-2 py-1.5 rounded-lg border text-[11px] font-mono transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap ${
                            selectedUpscaleMethod === 'retro-xbr'
                              ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-200'
                              : 'border-white/8 bg-[#151922] text-slate-400 hover:text-white'
                          }`}
                        >
                          Retro xBR 4x
                        </button>
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-1.5">
                      {(
                        [
                          { id: '1080p', label: simpleMode ? 'HD (1080p)' : '1080p (1K)' },
                          { id: '1440p', label: simpleMode ? 'Çok Net (2K)' : '2K (2000px+)' },
                          { id: '2160p', label: simpleMode ? 'En Net (4K)' : '4K (2160p)' },
                        ] as const
                      ).map((opt) => {
                        const isBusy = upscalingTarget === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            disabled={
                              Boolean(upscalingTarget) ||
                              (activeFile.status === 'expired' && !stableSrc)
                            }
                            onClick={() => void handleUpscale(opt.id)}
                            className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border border-white/10 bg-[#151922] hover:border-blue-500/50 hover:text-white disabled:opacity-45 text-[11px] font-mono text-slate-200 transition-colors cursor-pointer disabled:cursor-not-allowed whitespace-nowrap"
                          >
                            {isBusy ? (
                              <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
                            ) : null}
                            <span>{isBusy ? 'İşleniyor...' : opt.label}</span>
                          </button>
                        );
                      })}
                    </div>

                    {upscaleError && (
                      <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
                        {upscaleError}
                      </div>
                    )}
                  </div>
                )}
            </div>

            {/* Clean Unboxed Metadata */}
            <div className="pt-2 border-t border-white/8 space-y-1.5 text-xs">
              {!simpleMode && (
                <div className="font-mono text-slate-200 truncate">{activeFile.filename}</div>
              )}
              <div className="flex flex-wrap items-center gap-2 text-slate-400 tabular-nums">
                {!simpleMode && <span>{activeEntry?.model}</span>}
                {effectiveDuration > 0 && (
                  <>
                    {!simpleMode && <span aria-hidden="true">·</span>}
                    <span>{effectiveDuration.toFixed(1)} sn</span>
                  </>
                )}
                {videoDimensions && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      {videoDimensions.w}×{videoDimensions.h}
                    </span>
                  </>
                )}
                {activeFile.sizeBytes ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{formatBytes(activeFile.sizeBytes)}</span>
                  </>
                ) : null}
                {activeFile.clipCount && activeFile.clipCount > 1 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1 text-blue-300">
                      <Layers className="w-3 h-3" />
                      <span>{activeFile.clipCount} klip birleştirildi</span>
                    </span>
                  </>
                )}
              </div>

              {!simpleMode && (
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  {activeFile.status === 'cached' || Boolean(activeFile.blobUrl) ? (
                    <span className="inline-flex items-center gap-1 text-emerald-400">
                      <HardDrive className="w-3 h-3" />
                      <span>Kalıcı önbellekte korundu</span>
                    </span>
                  ) : !activeFile.isMerged ? (
                    <span className="inline-flex items-center gap-1 text-amber-300 tabular-nums">
                      <Clock className="w-3 h-3" />
                      <span>
                        {remainingTtl > 0
                          ? `Upstream TTL: ${remainingTtl}s`
                          : 'Sunucu önbelleği kontrol ediliyor'}
                      </span>
                    </span>
                  ) : null}
                </div>
              )}

              {activeEntry?.prompt && (
                <p className="text-xs text-slate-400 leading-relaxed pt-1 line-clamp-3">
                  {activeEntry.prompt.replace(/--[a-zA-Z0-9_-]+(?:\s+(?:"[^"]*"|'[^']*'|[^\s]+))?/g, '').trim() || activeEntry.prompt}
                </p>
              )}
            </div>
          </div>
        ) : (
          /* Empty State */
          <div className="py-12 px-4 rounded-xl border border-dashed border-white/10 bg-[#12151C] text-center space-y-2.5">
            <div className="w-10 h-10 rounded-lg bg-white/[0.04] border border-white/8 flex items-center justify-center mx-auto text-slate-400">
              <Film className="w-5 h-5" />
            </div>
            <div className="text-sm font-medium text-slate-200">
              Henüz video veya resim yok
            </div>
            <p className="text-xs text-slate-400 leading-relaxed max-w-xs mx-auto">
              Bir video veya resim oluşturduğunuzda buradan izleyebilir, indirebilir ve
              istediğiniz zaman silebilirsiniz.
            </p>
          </div>
        )}

        {/* Session Generated Outputs Switcher */}
        {entries.length > 0 && (
          <div className="pt-3 border-t border-white/8 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-300">
                {simpleMode ? 'Oluşturulanlar' : 'Bu Oturumdaki Çıktılar'}
              </span>
              <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                {entries.length}
              </span>
            </div>

            <div className="space-y-1.5">
              {[...entries].reverse().map((entry, idx) => {
                const isSelected = entry.file.originalUrl === activeFile?.originalUrl;
                const cleanPrompt = entry.prompt
                  .replace(/--[a-zA-Z0-9_-]+(?:\s+(?:"[^"]*"|'[^']*'|[^\s]+))?/g, '')
                  .trim();
                const isConfirming = confirmDeleteListUrl === entry.file.originalUrl;

                return (
                  <div
                    key={`${entry.messageId}-${entry.file.originalUrl}`}
                    className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border transition-colors ${
                      isSelected
                        ? 'border-blue-500/45 bg-blue-500/12 text-slate-100'
                        : 'border-white/8 bg-[#12161E] text-slate-300 hover:border-white/18'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectUrl(entry.file.originalUrl)}
                      className="flex-1 flex items-center gap-2.5 min-w-0 text-left cursor-pointer"
                    >
                      {entry.file.mediaKind === 'video' ? (
                        <Film
                          className={`w-3.5 h-3.5 shrink-0 ${
                            entry.file.isMerged ? 'text-blue-400' : 'text-slate-400'
                          }`}
                        />
                      ) : entry.file.mediaKind === '3d' ? (
                        <Box className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                      ) : (
                        <ImageIcon className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
                      )}
                      <div className="min-w-0">
                        <div className={`text-xs truncate ${simpleMode ? 'font-medium' : 'font-mono'}`}>
                          {simpleMode
                            ? cleanPrompt || `Kayıt #${entries.length - idx}`
                            : entry.file.isMerged
                              ? `Birleştirilmiş (${entry.file.clipCount || 1} klip)`
                              : entry.file.filename}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate tabular-nums">
                          {entry.file.durationSec ? `${entry.file.durationSec.toFixed(1)}s · ` : ''}
                          {entry.file.upscaleLabel ? `${entry.file.upscaleLabel} · ` : ''}
                          {entry.file.sizeBytes ? formatBytes(entry.file.sizeBytes) : entry.model}
                        </div>
                      </div>
                    </button>

                    {onDeleteFile && (
                      isConfirming ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteListUrl(null);
                              onDeleteFile(entry.messageId, entry.file);
                            }}
                            className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-[11px] font-medium text-white cursor-pointer"
                          >
                            Sil
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteListUrl(null)}
                            className="px-1.5 py-1 rounded text-[11px] text-slate-400 hover:text-white cursor-pointer"
                          >
                            İptal
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteListUrl(entry.file.originalUrl)}
                          title="Videoyu / Dosyayı Sil"
                          aria-label="Sil"
                          className="p-1.5 rounded-md text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Expanded Theater Preview Modal */}
      {theaterOpen && activeFile && stableSrc && (
        <div
          className="fixed inset-0 z-50 bg-black/92 flex flex-col items-center justify-center p-4 sm:p-8"
          onClick={() => setTheaterOpen(false)}
        >
          <div
            className="w-full max-w-5xl flex items-center justify-between gap-4 pb-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="min-w-0 text-xs text-slate-300 flex items-center gap-2 truncate">
              <span className="font-mono text-slate-100 truncate">{activeFile.filename}</span>
              {effectiveDuration > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{effectiveDuration.toFixed(1)} sn</span>
                </>
              )}
              {activeFile.sizeBytes ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{formatBytes(activeFile.sizeBytes)}</span>
                </>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {activeFile.mediaKind === 'video' && (
                <>
                  <div
                    role="group"
                    aria-label="Tam ekran oynatma hızı"
                    className="inline-flex items-center p-0.5 rounded-lg border border-white/15 bg-[#12161E] gap-0.5"
                  >
                    {PLAYBACK_RATES.map((rate, idx) => (
                      <button
                        key={rate}
                        type="button"
                        onClick={() => setPlaybackRateIdx(idx)}
                        className={`px-2 py-1 rounded font-mono text-xs tabular-nums transition-colors cursor-pointer ${
                          playbackRateIdx === idx
                            ? 'bg-blue-600 text-white font-semibold'
                            : 'text-slate-300 hover:text-white'
                        }`}
                      >
                        {rate}x
                      </button>
                    ))}
                  </div>

                  <div
                    role="group"
                    aria-label="Tam ekran dışa aktarma formatı"
                    className="inline-flex items-center p-0.5 rounded-lg border border-white/15 bg-[#12161E] gap-0.5"
                  >
                    {(['mp4', 'webm', 'gif'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        disabled={downloading}
                        onClick={() => setExportFormat(fmt)}
                        className={`px-2 py-1 rounded font-mono text-xs uppercase transition-colors cursor-pointer ${
                          exportFormat === fmt
                            ? 'bg-white text-[#08090C] font-semibold'
                            : 'text-slate-300 hover:text-white'
                        }`}
                      >
                        {fmt}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <button
                type="button"
                onClick={handleDownload}
                disabled={downloading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-medium text-white transition-colors cursor-pointer whitespace-nowrap"
              >
                {downloading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span>
                  {downloading
                    ? 'Hazırlanıyor...'
                    : `İndir (.${activeFile.mediaKind === 'video' ? exportFormat : 'dosya'})`}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setTheaterOpen(false)}
                aria-label="Tam ekran önizlemeyi kapat"
                className="p-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div
            className="w-full max-w-5xl flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            {activeFile.mediaKind === 'video' ? (
              <video
                ref={theaterVideoRef}
                src={stableSrc}
                controls
                autoPlay
                loop={isLooping}
                playsInline
                onLoadedMetadata={(e) => {
                  e.currentTarget.playbackRate = PLAYBACK_RATES[playbackRateIdx];
                }}
                className="max-w-full max-h-[82vh] rounded-lg border border-white/10 bg-black"
              />
            ) : (
              <img
                src={stableSrc}
                alt={activeFile.filename}
                referrerPolicy="no-referrer"
                className="max-w-full max-h-[82vh] object-contain rounded-lg"
              />
            )}
          </div>
        </div>
      )}

      {isMobileOverlay && <div className="sr-only">Mobil önizleme paneli</div>}
    </div>
  );
};
