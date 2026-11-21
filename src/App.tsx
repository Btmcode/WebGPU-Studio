import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Menu,
  Trash2,
  BookOpen,
  X,
  ArrowUpRight,
  Sparkles,
  PanelRight,
  Film,
  Image as ImageIcon,
  Box,
  SlidersHorizontal,
} from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { PromptComposer } from './components/PromptComposer';
import { MediaResultCard } from './components/MediaResultCard';
import { MediaPreviewPanel, type PreviewEntry } from './components/MediaPreviewPanel';
import {
  FLAG_DEFINITIONS,
  getModelProfile,
  parsePromptFlags,
  upsertFlagInPrompt,
} from './data/flags';
import type {
  ApiModel,
  ChatMessage,
  ChatSession,
  GenerationSpeedMode,
  MediaFileItem,
  UpscaleMethod,
  UpscaleResolution,
  VideoChainClipInfo,
  VideoChainState,
  WebGpuStreamEvent,
} from './types/api';
import {
  deleteMediaBlobs,
  loadMediaBlob,
  saveMediaBlob,
} from './utils/mediaStore';
import {
  ConcatenatedJsonStreamParser,
  buildProxyFileUrl,
  extractFilename,
  extractProgressPercentFromEvent,
  extractWebGpuFileUrls,
  inferMediaKind,
  normalizeUpstreamMediaUrl,
} from './utils/streamParser';

import starterNatureCat from './assets/images/starter_nature_cat_1795273398972.jpg';
import starterOceanSunset from './assets/images/starter_ocean_sunset_1795273399472.jpg';
import starterAlpineCabin from './assets/images/starter_alpine_cabin_1795273399454.jpg';

const STORAGE_KEY = 'webgpu_studio_sessions_v1';
const SIMPLE_MODE_STORAGE_KEY = 'webgpu_studio_simple_mode_v1';

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createEmptySession(model = 'minimax-h3'): ChatSession {
  return {
    id: createId(),
    title: 'Yeni Sohbet',
    model,
    updatedAt: Date.now(),
    messages: [],
  };
}

function loadStoredSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [createEmptySession()];
    const parsed = JSON.parse(raw) as ChatSession[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [createEmptySession()];
    }
    // Clean up ephemeral blob URLs & legacy TTL flags; hydrateBlobs() recovers from IndexedDB or server cache
    return parsed.map((session) => ({
      ...session,
      messages: (session.messages || []).map((msg) => ({
        ...msg,
        status: msg.status === 'streaming' ? 'aborted' : msg.status,
        files: (msg.files || []).map((f) => ({
          ...f,
          blobUrl: undefined,
          status: f.status === 'expired' ? 'fetching' : f.status,
          errorText:
            f.errorText && f.errorText.includes('TTL') ? undefined : f.errorText,
        })),
      })),
    }));
  } catch {
    return [createEmptySession()];
  }
}

interface SingleRunResult {
  urls: string[];
  outputType?: string;
  params?: Record<string, string | number | boolean>;
  elapsed?: number;
  textSummary?: string;
}

class HttpStatusError extends Error {
  public statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function runNdjsonPost<T>(
  url: string,
  init: RequestInit,
  onProgress?: (percent: number, message?: string) => void
): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let errMessage = `Sunucu hatası (HTTP ${res.status})`;
    try {
      const errBody = (await res.json()) as { error?: { message?: string }; message?: string };
      if (errBody?.error?.message) errMessage = errBody.error.message;
      else if (errBody?.message) errMessage = errBody.message;
    } catch {
      // Fallback to HTTP status message
    }
    throw new HttpStatusError(errMessage, res.status);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json') && !contentType.includes('ndjson')) {
    return (await res.json()) as T;
  }

  if (!res.body) {
    return (await res.json()) as T;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalData: T | null = null;

  const processLine = (rawLine: string) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    const ev = typeof parsed.event === 'string' ? parsed.event : '';
    if (ev === 'progress') {
      const pct = typeof parsed.percent === 'number' ? parsed.percent : 0;
      const msg = typeof parsed.message === 'string' ? parsed.message : undefined;
      onProgress?.(pct, msg);
    } else if (ev === 'done') {
      finalData = parsed.data as T;
    } else if (ev === 'error') {
      const msg = typeof parsed.message === 'string' ? parsed.message : 'İşlem başarısız oldu';
      const status = typeof parsed.status === 'number' ? parsed.status : 500;
      throw new HttpStatusError(msg, status);
    } else if (finalData === null && !ev) {
      // Direct JSON object fallback
      finalData = parsed as unknown as T;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      processLine(line);
    }
  }

  if (buffer.trim()) {
    processLine(buffer);
  }

  if (finalData === null) {
    throw new Error('Sunucudan işlem sonucu alınamadı');
  }
  return finalData;
}

