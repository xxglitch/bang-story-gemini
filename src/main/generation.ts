import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { estimateWordTimings } from '@shared/captions'
import { stripVoiceTags } from '@shared/speech'
import { effectiveResolution, getImageModel, getVideoModel, maxRefs, promptLimit, type MediaModel } from '@shared/media'
import { getStyle } from '@shared/styles'
import type { Asset, Character, Clip, Job, Project, WordTiming } from '@shared/types'
import { getDb } from './db'
import { emit } from './events'
import { runJob, type TaskCtx } from './jobs'
import { assetAbsPath } from './paths'
import {
  activeJobFor,
  charactersOf,
  clipsOf,
  getAsset,
  getCharacter,
  getClip,
  getJob,
  getProject,
  insertAsset,
  insertJob,
  patchClip,
  setCharacterSheet,
  touchProject,
  unfinishedJobs,
  updateJob
} from './repo'
import { getSettings } from './settings'
import { probeDurationMs, probeSize } from './services/audio'
import * as eleven from './services/elevenlabs'
import * as gemini from './services/gemini'
import * as media from './services/geminiMedia'
import { sleep } from './services/http'

function extFromType(contentType: string, fallback: string): string {
  if (/png/.test(contentType)) return '.png'
  if (/jpe?g/.test(contentType)) return '.jpg'
  if (/webp/.test(contentType)) return '.webp'
  if (/mp4/.test(contentType)) return '.mp4'
  return fallback
}

function saveFile(projectId: string, folder: string, ext: string, bytes: Buffer): string {
  const rel = `${folder}/${randomUUID()}${ext}`
  const abs = assetAbsPath(projectId, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  return rel
}

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** A stored picture as bytes for Gemini, which takes images inline (no upload step). */
function loadInline(asset: Asset): media.InlineImage {
  const abs = assetAbsPath(asset.projectId, asset.localPath)
  return { bytes: readFileSync(abs), mimeType: IMAGE_MIME[extname(abs).toLowerCase()] ?? 'image/png' }
}

/** Image requests answer in one go, so progress is a gentle curve toward "almost done" while we wait. */
async function withProgress<T>(ctx: TaskCtx, what: string, expectedMs: number, run: () => Promise<T>): Promise<T> {
  const started = Date.now()
  const tick = (): void => ctx.progress(0.12 + 0.78 * (1 - Math.exp(-(Date.now() - started) / expectedMs)), what)
  tick()
  const timer = setInterval(tick, 1000)
  try {
    return await run()
  } finally {
    clearInterval(timer)
  }
}

// ---------- prompts ----------

function characterLine(c: Character): string {
  return `${c.name}: ${c.description}`
}

/** Splits the storyboard's "Avoid:" line off the scene, so it can be phrased as a clear instruction. */
function splitAvoid(visual: string): { scene: string; avoid: string } {
  const lines = visual.split('\n')
  const i = lines.findIndex((l) => /^\s*avoid\s*:/i.test(l))
  if (i < 0) return { scene: visual.trim(), avoid: '' }
  const avoid = lines[i].replace(/^\s*avoid\s*:\s*/i, '').replace(/\.$/, '').trim()
  lines.splice(i, 1)
  return { scene: lines.join('\n').trim(), avoid }
}

/**
 * The image prompt for a clip. The scene comes first so the model gets the content right, then who the
 * characters are, then the art style. Clothing follows the scene's Wardrobe line when it has one, so a
 * character can change out of the outfit on their reference sheet (no spacesuit indoors).
 */
function clipPrompt(project: Project, clip: Clip, chars: Character[], refNames: string[], limit: number): string {
  const style = getStyle(project.styleId)
  const { scene, avoid } = splitAvoid(clip.visualPrompt)
  const wardrobe = /^\s*wardrobe\s*:/im.test(scene)
  const parts = [`Scene:\n${scene}`]
  if (chars.length)
    parts.push(
      `Recurring characters in this scene. Keep each one's body, face, hair and skin exactly as described${refNames.length ? ' and as on their reference sheet' : ''}.` +
        (wardrobe
          ? ' Their clothing follows the Wardrobe line of the scene: the default outfit only where it says so, otherwise the custom outfit.'
          : ' They wear their default outfit.') +
        `\n${chars.map(characterLine).join('\n')}`
    )
  if (refNames.length)
    parts.push(
      `Reference images are character sheets, in this order: ${refNames.join(', ')}. Use them for each character's identity, proportions and colors. ` +
        (wardrobe ? 'Copy the costume from a sheet only for characters whose Wardrobe line says "default outfit". ' : 'Match the costume to the sheet. ') +
        'Do not copy the sheet layout, poses or plain background.'
    )
  parts.push(`Art style: ${style.prompt}`)
  if (avoid) parts.push(`Must not appear in the image: ${avoid}.`)
  parts.push(`Frame format ${project.aspectRatio}, full-bleed composition.`)
  const full = parts.join('\n\n')
  if (full.length <= limit) return full
  // Models with short prompt limits get the scene first, so trimming only loses style detail.
  return [scene, chars.map(characterLine).join('; '), avoid && `Must not appear: ${avoid}.`, style.prompt].filter(Boolean).join('\n\n')
}

function sheetPrompt(project: Project, c: Character): string {
  const style = getStyle(project.styleId)
  return [
    style.prompt,
    `Character reference sheet for "${c.name}": ${c.description}. The character is ${style.characterHint}.`,
    'Show the SAME character three times side by side: front view, three-quarter view and side view, full body, neutral standing pose, evenly spaced, on a plain light neutral background (this overrides any background instruction above). Consistent proportions, costume and colors in all three views.'
  ].join('\n\n')
}

// ---------- waiting for character sheets ----------

async function waitForSheets(characterIds: string[], signal: AbortSignal): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 15 * 60 * 1000) {
    const pending = characterIds.some((id) => activeJobFor({ characterId: id }, 'sheet'))
    if (!pending) return
    await sleep(2000, signal)
  }
}

