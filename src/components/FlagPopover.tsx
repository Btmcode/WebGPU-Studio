import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Dices, Check, CornerDownLeft } from 'lucide-react';
import {
  FLAG_DEFINITIONS,
  type ActiveTriggerState,
  type FlagDefinition,
  type FlagValueOption,
} from '../data/flags';
import type { ModelProfile } from '../types/api';

interface FlagPopoverProps {
  trigger: ActiveTriggerState;
  modelProfile: ModelProfile;
  selectedIndex: number;
  onChangeSelectedIndex: (idx: number) => void;
  onSelectFlag: (def: FlagDefinition) => void;
  onSelectValue: (flag: string, value: string) => void;
  onBackToFlags: () => void;
  onClose: () => void;
}

export const FlagPopover: React.FC<FlagPopoverProps> = ({
  trigger,
  modelProfile,
  selectedIndex,
  onChangeSelectedIndex,
  onSelectFlag,
  onSelectValue,
  onBackToFlags,
  onClose,
}) => {
  const [customInput, setCustomInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // Filter and sort flags relevant to active model
  const filteredFlags = React.useMemo(() => {
    const q = trigger.flagQuery.replace(/^--/, '').toLowerCase();
    const list = FLAG_DEFINITIONS.filter((def) => {
      if (!q) return true;
      const matchesFlag = def.flag.toLowerCase().includes(q);
      const matchesAlias = (def.aliases || []).some((a) => a.toLowerCase().includes(q));
      const matchesTitle = def.title.toLowerCase().includes(q);
      return matchesFlag || matchesAlias || matchesTitle;
    });

    return list.sort((a, b) => {
      const aSupported = modelProfile.supportedFlags.includes(a.flag) ? 0 : 1;
      const bSupported = modelProfile.supportedFlags.includes(b.flag) ? 0 : 1;
      if (aSupported !== bSupported) return aSupported - bSupported;
      return 0;
    });
  }, [trigger.flagQuery, modelProfile.supportedFlags]);

  const activeDef = trigger.activeFlagDef;

  const filteredValues = React.useMemo(() => {
    if (!activeDef) return [];
    const q = trigger.valueQuery.toLowerCase().replace(/^"|"$/g, '');
    if (!q) return activeDef.options;
    return activeDef.options.filter(
      (opt) =>
        opt.value.toLowerCase().includes(q) ||
        opt.label.toLowerCase().includes(q) ||
        (opt.hint || '').toLowerCase().includes(q)
    );
  }, [activeDef, trigger.valueQuery]);

  useEffect(() => {
    setCustomInput('');
  }, [trigger.stage, activeDef?.flag]);

  useEffect(() => {
    if (!listRef.current) return;
    const activeEl = listRef.current.querySelector('[data-active="true"]');
    if (activeEl instanceof HTMLElement) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, trigger.stage]);

  const handleChooseOption = (opt: FlagValueOption) => {
    if (!activeDef) return;
    if (activeDef.valueType === 'seed' && opt.value === 'random') {
      const rand = Math.floor(Math.random() * 999999) + 1;
      onSelectValue(activeDef.flag, String(rand));
      return;
    }
    onSelectValue(activeDef.flag, opt.value);
  };

  if (trigger.stage === 'flag') {
    return (
      <div
        role="listbox"
        aria-label="Komut parametreleri"
        className="absolute bottom-full left-0 right-0 mb-2 z-40 rounded-xl border border-white/12 bg-[#141820] shadow-2xl shadow-black/60 overflow-hidden"
      >
        <div className="flex items-center justify-between px-3.5 py-2 border-b border-white/8 bg-[#10131A]">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="font-mono text-blue-400 font-medium">--</span>
            <span>Parametre Seç</span>
            <span aria-hidden="true">·</span>
            <span className="text-slate-500">{modelProfile.id}</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-500">
            <span>↑↓ Gezin</span>
            <span>Enter Seç</span>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
            >
              Esc
            </button>
          </div>
        </div>

        <div ref={listRef} className="max-h-72 overflow-y-auto p-1.5 divide-y divide-white/[0.03]">
          {filteredFlags.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-slate-500">
              Eşleşen parametre bulunamadı. Özel bir değer yazmaya devam edebilirsiniz.
            </div>
          ) : (
            filteredFlags.map((def, idx) => {
              const isSelected = idx === selectedIndex;
              const isRecommended = modelProfile.supportedFlags.includes(def.flag);
              return (
                <button
                  key={def.flag}
                  type="button"
                  data-active={isSelected}
                  onMouseEnter={() => onChangeSelectedIndex(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelectFlag(def);
                  }}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-left transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-blue-500/15 text-slate-100'
                      : 'text-slate-300 hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <span className="font-mono text-xs font-semibold text-blue-400 shrink-0">
                        {def.flag}
                      </span>
                      <span className="text-sm font-medium text-slate-100 truncate">
                        {def.title}
                      </span>
                      {isRecommended && (
                        <span className="text-[11px] text-slate-500 whitespace-nowrap">
                          · önerilen
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5 truncate">{def.description}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 text-xs font-mono text-slate-500">
                    <span>{def.placeholder}</span>
                    {isSelected && <CornerDownLeft className="w-3.5 h-3.5 text-blue-400" />}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    );
  }

  // Stage 2: Value Picker for a specific flag (e.g., --ar -> 16:9, 1:1, 9:16...)
  if (!activeDef) return null;

  return (
    <div
      role="listbox"
      aria-label={`${activeDef.flag} değer seçici`}
      className="absolute bottom-full left-0 right-0 mb-2 z-40 rounded-xl border border-white/12 bg-[#141820] shadow-2xl shadow-black/60 overflow-hidden"
    >
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-white/8 bg-[#10131A]">
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onBackToFlags();
            }}
            className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Parametreler</span>
          </button>
          <span className="text-slate-600">/</span>
          <span className="font-mono font-semibold text-blue-400">{activeDef.flag}</span>
          <span className="text-slate-400 hidden sm:inline">{activeDef.title}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
        >
          Esc Kapat
        </button>
      </div>

      <div ref={listRef} className="p-2.5 max-h-80 overflow-y-auto">
        {activeDef.valueType === 'ratio' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {filteredValues.map((opt, idx) => {
              const isSelected = idx === selectedIndex;
              const w = opt.ratioW || 1;
              const h = opt.ratioH || 1;
              const maxDim = 26;
              const boxW = w >= h ? maxDim : Math.max(10, Math.round((w / h) * maxDim));
              const boxH = h >= w ? maxDim : Math.max(10, Math.round((h / w) * maxDim));

              return (
                <button
                  key={opt.value}
                  type="button"
                  data-active={isSelected}
                  onMouseEnter={() => onChangeSelectedIndex(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleChooseOption(opt);
                  }}
                  className={`flex items-center gap-3 p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                    isSelected
                      ? 'border-blue-500/60 bg-blue-500/15 text-slate-100'
                      : 'border-white/8 bg-[#181C25] text-slate-300 hover:border-white/20 hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="w-8 h-8 flex items-center justify-center shrink-0">
                    <div
                      style={{ width: `${boxW}px`, height: `${boxH}px` }}
                      className={`rounded-[3px] border ${
                        isSelected
                          ? 'border-blue-400 bg-blue-400/20'
                          : 'border-slate-500 bg-slate-700/30'
                      }`}
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-semibold text-slate-100">
                      {opt.value}
                    </div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {opt.hint || opt.label}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredValues.map((opt, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <button
                  key={opt.value}
                  type="button"
                  data-active={isSelected}
                  onMouseEnter={() => onChangeSelectedIndex(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleChooseOption(opt);
                  }}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-blue-500/15 text-slate-100'
                      : 'text-slate-300 hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    {activeDef.valueType === 'seed' && opt.value === 'random' ? (
                      <Dices className="w-4 h-4 text-blue-400 shrink-0" />
                    ) : (
                      <span className="font-mono text-xs font-semibold text-blue-400 shrink-0">
                        {opt.value}
                      </span>
                    )}
                    <span className="text-sm text-slate-200 truncate">{opt.label}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {opt.hint && <span className="text-xs text-slate-400">{opt.hint}</span>}
                    {isSelected && <Check className="w-3.5 h-3.5 text-blue-400" />}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Custom manual entry inside popover for quick numeric/text values */}
        <div className="mt-2.5 pt-2.5 border-t border-white/8 flex items-center gap-2">
          <span className="font-mono text-xs text-slate-400 shrink-0">{activeDef.flag}</span>
          <input
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customInput.trim()) {
                e.preventDefault();
                const val =
                  activeDef.valueType === 'text' &&
                  customInput.includes(' ') &&
                  !customInput.startsWith('"')
                    ? `"${customInput.trim()}"`
                    : customInput.trim();
                onSelectValue(activeDef.flag, val);
              }
            }}
            placeholder={`Özel değer yazın (örn. ${activeDef.placeholder})`}
            className="flex-1 bg-[#0E1116] border border-white/10 rounded-md px-2.5 py-1.5 text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            disabled={!customInput.trim()}
            onMouseDown={(e) => {
              e.preventDefault();
              if (!customInput.trim()) return;
              const val =
                activeDef.valueType === 'text' &&
                customInput.includes(' ') &&
                !customInput.startsWith('"')
                  ? `"${customInput.trim()}"`
                  : customInput.trim();
              onSelectValue(activeDef.flag, val);
            }}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap"
          >
            Uygula
          </button>
        </div>
      </div>
    </div>
  );
};
