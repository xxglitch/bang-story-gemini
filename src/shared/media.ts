import type { ModelOption } from './types'

/**
 * The Google models that draw clip images (Nano Banana, through generateContent) and animate them (Veo).
 * One Gemini API key covers both, so there is no separate image/video service to configure.
 *
 * Prices are USD from Google's public pricing page and only used for the on-screen estimate; Google bills
 * the real amount. Check ai.google.dev/gemini-api/docs/pricing when adding or updating a model.
 */

export interface MediaModel {
  id: string
  name: string
  family: 'Nano Banana' | 'Veo'
  kind: 'image' | 'video'
  /** Image models: how many character sheets can go along as references. 0 means sheets are not used. */
  maxRefs: number
  /** Longest prompt we send, in characters. */
  maxPrompt: number
  /** Resolutions the model offers, lowest first. */
  resolutions: string[]
  /** The one used when the project has not picked (or picked something this model lacks). */
  defaultResolution: string
  /** Video models: clip lengths in seconds the model accepts. */
  durations: number[] | null
  /** Video models: resolutions that only work with the longest duration. */
  longOnly: string[]
  /** USD per image (image models) or per second of video (video models), by resolution. */
  usd: Record<string, number>
  tags: string[]
}

export const IMAGE_MODELS: MediaModel[] = [
  {
    id: 'gemini-nano-banana-2.1',
    name: 'Nano Banana 2.1',
    family: 'Nano Banana',
    kind: 'image',
    maxRefs: 6,
    maxPrompt: 6000,
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '2K',
    durations: null,
    longOnly: [],
    usd: { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 },
    tags: ['Referensi']
  },
  {
    id: 'gemini-3.1-flash-image',
    name: 'Nano Banana 2',
    family: 'Nano Banana',
    kind: 'image',
    maxRefs: 6,
    maxPrompt: 6000,
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '2K',
    durations: null,
    longOnly: [],
    usd: { '1K': 0.067, '2K': 0.101, '4K': 0.151 },
    tags: ['Referensi']
  },
  {
    id: 'gemini-3-pro-image',
    name: 'Nano Banana Pro',
    family: 'Nano Banana',
    kind: 'image',
    maxRefs: 6,
    maxPrompt: 6000,
    resolutions: ['1K', '2K', '4K'],
    defaultResolution: '2K',
    durations: null,
    longOnly: [],
    // Approximate: taken from earlier published rates, not re-checked against the current page.
    usd: { '1K': 0.134, '2K': 0.134, '4K': 0.24 },
    tags: ['Referensi', 'Kualitas tertinggi']
  },
  {
    id: 'gemini-3.1-flash-lite-image',
    name: 'Nano Banana 2 Lite',
    family: 'Nano Banana',
    kind: 'image',
    maxRefs: 0,
    maxPrompt: 6000,
    resolutions: ['1K'],
    defaultResolution: '1K',
    durations: null,
    longOnly: [],
    usd: { '1K': 0.0336 },
    tags: ['Hemat']
  }
]

export const VIDEO_MODELS: MediaModel[] = [
  {
    id: 'veo-3.1-lite-generate-preview',
    name: 'Veo 3.1 Lite',
    family: 'Veo',
    kind: 'video',
    maxRefs: 0,
    maxPrompt: 2500,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    durations: [4, 6, 8],
    longOnly: ['1080p'],
    usd: { '720p': 0.05, '1080p': 0.08 },
    tags: ['Hemat']
  },
  {
    id: 'veo-3.1-fast-generate-preview',
    name: 'Veo 3.1 Fast',
    family: 'Veo',
    kind: 'video',
    maxRefs: 0,
    maxPrompt: 2500,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '720p',
    durations: [4, 6, 8],
    longOnly: ['1080p', '4k'],
    usd: { '720p': 0.1, '1080p': 0.12, '4k': 0.3 },
    tags: ['4K']
  },
  {
    id: 'veo-3.1-generate-preview',
    name: 'Veo 3.1',
    family: 'Veo',
    kind: 'video',
    maxRefs: 0,
    maxPrompt: 2500,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '720p',
    durations: [4, 6, 8],
    longOnly: ['1080p', '4k'],
    usd: { '720p': 0.4, '1080p': 0.4, '4k': 0.6 },
    tags: ['Kualitas tertinggi', '4K']
  }
]

/** Cheap enough to try freely, and the one model with references that is also the lowest-priced. */
export const DEFAULT_IMAGE_MODEL = 'gemini-nano-banana-2.1'
export const DEFAULT_VIDEO_MODEL = 'veo-3.1-lite-generate-preview'

