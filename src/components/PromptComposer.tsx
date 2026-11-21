import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Send,
  Square,
  SlidersHorizontal,
  X,
  ImagePlus,
  Plus,
  Clock,
  Layers,
  Sparkles,
} from 'lucide-react';
import {
  FLAG_DEFINITIONS,
  detectActiveFlagTrigger,
  getFlagDefinition,
  parsePromptFlags,
  removeFlagFromPrompt,
  upsertFlagInPrompt,
  type ActiveTriggerState,
  type FlagDefinition,
} from '../data/flags';
import type {
  GenerationSpeedMode,
  ModelProfile,
  UpscaleMethod,
  UpscaleResolution,
} from '../types/api';
import { FlagPopover } from './FlagPopover';

interface PromptComposerProps {
  value: string;
  onChange: (val: string) => void;
  attachedImageUrl: string;
  onChangeAttachedImageUrl: (url: string) => void;
  modelProfile: ModelProfile;
  isStreaming: boolean;
  simpleMode?: boolean;
  simpleAspectRatio?: '16:9' | '9:16' | '1:1';
  onChangeSimpleAspectRatio?: (ar: '16:9' | '9:16' | '1:1') => void;
  targetDurationSec: number;
  onChangeTargetDurationSec: (sec: number) => void;
  continuityEnabled: boolean;
  onChangeContinuityEnabled: (enabled: boolean) => void;
  upscaleResolution: UpscaleResolution;
  onChangeUpscaleResolution: (res: UpscaleResolution) => void;
  upscaleMethod: UpscaleMethod;
  onChangeUpscaleMethod: (method: UpscaleMethod) => void;
  speedMode?: GenerationSpeedMode;
  onChangeSpeedMode?: (mode: GenerationSpeedMode) => void;
  onSend: () => void;
  onAbort: () => void;
}

const UPSCALE_PRESETS: Array<{ value: UpscaleResolution; label: string }> = [
  { value: 'original', label: 'Orijinal' },
  { value: '1080p', label: '1080p (1K)' },
  { value: '1440p', label: '2K (2000px+)' },
  { value: '2160p', label: '4K (2160p)' },
];

const DURATION_PRESETS = [
  { sec: 0, label: '5 sn' },
  { sec: 10, label: '10 sn' },
  { sec: 60, label: '1 dk' },
  { sec: 120, label: '2 dk' },
  { sec: 300, label: '5 dk' },
  { sec: 480, label: '8 dk' },
  { sec: 600, label: '10 dk' },
] as const;

function formatDurationLabel(sec: number): string {
  if (sec <= 0) return '5 sn';
  if (sec < 60) return `${sec} sn`;
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem === 0 ? `${mins} dk` : `${mins} dk ${rem} sn`;
}

