import type { ModelCategory, ModelProfile } from '../types/api';

export interface FlagValueOption {
  value: string;
  label: string;
  hint?: string;
  ratioW?: number;
  ratioH?: number;
}

export interface FlagDefinition {
  flag: string;
  aliases?: string[];
  title: string;
  description: string;
  valueType: 'ratio' | 'preset' | 'seed' | 'text';
  placeholder: string;
  categories: ModelCategory[];
  options: FlagValueOption[];
}

export const FLAG_DEFINITIONS: FlagDefinition[] = [
  {
    flag: '--ar',
    aliases: ['--aspect', '--ratio'],
    title: 'Aspect Ratio',
    description: 'Çıktı görsel veya video en-boy oranını belirler',
    valueType: 'ratio',
    placeholder: '16:9',
    categories: ['video', 'image'],
    options: [
      { value: '1:1', label: '1:1 Kare', hint: '544×544 · Dengeli', ratioW: 1, ratioH: 1 },
      { value: '16:9', label: '16:9 Geniş', hint: 'Sinematik yatay', ratioW: 16, ratioH: 9 },
      { value: '9:16', label: '9:16 Dikey', hint: 'Mobil / Reels', ratioW: 9, ratioH: 16 },
      { value: '4:3', label: '4:3 Klasik', hint: 'Standart yatay', ratioW: 4, ratioH: 3 },
      { value: '3:4', label: '3:4 Portre', hint: 'Dikey kadraj', ratioW: 3, ratioH: 4 },
      { value: '21:9', label: '21:9 Ultra', hint: 'Anamorfik geniş', ratioW: 21, ratioH: 9 },
    ],
  },
  {
    flag: '--mode',
    aliases: ['--preset', '--quality'],
    title: 'Çalışma Modu',
    description: 'Hız ve örnekleme kalitesi dengesini seçer',
    valueType: 'preset',
    placeholder: 'fast',
    categories: ['video', 'image', '3d'],
    options: [
      { value: 'fast', label: 'fast', hint: 'Düşük gecikme · 4 adım' },
      { value: 'balanced', label: 'balanced', hint: 'Orta detay ve hız' },
      { value: 'hq', label: 'hq', hint: 'Yüksek keskinlik' },
    ],
  },
  {
    flag: '--seed',
    title: 'Seed (Tohum)',
    description: 'Tekrarlanabilir sonuçlar için sabit rastgelelik değeri',
    valueType: 'seed',
    placeholder: '42',
    categories: ['video', 'image', '3d'],
    options: [
      { value: '42', label: '42', hint: 'Varsayılan referans' },
      { value: '1337', label: '1337', hint: 'Alternatif sabit' },
      { value: '2026', label: '2026', hint: 'Sabit tohum' },
      { value: 'random', label: 'Rastgele Üret', hint: 'Yeni seed oluşturur' },
    ],
  },
  {
    flag: '--steps',
    title: 'Örnekleme Adımı',
    description: 'Denoising adım sayısını ayarlar',
    valueType: 'preset',
    placeholder: '4',
    categories: ['video', 'image', '3d'],
    options: [
      { value: '4', label: '4 steps', hint: 'FlashGen / Turbo ultra hızlı' },
      { value: '8', label: '8 steps', hint: 'Turbo dengeli' },
      { value: '16', label: '16 steps', hint: 'Detaylı doku' },
      { value: '28', label: '28 steps', hint: 'Maksimum kalite' },
    ],
  },
  {
    flag: '--frames',
    aliases: ['--len', '--duration'],
    title: 'Kare Sayısı (Frames)',
    description: 'Video modelleri için üretilecek toplam kare sayısı',
    valueType: 'preset',
    placeholder: '124',
    categories: ['video'],
    options: [
      { value: '49', label: '49 frames', hint: '~2.0 sn klip' },
      { value: '85', label: '85 frames', hint: '~3.5 sn klip' },
      { value: '124', label: '124 frames', hint: '~5.17 sn tam klip' },
      { value: '169', label: '169 frames', hint: '~7.0 sn uzun klip' },
    ],
  },
  {
    flag: '--cfg',
    aliases: ['--guidance'],
    title: 'Guidance Scale (CFG)',
    description: 'Prompta sadakat katsayısı',
    valueType: 'preset',
    placeholder: '3.5',
    categories: ['video', 'image', '3d'],
    options: [
      { value: '1.0', label: '1.0', hint: 'Distilled / CFG-free' },
      { value: '2.5', label: '2.5', hint: 'Doğal akış' },
      { value: '3.5', label: '3.5', hint: 'Dengeli yönlendirme' },
      { value: '5.5', label: '5.5', hint: 'Sıkı prompt uyumu' },
      { value: '7.5', label: '7.5', hint: 'Yüksek kontrast' },
    ],
  },
  {
    flag: '--neg',
    aliases: ['--negative'],
    title: 'Negatif Prompt',
    description: 'İstenmeyen görsel öğeleri hariç tutar',
    valueType: 'text',
    placeholder: '"blurry, distorted"',
    categories: ['video', 'image'],
    options: [
      { value: '"blurry, low quality, artifacts"', label: 'Kalite Filtresi', hint: 'Bulanıklık ve artefakt önler' },
      { value: '"watermark, text, logo"', label: 'Metin & Filigran', hint: 'Yazı ve logo oluşumunu engeller' },
      { value: '"deformed, extra limbs, bad anatomy"', label: 'Anatomi Filtresi', hint: 'Karakter bozulmalarını azaltır' },
    ],
  },
  {
    flag: '--n',
    aliases: ['--batch'],
    title: 'Çıktı Adedi',
    description: 'Tek istekte üretilecek varyasyon sayısı',
    valueType: 'preset',
    placeholder: '1',
    categories: ['image'],
    options: [
      { value: '1', label: '1 çıktı', hint: 'Tekil hızlı üretim' },
      { value: '2', label: '2 çıktı', hint: 'İkili karşılaştırma' },
      { value: '4', label: '4 çıktı', hint: 'Çoklu varyasyon' },
    ],
  },
];

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'minimax-h3': {
    id: 'minimax-h3',
    label: 'MiniMax H3',
    category: 'video',
    summary: 'FlashGen hızlandırılmış metinden ve görselden video üretim modeli',
    defaultRatio: '1:1',
    supportedFlags: ['--ar', '--mode', '--frames', '--steps', '--seed', '--cfg', '--neg'],
    samplePrompt: 'a cat running through sunlit tall grass --ar 16:9 --mode fast --seed 42',
    supportsImageInput: true,
  },
  'z-image-turbo': {
    id: 'z-image-turbo',
    label: 'Z-Image Turbo',
    category: 'image',
    summary: 'Yüksek hızlı yüksek çözünürlüklü görsel üretim modeli',
    defaultRatio: '1:1',
    supportedFlags: ['--ar', '--steps', '--seed', '--cfg', '--neg', '--n'],
    samplePrompt: 'brutalist concrete architecture in morning fog, 35mm film --ar 16:9 --steps 8',
    supportsImageInput: false,
  },
  'krea-2-turbo': {
    id: 'krea-2-turbo',
    label: 'Krea 2 Turbo',
    category: 'image',
    summary: 'Fotogerçekçi ışıklandırma ve doku odaklı hızlı görsel modeli',
    defaultRatio: '16:9',
    supportedFlags: ['--ar', '--steps', '--seed', '--cfg', '--neg', '--n'],
    samplePrompt: 'studio photograph of a brushed aluminum espresso machine --ar 4:3 --seed 1337',
    supportsImageInput: false,
  },
  'qwen-image-2-1-uncensored': {
    id: 'qwen-image-2-1-uncensored',
    label: 'Qwen Image 2.1',
    category: 'image',
    summary: 'Kompozisyon ve metin yerleşimi güçlü çok amaçlı görsel modeli',
    defaultRatio: '1:1',
    supportedFlags: ['--ar', '--steps', '--seed', '--cfg', '--neg', '--n'],
    samplePrompt: 'editorial magazine layout with typography and ceramic sculpture --ar 3:4',
    supportsImageInput: true,
  },
  'idol-turbo': {
    id: 'idol-turbo',
    label: 'Idol Turbo',
    category: 'image',
    summary: 'Portre ve karakter tutarlılığı odaklı hızlı sentez modeli',
    defaultRatio: '3:4',
    supportedFlags: ['--ar', '--steps', '--seed', '--cfg', '--neg'],
    samplePrompt: 'editorial studio portrait, soft window rim light, Leica 50mm --ar 3:4 --seed 42',
    supportsImageInput: true,
  },
  hairdeck: {
    id: 'hairdeck',
    label: 'HairDeck',
    category: 'image',
    summary: 'Saç stili ve görünüm düzenleme odaklı özel model',
    defaultRatio: '3:4',
    supportedFlags: ['--ar', '--steps', '--seed', '--cfg', '--neg'],
    samplePrompt: 'modern textured bob haircut, natural studio daylight --ar 3:4',
    supportsImageInput: true,
  },
  'hunyuan3d-2-1': {
    id: 'hunyuan3d-2-1',
    label: 'Hunyuan3D 2.1',
    category: '3d',
    summary: 'Tek görsel veya metinden PBR dokulu 3D mesh (.glb) üretimi',
    defaultRatio: '1:1',
    supportedFlags: ['--steps', '--seed', '--cfg', '--mode'],
    samplePrompt: 'stylized mechanical brass compass with glass lens --steps 20 --seed 42',
    supportsImageInput: true,
  },
  'hunyuan3d-2-1-mv': {
    id: 'hunyuan3d-2-1-mv',
    label: 'Hunyuan3D 2.1 MV',
    category: '3d',
    summary: 'Çoklu açı (multi-view) destekli yüksek geometri tutarlılıklı 3D modeli',
    defaultRatio: '1:1',
    supportedFlags: ['--steps', '--seed', '--cfg', '--mode'],
    samplePrompt: 'ergonomic carbon fiber racing helmet, clean topology --steps 20 --seed 101',
    supportsImageInput: true,
  },
};