/** Character sheets as inline reference images, in character order, so the prompt can name them in the same order. */
async function referenceImages(model: MediaModel, chars: Character[], signal: AbortSignal): Promise<{ images: media.InlineImage[]; names: string[] }> {
  const limit = maxRefs(model)
  if (limit === 0) return { images: [], names: [] }
  await waitForSheets(
    chars.map((c) => c.id),
    signal
  )
  const images: media.InlineImage[] = []
  const names: string[] = []
  for (const c of chars) {
    const fresh = getCharacter(c.id)
    const sheet = getAsset(fresh.sheetAssetId)
    if (!sheet || images.length >= limit) continue
    images.push(loadInline(sheet))
    names.push(fresh.name)
  }
  return { images, names }
}

// ---------- storing a finished picture or video ----------

interface MediaPayload {
  target: 'clip-image' | 'sheet' | 'clip-video'
  model: string
  prompt: string
}

/** Saves the result as an asset and attaches it to its clip or character. `remoteId` is the Veo operation, when there is one. */
async function storeMedia(job: Job, payload: MediaPayload, bytes: Buffer, contentType: string, remoteId?: string): Promise<string> {
  const isVideo = payload.target === 'clip-video'
  const rel = saveFile(job.projectId, isVideo ? 'videos' : 'images', extFromType(contentType, isVideo ? '.mp4' : '.png'), bytes)
  const abs = assetAbsPath(job.projectId, rel)
  const size = await probeSize(abs)
  const durationMs = isVideo ? await probeDurationMs(abs).catch(() => null) : null
  const asset = insertAsset({
    projectId: job.projectId,
    clipId: job.clipId,
    characterId: job.characterId,
    kind: isVideo ? 'video' : 'image',
    provider: 'gemini',
    model: payload.model,
    prompt: payload.prompt,
    remoteId,
    localPath: rel,
    durationMs,
    width: size?.width ?? null,
    height: size?.height ?? null
  })
  emit.asset(asset)
  if (payload.target === 'sheet' && job.characterId) {
    setCharacterSheet(job.characterId, asset.id)
    emit.character({ characterId: job.characterId, patch: { sheetAssetId: asset.id } })
  } else if (payload.target === 'clip-image' && job.clipId) {
    patchClip(job.clipId, { imageAssetId: asset.id })
    emit.clip({ clipId: job.clipId, patch: { imageAssetId: asset.id } })
    const project = getProject(job.projectId)
    const first = clipsOf(job.projectId)[0]
    if (!project.coverAssetId || first?.id === job.clipId) touchProject(job.projectId, { coverAssetId: asset.id })
  } else if (payload.target === 'clip-video' && job.clipId) {
    const patch = { videoAssetId: asset.id, motionType: 'video' as const, mediaInMs: 0 }
    patchClip(job.clipId, patch)
    emit.clip({ clipId: job.clipId, patch })
  }
  touchProject(job.projectId)
  return asset.id
}

function startMedia(job: Job, task: (ctx: TaskCtx) => Promise<string>): Job {
  emit.job(job)
  return runJob(job, 'media', task)
}