export function getImageModel(id: string | null | undefined): MediaModel {
  return IMAGE_MODELS.find((m) => m.id === id) ?? IMAGE_MODELS.find((m) => m.id === DEFAULT_IMAGE_MODEL)!
}

export function getVideoModel(id: string | null | undefined): MediaModel {
  return VIDEO_MODELS.find((m) => m.id === id) ?? VIDEO_MODELS.find((m) => m.id === DEFAULT_VIDEO_MODEL)!
}

/** How many character sheets an image model accepts as references. 0 means sheets are not used. */
export function maxRefs(m: MediaModel): number {
  return m.kind === 'image' ? m.maxRefs : 0
}

export function promptLimit(m: MediaModel): number {
  return m.maxPrompt
}

/** The resolution a request uses: the project's pick when this model offers it, else the model's default. */
export function effectiveResolution(m: MediaModel, want?: string | null): string {
  return want && m.resolutions.includes(want) ? want : m.defaultResolution
}

/** Resolutions a model offers, lowest first, as picker values. */
export function resolutionOptions(m: MediaModel): string[] {
  return m.resolutions
}

/**
 * The video length to request for a clip: the shortest allowed length that covers it, or the longest.
 * Veo only renders 1080p and 4K at the longest length, whatever the clip needs.
 */
export function fitDuration(m: MediaModel, seconds: number, resolution?: string | null): number | null {
  if (!m.durations) return null
  const values = [...m.durations].sort((a, b) => a - b)
  if (m.longOnly.includes(effectiveResolution(m, resolution))) return values[values.length - 1]
  const want = Math.max(1, Math.ceil(seconds))
  return values.find((v) => v >= want) ?? values[values.length - 1]
}

export function durationLabel(m: MediaModel): string | null {
  return m.durations ? `${m.durations.join(' / ')} dtk` : null
}

/** Estimated USD for one image, or for one clip video of about `seconds`. */
export function estimateUsd(m: MediaModel, resolution?: string | null, seconds = 5): number | null {
  const rate = m.usd[effectiveResolution(m, resolution)]
  if (rate === undefined) return null
  return m.kind === 'image' ? rate : rate * (fitDuration(m, seconds, resolution) ?? seconds)
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return (space > limit * 0.8 ? cut.slice(0, space) : cut).trim()
}

/** The image prompt, cut to the model's limit. */
export function imagePrompt(m: MediaModel, prompt: string): string {
  return clip(prompt, promptLimit(m))
}

/**
 * Said in every video prompt. Narration and music are added in the editor, but Veo always makes its own
 * soundtrack and has no switch for it.
 */
export const NO_MUSIC = 'Silent clip: no background music, no soundtrack, no singing or humming.'

/** The video prompt with the no-music rule, trimmed so the rule itself never gets cut off. */
export function videoPrompt(m: MediaModel, prompt: string): string {
  return `${clip(prompt.trim(), promptLimit(m) - NO_MUSIC.length - 1)} ${NO_MUSIC}`
}

/** What the app will actually request from this model, in words. */
export function describeModel(m: MediaModel): string {
  if (m.kind === 'image') {
    return [m.maxRefs ? `pakai lembar karakter (maks ${m.maxRefs})` : 'tanpa lembar karakter', `hasil ${m.defaultResolution}`].join(' · ')
  }
  return [durationLabel(m), m.resolutions.map((r) => r.toUpperCase().replace(/^(\d+)P$/, '$1p')).join(' / '), 'mulai dari gambar klip'].filter(Boolean).join(' · ')
}

/** Picker rows with the recommended model first and each model's estimated price for this project. */
export function modelOptions(kind: 'image' | 'video', ctx: { resolution?: string | null; seconds?: number } = {}): ModelOption[] {
  const list = kind === 'image' ? IMAGE_MODELS : VIDEO_MODELS
  const recommended = kind === 'image' ? DEFAULT_IMAGE_MODEL : DEFAULT_VIDEO_MODEL
  return [...list.filter((m) => m.id === recommended), ...list.filter((m) => m.id !== recommended)].map((m) => ({
    id: m.id,
    name: m.name,
    family: m.family,
    description: describeModel(m),
    tags: m.id === recommended ? ['Rekomendasi', ...m.tags] : m.tags,
    usd: estimateUsd(m, kind === 'video' ? ctx.resolution : undefined, ctx.seconds),
    costUnit: kind === 'video' ? `${fitDuration(m, ctx.seconds ?? 5, ctx.resolution)} dtk` : 'per gambar'
  }))
}