export function getModelProfile(modelId: string): ModelProfile {
  if (MODEL_PROFILES[modelId]) {
    return MODEL_PROFILES[modelId];
  }
  const lower = modelId.toLowerCase();
  const inferredCategory: ModelCategory = lower.includes('3d')
    ? '3d'
    : lower.includes('video') || lower.includes('h3') || lower.includes('minimax')
      ? 'video'
      : 'image';

  return {
    id: modelId,
    label: modelId,
    category: inferredCategory,
    summary: 'webgpu.hrmn.tr/v1 uç noktası üzerinden canlı model',
    defaultRatio: '1:1',
    supportedFlags: ['--ar', '--mode', '--steps', '--seed', '--cfg', '--neg'],
    samplePrompt: 'a cat running --ar 16:9',
    supportsImageInput: true,
  };
}

export interface ParsedFlagToken {
  flag: string;
  canonicalFlag: string;
  value: string;
  raw: string;
  startIndex: number;
  endIndex: number;
}

const ALIAS_TO_CANONICAL = new Map<string, string>();
for (const def of FLAG_DEFINITIONS) {
  ALIAS_TO_CANONICAL.set(def.flag, def.flag);
  for (const alias of def.aliases || []) {
    ALIAS_TO_CANONICAL.set(alias, def.flag);
  }
}