/** Only video jobs keep a payload: it is what lets a restart resume polling the Veo operation. */
function updateJobPayload(jobId: string, payload: MediaPayload): void {
  getDb().prepare('UPDATE jobs SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), jobId)
}

/** Waits for a Veo operation (new or resumed after a restart), downloads the file and stores it. */
async function finishVideo(ctx: TaskCtx, job: Job, operation: string, payload: MediaPayload): Promise<string> {
  const uri = await media.waitForVideo(
    operation,
    (elapsed) => ctx.progress(0.12 + 0.78 * (1 - Math.exp(-elapsed / 120_000)), 'Membuat video'),
    ctx.signal
  )
  ctx.progress(0.93, 'Mengunduh hasil')
  const { bytes, contentType } = await media.downloadVideo(uri, ctx.signal)
  return storeMedia(job, payload, bytes, contentType, operation)
}

// ---------- public entry points ----------

export function generateClipImage(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'image')
  if (existing) return existing
  const clip = getClip(clipId)
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'image', provider: 'gemini' })
  return startMedia(job, async (ctx) => {
    ctx.progress(0.04, 'Menyiapkan prompt')
    const fresh = getClip(clipId)
    const project = getProject(fresh.projectId)
    const model = getImageModel(project.imageModel)
    const chars = charactersOf(project.id).filter((c) => fresh.characterIds.includes(c.id))
    const refs = await referenceImages(model, chars, ctx.signal)
    const prompt = clipPrompt(project, fresh, chars, refs.names, promptLimit(model))
    const image = await withProgress(ctx, 'Membuat gambar', 40_000, () =>
      media.generateImage(model, prompt, project.aspectRatio, null, refs.images, ctx.signal)
    )
    ctx.progress(0.93, 'Menyimpan hasil')
    return storeMedia(job, { target: 'clip-image', model: model.id, prompt }, image.bytes, image.mimeType)
  })
}

export function generateCharacterSheet(characterId: string): Job {
  const existing = activeJobFor({ characterId }, 'sheet')
  if (existing) return existing
  const c = getCharacter(characterId)
  const job = insertJob({ projectId: c.projectId, characterId, kind: 'sheet', provider: 'gemini' })
  return startMedia(job, async (ctx) => {
    ctx.progress(0.04, 'Menyiapkan prompt')
    const project = getProject(c.projectId)
    const model = getImageModel(project.imageModel)
    const prompt = sheetPrompt(project, getCharacter(characterId))
    // The sheet shows three views side by side, so it is always wide whatever the video's frame is.
    const image = await withProgress(ctx, 'Membuat lembar karakter', 40_000, () =>
      media.generateImage(model, prompt, '16:9', null, [], ctx.signal)
    )
    ctx.progress(0.93, 'Menyimpan hasil')
    return storeMedia(job, { target: 'sheet', model: model.id, prompt }, image.bytes, image.mimeType)
  })
}

export function generateClipVideo(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'video')
  if (existing) return existing
  const clip = getClip(clipId)
  if (!clip.imageAssetId) throw new Error('Buat gambar klip ini dulu sebelum membuat video AI.')
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'video', provider: 'gemini' })
  return startMedia(job, async (ctx) => {
    const fresh = getClip(clipId)
    const image = getAsset(fresh.imageAssetId)
    if (!image) throw new Error('Gambar klip tidak ditemukan')
    const project = getProject(fresh.projectId)
    const model = getVideoModel(project.videoModel)
    ctx.progress(0.05, 'Menyiapkan gambar awal')
    const firstFrame = loadInline(image)
    const prompt =
      fresh.videoPrompt.trim() ||
      `${splitAvoid(fresh.visualPrompt).scene.replace(/\.$/, '')}. Subtle natural motion of the characters and environment, the camera slowly pushes in. Keep the art style of the first frame.`
    ctx.progress(0.08, 'Mengirim ke Gemini')
    const operation = await media.startVideo(
      model,
      prompt,
      firstFrame,
      fresh.durationMs / 1000,
      project.aspectRatio,
      effectiveResolution(model, project.videoResolution),
      ctx.signal
    )
    ctx.setRemote(operation)
    const payload: MediaPayload = { target: 'clip-video', model: model.id, prompt }
    updateJobPayload(job.id, payload)
    return finishVideo(ctx, job, operation, payload)
  })
}