export const PromptComposer: React.FC<PromptComposerProps> = ({
  value,
  onChange,
  attachedImageUrl,
  onChangeAttachedImageUrl,
  modelProfile,
  isStreaming,
  simpleMode = false,
  simpleAspectRatio = '16:9',
  onChangeSimpleAspectRatio,
  targetDurationSec,
  onChangeTargetDurationSec,
  continuityEnabled,
  onChangeContinuityEnabled,
  upscaleResolution,
  onChangeUpscaleResolution,
  upscaleMethod,
  onChangeUpscaleMethod,
  speedMode = 'fast',
  onChangeSpeedMode,
  onSend,
  onAbort,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [cursorPos, setCursorPos] = useState(0);
  const [manualTrigger, setManualTrigger] = useState<ActiveTriggerState | null>(null);
  const [popoverDismissedAt, setPopoverDismissedAt] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showImageInput, setShowImageInput] = useState(false);
  const [customDurationOpen, setCustomDurationOpen] = useState(false);
  const [customSecondsInput, setCustomSecondsInput] = useState('720');
  const [simpleSliderOpen, setSimpleSliderOpen] = useState(false);

  const parsedFlags = useMemo(() => parsePromptFlags(value), [value]);

  const detectedTrigger = useMemo(() => {
    if (simpleMode) return null;
    const t = detectActiveFlagTrigger(value, cursorPos);
    if (!t) return null;
    const signature = `${t.stage}:${t.flagQuery}:${t.valueQuery}:${t.replaceStart}`;
    if (popoverDismissedAt === signature) return null;
    return t;
  }, [simpleMode, value, cursorPos, popoverDismissedAt]);

  const activeTrigger = simpleMode ? null : manualTrigger || detectedTrigger;

  // Reset highlighted row whenever trigger context changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [activeTrigger?.stage, activeTrigger?.flagQuery, activeTrigger?.valueQuery]);

  // Auto-resize textarea cleanly
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  const getActiveItemsCount = (): number => {
    if (!activeTrigger) return 0;
    if (activeTrigger.stage === 'flag') {
      const q = activeTrigger.flagQuery.replace(/^--/, '').toLowerCase();
      return FLAG_DEFINITIONS.filter(
        (d) =>
          !q ||
          d.flag.toLowerCase().includes(q) ||
          d.title.toLowerCase().includes(q) ||
          (d.aliases || []).some((a) => a.toLowerCase().includes(q))
      ).length;
    }
    const def = activeTrigger.activeFlagDef;
    if (!def) return 0;
    const q = activeTrigger.valueQuery.toLowerCase().replace(/^"|"$/g, '');
    return def.options.filter(
      (o) =>
        !q ||
        o.value.toLowerCase().includes(q) ||
        o.label.toLowerCase().includes(q) ||
        (o.hint || '').toLowerCase().includes(q)
    ).length;
  };

  const getSortedFilteredFlags = (): FlagDefinition[] => {
    if (!activeTrigger) return [];
    const q = activeTrigger.flagQuery.replace(/^--/, '').toLowerCase();
    return FLAG_DEFINITIONS.filter(
      (d) =>
        !q ||
        d.flag.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q) ||
        (d.aliases || []).some((a) => a.toLowerCase().includes(q))
    ).sort((a, b) => {
      const aRec = modelProfile.supportedFlags.includes(a.flag) ? 0 : 1;
      const bRec = modelProfile.supportedFlags.includes(b.flag) ? 0 : 1;
      return aRec - bRec;
    });
  };

  const handleSelectFlag = (def: FlagDefinition) => {
    if (manualTrigger) {
      // Opened via button or flag bar -> transition directly to Stage 2 value picker
      setManualTrigger({
        stage: 'value',
        flagQuery: def.flag,
        valueQuery: '',
        activeFlagDef: def,
        replaceStart: value.length,
        replaceEnd: value.length,
      });
      return;
    }

    if (!detectedTrigger) return;
    const before = value.slice(0, detectedTrigger.replaceStart);
    const after = value.slice(detectedTrigger.replaceEnd);
    const inserted = `${def.flag} `;
    const nextValue = `${before}${inserted}${after}`;
    const nextCursor = before.length + inserted.length;

    onChange(nextValue);
    setPopoverDismissedAt(null);

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextCursor, nextCursor);
        setCursorPos(nextCursor);
      }
    });
  };

  const handleSelectValue = (flag: string, chosenValue: string) => {
    if (manualTrigger) {
      const next = upsertFlagInPrompt(value, flag, chosenValue);
      onChange(next);
      setManualTrigger(null);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          const len = next.length;
          textareaRef.current.setSelectionRange(len, len);
          setCursorPos(len);
        }
      });
      return;
    }

    if (detectedTrigger) {
      const before = value.slice(0, detectedTrigger.replaceStart);
      const after = value.slice(detectedTrigger.replaceEnd);
      const insertion = `${flag} ${chosenValue}${after.startsWith(' ') ? '' : ' '}`;
      const next = `${before}${insertion}${after}`.replace(/ {2,}/g, ' ');
      const nextCursor = Math.min(next.length, before.length + insertion.length);

      onChange(next);
      setPopoverDismissedAt(null);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(nextCursor, nextCursor);
          setCursorPos(nextCursor);
        }
      });
    }
  };

  const handleOpenManualFlagMenu = () => {
    if (manualTrigger) {
      setManualTrigger(null);
      return;
    }
    setManualTrigger({
      stage: 'flag',
      flagQuery: '--',
      valueQuery: '',
      replaceStart: value.length,
      replaceEnd: value.length,
    });
  };

  const handleEditExistingFlag = (flagStr: string) => {
    const def = getFlagDefinition(flagStr);
    if (!def) return;
    setManualTrigger({
      stage: 'value',
      flagQuery: def.flag,
      valueQuery: '',
      activeFlagDef: def,
      replaceStart: value.length,
      replaceEnd: value.length,
    });
  };

  const handleDismissPopover = () => {
    if (manualTrigger) {
      setManualTrigger(null);
      return;
    }
    if (detectedTrigger) {
      const sig = `${detectedTrigger.stage}:${detectedTrigger.flagQuery}:${detectedTrigger.valueQuery}:${detectedTrigger.replaceStart}`;
      setPopoverDismissedAt(sig);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (activeTrigger) {
      const count = getActiveItemsCount();
      if (e.key === 'ArrowDown' && count > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % count);
        return;
      }
      if (e.key === 'ArrowUp' && count > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + count) % count);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && count > 0) {
        e.preventDefault();
        if (activeTrigger.stage === 'flag') {
          const flags = getSortedFilteredFlags();
          const chosen = flags[selectedIndex];
          if (chosen) handleSelectFlag(chosen);
        } else if (activeTrigger.activeFlagDef) {
          const q = activeTrigger.valueQuery.toLowerCase().replace(/^"|"$/g, '');
          const opts = activeTrigger.activeFlagDef.options.filter(
            (o) =>
              !q ||
              o.value.toLowerCase().includes(q) ||
              o.label.toLowerCase().includes(q) ||
              (o.hint || '').toLowerCase().includes(q)
          );
          const chosenOpt = opts[selectedIndex];
          if (chosenOpt) {
            const resolvedVal =
              activeTrigger.activeFlagDef.valueType === 'seed' && chosenOpt.value === 'random'
                ? String(Math.floor(Math.random() * 999999) + 1)
                : chosenOpt.value;
            handleSelectValue(activeTrigger.activeFlagDef.flag, resolvedVal);
          }
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDismissPopover();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming && value.trim()) {
        onSend();
      }
    }
  };

  const handleCursorSync = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const pos = e.currentTarget.selectionStart ?? value.length;
    setCursorPos(pos);
  };

  if (simpleMode) {
    const simplePlaceholder =
      modelProfile.category === 'video'
        ? 'Hayalinizdeki sahneyi anlatın... (Örnek: Güneşli bahçede koşan sevimli bir kedi)'
        : modelProfile.category === 'image'
          ? 'Nasıl bir resim çizelim? (Örnek: Papatyalarla dolu güneşli bir yayla çayırı)'
          : modelProfile.category === '3d'
            ? 'Nasıl bir 3D nesne yapalım? (Örnek: Antika altın cep saati)'
            : 'Ne oluşturmak istediğinizi yazın...';

    const simpleSubmitLabel =
      modelProfile.category === 'video'
        ? targetDurationSec > 0
          ? `${formatDurationLabel(targetDurationSec)} Video Oluştur`
          : 'Videoyu Oluştur'
        : modelProfile.category === 'image'
          ? 'Resmi Oluştur'
          : modelProfile.category === '3d'
            ? '3D Modeli Oluştur'
            : 'Oluştur';

    const simplePresets = DURATION_PRESETS;

    const isCustomSimpleDuration =
      targetDurationSec > 0 && !simplePresets.some((p) => p.sec === targetDurationSec);

    const quickExamplePrompt =
      modelProfile.category === 'video'
        ? 'Güneşli bahçede koşan sevimli bir kedi'
        : modelProfile.category === 'image'
          ? 'Papatyalarla dolu güneşli bir yayla çayırı'
          : 'Antika altın cep saati';

    const speedSummaryText =
      speedMode === 'fast'
        ? 'Hızlı mod (~10 sn/klip)'
        : speedMode === 'balanced'
          ? 'Dengeli mod (~16 sn/klip)'
          : 'Detaylı HQ mod (~28 sn/klip)';

    return (
      <div className="relative w-full">
        <div className="rounded-2xl border border-white/14 bg-[#111318]/95 backdrop-blur-xl focus-within:border-[#D4FF2A]/70 transition-colors shadow-2xl">
          <div className="px-4 pt-3 pb-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                Sahne Açıklaması
              </span>
              {!value.trim() && !isStreaming && (
                <button
                  type="button"
                  onClick={() => onChange(quickExamplePrompt)}
                  className="text-xs font-medium text-[#D4FF2A] hover:text-[#e8ff85] transition-colors cursor-pointer whitespace-nowrap"
                >
                  + Örnek Doldur
                </button>
              )}
            </div>
            <textarea
              ref={textareaRef}
              rows={2}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={simplePlaceholder}
              className="w-full resize-none bg-transparent text-base sm:text-[17px] leading-relaxed text-slate-100 placeholder:text-slate-400/90 focus:outline-none"
            />
          </div>

          {/* Inline Higgsfield-style Dock Control Strip */}
          <div className="px-4 py-3 border-t border-white/8 bg-[#0C0E12]/90 rounded-b-2xl space-y-3">
            {(modelProfile.category === 'video' || modelProfile.category === 'image') && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
                {/* Aspect Ratio */}
                {onChangeSimpleAspectRatio && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-slate-400 mr-0.5 whitespace-nowrap">
                      Ekran:
                    </span>
                    <div className="inline-flex items-center p-0.5 rounded-lg bg-[#161922] border border-white/8 gap-0.5">
                      {(
                        [
                          { value: '16:9', label: 'Yatay' },
                          { value: '9:16', label: 'Dikey' },
                          { value: '1:1', label: 'Kare' },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={isStreaming}
                          onClick={() => onChangeSimpleAspectRatio(opt.value)}
                          className={`px-2.5 py-1 rounded-md text-xs sm:text-sm font-medium transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap shrink-0 ${
                            simpleAspectRatio === opt.value
                              ? 'bg-white text-[#08090C] shadow-sm'
                              : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Speed Mode */}
                {modelProfile.category === 'video' && onChangeSpeedMode && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-slate-400 mr-0.5 whitespace-nowrap">
                      Hız:
                    </span>
                    <div className="inline-flex items-center p-0.5 rounded-lg bg-[#161922] border border-white/8 gap-0.5">
                      {(
                        [
                          { value: 'fast', label: 'Hızlı' },
                          { value: 'balanced', label: 'Dengeli' },
                          { value: 'hq', label: 'Detaylı' },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={isStreaming}
                          onClick={() => onChangeSpeedMode(opt.value)}
                          className={`px-2.5 py-1 rounded-md text-xs sm:text-sm font-medium transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap shrink-0 ${
                            speedMode === opt.value
                              ? 'bg-[#D4FF2A] text-[#08090C] font-semibold'
                              : 'text-slate-300 hover:text-white'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Quality */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium text-slate-400 mr-0.5 whitespace-nowrap">
                    Kalite:
                  </span>
                  <div className="inline-flex items-center p-0.5 rounded-lg bg-[#161922] border border-white/8 gap-0.5">
                    {(
                      [
                        { value: 'original', label: 'Normal' },
                        { value: '1440p', label: 'Çok Net (2K)' },
                        { value: '2160p', label: 'En Net (4K)' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={isStreaming}
                        onClick={() => onChangeUpscaleResolution(opt.value)}
                        className={`px-2.5 py-1 rounded-md text-xs sm:text-sm font-medium transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap shrink-0 ${
                          upscaleResolution === opt.value
                            ? 'bg-white text-[#08090C] shadow-sm'
                            : 'text-slate-300 hover:text-white'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Video Duration Row + Max Length Slider */}
            {modelProfile.category === 'video' && (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-slate-400 mr-0.5 whitespace-nowrap">
                      Süre:
                    </span>
                    {simplePresets.map((opt) => (
                      <button
                        key={opt.sec}
                        type="button"
                        disabled={isStreaming}
                        onClick={() => {
                          setSimpleSliderOpen(false);
                          onChangeTargetDurationSec(opt.sec);
                        }}
                        className={`px-2.5 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap shrink-0 tabular-nums ${
                          targetDurationSec === opt.sec && !simpleSliderOpen
                            ? 'bg-white text-[#08090C]'
                            : 'bg-[#181B22] text-slate-300 hover:text-white border border-white/8'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={isStreaming}
                      onClick={() => setSimpleSliderOpen((prev) => !prev)}
                      className={`px-2.5 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap shrink-0 tabular-nums ${
                        simpleSliderOpen || isCustomSimpleDuration
                          ? 'bg-white text-[#08090C]'
                          : 'bg-[#181B22] text-slate-300 hover:text-white border border-white/8'
                      }`}
                    >
                      {isCustomSimpleDuration
                        ? `Özel (${formatDurationLabel(targetDurationSec)})`
                        : 'Süreyi Uzat'}
                    </button>
                  </div>
                </div>

                {simpleSliderOpen && (
                  <div className="p-3 rounded-xl border border-white/10 bg-[#14171E] space-y-2">
                    <div className="flex items-center justify-between text-xs text-slate-300">
                      <span>İstediğiniz Uzunluğu Seçin (Maksimum 30 dk)</span>
                      <span className="font-mono font-semibold text-[#D4FF2A] tabular-nums">
                        {formatDurationLabel(targetDurationSec || 5)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={15}
                      max={1800}
                      step={15}
                      disabled={isStreaming}
                      value={targetDurationSec > 0 ? Math.min(1800, targetDurationSec) : 120}
                      onChange={(e) => onChangeTargetDurationSec(Number(e.target.value))}
                      aria-label="Maksimum video süresi"
                      className="w-full h-2 accent-[#D4FF2A] cursor-pointer bg-slate-800 rounded-lg"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                      <span>15 sn</span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {[
                          { sec: 720, label: '12 dk' },
                          { sec: 900, label: '15 dk' },
                          { sec: 1200, label: '20 dk' },
                          { sec: 1800, label: '30 dk (Maks)' },
                        ].map((m) => (
                          <button
                            key={m.sec}
                            type="button"
                            disabled={isStreaming}
                            onClick={() => onChangeTargetDurationSec(m.sec)}
                            className={`px-2 py-1 rounded border text-[11px] transition-colors cursor-pointer tabular-nums ${
                              targetDurationSec === m.sec
                                ? 'border-[#D4FF2A]/70 bg-[#D4FF2A]/15 text-[#D4FF2A]'
                                : 'border-white/10 bg-[#1B1F29] text-slate-300 hover:text-white'
                            }`}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Primary Higgsfield-Style Generate Action Row */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1 border-t border-white/6">
              <span className="text-xs sm:text-sm text-slate-400 truncate">
                {isStreaming
                  ? 'Üretim, birleştirme ve netleştirme tek seferde yapılıyor...'
                  : modelProfile.category === 'video'
                    ? `${speedSummaryText}${
                        upscaleResolution !== 'original'
                          ? ` · ${upscaleResolution === '2160p' ? '4K' : '2K'} netlik otomatik`
                          : ' · Kalan süre canlı hesaplanır'
                      }`
                    : upscaleResolution !== 'original' && modelProfile.category === 'image'
                      ? `${upscaleResolution === '2160p' ? '4K' : '2K'} netlik üretim sırasında otomatik uygulanır`
                      : 'Ne istediğinizi yazın ve Oluştur düğmesine basın'}
              </span>

              {isStreaming ? (
                <button
                  type="button"
                  onClick={onAbort}
                  className="inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-sm sm:text-base font-semibold bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Square className="w-4 h-4 fill-current" />
                  <span>Durdur</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onSend}
                  disabled={!value.trim()}
                  className="inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-sm sm:text-base font-semibold bg-[#D4FF2A] hover:bg-[#e1ff66] disabled:bg-white/10 disabled:text-slate-500 text-[#08090C] transition-colors cursor-pointer disabled:cursor-not-allowed whitespace-nowrap shrink-0"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>{simpleSubmitLabel}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full">
      {activeTrigger && (
        <FlagPopover
          trigger={activeTrigger}
          modelProfile={modelProfile}
          selectedIndex={selectedIndex}
          onChangeSelectedIndex={setSelectedIndex}
          onSelectFlag={handleSelectFlag}
          onSelectValue={handleSelectValue}
          onBackToFlags={() =>
            setManualTrigger({
              stage: 'flag',
              flagQuery: '--',
              valueQuery: '',
              replaceStart: value.length,
              replaceEnd: value.length,
            })
          }
          onClose={handleDismissPopover}
        />
      )}

      <div className="rounded-xl border border-white/12 bg-[#12151B] focus-within:border-blue-500/60 transition-colors">
        {/* Optional reference image attachment bar */}
        {showImageInput && (
          <div className="flex items-center gap-2 px-3.5 py-2 border-b border-white/8 bg-[#0E1116] rounded-t-xl">
            <ImagePlus className="w-4 h-4 text-slate-400 shrink-0" />
            <input
              type="url"
              value={attachedImageUrl}
              onChange={(e) => onChangeAttachedImageUrl(e.target.value)}
              placeholder="Referans görsel URL (image-to-video / image-to-3D için isteğe bağlı)..."
              className="flex-1 bg-transparent text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                onChangeAttachedImageUrl('');
                setShowImageInput(false);
              }}
              aria-label="Görsel ekini kapat"
              className="text-slate-500 hover:text-slate-200 p-1 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Active parsed -- flags interactive strip */}
        <div className="flex items-center flex-wrap gap-1.5 px-3.5 pt-2.5 pb-1">
          <button
            type="button"
            onClick={handleOpenManualFlagMenu}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-white/10 bg-[#181C24] text-xs text-slate-300 hover:text-white hover:border-white/20 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-blue-400" />
            <span>Parametre</span>
            <span className="font-mono text-[11px] text-slate-500">--</span>
          </button>

          {parsedFlags.map((tok, idx) => (
            <div
              key={`${tok.canonicalFlag}-${idx}`}
              className="inline-flex items-center rounded-md border border-blue-500/25 bg-blue-500/10 text-xs font-mono"
            >
              <button
                type="button"
                onClick={() => handleEditExistingFlag(tok.canonicalFlag)}
                title="Değeri düzenle"
                className="px-2 py-1 text-blue-300 hover:text-blue-200 transition-colors cursor-pointer whitespace-nowrap"
              >
                {tok.canonicalFlag}
                {tok.value ? (
                  <span className="text-slate-100 ml-1">{tok.value}</span>
                ) : (
                  <span className="text-slate-500 ml-1">…</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => onChange(removeFlagFromPrompt(value, tok.canonicalFlag))}
                aria-label={`${tok.canonicalFlag} parametresini kaldır`}
                className="pr-1.5 pl-0.5 py-1 text-slate-400 hover:text-rose-300 transition-colors cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}

          {parsedFlags.length === 0 && (
            <span className="text-xs text-slate-500 pl-1">
              İpucu: <span className="font-mono text-slate-400">--ar</span> yazarak en-boy oranı
              seçicisini açabilirsiniz
            </span>
          )}
        </div>

        {/* Prompt Textarea */}
        <textarea
          ref={textareaRef}
          rows={2}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setManualTrigger(null);
            setPopoverDismissedAt(null);
            setCursorPos(e.target.selectionStart ?? e.target.value.length);
          }}
          onClick={handleCursorSync}
          onKeyUp={handleCursorSync}
          onKeyDown={handleKeyDown}
          placeholder={`Örnek: a cat running --ar 16:9`}
          className="w-full resize-none bg-transparent px-3.5 py-2 text-sm sm:text-[15px] leading-relaxed text-slate-100 placeholder:text-slate-500 focus:outline-none"
        />

        {/* Video Target Duration, Auto-Stitching & Media Resolution Selector */}
        {(modelProfile.category === 'video' || modelProfile.category === 'image') && (
          <div className="px-3.5 py-2 border-t border-white/8 bg-[#0E1117] space-y-2 text-xs">
            {modelProfile.category === 'video' && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1.5 text-slate-400 mr-1 whitespace-nowrap">
                    <Clock className="w-3.5 h-3.5 text-blue-400" />
                    <span>Hedef Süre:</span>
                  </span>

                  {DURATION_PRESETS.map((preset) => {
                    const isSelected = targetDurationSec === preset.sec && !customDurationOpen;
                    return (
                      <button
                        key={preset.sec}
                        type="button"
                        disabled={isStreaming}
                        onClick={() => {
                          setCustomDurationOpen(false);
                          onChangeTargetDurationSec(preset.sec);
                        }}
                        className={`px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap shrink-0 tabular-nums ${
                          isSelected
                            ? 'bg-blue-600 text-white'
                            : 'bg-[#171B24] text-slate-300 hover:text-white border border-white/8'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    disabled={isStreaming}
                    onClick={() => setCustomDurationOpen((prev) => !prev)}
                    className={`px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap shrink-0 ${
                      customDurationOpen ||
                      (targetDurationSec > 0 &&
                        !DURATION_PRESETS.some((p) => p.sec === targetDurationSec))
                        ? 'bg-blue-600 text-white'
                        : 'bg-[#171B24] text-slate-400 hover:text-white border border-white/8'
                    }`}
                  >
                    Özel
                  </button>

                  {customDurationOpen && (
                    <div className="inline-flex items-center gap-1 ml-1">
                      <input
                        type="number"
                        min={10}
                        max={1800}
                        step={5}
                        value={customSecondsInput}
                        onChange={(e) => setCustomSecondsInput(e.target.value)}
                        aria-label="Özel süre (saniye)"
                        className="w-16 bg-[#151922] border border-white/15 rounded-md px-2 py-1 text-xs font-mono text-slate-100 tabular-nums focus:outline-none focus:border-blue-500"
                      />
                      <span className="text-[11px] text-slate-400">sn (maks 1800)</span>
                      <button
                        type="button"
                        onClick={() => {
                          const parsed = Math.max(
                            10,
                            Math.min(1800, Math.round(Number(customSecondsInput) || 720))
                          );
                          onChangeTargetDurationSec(parsed);
                          setCustomDurationOpen(false);
                        }}
                        className="px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-[11px] font-medium text-white cursor-pointer whitespace-nowrap"
                      >
                        Uygula
                      </button>
                    </div>
                  )}
                </div>

                {targetDurationSec > 0 && (
                  <div className="flex flex-wrap items-center gap-3 text-[11px]">
                    <span className="inline-flex items-center gap-1 text-blue-300 tabular-nums whitespace-nowrap">
                      <Layers className="w-3.5 h-3.5" />
                      <span>
                        ~{Math.max(1, Math.ceil(targetDurationSec / 4.65))} klip birleştirilir (
                        {targetDurationSec} sn)
                      </span>
                    </span>
                    <label className="inline-flex items-center gap-1.5 text-slate-300 cursor-pointer whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={continuityEnabled}
                        disabled={isStreaming}
                        onChange={(e) => onChangeContinuityEnabled(e.target.checked)}
                        className="accent-blue-500 rounded cursor-pointer"
                      />
                      <span>Son kareden devam et</span>
                    </label>
                  </div>
                )}
              </div>
            )}

            {/* Output Quality & Game-Dev Auto-Upscale Strip */}
            <div
              className={`flex flex-wrap items-center justify-between gap-2 ${
                modelProfile.category === 'video' ? 'pt-1.5 border-t border-white/6' : ''
              }`}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1.5 text-slate-400 mr-1 whitespace-nowrap">
                  <Sparkles className="w-3.5 h-3.5 text-blue-400" />
                  <span>Çözünürlük:</span>
                </span>
                {UPSCALE_PRESETS.map((preset) => {
                  const active = upscaleResolution === preset.value;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      disabled={isStreaming}
                      onClick={() => onChangeUpscaleResolution(preset.value)}
                      className={`px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap shrink-0 tabular-nums ${
                        active
                          ? 'bg-blue-600 text-white'
                          : 'bg-[#171B24] text-slate-300 hover:text-white border border-white/8'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}

                {upscaleResolution !== 'original' && (
                  <div className="inline-flex items-center gap-1 pl-1 ml-1 border-l border-white/10">
                    <button
                      type="button"
                      disabled={isStreaming}
                      onClick={() => onChangeUpscaleMethod('game-cas')}
                      title="Oyun Motoru FSR/CAS + Deband + Mikro Doku Sentezi"
                      className={`px-2 py-1 rounded-md text-[11px] font-mono transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap ${
                        upscaleMethod === 'game-cas'
                          ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40'
                          : 'bg-[#171B24] text-slate-400 hover:text-white border border-white/8'
                      }`}
                    >
                      CAS + Mikro Doku
                    </button>
                    <button
                      type="button"
                      disabled={isStreaming}
                      onClick={() => onChangeUpscaleMethod('retro-xbr')}
                      title="Klasik 250px → 2000px xBR 4x Kenar Büyütme + CAS"
                      className={`px-2 py-1 rounded-md text-[11px] font-mono transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap ${
                        upscaleMethod === 'retro-xbr'
                          ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40'
                          : 'bg-[#171B24] text-slate-400 hover:text-white border border-white/8'
                      }`}
                    >
                      xBR 4x
                    </button>
                  </div>
                )}
              </div>

              {modelProfile.category === 'video' && (
                <div className="inline-flex items-center gap-1">
                  <span className="text-slate-400 mr-0.5 whitespace-nowrap">Hız:</span>
                  {(
                    [
                      { value: 'fast', label: 'Hızlı (fast)' },
                      { value: 'balanced', label: 'Dengeli' },
                      { value: 'hq', label: 'HQ' },
                    ] as const
                  ).map((opt) => {
                    const active = speedMode === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={isStreaming}
                        onClick={() => {
                          onChangeSpeedMode?.(opt.value);
                          const stepsVal = opt.value === 'fast' ? '4' : opt.value === 'balanced' ? '8' : '16';
                          let next = upsertFlagInPrompt(value, '--mode', opt.value);
                          next = upsertFlagInPrompt(next, '--steps', stepsVal);
                          onChange(next);
                        }}
                        title={`--mode ${opt.value} örnekleme modunu uygular`}
                        className={`px-2 py-1 rounded-md border text-[11px] font-mono transition-colors cursor-pointer disabled:opacity-45 whitespace-nowrap shrink-0 ${
                          active
                            ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                            : 'border-white/10 bg-[#171B24] text-slate-300 hover:border-blue-500/40 hover:text-white'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Bottom Composer Controls */}
        <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 border-t border-white/8">
          <div className="flex items-center gap-2 min-w-0">
            {modelProfile.supportsImageInput && (
              <button
                type="button"
                onClick={() => setShowImageInput((prev) => !prev)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  showImageInput || attachedImageUrl
                    ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
                }`}
              >
                <ImagePlus className="w-3.5 h-3.5" />
                <span>Görsel Ekle</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                const next = upsertFlagInPrompt(value, '--ar', '16:9');
                onChange(next);
                handleEditExistingFlag('--ar');
              }}
              className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] transition-colors cursor-pointer whitespace-nowrap shrink-0 font-mono"
            >
              <Plus className="w-3 h-3" />
              <span>--ar</span>
            </button>

            <span className="text-xs text-slate-500 truncate hidden md:inline">
              Model: <span className="text-slate-300 font-mono">{modelProfile.id}</span>
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isStreaming ? (
              <button
                type="button"
                onClick={onAbort}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-rose-600/90 hover:bg-rose-500 text-white transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>Durdur</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!value.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white transition-colors cursor-pointer disabled:cursor-not-allowed whitespace-nowrap shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                <span>
                  {modelProfile.category === 'video' && targetDurationSec > 0
                    ? `${targetDurationSec} sn Üret`
                    : 'Gönder'}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