export function getCanonicalFlag(flag: string): string {
  return ALIAS_TO_CANONICAL.get(flag.toLowerCase()) || flag.toLowerCase();
}

export function getFlagDefinition(flag: string): FlagDefinition | undefined {
  const canonical = getCanonicalFlag(flag);
  return FLAG_DEFINITIONS.find((f) => f.flag === canonical);
}

/**
 * Parses inline `--flag value` tokens from a prompt string.
 * Supports quoted values like `--neg "blurry, text"` and unquoted values like `--ar 16:9`.
 */
export function parsePromptFlags(text: string): ParsedFlagToken[] {
  const results: ParsedFlagToken[] = [];
  const regex = /(?:^|\s)(--[a-zA-Z0-9_-]+)(?:\s+("[^"]*"|'[^']*'|[^\s]+))?/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const leadingSpace = match[0].startsWith(' ') || match[0].startsWith('\n') || match[0].startsWith('\t') ? 1 : 0;
    const startIndex = match.index + leadingSpace;
    const endIndex = match.index + match[0].length;
    const flag = match[1];
    const rawValue = match[2] ?? '';

    // Avoid capturing another `--flag` as the value of a valueless flag
    if (rawValue.startsWith('--')) {
      const flagOnlyEnd = startIndex + flag.length;
      results.push({
        flag,
        canonicalFlag: getCanonicalFlag(flag),
        value: '',
        raw: flag,
        startIndex,
        endIndex: flagOnlyEnd,
      });
      regex.lastIndex = flagOnlyEnd;
      continue;
    }

    results.push({
      flag,
      canonicalFlag: getCanonicalFlag(flag),
      value: rawValue,
      raw: match[0].slice(leadingSpace),
      startIndex,
      endIndex,
    });
  }

  return results;
}