export function generateClipTts(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'tts')
  if (existing) return existing
  const clip = getClip(clipId)
  const project = getProject(clip.projectId)
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'tts', provider: project.ttsProvider })
  emit.job(job)
  return runJob(job, 'tts', async (ctx) => {
    const fresh = getClip(clipId)
    const p = getProject(fresh.projectId)
    const text = fresh.narration.trim()
    if (!text) throw new Error('Naskah klip ini masih kosong')
    ctx.progress(0.2, 'Membuat suara')
    let rel: string
    let words: WordTiming[] | undefined
    let estimated = false
    const voice = p.ttsVoice || (p.ttsProvider === 'gemini' ? 'Charon' : '')
    if (p.ttsProvider === 'elevenlabs') {
      if (!voice) throw new Error('Pilih suara ElevenLabs dulu di langkah Ide cerita.')
      const out = await eleven.speak(text, voice, p.language, ctx.signal)
      rel = saveFile(p.id, 'audio', '.mp3', out.audio)
      words = out.words
    } else {
      const wav = await gemini.speak(text, voice, p.language, ctx.signal)
      rel = saveFile(p.id, 'audio', '.wav', wav)
    }
    ctx.progress(0.85, 'Mengukur durasi')
    const audioMs = await probeDurationMs(assetAbsPath(p.id, rel))
    if (!words?.length) {
      words = estimateWordTimings(stripVoiceTags(text), audioMs / 1000)
      estimated = true
    }
    const asset = insertAsset({
      projectId: p.id,
      clipId,
      kind: 'audio',
      provider: p.ttsProvider,
      model: p.ttsProvider === 'gemini' ? getSettings().geminiTtsModel : getSettings().elevenModel,
      prompt: text,
      localPath: rel,
      durationMs: audioMs,
      meta: { words, estimatedTimings: estimated, voice }
    })
    emit.asset(asset)
    const durationMs = Math.max(1500, audioMs + 400)
    const patch = { audioAssetId: asset.id, durationMs, voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
    patchClip(clipId, patch)
    emit.clip({ clipId, patch })
    touchProject(p.id)
    return asset.id
  })
}

export function generateMissingImages(projectId: string): Job[] {
  const jobs: Job[] = []
  const project = getProject(projectId)
  const model = getImageModel(project.imageModel)
  if (maxRefs(model) > 0) {
    const needed = new Set(clipsOf(projectId).flatMap((c) => c.characterIds))
    for (const c of charactersOf(projectId)) {
      if (needed.has(c.id) && !c.sheetAssetId) jobs.push(generateCharacterSheet(c.id))
    }
  }
  for (const clip of clipsOf(projectId)) {
    if (!clip.imageAssetId) jobs.push(generateClipImage(clip.id))
  }
  return jobs
}

/** Turns every clip that has an image but no AI video yet into a video. */
export function generateMissingVideos(projectId: string): Job[] {
  const clips = clipsOf(projectId)
  if (clips.some((c) => !c.imageAssetId)) throw new Error('Buat gambar semua klip dulu sebelum menjadikannya video.')
  return clips.filter((c) => !c.videoAssetId).map((c) => generateClipVideo(c.id))
}

export function generateMissingTts(projectId: string): Job[] {
  return clipsOf(projectId)
    .filter((c) => !c.audioAssetId && c.narration.trim())
    .map((c) => generateClipTts(c.id))
}

/** After a restart, keep polling Veo operations that were already submitted; pictures answer in one request, so those fail. */
export function resumeJobs(): void {
  for (const row of unfinishedJobs()) {
    const payload = JSON.parse(row.payload_json || '{}') as Partial<MediaPayload>
    if (row.provider === 'gemini' && row.remote_id && payload.target === 'clip-video') {
      const job = getJob(row.id)!
      runJob(job, 'media', (ctx) => finishVideo(ctx, job, row.remote_id, payload as MediaPayload))
    } else {
      emit.job(updateJob(row.id, { status: 'failed', error: 'Terhenti karena aplikasi ditutup. Coba lagi.', message: null }))
    }
  }
}

export async function setActiveAsset(clipId: string, assetId: string): Promise<void> {
  const asset = getAsset(assetId)
  if (!asset || asset.clipId !== clipId) throw new Error('Aset tidak cocok dengan klip ini')
  const patch: Partial<Clip> =
    asset.kind === 'image'
      ? { imageAssetId: asset.id }
      : asset.kind === 'video'
        ? { videoAssetId: asset.id, mediaInMs: 0 }
        : asset.kind === 'audio'
          ? { audioAssetId: asset.id, durationMs: Math.max(1500, (asset.durationMs ?? 0) + 400), voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
          : {}
  patchClip(clipId, patch)
  emit.clip({ clipId, patch })
}