export default function App() {
  const [models, setModels] = useState<ApiModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<ChatSession[]>(() => loadStoredSessions());
  const [activeSessionId, setActiveSessionId] = useState<string>('');

  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) {
      setActiveSessionId(sessions[0].id);
    }
  }, [activeSessionId, sessions]);

  const [simpleMode, setSimpleMode] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(SIMPLE_MODE_STORAGE_KEY);
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const [simpleAspectRatio, setSimpleAspectRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [speedMode, setSpeedMode] = useState<GenerationSpeedMode>('fast');
  const [promptInput, setPromptInput] = useState('');
  const [attachedImageUrl, setAttachedImageUrl] = useState('');
  const [targetDurationSec, setTargetDurationSec] = useState<number>(0);
  const [continuityEnabled, setContinuityEnabled] = useState<boolean>(true);
  const [upscaleResolution, setUpscaleResolution] = useState<UpscaleResolution>('original');
  const [upscaleMethod, setUpscaleMethod] = useState<UpscaleMethod>('game-cas');
  const [isStreaming, setIsStreaming] = useState(false);
  const [sidebarOpenMobile, setSidebarOpenMobile] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  // Dedicated Preview & Download Area state
  const [previewPanelDesktopOpen, setPreviewPanelDesktopOpen] = useState(
    () => !(() => {
      try {
        const saved = localStorage.getItem(SIMPLE_MODE_STORAGE_KEY);
        return saved === null ? true : saved === 'true';
      } catch {
        return true;
      }
    })()
  );
  const [previewPanelMobileOpen, setPreviewPanelMobileOpen] = useState(false);
  const [selectedPreviewUrl, setSelectedPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SIMPLE_MODE_STORAGE_KEY, String(simpleMode));
    } catch {
      // Ignore storage error
    }
  }, [simpleMode]);

  const abortControllerRef = useRef<AbortController | null>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const blobUrlsRef = useRef<string[]>([]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || sessions[0],
    [sessions, activeSessionId]
  );

  const activeSessionIdRef = useRef<string>('');
  activeSessionIdRef.current = activeSession?.id || '';

  const activeModelId = activeSession?.model || 'minimax-h3';
  const modelProfile = useMemo(() => getModelProfile(activeModelId), [activeModelId]);

  // Hydrate persisted media blobs from IndexedDB or persistent server disk cache on mount
  useEffect(() => {
    let cancelled = false;
    async function hydrateBlobs() {
      const urlsToHydrate = new Set<string>();
      for (const s of sessions) {
        for (const m of s.messages) {
          for (const f of m.files || []) {
            if (!f.blobUrl) {
              urlsToHydrate.add(f.originalUrl);
            }
          }
        }
      }
      if (urlsToHydrate.size === 0) return;

      const hydratedMap = new Map<
        string,
        { blobUrl: string; mimeType: string; sizeBytes: number }
      >();
      const missingSet = new Set<string>();

      await Promise.all(
        Array.from(urlsToHydrate).map(async (url) => {
          const stored = await loadMediaBlob(url);
          if (stored) {
            if (!cancelled) {
              const blobUrl = URL.createObjectURL(stored.blob);
              blobUrlsRef.current.push(blobUrl);
              hydratedMap.set(url, {
                blobUrl,
                mimeType: stored.mimeType,
                sizeBytes: stored.sizeBytes,
              });
            }
            return;
          }

          // Fallback: pull from persistent server cache (.webgpu-cache) and save into IndexedDB
          try {
            const res = await fetch(buildProxyFileUrl(url, false));
            if (res.ok) {
              const blob = await res.blob();
              if (blob.size > 0 && !cancelled) {
                void saveMediaBlob(url, blob);
                const blobUrl = URL.createObjectURL(blob);
                blobUrlsRef.current.push(blobUrl);
                hydratedMap.set(url, {
                  blobUrl,
                  mimeType: blob.type,
                  sizeBytes: blob.size,
                });
                return;
              }
            }
          } catch {
            // Network/server error
          }

          missingSet.add(url);
        })
      );

      if ((hydratedMap.size === 0 && missingSet.size === 0) || cancelled) return;

      setSessions((prev) =>
        prev.map((session) => ({
          ...session,
          messages: session.messages.map((msg) => ({
            ...msg,
            files: (msg.files || []).map((f) => {
              const hit = hydratedMap.get(f.originalUrl);
              if (hit) {
                return {
                  ...f,
                  blobUrl: hit.blobUrl,
                  mimeType: hit.mimeType || f.mimeType,
                  sizeBytes: hit.sizeBytes || f.sizeBytes,
                  status: 'cached',
                  errorText: undefined,
                };
              }
              if (missingSet.has(f.originalUrl)) {
                return {
                  ...f,
                  status: 'expired',
                  errorText:
                    'Dosya yerel önbellekte bulunamadı. "Tekrar Yap" ile yeniden oluşturabilirsiniz.',
                };
              }
              return f;
            }),
          })),
        }))
      );
    }

    void hydrateBlobs();
    return () => {
      cancelled = true;
    };
    // Run once on initial mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist sessions (excluding ephemeral blobUrls)
  useEffect(() => {
    try {
      const serializable = sessions.map((s) => ({
        ...s,
        messages: s.messages.map((m) => ({
          ...m,
          files: m.files?.map(({ blobUrl: _ignored, ...rest }) => rest),
        })),
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable.slice(0, 20)));
    } catch {
      // Ignore storage quota errors
    }
  }, [sessions]);

  // Revoke object URLs on unmount
  useEffect(() => {
    return () => {
      for (const url of blobUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  const fetchModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const res = await fetch('/api/v1/models');
      if (!res.ok) {
        throw new Error(`Modeller alınamadı (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { data?: ApiModel[] };
      const list = Array.isArray(data.data) ? data.data : [];
      setModels(list);
      if (list.length > 0) {
        const currentSid = activeSessionIdRef.current;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === currentSid && !list.some((m) => m.id === s.model)
              ? { ...s, model: list[0].id }
              : s
          )
        );
      }
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : 'Model listesi alınamadı');
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  // Build list of all generated preview entries in the active session
  const previewEntries = useMemo<PreviewEntry[]>(() => {
    if (!activeSession) return [];
    const items: PreviewEntry[] = [];
    for (let i = 0; i < activeSession.messages.length; i++) {
      const msg = activeSession.messages[i];
      if (msg.role !== 'assistant' || !msg.files || msg.files.length === 0) continue;
      // Find preceding user message prompt
      let promptText = '';
      for (let j = i - 1; j >= 0; j--) {
        if (activeSession.messages[j].role === 'user') {
          promptText = activeSession.messages[j].content;
          break;
        }
      }
      for (const file of msg.files) {
        items.push({
          messageId: msg.id,
          prompt: promptText,
          model: msg.model,
          createdAt: msg.createdAt,
          file,
          isActiveStreaming: msg.status === 'streaming',
        });
      }
    }
    return items;
  }, [activeSession]);

  const activeStreamingMessage = useMemo(
    () =>
      activeSession?.messages.find(
        (m) => m.role === 'assistant' && m.status === 'streaming'
      ) || null,
    [activeSession]
  );

  // Ensure selectedPreviewUrl points to a valid entry in the active session
  useEffect(() => {
    if (previewEntries.length === 0) {
      setSelectedPreviewUrl(null);
      return;
    }
    if (!selectedPreviewUrl || !previewEntries.some((e) => e.file.originalUrl === selectedPreviewUrl)) {
      setSelectedPreviewUrl(previewEntries[previewEntries.length - 1].file.originalUrl);
    }
  }, [previewEntries, selectedPreviewUrl]);

  // Scroll to bottom when messages arrive or finish
  const lastMsg = activeSession?.messages[activeSession.messages.length - 1];
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [activeSession?.messages.length, lastMsg?.status, lastMsg?.files?.length]);

  const updateMessageInSession = useCallback(
    (sessionId: string, messageId: string, updater: (msg: ChatMessage) => ChatMessage) => {
      setSessions((prev) =>
        prev.map((session) => {
          if (session.id !== sessionId) return session;
          return {
            ...session,
            updatedAt: Date.now(),
            messages: session.messages.map((m) => (m.id === messageId ? updater(m) : m)),
          };
        })
      );
    },
    []
  );

  const cacheMediaFileLocally = useCallback(
    async (
      sessionId: string,
      messageId: string,
      originalUrl: string,
      extraMeta?: { durationSec?: number; width?: number; height?: number }
    ): Promise<Blob | null> => {
      try {
        const proxyUrl = buildProxyFileUrl(originalUrl, false);
        const res = await fetch(proxyUrl);
        if (!res.ok) {
          throw new Error(`Dosya alınamadı (HTTP ${res.status})`);
        }
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        blobUrlsRef.current.push(blobUrl);

        // Save persistently in IndexedDB so previews & downloads survive page refresh
        void saveMediaBlob(originalUrl, blob);

        updateMessageInSession(sessionId, messageId, (msg) => ({
          ...msg,
          files: (msg.files || []).map((f) =>
            f.originalUrl === originalUrl
              ? {
                  ...f,
                  blobUrl,
                  mimeType: blob.type,
                  sizeBytes: blob.size,
                  durationSec: extraMeta?.durationSec ?? f.durationSec,
                  width: extraMeta?.width ?? f.width,
                  height: extraMeta?.height ?? f.height,
                  status: 'cached',
                }
              : f
          ),
        }));

        return blob;
      } catch (err) {
        const errorText = err instanceof Error ? err.message : 'Önbelleğe alınamadı';
        updateMessageInSession(sessionId, messageId, (msg) => ({
          ...msg,
          files: (msg.files || []).map((f) =>
            f.originalUrl === originalUrl
              ? { ...f, status: 'error', errorText }
              : f
          ),
        }));
        return null;
      }
    },
    [updateMessageInSession]
  );

  const handleSelectModel = (modelId: string) => {
    if (!activeSession || isStreaming) return;
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSession.id ? { ...s, model: modelId } : s))
    );
  };

  const handleNewSession = () => {
    if (isStreaming) return;
    const fresh = createEmptySession(activeModelId);
    setSessions((prev) => [fresh, ...prev]);
    setActiveSessionId(fresh.id);
    setPromptInput('');
    setAttachedImageUrl('');
  };

  const cleanupSessionFiles = (messages: ChatMessage[]) => {
    const urls: string[] = [];
    for (const m of messages) {
      for (const f of m.files || []) {
        urls.push(f.originalUrl);
        if (f.blobUrl) {
          URL.revokeObjectURL(f.blobUrl);
        }
        if (
          f.originalUrl.startsWith('/api/video/merged/') ||
          f.originalUrl.startsWith('/api/media/cached/')
        ) {
          void fetch(f.originalUrl, { method: 'DELETE' }).catch(() => {});
        }
      }
    }
    if (urls.length > 0) {
      void deleteMediaBlobs(urls);
    }
  };

  const handleDeleteSession = (sessionId: string) => {
    if (isStreaming && sessionId === activeSessionId) {
      abortControllerRef.current?.abort();
    }
    const target = sessions.find((s) => s.id === sessionId);
    if (target) {
      cleanupSessionFiles(target.messages);
    }

    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== sessionId);
      if (remaining.length === 0) {
        const fallback = createEmptySession(activeModelId);
        setActiveSessionId(fallback.id);
        return [fallback];
      }
      if (sessionId === activeSessionId) {
        setActiveSessionId(remaining[0].id);
      }
      return remaining;
    });
  };

  const handleClearCurrentSession = () => {
    if (!activeSession || isStreaming) return;
    cleanupSessionFiles(activeSession.messages);
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSession.id
          ? { ...s, title: 'Yeni Sohbet', messages: [], updatedAt: Date.now() }
          : s
      )
    );
  };

  const handleDeleteMediaFile = useCallback(
    (messageId: string, file: MediaFileItem) => {
      if (file.blobUrl) {
        URL.revokeObjectURL(file.blobUrl);
      }
      void deleteMediaBlobs([file.originalUrl]);
      if (
        file.originalUrl.startsWith('/api/video/merged/') ||
        file.originalUrl.startsWith('/api/media/cached/')
      ) {
        void fetch(file.originalUrl, { method: 'DELETE' }).catch(() => {});
      }

      const targetSid = activeSessionIdRef.current;
      setSessions((prev) =>
        prev.map((session) => {
          if (session.id !== targetSid) return session;
          const nextMessages: ChatMessage[] = [];
          for (let i = 0; i < session.messages.length; i++) {
            const msg = session.messages[i];
            if (msg.id !== messageId) {
              nextMessages.push(msg);
              continue;
            }
            const remainingFiles = (msg.files || []).filter(
              (f) => f.originalUrl !== file.originalUrl
            );
            if (remainingFiles.length === 0 && !msg.errorMessage && msg.status !== 'streaming') {
              if (nextMessages.length > 0 && nextMessages[nextMessages.length - 1].role === 'user') {
                nextMessages.pop();
              }
              continue;
            }
            nextMessages.push({ ...msg, files: remainingFiles });
          }
          return {
            ...session,
            updatedAt: Date.now(),
            messages: nextMessages,
          };
        })
      );
    },
    []
  );

  const handleSelectPreview = useCallback((url: string) => {
    setSelectedPreviewUrl(url);
    setPreviewPanelDesktopOpen(true);
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setPreviewPanelMobileOpen(true);
    }
  }, []);

  /**
   * Executes one streaming generation request against /api/v1/chat/completions
   * and invokes callbacks for telemetry/discovered files.
   */
  const runSingleGeneration = useCallback(
    async (opts: {
      prompt: string;
      model: string;
      imageUrl?: string;
      signal: AbortSignal;
      onEvent?: (ev: WebGpuStreamEvent) => void;
      onMeta?: (meta: {
        outputType?: string;
        params?: Record<string, string | number | boolean>;
        elapsed?: number;
        progressPct?: number;
        textSummary?: string;
      }) => void;
      onDiscoverUrls?: (urls: string[], reportedType?: string) => void;
    }): Promise<SingleRunResult> => {
      const messageContent = opts.imageUrl
        ? [
            { type: 'text', text: opts.prompt },
            { type: 'image_url', image_url: { url: opts.imageUrl } },
          ]
        : opts.prompt;

      const payload = {
        model: opts.model,
        messages: [{ role: 'user', content: messageContent }],
        stream: true,
      };

      const res = await fetch('/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: opts.signal,
      });

      if (!res.ok) {
        let errMessage = `HTTP ${res.status}`;
        try {
          const errBody = (await res.json()) as { error?: { message?: string } };
          if (errBody?.error?.message) errMessage = errBody.error.message;
        } catch {
          // Fallback to status code
        }
        throw new Error(errMessage);
      }

      if (!res.body) {
        throw new Error('Sunucudan akış gövdesi alınamadı');
      }

      const outerParser = new ConcatenatedJsonStreamParser();
      const innerParser = new ConcatenatedJsonStreamParser();
      const discoveredSet = new Set<string>();
      const orderedUrls: string[] = [];
      let rawStreamText = '';
      let outputType: string | undefined;
      let params: Record<string, string | number | boolean> | undefined;
      let elapsed: number | undefined;
      let textSummary = '';
      let streamError: string | null = null;

      const registerUrls = (urls: string[], reportedType?: string) => {
        const fresh = urls.filter((u) => {
          if (discoveredSet.has(u)) return false;
          discoveredSet.add(u);
          orderedUrls.push(u);
          return true;
        });
        if (fresh.length > 0 && opts.onDiscoverUrls) {
          opts.onDiscoverUrls(fresh, reportedType);
        }
      };

      const processDomainEvent = (ev: WebGpuStreamEvent) => {
        const obj = ev as Record<string, unknown>;
        opts.onEvent?.(ev);

        if (obj.error && typeof obj.error === 'object') {
          const errObj = obj.error as { message?: string };
          streamError = errObj.message || 'API hatası';
          return;
        }

        const eventType = typeof obj.event === 'string' ? obj.event : '';
        const reportedType = typeof obj.type === 'string' ? obj.type : undefined;
        if (reportedType) outputType = reportedType;

        const serializedUrls = extractWebGpuFileUrls(JSON.stringify(ev));

        if (eventType === 'start') {
          if (obj.params && typeof obj.params === 'object') {
            params = obj.params as Record<string, string | number | boolean>;
          }
          opts.onMeta?.({ outputType, params });
          if (serializedUrls.length > 0) {
            registerUrls(serializedUrls, reportedType);
          }
        } else if (eventType === 'progress') {
          if (typeof obj.elapsed === 'number') elapsed = obj.elapsed;
          const pct = extractProgressPercentFromEvent(obj);
          opts.onMeta?.({ elapsed, progressPct: pct });
          if (serializedUrls.length > 0) {
            registerUrls(serializedUrls, reportedType);
          }
        } else if (eventType === 'done') {
          if (typeof obj.elapsed === 'number') elapsed = obj.elapsed;
          if (typeof obj.text === 'string') textSummary = obj.text;

          const explicitFiles = Array.isArray(obj.files)
            ? obj.files
                .filter((u): u is string => typeof u === 'string')
                .map((u) => normalizeUpstreamMediaUrl(u))
                .filter((u): u is string => u !== null)
            : [];

          const allUrls = Array.from(new Set([...explicitFiles, ...serializedUrls]));
          if (allUrls.length > 0) {
            registerUrls(allUrls, reportedType);
          }
          opts.onMeta?.({ outputType, params, elapsed, textSummary });
        } else if (eventType === 'error') {
          streamError =
            typeof obj.message === 'string' ? obj.message : 'Üretim sırasında hata oluştu';
        } else if (serializedUrls.length > 0) {
          registerUrls(serializedUrls, reportedType);
        }
      };

      const processOuterEvents = (events: WebGpuStreamEvent[]) => {
        for (const ev of events) {
          const obj = ev as Record<string, unknown>;
          if (Array.isArray(obj.choices)) {
            const first = obj.choices[0] as
              | {
                  delta?: { content?: string; role?: string };
                  message?: { content?: string };
                  finish_reason?: string | null;
                }
              | undefined;
            const deltaText = first?.delta?.content ?? first?.message?.content ?? '';

            if (deltaText) {
              const directUrls = extractWebGpuFileUrls(deltaText);
              if (directUrls.length > 0) {
                registerUrls(directUrls);
              }

              const innerResult = innerParser.push(deltaText);
              for (const innerEv of innerResult.events) {
                processDomainEvent(innerEv);
              }

              const cleanProse = innerResult.plainText
                .replace(/https?:\/\/webgpu\.hrmn\.tr\/files\/[a-zA-Z0-9._-]+/gi, '')
                .trim();
              if (cleanProse) {
                textSummary = textSummary ? `${textSummary} ${cleanProse}` : cleanProse;
                opts.onMeta?.({ textSummary });
              }
            }

            if (first?.finish_reason === 'stop' || first?.message) {
              const flushedInner = innerParser.flush();
              for (const innerEv of flushedInner.events) {
                processDomainEvent(innerEv);
              }
            }
          } else {
            processDomainEvent(ev);
          }
        }
      };

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkStr = decoder.decode(value, { stream: true });
        rawStreamText += chunkStr;

        const rawUrls = extractWebGpuFileUrls(rawStreamText);
        if (rawUrls.length > 0) {
          registerUrls(rawUrls);
        }

        const outerResult = outerParser.push(chunkStr);
        if (outerResult.events.length > 0) {
          processOuterEvents(outerResult.events);
        }
      }

      const outerFlushed = outerParser.flush();
      if (outerFlushed.events.length > 0) {
        processOuterEvents(outerFlushed.events);
      }
      const innerFlushed = innerParser.flush();
      for (const innerEv of innerFlushed.events) {
        processDomainEvent(innerEv);
      }

      const finalRawUrls = extractWebGpuFileUrls(rawStreamText);
      if (finalRawUrls.length > 0) {
        registerUrls(finalRawUrls);
      }

      if (streamError) {
        throw new Error(streamError);
      }

      return {
        urls: orderedUrls,
        outputType,
        params,
        elapsed,
        textSummary: textSummary || undefined,
      };
    },
    []
  );

  const mergeAndAttachVideo = useCallback(
    async (opts: {
      sessionId: string;
      messageId: string;
      clipUrls: string[];
      continuityEnabled?: boolean;
      trimToSeconds?: number;
      signal: AbortSignal;
      attachToMessage?: boolean;
      onMergeProgress?: (percent: number, message?: string) => void;
    }): Promise<MediaFileItem> => {
      const data = await runNdjsonPost<{
        mergedUrl: string;
        filename: string;
        durationSec: number;
        width?: number;
        height?: number;
        sizeBytes: number;
      }>(
        '/api/video/merge',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            urls: opts.clipUrls,
            continuityEnabled: opts.continuityEnabled !== false,
            trimToSeconds: opts.trimToSeconds,
            outputName: `webgpu_${opts.clipUrls.length}clips`,
            streamProgress: true,
          }),
          signal: opts.signal,
        },
        opts.onMergeProgress
      );

      // Cache merged MP4 blob in browser RAM & IndexedDB for instant playback and reload persistence
      const fileRes = await fetch(data.mergedUrl, { signal: opts.signal });
      let blobUrl: string | undefined;
      if (fileRes.ok) {
        const blob = await fileRes.blob();
        blobUrl = URL.createObjectURL(blob);
        blobUrlsRef.current.push(blobUrl);
        void saveMediaBlob(data.mergedUrl, blob);
      }

      const mergedItem: MediaFileItem = {
        originalUrl: data.mergedUrl,
        filename: data.filename,
        mediaKind: 'video',
        blobUrl,
        mimeType: 'video/mp4',
        sizeBytes: data.sizeBytes,
        durationSec: data.durationSec,
        width: data.width,
        height: data.height,
        isMerged: true,
        clipCount: opts.clipUrls.length,
        status: blobUrl ? 'cached' : 'fetching',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
      };

      if (opts.attachToMessage !== false) {
        updateMessageInSession(opts.sessionId, opts.messageId, (msg) => ({
          ...msg,
          files: [mergedItem],
        }));

        setSelectedPreviewUrl(mergedItem.originalUrl);
        if (!simpleMode) {
          setPreviewPanelDesktopOpen(true);
        }
      }

      return mergedItem;
    },
    [simpleMode, updateMessageInSession]
  );

  const upscaleMediaFile = useCallback(
    async (
      sessionId: string,
      messageId: string,
      sourceFile: MediaFileItem,
      targetRes: '1080p' | '1440p' | '2160p',
      method: UpscaleMethod = 'game-cas',
      opts?: {
        signal?: AbortSignal;
        replaceMessageFiles?: boolean;
        onProgress?: (percent: number, message?: string) => void;
      }
    ): Promise<MediaFileItem> => {
      const isImage = sourceFile.mediaKind === 'image';
      const endpoint = isImage ? '/api/image/upscale' : '/api/video/upscale';
      const blobEndpoint = isImage ? '/api/image/upscale-blob' : '/api/video/upscale-blob';

      type UpscalePayload = {
        upscaledUrl: string;
        filename: string;
        durationSec?: number;
        width?: number;
        height?: number;
        sizeBytes: number;
        resolutionLabel: string;
        method?: UpscaleMethod;
      };

      const fetchBlobFallback = async (): Promise<Blob | null> => {
        if (sourceFile.blobUrl) {
          try {
            const bRes = await fetch(sourceFile.blobUrl, { signal: opts?.signal });
            if (bRes.ok) return await bRes.blob();
          } catch {
            // Try IndexedDB below
          }
        }
        const stored = await loadMediaBlob(sourceFile.originalUrl);
        return stored ? stored.blob : null;
      };

      let data: UpscalePayload;
      if (isImage) {
        opts?.onProgress?.(35, 'Görsel yüksek netliğe yükseltiliyor...');
        let upscaleRes = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: sourceFile.originalUrl,
            resolution: targetRes,
            method,
            outputName: sourceFile.filename,
          }),
          signal: opts?.signal,
        });

        if (
          !upscaleRes.ok &&
          (upscaleRes.status === 404 || upscaleRes.status === 410 || upscaleRes.status === 502)
        ) {
          const fallbackBlob = await fetchBlobFallback();
          if (fallbackBlob) {
            const qs = new URLSearchParams({
              resolution: targetRes,
              method,
              filename: sourceFile.filename,
            });
            upscaleRes = await fetch(`${blobEndpoint}?${qs.toString()}`, {
              method: 'POST',
              headers: {
                'Content-Type': fallbackBlob.type || 'image/png',
              },
              body: fallbackBlob,
              signal: opts?.signal,
            });
          }
        }

        if (!upscaleRes.ok) {
          let msg = `Görsel yükseltilemedi (HTTP ${upscaleRes.status})`;
          try {
            const err = (await upscaleRes.json()) as { error?: { message?: string } };
            if (err?.error?.message) msg = err.error.message;
          } catch {
            // Ignore parse error
          }
          throw new Error(msg);
        }

        data = (await upscaleRes.json()) as UpscalePayload;
        opts?.onProgress?.(100, `${data.resolutionLabel} netlik hazır`);
      } else {
        try {
          data = await runNdjsonPost<UpscalePayload>(
            endpoint,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: sourceFile.originalUrl,
                resolution: targetRes,
                method,
                outputName: sourceFile.filename,
                streamProgress: true,
              }),
              signal: opts?.signal,
            },
            opts?.onProgress
          );
        } catch (err) {
          const status = err instanceof HttpStatusError ? err.statusCode : 0;
          if (status === 404 || status === 410 || status === 502) {
            const fallbackBlob = await fetchBlobFallback();
            if (!fallbackBlob) throw err;
            const qs = new URLSearchParams({
              resolution: targetRes,
              method,
              filename: sourceFile.filename,
              streamProgress: '1',
            });
            data = await runNdjsonPost<UpscalePayload>(
              `${blobEndpoint}?${qs.toString()}`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': fallbackBlob.type || 'video/mp4',
                },
                body: fallbackBlob,
                signal: opts?.signal,
              },
              opts?.onProgress
            );
          } else {
            throw err;
          }
        }
      }

      const fileRes = await fetch(data.upscaledUrl, { signal: opts?.signal });
      let blobUrl: string | undefined;
      if (fileRes.ok) {
        const blob = await fileRes.blob();
        blobUrl = URL.createObjectURL(blob);
        blobUrlsRef.current.push(blobUrl);
        void saveMediaBlob(data.upscaledUrl, blob);
      }

      const upscaledItem: MediaFileItem = {
        originalUrl: data.upscaledUrl,
        filename: data.filename,
        mediaKind: isImage ? 'image' : 'video',
        blobUrl,
        mimeType: isImage ? 'image/png' : 'video/mp4',
        sizeBytes: data.sizeBytes,
        durationSec: isImage ? undefined : data.durationSec || sourceFile.durationSec,
        width: data.width,
        height: data.height,
        isMerged: sourceFile.isMerged,
        clipCount: sourceFile.clipCount,
        upscaleLabel: data.resolutionLabel,
        upscaleMethod: data.method || method,
        status: blobUrl ? 'cached' : 'fetching',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
      };

      if (opts?.replaceMessageFiles) {
        if (sourceFile.blobUrl) {
          URL.revokeObjectURL(sourceFile.blobUrl);
        }
        void deleteMediaBlobs([sourceFile.originalUrl]);
        if (
          sourceFile.originalUrl.startsWith('/api/video/merged/') ||
          sourceFile.originalUrl.startsWith('/api/media/cached/')
        ) {
          void fetch(sourceFile.originalUrl, { method: 'DELETE' }).catch(() => {});
        }
      }

      updateMessageInSession(sessionId, messageId, (msg) => ({
        ...msg,
        files: opts?.replaceMessageFiles
          ? [upscaledItem]
          : [...(msg.files || []), upscaledItem],
      }));

      setSelectedPreviewUrl(upscaledItem.originalUrl);
      if (!simpleMode) {
        setPreviewPanelDesktopOpen(true);
      }
      return upscaledItem;
    },
    [simpleMode, updateMessageInSession]
  );

  const sendPrompt = useCallback(
    async (overridePrompt?: string) => {
      const rawInput = (overridePrompt ?? promptInput).trim();
      if (!rawInput || isStreaming || !activeSession) return;

      const targetSessionId = activeSession.id;
      const targetModel = activeSession.model;
      const profile = getModelProfile(targetModel);
      const imageUrl = attachedImageUrl.trim();
      const isLongVideoChain = profile.category === 'video' && targetDurationSec > 0;
      const effectiveUpscaleMethod: UpscaleMethod = simpleMode ? 'game-cas' : upscaleMethod;
      const wantsUpscale =
        upscaleResolution !== 'original' &&
        (profile.category === 'video' || profile.category === 'image');
      const upscaleTag =
        upscaleResolution === '1080p' ? '1080p' : upscaleResolution === '1440p' ? '2K' : '4K';

      let textToSend = rawInput;
      const existingFlags = parsePromptFlags(rawInput);
      if (simpleMode && (profile.category === 'video' || profile.category === 'image')) {
        if (!existingFlags.some((t) => t.canonicalFlag === '--ar')) {
          textToSend = upsertFlagInPrompt(textToSend, '--ar', simpleAspectRatio).trim();
        }
      }
      if (profile.category === 'video') {
        const hasModeFlag = existingFlags.some((t) => t.canonicalFlag === '--mode');
        const hasStepsFlag = existingFlags.some((t) => t.canonicalFlag === '--steps');
        const defaultSteps = speedMode === 'fast' ? '4' : speedMode === 'balanced' ? '8' : '16';
        if (!hasModeFlag) {
          textToSend = upsertFlagInPrompt(textToSend, '--mode', speedMode).trim();
        }
        if (!hasStepsFlag) {
          textToSend = upsertFlagInPrompt(textToSend, '--steps', defaultSteps).trim();
        }
      }

      if (!overridePrompt) {
        setPromptInput('');
        setAttachedImageUrl('');
      }

      const userMsg: ChatMessage = {
        id: createId(),
        role: 'user',
        content: textToSend,
        attachedImageUrl: imageUrl || undefined,
        model: targetModel,
        createdAt: Date.now(),
      };

      const initialSpeedSteps = speedMode === 'fast' ? 4 : speedMode === 'balanced' ? 8 : 16;
      const assistantMsgId = createId();
      const initialChainState: VideoChainState | undefined = isLongVideoChain
        ? {
            targetDurationSec,
            clipFrames: 124,
            continuityEnabled,
            upscaleResolution: wantsUpscale ? upscaleResolution : 'original',
            accumulatedDurationSec: 0,
            currentClipIndex: 1,
            estimatedTotalClips: Math.max(1, Math.ceil(targetDurationSec / 5)),
            clipWallSeconds: [],
            stage: 'generating',
            statusNote: 'İlk 5 saniyelik klip üretiliyor...',
            clips: [],
          }
        : undefined;

      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        model: targetModel,
        createdAt: Date.now(),
        status: 'streaming',
        pipelineStage: 'generating',
        pipelineLabel: isLongVideoChain
          ? 'İlk video parçası üretiliyor...'
          : profile.category === 'image'
            ? 'Görsel oluşturuluyor...'
            : profile.category === '3d'
              ? '3D model oluşturuluyor...'
              : 'Video oluşturuluyor...',
        upscaleTarget: wantsUpscale ? upscaleResolution : undefined,
        params:
          profile.category === 'video'
            ? { mode: speedMode, steps: initialSpeedSteps }
            : undefined,
        outputType: isLongVideoChain
          ? 'video'
          : profile.category !== 'text'
            ? profile.category
            : undefined,
        streamEvents: [],
        files: [],
        videoChain: initialChainState,
      };

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== targetSessionId) return s;
          const isFirst = s.messages.length === 0;
          const cleanTitle = textToSend.replace(/--[a-zA-Z0-9_-]+(?:\s+[^\s]+)?/g, '').trim();
          return {
            ...s,
            title: isFirst ? (cleanTitle || textToSend).slice(0, 42) : s.title,
            updatedAt: Date.now(),
            messages: [...s.messages, userMsg, assistantMsg],
          };
        })
      );

      setIsStreaming(true);
      if (!simpleMode) {
        setPreviewPanelDesktopOpen(true);
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Single generation path (normal clip, image, or 3D) with integrated upscaling phase
      if (!isLongVideoChain) {
        const discoveredUrls = new Set<string>();

        try {
          const result = await runSingleGeneration({
            prompt: textToSend,
            model: targetModel,
            imageUrl: imageUrl || undefined,
            signal: controller.signal,
            onEvent: (ev) => {
              updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                ...msg,
                streamEvents: [...(msg.streamEvents || []), ev],
              }));
            },
            onMeta: (meta) => {
              updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                ...msg,
                outputType: meta.outputType || msg.outputType,
                params: meta.params || msg.params,
                elapsed: meta.elapsed ?? msg.elapsed,
                progressPct:
                  typeof meta.progressPct === 'number'
                    ? Math.max(msg.progressPct ?? 0, meta.progressPct)
                    : msg.progressPct,
                textSummary: meta.textSummary ?? msg.textSummary,
              }));
            },
            onDiscoverUrls: (freshUrls, reportedType) => {
              const unique = freshUrls.filter((u) => {
                if (discoveredUrls.has(u)) return false;
                discoveredSetAdd(discoveredUrls, u);
                return true;
              });
              if (unique.length === 0) return;

              if (wantsUpscale) {
                // Defer exposing raw low-res output until integrated upscale completes,
                // while immediately pulling into /api/file disk cache before 60s TTL.
                for (const url of unique) {
                  void fetch(buildProxyFileUrl(url, false), { signal: controller.signal }).catch(
                    () => {}
                  );
                }
                updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                  ...msg,
                  progressPct: Math.max(msg.progressPct ?? 0, 99),
                  pipelineLabel: `Üretim tamamlandı, ${upscaleTag} netliğe hazırlanıyor...`,
                }));
                return;
              }

              const now = Date.now();
              const newItems: MediaFileItem[] = unique.map((url) => ({
                originalUrl: url,
                filename: extractFilename(url),
                mediaKind: inferMediaKind(url, reportedType),
                status: 'fetching',
                createdAt: now,
                expiresAt: now + 60_000,
              }));

              updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                ...msg,
                files: [...(msg.files || []), ...newItems],
              }));

              setSelectedPreviewUrl(newItems[0].originalUrl);

              for (const item of newItems) {
                void cacheMediaFileLocally(targetSessionId, assistantMsgId, item.originalUrl);
              }
            },
          });

          for (const url of result.urls) {
            const mediaKind = inferMediaKind(url, result.outputType);
            let probedMeta: { durationSec?: number; width?: number; height?: number; sizeBytes?: number } = {};

            if (mediaKind === 'video') {
              try {
                const probeRes = await fetch('/api/video/probe', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ url, extractLastFrame: false }),
                  signal: controller.signal,
                });
                if (probeRes.ok) {
                  probedMeta = (await probeRes.json()) as {
                    durationSec?: number;
                    width?: number;
                    height?: number;
                    sizeBytes?: number;
                  };
                  if (!wantsUpscale) {
                    updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                      ...msg,
                      files: (msg.files || []).map((f) =>
                        f.originalUrl === url
                          ? {
                              ...f,
                              durationSec: probedMeta.durationSec || f.durationSec,
                              width: probedMeta.width || f.width,
                              height: probedMeta.height || f.height,
                              sizeBytes: probedMeta.sizeBytes || f.sizeBytes,
                            }
                          : f
                      ),
                    }));
                  }
                }
              } catch {
                // Probe best-effort
              }
            }

            if (
              wantsUpscale &&
              (mediaKind === 'video' || mediaKind === 'image') &&
              !controller.signal.aborted
            ) {
              // Ensure cached on server + browser before upscaling
              let baseBlobUrl: string | undefined;
              let baseSizeBytes = probedMeta.sizeBytes;
              try {
                const cacheRes = await fetch(buildProxyFileUrl(url, false), {
                  signal: controller.signal,
                });
                if (cacheRes.ok) {
                  const rawBlob = await cacheRes.blob();
                  baseSizeBytes = rawBlob.size;
                  baseBlobUrl = URL.createObjectURL(rawBlob);
                  blobUrlsRef.current.push(baseBlobUrl);
                  void saveMediaBlob(url, rawBlob);
                }
              } catch {
                // Best effort
              }

              const baseItem: MediaFileItem = {
                originalUrl: url,
                filename: extractFilename(url),
                mediaKind,
                blobUrl: baseBlobUrl,
                sizeBytes: baseSizeBytes,
                durationSec: probedMeta.durationSec,
                width: probedMeta.width,
                height: probedMeta.height,
                status: baseBlobUrl ? 'cached' : 'fetching',
                createdAt: Date.now(),
                expiresAt: Date.now() + 60_000,
              };

              updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                ...msg,
                pipelineStage: 'upscaling',
                upscaleStartedAt: Date.now(),
                upscaleProgressPct: 2,
                pipelineLabel: `${upscaleTag} netliğe yükseltiliyor...`,
              }));

              try {
                await upscaleMediaFile(
                  targetSessionId,
                  assistantMsgId,
                  baseItem,
                  upscaleResolution,
                  effectiveUpscaleMethod,
                  {
                    signal: controller.signal,
                    replaceMessageFiles: true,
                    onProgress: (pct, lbl) => {
                      updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                        ...msg,
                        upscaleProgressPct: pct,
                        pipelineLabel: lbl || `${upscaleTag} netliğe yükseltiliyor (%${pct})...`,
                      }));
                    },
                  }
                );
              } catch (upErr) {
                if (controller.signal.aborted) throw upErr;
                const warnMsg =
                  upErr instanceof Error
                    ? upErr.message
                    : 'Otomatik çözünürlük yükseltme başarısız';
                // Attach raw file so user never loses generated media
                updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                  ...msg,
                  files: [...(msg.files || []), baseItem],
                  nonFatalWarning: `Otomatik yükseltme tamamlanamadı: ${warnMsg}`,
                }));
                setSelectedPreviewUrl(baseItem.originalUrl);
              }
            }
          }

          updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
            ...msg,
            pipelineStage: 'completed',
            progressPct: 100,
            upscaleProgressPct: wantsUpscale ? 100 : msg.upscaleProgressPct,
            pipelineLabel: 'Tamamlandı',
            status: 'completed',
          }));
        } catch (err) {
          if (controller.signal.aborted) {
            updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
              ...msg,
              pipelineStage: 'aborted',
              status: 'aborted',
            }));
          } else {
            const errorMessage = err instanceof Error ? err.message : 'Bilinmeyen bağlantı hatası';
            updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
              ...msg,
              pipelineStage: 'error',
              status: 'error',
              errorMessage,
            }));
          }
        } finally {
          setIsStreaming(false);
          abortControllerRef.current = null;
        }
        return;
      }

      // Long-form video chaining loop: keep generating ~5s clips and stitching them together until targetDurationSec
      const completedClipUrls: string[] = [];
      let accumulatedSec = 0;
      let clipIndex = 0;
      let nextFrameDataUrl: string | undefined = imageUrl || undefined;
      const parsedFlags = parsePromptFlags(textToSend);
      const userSeedToken = parsedFlags.find((t) => t.canonicalFlag === '--seed');
      const userBaseSeed =
        userSeedToken && /^\d+$/.test(userSeedToken.value)
          ? parseInt(userSeedToken.value, 10)
          : null;
      const hasFramesFlag = parsedFlags.some((t) => t.canonicalFlag === '--frames');
      const baseChainPrompt = hasFramesFlag
        ? textToSend
        : upsertFlagInPrompt(textToSend, '--frames', '124').trim();

      const updateChain = (updater: (chain: VideoChainState) => VideoChainState) => {
        updateMessageInSession(targetSessionId, assistantMsgId, (msg) => {
          if (!msg.videoChain) return msg;
          return {
            ...msg,
            videoChain: updater(msg.videoChain),
          };
        });
      };

      try {
        while (accumulatedSec < targetDurationSec && !controller.signal.aborted) {
          clipIndex += 1;
          const remainingSec = Math.max(0, targetDurationSec - accumulatedSec);
          const avgClip = clipIndex > 1 ? accumulatedSec / (clipIndex - 1) : 5.0;
          const estimatedTotal = Math.max(
            clipIndex,
            (clipIndex - 1) + Math.ceil(remainingSec / Math.max(2, avgClip))
          );

          const clipPrompt =
            userBaseSeed !== null && clipIndex > 1
              ? upsertFlagInPrompt(baseChainPrompt, '--seed', String(userBaseSeed + clipIndex - 1)).trim()
              : baseChainPrompt;

          const clipPlaceholder: VideoChainClipInfo = {
            index: clipIndex,
            durationSec: 0,
            status: 'streaming',
          };

          const clipWallStartMs = Date.now();
          updateChain((chain) => ({
            ...chain,
            currentClipIndex: clipIndex,
            estimatedTotalClips: estimatedTotal,
            currentClipStartedAt: clipWallStartMs,
            currentClipProgressPct: undefined,
            stage: 'generating',
            statusNote: `Klip ${clipIndex} / ~${estimatedTotal} üretiliyor (${accumulatedSec.toFixed(
              1
            )}s / ${targetDurationSec}s)...`,
            clips: [...chain.clips, clipPlaceholder],
          }));

          let clipResult: SingleRunResult;
          try {
            clipResult = await runSingleGeneration({
              prompt: clipPrompt,
              model: targetModel,
              imageUrl: nextFrameDataUrl,
              signal: controller.signal,
              onEvent: (ev) => {
                updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                  ...msg,
                  streamEvents: [...(msg.streamEvents || []).slice(-40), ev],
                }));
              },
              onMeta: (meta) => {
                updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                  ...msg,
                  outputType: meta.outputType || msg.outputType,
                  params: meta.params || msg.params,
                  videoChain: msg.videoChain
                    ? {
                        ...msg.videoChain,
                        currentClipProgressPct:
                          typeof meta.progressPct === 'number'
                            ? Math.max(msg.videoChain.currentClipProgressPct ?? 0, meta.progressPct)
                            : msg.videoChain.currentClipProgressPct,
                      }
                    : msg.videoChain,
                }));
              },
            });
          } catch (clipErr) {
            if (controller.signal.aborted) throw clipErr;

            // If a continuity image frame caused the API error on clip > 1, automatically retry with text prompt only
            if (nextFrameDataUrl && clipIndex > 1 && nextFrameDataUrl.startsWith('data:')) {
              nextFrameDataUrl = undefined;
              updateChain((chain) => ({
                ...chain,
                currentClipStartedAt: Date.now(),
                currentClipProgressPct: undefined,
                statusNote: `Klip ${clipIndex} görsel süreklilik olmadan yeniden deneniyor...`,
              }));
              clipResult = await runSingleGeneration({
                prompt: clipPrompt,
                model: targetModel,
                signal: controller.signal,
                onMeta: (meta) => {
                  updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                    ...msg,
                    outputType: meta.outputType || msg.outputType,
                    params: meta.params || msg.params,
                    videoChain: msg.videoChain
                      ? {
                          ...msg.videoChain,
                          currentClipProgressPct:
                            typeof meta.progressPct === 'number'
                              ? Math.max(msg.videoChain.currentClipProgressPct ?? 0, meta.progressPct)
                              : msg.videoChain.currentClipProgressPct,
                        }
                      : msg.videoChain,
                  }));
                },
              });
            } else {
              throw clipErr;
            }
          }

          const clipUrl = clipResult.urls[0];
          if (!clipUrl) {
            throw new Error(`Klip ${clipIndex} için video URL alınamadı`);
          }

          updateChain((chain) => ({
            ...chain,
            currentClipProgressPct: 98,
            statusNote: `Klip ${clipIndex} analiz ediliyor ve önbelleğe alınıyor...`,
            clips: chain.clips.map((c) =>
              c.index === clipIndex ? { ...c, url: clipUrl, status: 'probing' } : c
            ),
          }));

          // Probe exact duration + populate .webgpu-cache/segments directly (no duplicate pre-probe /api/file fetch)
          let clipDuration = 5.0;
          try {
            const probeRes = await fetch('/api/video/probe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: clipUrl,
                extractLastFrame: continuityEnabled,
              }),
              signal: controller.signal,
            });
            if (probeRes.ok) {
              const probeData = (await probeRes.json()) as {
                durationSec?: number;
                lastFrameDataUrl?: string;
              };
              if (probeData.durationSec && probeData.durationSec > 0) {
                clipDuration = probeData.durationSec;
              }
              if (continuityEnabled && probeData.lastFrameDataUrl) {
                nextFrameDataUrl = probeData.lastFrameDataUrl;
              }
            }
          } catch {
            // Fallback to default 5.0s if probe fails
          }

          completedClipUrls.push(clipUrl);
          // Account for seamless xfade overlap + duplicate start-frame trim on clips after #1
          const seamOverlapSec = continuityEnabled ? 0.36 : 0.28;
          const effectiveAddedSec =
            completedClipUrls.length === 1
              ? clipDuration
              : Math.max(0.5, clipDuration - seamOverlapSec);
          accumulatedSec += effectiveAddedSec;
          const clipWallSec = Math.max(1, (Date.now() - clipWallStartMs) / 1000);

          updateChain((chain) => ({
            ...chain,
            accumulatedDurationSec: accumulatedSec,
            currentClipStartedAt: undefined,
            currentClipProgressPct: undefined,
            clipWallSeconds: [...(chain.clipWallSeconds || []), clipWallSec].slice(-12),
            clips: chain.clips.map((c) =>
              c.index === clipIndex
                ? { ...c, url: clipUrl, durationSec: clipDuration, status: 'completed' }
                : c
            ),
          }));

          // Merge at milestones (clip 2, 5, 10, 20, ...) and always when target duration is reached
          const reachedTarget = accumulatedSec >= targetDurationSec;
          const shouldMergeMilestone =
            reachedTarget ||
            completedClipUrls.length === 2 ||
            completedClipUrls.length === 5 ||
            completedClipUrls.length % 10 === 0;

          if (shouldMergeMilestone && (completedClipUrls.length >= 2 || reachedTarget)) {
            updateChain((chain) => ({
              ...chain,
              stage: 'merging',
              mergeStartedAt: reachedTarget ? Date.now() : chain.mergeStartedAt,
              mergeProgressPct: 2,
              statusNote: reachedTarget
                ? `Kesintisiz birleştirme yapılıyor (${completedClipUrls.length} klip → ${targetDurationSec} sn)...`
                : `Ara önizleme birleştiriliyor (${completedClipUrls.length} klip, ${accumulatedSec.toFixed(
                    1
                  )}s / ${targetDurationSec}s)...`,
            }));

            const mergedItem = await mergeAndAttachVideo({
              sessionId: targetSessionId,
              messageId: assistantMsgId,
              clipUrls: completedClipUrls,
              continuityEnabled,
              trimToSeconds: reachedTarget ? targetDurationSec : undefined,
              signal: controller.signal,
              attachToMessage: !wantsUpscale,
              onMergeProgress: (pct, msg) => {
                updateChain((chain) => ({
                  ...chain,
                  mergeProgressPct: pct,
                  statusNote: msg || chain.statusNote,
                }));
              },
            });

            if (reachedTarget && wantsUpscale) {
              const upStartMs = Date.now();
              updateChain((chain) => ({
                ...chain,
                stage: 'upscaling',
                mergeProgressPct: 100,
                upscaleStartedAt: upStartMs,
                upscaleProgressPct: 2,
                statusNote: `Birleştirilen video ${upscaleTag} netliğe yükseltiliyor...`,
              }));
              updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                ...msg,
                pipelineStage: 'upscaling',
                upscaleStartedAt: upStartMs,
                upscaleProgressPct: 2,
                pipelineLabel: `${upscaleTag} netliğe yükseltiliyor...`,
              }));

              try {
                await upscaleMediaFile(
                  targetSessionId,
                  assistantMsgId,
                  mergedItem,
                  upscaleResolution,
                  effectiveUpscaleMethod,
                  {
                    signal: controller.signal,
                    replaceMessageFiles: true,
                    onProgress: (pct, msg) => {
                      updateChain((chain) => ({
                        ...chain,
                        upscaleProgressPct: pct,
                        statusNote: msg || `${upscaleTag} netliğe yükseltiliyor (%${pct})...`,
                      }));
                      updateMessageInSession(targetSessionId, assistantMsgId, (m) => ({
                        ...m,
                        upscaleProgressPct: pct,
                        pipelineLabel: msg || `${upscaleTag} netliğe yükseltiliyor (%${pct})...`,
                      }));
                    },
                  }
                );
              } catch (upErr) {
                if (controller.signal.aborted) throw upErr;
                const warnMsg =
                  upErr instanceof Error
                    ? upErr.message
                    : 'Otomatik çözünürlük yükseltme başarısız';
                updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                  ...msg,
                  files: [mergedItem],
                  nonFatalWarning: `Otomatik yükseltme tamamlanamadı: ${warnMsg}`,
                }));
                setSelectedPreviewUrl(mergedItem.originalUrl);
              }
            }
          } else if (completedClipUrls.length === 1 && !wantsUpscale) {
            // Show Clip #1 right away in preview when not waiting for final upscale
            const now = Date.now();
            const firstItem: MediaFileItem = {
              originalUrl: clipUrl,
              filename: extractFilename(clipUrl),
              mediaKind: 'video',
              durationSec: clipDuration,
              status: 'fetching',
              createdAt: now,
              expiresAt: now + 60_000,
            };
            updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
              ...msg,
              files: [firstItem],
            }));
            setSelectedPreviewUrl(firstItem.originalUrl);
            void cacheMediaFileLocally(targetSessionId, assistantMsgId, clipUrl, {
              durationSec: clipDuration,
            });
          }
        }

        if (!controller.signal.aborted) {
          updateChain((chain) => ({
            ...chain,
            stage: 'completed',
            mergeProgressPct: 100,
            upscaleProgressPct: wantsUpscale ? 100 : chain.upscaleProgressPct,
            statusNote: `${completedClipUrls.length} klip kesintisiz birleştirildi${
              wantsUpscale ? ` ve ${upscaleTag} netliğe yükseltildi` : ''
            } (${Math.min(accumulatedSec, targetDurationSec).toFixed(1)} sn).`,
          }));
          updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
            ...msg,
            pipelineStage: 'completed',
            progressPct: 100,
            status: 'completed',
          }));
        }
      } catch (err) {
        if (controller.signal.aborted) {
          // If stopped mid-way after >= 2 clips, merge what we already produced using a fresh non-aborted call
          if (completedClipUrls.length >= 2) {
            try {
              const fallbackCtrl = new AbortController();
              await mergeAndAttachVideo({
                sessionId: targetSessionId,
                messageId: assistantMsgId,
                clipUrls: completedClipUrls,
                continuityEnabled,
                signal: fallbackCtrl.signal,
              });
            } catch {
              // Ignore merge error on abort
            }
          }
          updateChain((chain) => ({
            ...chain,
            stage: 'aborted',
            statusNote: `Kullanıcı tarafından durduruldu (${completedClipUrls.length} klip, ${accumulatedSec.toFixed(
              1
            )} sn üretildi).`,
          }));
          updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
            ...msg,
            pipelineStage: 'aborted',
            status: 'aborted',
          }));
        } else {
          const errorMessage = err instanceof Error ? err.message : 'Zincirleme video hatası';
          updateChain((chain) => ({
            ...chain,
            stage: 'error',
            statusNote: errorMessage,
          }));
          updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
            ...msg,
            pipelineStage: 'error',
            status: 'error',
            errorMessage,
          }));
        }
      } finally {
        setIsStreaming(false);
        abortControllerRef.current = null;
      }
    },
    [
      activeSession,
      attachedImageUrl,
      cacheMediaFileLocally,
      continuityEnabled,
      isStreaming,
      mergeAndAttachVideo,
      promptInput,
      runSingleGeneration,
      simpleAspectRatio,
      simpleMode,
      speedMode,
      targetDurationSec,
      updateMessageInSession,
      upscaleMethod,
      upscaleResolution,
      upscaleMediaFile,
    ]
  );

  const handleExtendVideo = useCallback(
    async (_sourceMessageId: string, sourceFile: MediaFileItem, addSeconds: number) => {
      if (isStreaming || !activeSession) return;

      const targetSessionId = activeSession.id;
      const targetModel = activeSession.model;
      const effectiveUpscaleMethod: UpscaleMethod = simpleMode ? 'game-cas' : upscaleMethod;
      const wantsUpscale = upscaleResolution !== 'original';
      const upscaleTag =
        upscaleResolution === '1080p' ? '1080p' : upscaleResolution === '1440p' ? '2K' : '4K';

      // Locate user's original prompt for this video
      let basePromptText = '';
      const msgIdx = activeSession.messages.findIndex((m) => m.id === _sourceMessageId);
      for (let i = msgIdx - 1; i >= 0; i--) {
        if (activeSession.messages[i].role === 'user') {
          basePromptText = activeSession.messages[i].content;
          break;
        }
      }
      if (!basePromptText) {
        basePromptText = `continuation scene --ar ${simpleAspectRatio}`;
      }

      const parsedFlags = parsePromptFlags(basePromptText);
      const hasFramesFlag = parsedFlags.some((t) => t.canonicalFlag === '--frames');
      const hasModeFlag = parsedFlags.some((t) => t.canonicalFlag === '--mode');
      const hasStepsFlag = parsedFlags.some((t) => t.canonicalFlag === '--steps');
      let baseChainPrompt = hasFramesFlag
        ? basePromptText
        : upsertFlagInPrompt(basePromptText, '--frames', '124').trim();
      const extendSpeedSteps = speedMode === 'fast' ? '4' : speedMode === 'balanced' ? '8' : '16';
      if (!hasModeFlag) {
        baseChainPrompt = upsertFlagInPrompt(baseChainPrompt, '--mode', speedMode).trim();
      }
      if (!hasStepsFlag) {
        baseChainPrompt = upsertFlagInPrompt(baseChainPrompt, '--steps', extendSpeedSteps).trim();
      }

      const addLabel =
        addSeconds >= 60 ? `+${Math.round(addSeconds / 60)} dk` : `+${addSeconds} sn`;
      const userMsg: ChatMessage = {
        id: createId(),
        role: 'user',
        content: `${basePromptText.replace(/--[a-zA-Z0-9_-]+(?:\s+(?:"[^"]*"|'[^']*'|[^\s]+))?/g, '').trim()} (${addLabel} uzatma)`,
        model: targetModel,
        createdAt: Date.now(),
      };

      const assistantMsgId = createId();
      const baseDurSec = sourceFile.durationSec || 5;
      const initialChainState: VideoChainState = {
        targetDurationSec: addSeconds,
        clipFrames: 124,
        continuityEnabled: true,
        upscaleResolution: wantsUpscale ? upscaleResolution : 'original',
        accumulatedDurationSec: 0,
        currentClipIndex: 1,
        estimatedTotalClips: Math.max(1, Math.ceil(addSeconds / 5)),
        clipWallSeconds: [],
        stage: 'generating',
        statusNote: 'Mevcut videonun son karesi alınıyor ve devam üretiliyor...',
        clips: [],
      };

      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        model: targetModel,
        createdAt: Date.now(),
        status: 'streaming',
        pipelineStage: 'generating',
        upscaleTarget: wantsUpscale ? upscaleResolution : undefined,
        params: { mode: speedMode, steps: Number(extendSpeedSteps) },
        outputType: 'video',
        streamEvents: [],
        files: [],
        videoChain: initialChainState,
      };

      setSessions((prev) =>
        prev.map((s) =>
          s.id === targetSessionId
            ? {
                ...s,
                updatedAt: Date.now(),
                messages: [...s.messages, userMsg, assistantMsg],
              }
            : s
        )
      );

      setIsStreaming(true);
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const updateChain = (updater: (chain: VideoChainState) => VideoChainState) => {
        updateMessageInSession(targetSessionId, assistantMsgId, (msg) => {
          if (!msg.videoChain) return msg;
          return { ...msg, videoChain: updater(msg.videoChain) };
        });
      };

      const newClipUrls: string[] = [];
      let accumulatedNewSec = 0;
      let clipIndex = 0;
      let nextFrameDataUrl: string | undefined;

      try {
        // Extract exact final frame from the source video for seamless continuation
        try {
          const probeRes = await fetch('/api/video/probe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: sourceFile.originalUrl, extractLastFrame: true }),
            signal: controller.signal,
          });
          if (probeRes.ok) {
            const pData = (await probeRes.json()) as { lastFrameDataUrl?: string };
            if (pData.lastFrameDataUrl) nextFrameDataUrl = pData.lastFrameDataUrl;
          }
        } catch {
          // Best-effort last frame extraction
        }

        while (accumulatedNewSec < addSeconds && !controller.signal.aborted) {
          clipIndex += 1;
          const remaining = Math.max(0, addSeconds - accumulatedNewSec);
          const avgClip = clipIndex > 1 ? accumulatedNewSec / (clipIndex - 1) : 5.0;
          const estimatedTotal = Math.max(
            clipIndex,
            clipIndex - 1 + Math.ceil(remaining / Math.max(2, avgClip))
          );

          const clipWallStartMs = Date.now();
          updateChain((chain) => ({
            ...chain,
            currentClipIndex: clipIndex,
            estimatedTotalClips: estimatedTotal,
            currentClipStartedAt: clipWallStartMs,
            currentClipProgressPct: undefined,
            stage: 'generating',
            statusNote: `Devam klibi ${clipIndex} / ~${estimatedTotal} üretiliyor...`,
            clips: [...chain.clips, { index: clipIndex, durationSec: 0, status: 'streaming' }],
          }));

          let clipResult: SingleRunResult;
          try {
            clipResult = await runSingleGeneration({
              prompt: baseChainPrompt,
              model: targetModel,
              imageUrl: nextFrameDataUrl,
              signal: controller.signal,
              onMeta: (meta) => {
                updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                  ...msg,
                  outputType: meta.outputType || msg.outputType,
                  params: meta.params || msg.params,
                  videoChain: msg.videoChain
                    ? {
                        ...msg.videoChain,
                        currentClipProgressPct:
                          typeof meta.progressPct === 'number'
                            ? Math.max(msg.videoChain.currentClipProgressPct ?? 0, meta.progressPct)
                            : msg.videoChain.currentClipProgressPct,
                      }
                    : msg.videoChain,
                }));
              },
            });
          } catch (clipErr) {
            if (controller.signal.aborted) throw clipErr;
            if (nextFrameDataUrl && nextFrameDataUrl.startsWith('data:')) {
              nextFrameDataUrl = undefined;
              clipResult = await runSingleGeneration({
                prompt: baseChainPrompt,
                model: targetModel,
                signal: controller.signal,
              });
            } else {
              throw clipErr;
            }
          }

          const clipUrl = clipResult.urls[0];
          if (!clipUrl) throw new Error(`Devam klibi ${clipIndex} alınamadı`);

          let clipDuration = 5.0;
          try {
            const pRes = await fetch('/api/video/probe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: clipUrl, extractLastFrame: true }),
              signal: controller.signal,
            });
            if (pRes.ok) {
              const pData = (await pRes.json()) as { durationSec?: number; lastFrameDataUrl?: string };
              if (pData.durationSec && pData.durationSec > 0) clipDuration = pData.durationSec;
              if (pData.lastFrameDataUrl) nextFrameDataUrl = pData.lastFrameDataUrl;
            }
          } catch {
            // Keep default 5s
          }

          newClipUrls.push(clipUrl);
          accumulatedNewSec += Math.max(0.5, clipDuration - 0.36);
          const clipWallSec = Math.max(1, (Date.now() - clipWallStartMs) / 1000);

          updateChain((chain) => ({
            ...chain,
            accumulatedDurationSec: accumulatedNewSec,
            currentClipStartedAt: undefined,
            currentClipProgressPct: undefined,
            clipWallSeconds: [...(chain.clipWallSeconds || []), clipWallSec].slice(-12),
            clips: chain.clips.map((c) =>
              c.index === clipIndex
                ? { ...c, url: clipUrl, durationSec: clipDuration, status: 'completed' }
                : c
            ),
          }));
        }

        if (newClipUrls.length > 0 && !controller.signal.aborted) {
          const allUrlsToMerge = [sourceFile.originalUrl, ...newClipUrls];
          updateChain((chain) => ({
            ...chain,
            stage: 'merging',
            mergeStartedAt: Date.now(),
            mergeProgressPct: 2,
            statusNote: 'Eski video ile yeni bölümler kesintisiz birleştiriliyor...',
          }));

          const mergedItem = await mergeAndAttachVideo({
            sessionId: targetSessionId,
            messageId: assistantMsgId,
            clipUrls: allUrlsToMerge,
            continuityEnabled: true,
            trimToSeconds: baseDurSec + addSeconds,
            signal: controller.signal,
            attachToMessage: !wantsUpscale,
            onMergeProgress: (pct, msg) => {
              updateChain((chain) => ({
                ...chain,
                mergeProgressPct: pct,
                statusNote: msg || chain.statusNote,
              }));
            },
          });

          if (wantsUpscale) {
            const upStartMs = Date.now();
            updateChain((chain) => ({
              ...chain,
              stage: 'upscaling',
              mergeProgressPct: 100,
              upscaleStartedAt: upStartMs,
              upscaleProgressPct: 2,
              statusNote: `Uzatılan video ${upscaleTag} netliğe yükseltiliyor...`,
            }));
            try {
              await upscaleMediaFile(
                targetSessionId,
                assistantMsgId,
                mergedItem,
                upscaleResolution,
                effectiveUpscaleMethod,
                {
                  signal: controller.signal,
                  replaceMessageFiles: true,
                  onProgress: (pct, msg) => {
                    updateChain((chain) => ({
                      ...chain,
                      upscaleProgressPct: pct,
                      statusNote: msg || `${upscaleTag} netliğe yükseltiliyor (%${pct})...`,
                    }));
                  },
                }
              );
            } catch (upErr) {
              if (controller.signal.aborted) throw upErr;
              updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
                ...msg,
                files: [mergedItem],
                nonFatalWarning: `Otomatik yükseltme tamamlanamadı: ${
                  upErr instanceof Error ? upErr.message : 'Hata'
                }`,
              }));
            }
          }

          updateChain((chain) => ({
            ...chain,
            stage: 'completed',
            mergeProgressPct: 100,
            upscaleProgressPct: wantsUpscale ? 100 : chain.upscaleProgressPct,
            statusNote: 'Video başarıyla uzatıldı ve birleştirildi.',
          }));
          updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
            ...msg,
            pipelineStage: 'completed',
            progressPct: 100,
            status: 'completed',
          }));
        }
      } catch (err) {
        if (controller.signal.aborted) {
          if (newClipUrls.length > 0) {
            try {
              const fallbackCtrl = new AbortController();
              await mergeAndAttachVideo({
                sessionId: targetSessionId,
                messageId: assistantMsgId,
                clipUrls: [sourceFile.originalUrl, ...newClipUrls],
                continuityEnabled: true,
                signal: fallbackCtrl.signal,
              });
            } catch {
              // Best effort
            }
          }
          updateChain((chain) => ({
            ...chain,
            stage: 'aborted',
            statusNote: 'Video uzatma işlemi durduruldu.',
          }));
          updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
            ...msg,
            pipelineStage: 'aborted',
            status: 'aborted',
          }));
        } else {
          const errorMessage = err instanceof Error ? err.message : 'Video uzatma hatası';
          updateChain((chain) => ({
            ...chain,
            stage: 'error',
            statusNote: errorMessage,
          }));
          updateMessageInSession(targetSessionId, assistantMsgId, (msg) => ({
            ...msg,
            pipelineStage: 'error',
            status: 'error',
            errorMessage,
          }));
        }
      } finally {
        setIsStreaming(false);
        abortControllerRef.current = null;
      }
    },
    [
      activeSession,
      isStreaming,
      mergeAndAttachVideo,
      runSingleGeneration,
      simpleAspectRatio,
      simpleMode,
      speedMode,
      updateMessageInSession,
      upscaleMediaFile,
      upscaleMethod,
      upscaleResolution,
    ]
  );

  const handleAbort = () => {
    abortControllerRef.current?.abort();
  };

  const quickStarters = useMemo(() => {
    if (simpleMode) {
      if (modelProfile.category === '3d') {
        return [
          'Antika altın cep saati',
          'El yapımı seramik kahve fincanı',
          'Klasik pirinç pusula',
        ];
      }
      if (modelProfile.category === 'video') {
        return [
          'Güneşli bahçede koşan sevimli bir kedi',
          'Deniz kıyısında gün batımı ve sakin dalgalar',
          'Çiçekli tarlada uçuşan renkli kelebekler',
        ];
      }
      return [
        'Papatyalarla dolu güneşli bir yayla çayırı',
        'Ahşap masada sıcak çay ve taze simit',
        'Karlı dağların önünde sıcak ışıklı bir ahşap ev',
      ];
    }

    if (modelProfile.category === '3d') {
      return [
        'stylized mechanical brass compass --steps 20 --seed 42',
        'minimalist ceramic coffee mug --steps 16 --mode balanced',
        'futuristic carbon fiber helmet --steps 20 --seed 1337',
      ];
    }
    if (modelProfile.category === 'video') {
      return [
        'a cat running --ar 16:9',
        'a cat running through sunlit grass --ar 16:9 --mode fast --seed 42',
        'ocean waves crashing on basalt cliffs, slow motion --ar 9:16 --frames 124',
      ];
    }
    return [
      'a cat running --ar 16:9',
      'minimalist architectural concrete pavilion in morning mist --ar 16:9 --seed 42',
      'editorial portrait in soft window light, 35mm film --ar 3:4 --steps 8',
    ];
  }, [modelProfile.category, simpleMode]);

  const videoModelId = useMemo(
    () => models.find((m) => getModelProfile(m.id).category === 'video')?.id || 'minimax-h3',
    [models]
  );
  const imageModelId = useMemo(
    () => models.find((m) => getModelProfile(m.id).category === 'image')?.id || 'z-image-turbo',
    [models]
  );
  const threeDModelId = useMemo(
    () => models.find((m) => getModelProfile(m.id).category === '3d')?.id || 'hunyuan3d-2-1',
    [models]
  );

  const simpleShowcaseCards = useMemo(() => {
    if (modelProfile.category === '3d') {
      return [
        {
          title: 'Altın Cep Saati',
          prompt: 'Antika altın cep saati',
          image: starterAlpineCabin,
        },
        {
          title: 'Seramik Kahve Fincanı',
          prompt: 'El yapımı seramik kahve fincanı',
          image: starterNatureCat,
        },
        {
          title: 'Klasik Pirinç Pusula',
          prompt: 'Klasik pirinç pusula',
          image: starterOceanSunset,
        },
      ];
    }
    if (modelProfile.category === 'image') {
      return [
        {
          title: 'Yayla Çayırı',
          prompt: 'Papatyalarla dolu güneşli bir yayla çayırı',
          image: starterNatureCat,
        },
        {
          title: 'Okyanus Gün Batımı',
          prompt: 'Altın ışıkta deniz kıyısı ve sakin dalgalar',
          image: starterOceanSunset,
        },
        {
          title: 'Dağ Evi',
          prompt: 'Karlı dağların önünde sıcak ışıklı ahşap dağ evi',
          image: starterAlpineCabin,
        },
      ];
    }
    return [
      {
        title: 'Bahçede Koşan Kedi',
        prompt: 'Güneşli bahçede koşan sevimli bir kedi',
        image: starterNatureCat,
      },
      {
        title: 'Denizde Gün Batımı',
        prompt: 'Deniz kıyısında gün batımı ve sakin dalgalar',
        image: starterOceanSunset,
      },
      {
        title: 'Karlı Dağ Evi',
        prompt: 'Karlı dağların önünde sıcak ışıklı bir ahşap ev',
        image: starterAlpineCabin,
      },
    ];
  }, [modelProfile.category]);

  const simpleFeedItems = useMemo(() => {
    if (!activeSession) return [];
    const items: Array<{ message: ChatMessage; promptText: string }> = [];
    for (let i = 0; i < activeSession.messages.length; i++) {
      const m = activeSession.messages[i];
      if (m.role !== 'assistant') continue;
      let promptText = '';
      for (let j = i - 1; j >= 0; j--) {
        if (activeSession.messages[j].role === 'user') {
          promptText = activeSession.messages[j].content;
          break;
        }
      }
      items.push({ message: m, promptText });
    }
    return items;
  }, [activeSession]);

  return (
    <div
      className={`h-screen w-screen overflow-hidden text-slate-100 flex ${
        simpleMode ? 'bg-[#08090C]' : 'bg-[#0B0D10]'
      }`}
    >
      {/* Left Workspace Sidebar (Advanced mode only) */}
      {!simpleMode && (
        <Sidebar
          models={models}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          activeModelId={activeModelId}
          isStreaming={isStreaming}
          onSelectModel={handleSelectModel}
          onRefreshModels={fetchModels}
          sessions={sessions}
          activeSessionId={activeSession?.id || ''}
          onSelectSession={(id) => {
            if (!isStreaming) setActiveSessionId(id);
          }}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
          isOpenMobile={sidebarOpenMobile}
          onCloseMobile={() => setSidebarOpenMobile(false)}
        />
      )}

      {/* Main Workspace */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        {/* Top Bar Contract: Wordmark Left, Category Tabs Center (Simple Mode), Concise Actions Right */}
        <header
          className={`h-14 shrink-0 px-4 sm:px-6 border-b border-white/8 flex items-center justify-between gap-3 ${
            simpleMode ? 'bg-[#08090C]/95 backdrop-blur-md' : 'bg-[#0D1015]'
          }`}
        >
          <div className="flex items-center gap-3 min-w-0">
            {!simpleMode && (
              <button
                type="button"
                onClick={() => setSidebarOpenMobile(true)}
                aria-label="Menüyü aç"
                className="lg:hidden p-2 -ml-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] cursor-pointer"
              >
                <Menu className="w-5 h-5" />
              </button>
            )}
            {simpleMode ? (
              <div className="flex items-center gap-2.5 min-w-0 shrink-0">
                <div className="w-7 h-7 rounded-lg bg-[#D4FF2A] text-[#08090C] flex items-center justify-center shrink-0">
                  <Film className="w-4 h-4" />
                </div>
                <span className="font-display text-sm sm:text-base font-semibold text-white whitespace-nowrap">
                  WebGPU Studio
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs sm:text-sm min-w-0 truncate">
                <span className="text-slate-500 hidden sm:inline whitespace-nowrap">
                  v1/chat/completions
                </span>
                <span className="text-slate-600 hidden sm:inline">/</span>
                <span className="font-mono font-medium text-slate-100 truncate">
                  {activeModelId}
                </span>
              </div>
            )}
          </div>

          {/* Higgsfield-style Center Category Tabs in Simple Mode */}
          {simpleMode && (
            <nav
              aria-label="Stüdyo kategorileri"
              className="hidden md:flex items-center gap-1 p-1 rounded-xl border border-white/10 bg-[#12141A] shrink-0"
            >
              {(
                [
                  { category: 'video', modelId: videoModelId, label: 'Video', Icon: Film },
                  { category: 'image', modelId: imageModelId, label: 'Resim', Icon: ImageIcon },
                  { category: '3d', modelId: threeDModelId, label: '3D', Icon: Box },
                ] as const
              ).map(({ category, modelId, label, Icon }) => {
                const active = modelProfile.category === category;
                return (
                  <button
                    key={category}
                    type="button"
                    disabled={isStreaming}
                    onClick={() => handleSelectModel(modelId)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-white text-[#08090C]'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{label}</span>
                  </button>
                );
              })}
            </nav>
          )}

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setSimpleMode((prev) => !prev)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 bg-[#141820] hover:border-white/25 text-xs font-medium text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {simpleMode ? (
                <>
                  <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400" />
                  <span>Gelişmiş Mod</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 text-[#D4FF2A]" />
                  <span>Basit Mod</span>
                </>
              )}
            </button>

            {!simpleMode && (
              <button
                type="button"
                onClick={() => setGuideOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 bg-[#141820] hover:border-white/20 text-xs font-medium text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <BookOpen className="w-3.5 h-3.5 text-blue-400" />
                <span className="hidden sm:inline">-- Rehber</span>
              </button>
            )}

            {activeSession && activeSession.messages.length > 0 && (
              <button
                type="button"
                onClick={handleClearCurrentSession}
                disabled={isStreaming}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 hover:border-rose-500/40 text-xs text-slate-400 hover:text-rose-300 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span className={simpleMode ? 'inline' : 'hidden sm:inline'}>Temizle</span>
              </button>
            )}

            {/* Toggle Dedicated Video Preview & Download Area */}
            <button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined' && window.innerWidth < 1024) {
                  setPreviewPanelMobileOpen((prev) => !prev);
                } else {
                  setPreviewPanelDesktopOpen((prev) => !prev);
                }
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                previewPanelDesktopOpen
                  ? simpleMode
                    ? 'border-[#D4FF2A]/50 bg-[#D4FF2A]/12 text-[#D4FF2A]'
                    : 'border-blue-500/40 bg-blue-500/15 text-blue-200'
                  : 'border-white/10 bg-[#141820] text-slate-200 hover:border-white/20'
              }`}
            >
              <PanelRight
                className={`w-3.5 h-3.5 ${simpleMode ? 'text-[#D4FF2A]' : 'text-blue-400'}`}
              />
              <span>{simpleMode ? 'Videolarım' : 'Önizleme & İndirme'}</span>
              {previewEntries.length > 0 && (
                <span
                  className={`font-mono text-[11px] tabular-nums ${
                    simpleMode ? 'text-[#D4FF2A]' : 'text-blue-300'
                  }`}
                >
                  ({previewEntries.length})
                </span>
              )}
            </button>
          </div>
        </header>

        {/* Scrollable Studio Viewport */}
        <main className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
          <div className={`${simpleMode ? 'max-w-4xl' : 'max-w-3xl'} mx-auto space-y-6 pb-4`}>
            {!activeSession || activeSession.messages.length === 0 ? (
              simpleMode ? (
                <div className="py-4 sm:py-8 space-y-8">
                  {/* Mobile Category Switcher */}
                  <div className="flex md:hidden items-center gap-1 p-1 rounded-xl border border-white/10 bg-[#12141A] w-fit mx-auto">
                    {(
                      [
                        { category: 'video', modelId: videoModelId, label: 'Video', Icon: Film },
                        { category: 'image', modelId: imageModelId, label: 'Resim', Icon: ImageIcon },
                        { category: '3d', modelId: threeDModelId, label: '3D', Icon: Box },
                      ] as const
                    ).map(({ category, modelId, label, Icon }) => {
                      const active = modelProfile.category === category;
                      return (
                        <button
                          key={category}
                          type="button"
                          disabled={isStreaming}
                          onClick={() => handleSelectModel(modelId)}
                          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0 ${
                            active ? 'bg-white text-[#08090C]' : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          <span>{label}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Higgsfield Cinema Hero Title */}
                  <div className="text-center space-y-3 max-w-2xl mx-auto">
                    <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight text-white [text-wrap:balance]">
                      Hayalinizdeki Videoyu veya Resmi Oluşturun
                    </h1>
                    <p className="text-sm sm:text-base text-slate-400 leading-relaxed">
                      Aşağıdan beğendiğiniz bir örneğe tıklayın ya da ne görmek istediğinizi yazın;
                      hız, süre ve netlik ayarları otomatik uygulanır.
                    </p>
                  </div>

                  {/* Visual Cinema Showcase Cards */}
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm text-slate-400">
                      <span>Tek Tıkla Hazır Örnekler</span>
                      <span>Hızlı mod varsayılan olarak aktiftir</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {simpleShowcaseCards.map((card) => (
                        <div
                          key={card.title}
                          className="group relative rounded-2xl overflow-hidden border border-white/10 bg-[#111318] aspect-video"
                        >
                          <img
                            src={card.image}
                            alt={card.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-black/92 via-black/45 to-black/15" />
                          <div className="absolute inset-x-0 bottom-0 p-4 space-y-2.5">
                            <div>
                              <div className="text-base font-semibold text-white leading-tight">
                                {card.title}
                              </div>
                              <div className="text-xs text-slate-300 line-clamp-1 mt-0.5">
                                {card.prompt}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setPromptInput(card.prompt)}
                                className="px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-medium transition-colors cursor-pointer whitespace-nowrap"
                              >
                                Seç
                              </button>
                              <button
                                type="button"
                                onClick={() => void sendPrompt(card.prompt)}
                                className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-[#D4FF2A] hover:bg-[#e1ff66] text-[#08090C] text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap"
                              >
                                <span>Hemen Yap</span>
                                <ArrowUpRight className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="py-8 sm:py-12 space-y-8">
                  <div className="space-y-3 max-w-2xl">
                    <div className="text-xs font-mono text-slate-400">
                      {modelProfile.id} · {modelProfile.category}
                    </div>
                    <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-slate-100">
                      {modelProfile.label}
                    </h1>
                    <p className="text-sm sm:text-base text-slate-400 leading-relaxed">
                      {modelProfile.summary}. Prompt içerisine{' '}
                      <code className="font-mono text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded">
                        --ar 16:9
                      </code>{' '}
                      gibi parametreler ekleyebilir, video modellerinde{' '}
                      <span className="text-slate-200 font-medium">Hedef Süre</span> seçerek
                      otomatik birleştirilen uzun videolar üretebilirsiniz. Üretilen tüm çıktılar sağ
                      taraftaki önizleme ve indirme alanında saklanır.
                    </p>
                  </div>

                  {/* Quick-Start Prompts */}
                  <div className="space-y-2.5">
                    <div className="text-xs font-medium text-slate-400">
                      Hızlı Başlangıç Örnekleri
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                      {quickStarters.map((starter) => (
                        <div
                          key={starter}
                          className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-white/10 bg-[#12151B] hover:border-white/20 transition-colors"
                        >
                          <button
                            type="button"
                            onClick={() => setPromptInput(starter)}
                            className="flex-1 text-left font-mono text-xs sm:text-[13px] text-slate-200 hover:text-white truncate cursor-pointer"
                          >
                            {starter}
                          </button>
                          <button
                            type="button"
                            onClick={() => void sendPrompt(starter)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-600/20 hover:bg-blue-600 text-blue-300 hover:text-white text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0"
                          >
                            <span>Çalıştır</span>
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Supported -- Flags Quick Insert */}
                  <div className="space-y-2.5">
                    <div className="text-xs font-medium text-slate-400">
                      Bu Model İçin Yaygın Parametreler
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {FLAG_DEFINITIONS.filter((f) =>
                        modelProfile.supportedFlags.includes(f.flag)
                      ).map((def) => (
                        <button
                          key={def.flag}
                          type="button"
                          onClick={() => {
                            const defaultVal =
                              def.valueType === 'seed' ? '42' : def.options[0]?.value || '';
                            setPromptInput((prev) => upsertFlagInPrompt(prev, def.flag, defaultVal));
                          }}
                          className="p-3 rounded-xl border border-white/8 bg-[#11141A] hover:border-blue-500/40 text-left transition-colors cursor-pointer"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-xs font-semibold text-blue-400">
                              {def.flag}
                            </span>
                            <span className="font-mono text-[11px] text-slate-500">
                              {def.placeholder}
                            </span>
                          </div>
                          <div className="text-xs text-slate-300 mt-1 truncate">{def.title}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )
            ) : simpleMode ? (
              simpleFeedItems.map(({ message, promptText }) => (
                <MediaResultCard
                  key={message.id}
                  message={message}
                  promptText={promptText}
                  simpleMode
                  selectedPreviewUrl={selectedPreviewUrl}
                  onSelectPreview={handleSelectPreview}
                  onDeleteFile={handleDeleteMediaFile}
                  onUpscaleFile={async (msgId, file, res) => {
                    if (!activeSession) return;
                    await upscaleMediaFile(activeSession.id, msgId, file, res, 'game-cas');
                  }}
                  onExtendVideo={isStreaming ? undefined : handleExtendVideo}
                  onReusePrompt={(text) => setPromptInput(text)}
                  onRerunPrompt={(text) => void sendPrompt(text)}
                />
              ))
            ) : (
              activeSession.messages.map((message) => (
                <MediaResultCard
                  key={message.id}
                  message={message}
                  simpleMode={false}
                  selectedPreviewUrl={selectedPreviewUrl}
                  onSelectPreview={handleSelectPreview}
                  onDeleteFile={handleDeleteMediaFile}
                  onUpscaleFile={async (msgId, file, res) => {
                    if (!activeSession) return;
                    await upscaleMediaFile(activeSession.id, msgId, file, res, 'game-cas');
                  }}
                  onReusePrompt={(text) => setPromptInput(text)}
                  onRerunPrompt={(text) => void sendPrompt(text)}
                />
              ))
            )}
            <div ref={chatBottomRef} />
          </div>
        </main>

        {/* Bottom Prompt Composer Dock */}
        <footer
          className={`shrink-0 px-4 sm:px-6 pt-2 ${
            simpleMode
              ? 'pb-5 bg-gradient-to-t from-[#08090C] via-[#08090C]/95 to-transparent'
              : 'pb-4 bg-gradient-to-t from-[#0B0D10] via-[#0B0D10] to-transparent'
          }`}
        >
          <div className={`${simpleMode ? 'max-w-4xl' : 'max-w-3xl'} mx-auto`}>
            <PromptComposer
              value={promptInput}
              onChange={setPromptInput}
              attachedImageUrl={attachedImageUrl}
              onChangeAttachedImageUrl={setAttachedImageUrl}
              modelProfile={modelProfile}
              isStreaming={isStreaming}
              simpleMode={simpleMode}
              simpleAspectRatio={simpleAspectRatio}
              onChangeSimpleAspectRatio={setSimpleAspectRatio}
              targetDurationSec={targetDurationSec}
              onChangeTargetDurationSec={setTargetDurationSec}
              continuityEnabled={continuityEnabled}
              onChangeContinuityEnabled={setContinuityEnabled}
              upscaleResolution={upscaleResolution}
              onChangeUpscaleResolution={setUpscaleResolution}
              upscaleMethod={upscaleMethod}
              onChangeUpscaleMethod={setUpscaleMethod}
              speedMode={speedMode}
              onChangeSpeedMode={setSpeedMode}
              onSend={() => void sendPrompt()}
              onAbort={handleAbort}
            />
          </div>
        </footer>
      </div>

      {/* Right Dedicated Video & Media Preview & Download Area (Desktop) */}
      {previewPanelDesktopOpen && (
        <aside className="hidden lg:block w-[370px] xl:w-[420px] shrink-0 h-full border-l border-white/8">
          <MediaPreviewPanel
            entries={previewEntries}
            simpleMode={simpleMode}
            selectedUrl={selectedPreviewUrl}
            onSelectUrl={(url) => setSelectedPreviewUrl(url)}
            onDeleteFile={handleDeleteMediaFile}
            onUpscaleMedia={async (msgId, file, res, method) => {
              if (!activeSession) return;
              await upscaleMediaFile(activeSession.id, msgId, file, res, method);
            }}
            activeStreamingMessage={activeStreamingMessage}
            onClosePanel={() => setPreviewPanelDesktopOpen(false)}
          />
        </aside>
      )}

      {/* Mobile / Tablet Slide-over Preview & Download Drawer */}
      {previewPanelMobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex justify-end">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setPreviewPanelMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative w-[380px] max-w-[92vw] h-full z-10 border-l border-white/10">
            <MediaPreviewPanel
              entries={previewEntries}
              simpleMode={simpleMode}
              selectedUrl={selectedPreviewUrl}
              onSelectUrl={(url) => setSelectedPreviewUrl(url)}
              onDeleteFile={handleDeleteMediaFile}
              onUpscaleMedia={async (msgId, file, res, method) => {
                if (!activeSession) return;
                await upscaleMediaFile(activeSession.id, msgId, file, res, method);
              }}
              activeStreamingMessage={activeStreamingMessage}
              onClosePanel={() => setPreviewPanelMobileOpen(false)}
              isMobileOverlay
            />
          </aside>
        </div>
      )}

      {/* -- Flag Reference Drawer / Modal */}
      {guideOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
          onClick={() => setGuideOpen(false)}
        >
          <div
            className="w-full max-w-2xl max-h-[85vh] rounded-xl border border-white/12 bg-[#12151B] shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-white/8 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-blue-400" />
                <h2 className="font-display text-base font-semibold text-slate-100">
                  Komut Parametre Rehberi (--)
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setGuideOpen(false)}
                aria-label="Rehberi kapat"
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-3">
              <p className="text-xs text-slate-400 leading-relaxed">
                Mesaj kutusuna <code className="font-mono text-blue-400">--</code> yazdığınızda
                interaktif parametre seçici otomatik açılır. Aşağıdaki parametrelerden birine
                tıklayarak aktif promptunuza hemen ekleyebilirsiniz.
              </p>

              <div className="divide-y divide-white/8 border border-white/8 rounded-lg overflow-hidden">
                {FLAG_DEFINITIONS.map((def) => (
                  <div
                    key={def.flag}
                    className="p-3.5 bg-[#0E1116] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-blue-400">
                          {def.flag}
                        </span>
                        <span className="text-sm font-medium text-slate-100">{def.title}</span>
                      </div>
                      <p className="text-xs text-slate-400">{def.description}</p>
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {def.options.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => {
                              const val =
                                def.valueType === 'seed' && opt.value === 'random'
                                  ? String(Math.floor(Math.random() * 999999) + 1)
                                  : opt.value;
                              setPromptInput((prev) => upsertFlagInPrompt(prev, def.flag, val));
                              setGuideOpen(false);
                            }}
                            className="px-2 py-1 rounded border border-white/10 bg-[#171B23] hover:border-blue-500/50 text-[11px] font-mono text-slate-300 hover:text-white transition-colors cursor-pointer"
                          >
                            {def.flag} {opt.value === 'random' ? '42' : opt.value}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function discoveredSetAdd(set: Set<string>, value: string) {
  set.add(value);
}