export interface ActiveTriggerState {
  stage: 'flag' | 'value';
  flagQuery: string;
  valueQuery: string;
  activeFlagDef?: FlagDefinition;
  replaceStart: number;
  replaceEnd: number;
}

/**
 * Detects whether the user's cursor is currently inside a `--...` flag name
 * or typing a value right after `--flag `.
 */
export function detectActiveFlagTrigger(text: string, cursorPos: number): ActiveTriggerState | null {
  const beforeCursor = text.slice(0, cursorPos);

  // Stage 2: `--flag <partialValue>` (no space after value yet, or inside quotes)
  const valueQuotedMatch = beforeCursor.match(/(?:^|\s)(--[a-zA-Z0-9_-]+)\s+("[^"]*)$/);
  if (valueQuotedMatch) {
    const flagStr = valueQuotedMatch[1];
    const def = getFlagDefinition(flagStr);
    if (def) {
      const leadingLen = valueQuotedMatch[0].startsWith(flagStr) ? 0 : 1;
      const replaceStart = beforeCursor.length - valueQuotedMatch[0].length + leadingLen;
      return {
        stage: 'value',
        flagQuery: def.flag,
        valueQuery: valueQuotedMatch[2],
        activeFlagDef: def,
        replaceStart,
        replaceEnd: cursorPos,
      };
    }
  }

  const valueMatch = beforeCursor.match(/(?:^|\s)(--[a-zA-Z0-9_-]+)\s+([^\s"]*)$/);
  if (valueMatch) {
    const flagStr = valueMatch[1];
    const valuePart = valueMatch[2];
    if (!valuePart.startsWith('--')) {
      const def = getFlagDefinition(flagStr);
      if (def) {
        const leadingLen = valueMatch[0].startsWith(flagStr) ? 0 : 1;
        const replaceStart = beforeCursor.length - valueMatch[0].length + leadingLen;
        return {
          stage: 'value',
          flagQuery: def.flag,
          valueQuery: valuePart,
          activeFlagDef: def,
          replaceStart,
          replaceEnd: cursorPos,
        };
      }
    }
  }

  // Stage 1: `--` or `--ar`
  const flagMatch = beforeCursor.match(/(?:^|\s)(--[a-zA-Z0-9_-]*)$/);
  if (flagMatch) {
    const token = flagMatch[1];
    const leadingLen = flagMatch[0].startsWith(token) ? 0 : 1;
    const replaceStart = beforeCursor.length - flagMatch[0].length + leadingLen;
    return {
      stage: 'flag',
      flagQuery: token.toLowerCase(),
      valueQuery: '',
      replaceStart,
      replaceEnd: cursorPos,
    };
  }

  return null;
}

export function upsertFlagInPrompt(text: string, flag: string, value: string): string {
  const canonical = getCanonicalFlag(flag);
  const tokens = parsePromptFlags(text);
  const existing = tokens.find((t) => t.canonicalFlag === canonical);
  const formattedToken = value ? `${canonical} ${value}` : canonical;

  if (existing) {
    const before = text.slice(0, existing.startIndex);
    const after = text.slice(existing.endIndex);
    return `${before}${formattedToken}${after}`.replace(/ {2,}/g, ' ');
  }

  const trimmedRight = text.replace(/\s+$/, '');
  if (!trimmedRight) {
    return `${formattedToken} `;
  }
  return `${trimmedRight} ${formattedToken} `;
}

export function removeFlagFromPrompt(text: string, flag: string): string {
  const canonical = getCanonicalFlag(flag);
  const tokens = parsePromptFlags(text);
  const existing = tokens.find((t) => t.canonicalFlag === canonical);
  if (!existing) return text;

  const before = text.slice(0, existing.startIndex).replace(/\s+$/, '');
  const after = text.slice(existing.endIndex).replace(/^\s+/, '');
  if (!before && !after) return '';
  if (!before) return after;
  if (!after) return before;
  return `${before} ${after}`;
}
