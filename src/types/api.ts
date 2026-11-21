export type ModelCategory = 'video' | 'image' | '3d' | 'text';

export interface ApiModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface ModelProfile {
  id: string;
  label: string;
  category: ModelCategory;
  summary: string;
  defaultRatio: string;
  supportedFlags: string[];
  samplePrompt: string;
  supportsImageInput?: boolean;
}

export interface StreamEventStart {
  event: 'start';
  model?: string;
  type?: string;
  status?: string;
  params?: Record<string, string | number | boolean>;
}

export interface StreamEventProgress {
  event: 'progress';
  status?: string;
  elapsed?: number;
  step?: number;
  total_steps?: number;
  message?: string;
}

export interface StreamEventDone {
  event: 'done';
  status?: string;
  model?: string;
  type?: string;
  elapsed?: number;
  files?: string[];
  text?: string;
  params?: Record<string, string | number | boolean>;
}

export interface StreamEventError {
  event: 'error';
  status?: string;
  message?: string;
  error?: {
    message?: string;
    available?: string[];
  };
}

export type WebGpuStreamEvent =
  | StreamEventStart
  | StreamEventProgress
  | StreamEventDone
  | StreamEventError
  | Record<string, unknown>;

export type CachedMediaStatus = 'fetching' | 'cached' | 'expired' | 'error';

export type UpscaleResolution = 'original' | '1080p' | '1440p' | '2160p';

export type UpscaleMethod = 'game-cas' | 'retro-xbr';

export type GenerationSpeedMode = 'fast' | 'balanced' | 'hq';

export type VideoExportFormat = 'mp4' | 'webm' | 'gif';

export interface MediaFileItem {
  originalUrl: string;
  filename: string;
  mediaKind: 'video' | 'image' | '3d' | 'unknown';
  blobUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationSec?: number;
  width?: number;
  height?: number;
  isMerged?: boolean;
  clipCount?: number;
  upscaleLabel?: string;
  upscaleMethod?: UpscaleMethod;
  status: CachedMediaStatus;
  errorText?: string;
  createdAt: number;
  expiresAt: number; // 60 seconds after creation
}

export type GenerationStatus = 'streaming' | 'completed' | 'error' | 'aborted';

export type VideoChainStage =
  | 'generating'
  | 'merging'
  | 'upscaling'
  | 'completed'
  | 'aborted'
  | 'error';

export interface VideoChainClipInfo {
  index: number;
  url?: string;
  durationSec: number;
  status: 'streaming' | 'probing' | 'completed' | 'error';
  errorMessage?: string;
}

export interface VideoChainState {
  targetDurationSec: number;
  clipFrames: number;
  continuityEnabled: boolean;
  upscaleResolution?: UpscaleResolution;
  accumulatedDurationSec: number;
  currentClipIndex: number;
  estimatedTotalClips: number;
  currentClipStartedAt?: number;
  currentClipProgressPct?: number;
  clipWallSeconds?: number[];
  mergeStartedAt?: number;
  mergeProgressPct?: number;
  upscaleStartedAt?: number;
  upscaleProgressPct?: number;
  stage: VideoChainStage;
  statusNote?: string;
  clips: VideoChainClipInfo[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachedImageUrl?: string;
  model: string;
  createdAt: number;
  status?: GenerationStatus;
  pipelineStage?: 'generating' | 'merging' | 'upscaling' | 'completed' | 'aborted' | 'error';
  pipelineLabel?: string;
  upscaleTarget?: UpscaleResolution;
  upscaleStartedAt?: number;
  upscaleProgressPct?: number;
  outputType?: string;
  params?: Record<string, string | number | boolean>;
  elapsed?: number;
  progressPct?: number;
  textSummary?: string;
  streamEvents?: WebGpuStreamEvent[];
  files?: MediaFileItem[];
  videoChain?: VideoChainState;
  errorMessage?: string;
  nonFatalWarning?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
  messages: ChatMessage[];
}
