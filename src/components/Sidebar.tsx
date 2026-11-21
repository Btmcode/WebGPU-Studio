import React, { useMemo, useState } from 'react';
import {
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Film,
  Image as ImageIcon,
  Box,
  MessageSquare,
  X,
} from 'lucide-react';
import { getModelProfile } from '../data/flags';
import type { ApiModel, ChatSession, ModelCategory } from '../types/api';

interface SidebarProps {
  models: ApiModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  activeModelId: string;
  isStreaming?: boolean;
  onSelectModel: (modelId: string) => void;
  onRefreshModels: () => void;
  sessions: ChatSession[];
  activeSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
}

function getCategoryIcon(category: ModelCategory) {
  switch (category) {
    case 'video':
      return <Film className="w-3.5 h-3.5 text-blue-400 shrink-0" />;
    case '3d':
      return <Box className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    default:
      return <ImageIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
  }
}

function getCategoryLabel(category: ModelCategory): string {
  switch (category) {
    case 'video':
      return 'video';
    case '3d':
      return '3d';
    default:
      return 'görsel';
  }
}

export const Sidebar: React.FC<SidebarProps> = ({
  models,
  modelsLoading,
  modelsError,
  activeModelId,
  isStreaming = false,
  onSelectModel,
  onRefreshModels,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  isOpenMobile,
  onCloseMobile,
}) => {
  const [modelQuery, setModelQuery] = useState('');

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q));
  }, [models, modelQuery]);

  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#0F1218] border-r border-white/8 select-none">
      {/* Studio Brand & New Session */}
      <div className="px-4 py-4 border-b border-white/8 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-display text-sm font-semibold tracking-tight text-slate-100 whitespace-nowrap truncate">
            WebGPU Studio
          </div>
          <div className="text-[11px] font-mono text-slate-500 truncate">
            webgpu.hrmn.tr/v1
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onNewSession}
            disabled={isStreaming}
            title={isStreaming ? 'Üretim devam ederken yeni sohbet açılamaz' : 'Yeni Sohbet Başlat'}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-45 disabled:cursor-not-allowed text-xs font-medium text-white transition-colors cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Yeni</span>
          </button>
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Kenar çubuğunu kapat"
            className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Live /v1/models Section */}
      <div className="px-3 pt-3.5 pb-2 border-b border-white/8 flex-1 min-h-0 flex flex-col">
        <div className="flex items-center justify-between px-1 mb-2">
          <span className="text-xs font-medium text-slate-300">
            Modeller ({models.length})
          </span>
          <button
            type="button"
            onClick={onRefreshModels}
            disabled={modelsLoading}
            title="/v1/models listesini yenile"
            className="p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-white/[0.05] disabled:opacity-40 transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${modelsLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="relative mb-2">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={modelQuery}
            onChange={(e) => setModelQuery(e.target.value)}
            placeholder="Model ara..."
            className="w-full bg-[#151922] border border-white/8 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/60"
          />
        </div>

        {modelsError && (
          <div className="mx-1 mb-2 p-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-xs text-rose-300">
            <p className="mb-1.5">{modelsError}</p>
            <button
              type="button"
              onClick={onRefreshModels}
              className="text-[11px] font-medium underline hover:text-rose-200 cursor-pointer"
            >
              Tekrar Dene
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto space-y-0.5 pr-0.5">
          {modelsLoading && models.length === 0 ? (
            Array.from({ length: 6 }).map((_, idx) => (
              <div
                key={idx}
                className="h-9 rounded-lg bg-white/[0.03] animate-pulse mx-0.5 mb-1"
              />
            ))
          ) : filteredModels.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-500">
              Model bulunamadı
            </div>
          ) : (
            filteredModels.map((model) => {
              const profile = getModelProfile(model.id);
              const isActive = model.id === activeModelId;
              return (
                <button
                  key={model.id}
                  type="button"
                  disabled={isStreaming && !isActive}
                  onClick={() => {
                    onSelectModel(model.id);
                    onCloseMobile();
                  }}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-left transition-colors ${
                    isActive
                      ? 'bg-blue-500/15 text-slate-100 border border-blue-500/30 cursor-pointer'
                      : isStreaming
                        ? 'text-slate-500 border border-transparent opacity-50 cursor-not-allowed'
                        : 'text-slate-300 hover:bg-white/[0.04] border border-transparent cursor-pointer'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {getCategoryIcon(profile.category)}
                    <span className="font-mono text-xs truncate">{model.id}</span>
                  </div>
                  <span className="text-[11px] text-slate-500 shrink-0">
                    {getCategoryLabel(profile.category)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Chat Sessions History */}
      <div className="px-3 py-3 max-h-[38%] flex flex-col min-h-[140px]">
        <div className="flex items-center justify-between px-1 mb-2">
          <span className="text-xs font-medium text-slate-300">Sohbet Geçmişi</span>
          <span className="text-[11px] text-slate-500 tabular-nums">{sessions.length}</span>
        </div>

        <div className="flex-1 overflow-y-auto space-y-0.5 pr-0.5">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <div
                key={session.id}
                className={`group flex items-center justify-between gap-1.5 px-2.5 py-2 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-white/[0.07] text-slate-100'
                    : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelectSession(session.id);
                    onCloseMobile();
                  }}
                  className="flex-1 flex items-center gap-2 min-w-0 text-left cursor-pointer"
                >
                  <MessageSquare className="w-3.5 h-3.5 shrink-0 text-slate-500" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs truncate">{session.title || 'Yeni Sohbet'}</div>
                    <div className="text-[11px] text-slate-500 font-mono truncate">
                      {session.model} · {session.messages.length} ileti
                    </div>
                  </div>
                </button>
                {sessions.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onDeleteSession(session.id)}
                    title="Oturumu Sil"
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded text-slate-500 hover:text-rose-400 transition-opacity cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop persistent sidebar */}
      <aside className="hidden lg:block w-[272px] shrink-0 h-full">{sidebarContent}</aside>

      {/* Mobile slide-over drawer */}
      {isOpenMobile && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative w-[280px] max-w-[85vw] h-full z-10">{sidebarContent}</aside>
        </div>
      )}
    </>
  );
};
