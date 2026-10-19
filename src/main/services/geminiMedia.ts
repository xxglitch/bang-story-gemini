import { GoogleGenAI } from '@google/genai'
import { app } from 'electron'
import { effectiveResolution, fitDuration, imagePrompt, videoPrompt, type MediaModel } from '@shared/media'
import type { AspectRatio } from '@shared/types'
import { requireSecret } from '../secrets'
import { ApiError, readError, sleep } from './http'

/**
 * Pictures (Nano Banana, through generateContent) and video (Veo) from the user's Gemini key.
 * Images come back in the response. Veo is a long-running operation: it is submitted, polled by name, and
 * downloaded from a file URI. The operation name is saved on the job, so a restart can pick polling back up.
 */

const GOOGLE = 'https://generativelanguage.googleapis.com'
// Development builds can point at a local mock (STUDIO_GEMINI_BASE) to test the UI without spending money.
const OVERRIDE = (!app.isPackaged && process.env.STUDIO_GEMINI_BASE) || null
const API = `${OVERRIDE ?? GOOGLE}/v1beta`

export interface InlineImage {
  bytes: Buffer
  mimeType: string
}

const BILLING_HINT = 'Veo dan sebagian model gambar butuh akun Google AI dengan penagihan (billing) aktif.'

function fromStatus(status: number, detail: string): ApiError {
  if (status === 401 || status === 403)
    return new ApiError(`Kunci Gemini ditolak atau belum punya akses ke model ini. ${BILLING_HINT}`, status)
  if (status === 404) return new ApiError(`Model ini belum tersedia untuk kunci Gemini kamu (${detail}).`, status)
  if (status === 429) return new ApiError('Kuota Gemini habis atau terlalu banyak permintaan bersamaan. Coba lagi sebentar.', status, true)
  if (status >= 500) return new ApiError(`Server Gemini sedang bermasalah (${status}).`, status, true)
  if (/billing|paid|free tier|quota/i.test(detail)) return new ApiError(`${detail}. ${BILLING_HINT}`, status)
  return new ApiError(`Gemini menolak permintaan: ${detail}`, status)
}

/** Maps what the SDK throws (it only gives a message) onto the same errors as the REST calls. */
function fromSdk(e: unknown): ApiError {
  if (e instanceof ApiError) return e
  const msg = (e as Error)?.message ?? String(e)
  const code = Number((e as { status?: number })?.status) || Number(/\b(4\d\d|5\d\d)\b/.exec(msg)?.[1]) || 0
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)) return fromStatus(403, msg)
  if (/RESOURCE_EXHAUSTED/i.test(msg)) return fromStatus(429, msg)
  if (/UNAVAILABLE|overloaded|INTERNAL/i.test(msg)) return fromStatus(503, msg)
  if (/not found|NOT_FOUND/i.test(msg)) return fromStatus(404, msg)
  return code ? fromStatus(code, msg) : new ApiError(`Gemini gagal: ${msg}`, 0)
}

async function retrying<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (e) {
      if (signal?.aborted) throw new Error('Dibatalkan')
      const err = fromSdk(e)
      if (err.retryable && attempt < 5) {
        await sleep(5000 + attempt * 5000, signal)
        continue
      }
      throw err
    }
  }
}

function noImageReason(res: {
  promptFeedback?: { blockReason?: string }
  candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[]
}): string {
  const finish = res.candidates?.[0]?.finishReason
  if (res.promptFeedback?.blockReason || (finish && /SAFETY|PROHIBITED|BLOCK|RECITATION/i.test(finish)))
    return 'Ditolak filter keamanan Gemini. Ubah prompt lalu coba lagi.'
  const text = res.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text?.trim()
  return `Gemini tidak mengirim gambar${text ? `: ${text.slice(0, 200)}` : ''}`
}

/** One picture. Character sheets go first as reference images, then the prompt. */
export async function generateImage(
  model: MediaModel,
  prompt: string,
  aspect: AspectRatio,
  resolution: string | null | undefined,
  refs: InlineImage[],
  signal?: AbortSignal
): Promise<InlineImage> {
  const ai = new GoogleGenAI({ apiKey: requireSecret('gemini'), ...(OVERRIDE ? { httpOptions: { baseUrl: OVERRIDE } } : {}) })
  const parts = [
    ...refs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.bytes.toString('base64') } })),
    { text: imagePrompt(model, prompt) }
  ]
  return retrying(signal, async () => {
    const res = await ai.models.generateContent({
      model: model.id,
      contents: [{ role: 'user', parts }],
      config: {
        abortSignal: signal,
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: aspect, imageSize: effectiveResolution(model, resolution) }
      }
    })
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
    if (!part?.inlineData?.data) throw new ApiError(noImageReason(res), 0)
    return { bytes: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType ?? 'image/png' }
  })
}

async function rest<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const res = await fetch(`${API}/${path.replace(/^\//, '')}`, {
    method: init.method,
    headers: { 'x-goog-api-key': requireSecret('gemini'), 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal
  })
  if (!res.ok) throw fromStatus(res.status, await readError(res))
  return (await res.json()) as T
}

/** Submits an image-to-video request and returns the operation name to poll. */
export async function startVideo(
  model: MediaModel,
  prompt: string,
  firstFrame: InlineImage,
  seconds: number,
  aspect: AspectRatio,
  resolution: string | null | undefined,
  signal?: AbortSignal
): Promise<string> {
  const res = effectiveResolution(model, resolution)
  const body = {
    instances: [
      {
        prompt: videoPrompt(model, prompt),
        image: { bytesBase64Encoded: firstFrame.bytes.toString('base64'), mimeType: firstFrame.mimeType }
      }
    ],
    parameters: { aspectRatio: aspect, resolution: res, durationSeconds: fitDuration(model, seconds, res) }
  }
  const out = await retrying(signal, () => rest<{ name?: string }>(`models/${model.id}:predictLongRunning`, { method: 'POST', body, signal }))
  if (!out.name) throw new Error('Gemini tidak mengirim nomor proses video')
  return out.name
}

interface VideoOperation {
  done?: boolean
  error?: { message?: string }
  response?: {
    generateVideoResponse?: {
      generatedSamples?: { video?: { uri?: string } }[]
      raiMediaFilteredCount?: number
      raiMediaFilteredReasons?: string[]
    }
  }
}

/** Polls the operation every few seconds (Veo takes minutes) and returns the URI of the finished video. */
export async function waitForVideo(
  operation: string,
  onTick: (elapsedMs: number) => void,
  signal?: AbortSignal,
  timeoutMs = 30 * 60 * 1000
): Promise<string> {
  const started = Date.now()
  let failures = 0
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error('Gemini terlalu lama membuat video. Coba lagi nanti.')
    let op: VideoOperation | null = null
    try {
      op = await rest<VideoOperation>(operation, { method: 'GET', signal })
      failures = 0
    } catch (e) {
      if (signal?.aborted) throw e
      if (e instanceof ApiError && !e.retryable) throw e
      if (++failures > 8) throw e
    }
    if (op) {
      onTick(Date.now() - started)
      if (op.done) {
        if (op.error) throw new Error(`Gemini gagal membuat video: ${op.error.message ?? 'tanpa keterangan'}`)
        const out = op.response?.generateVideoResponse
        const uri = out?.generatedSamples?.[0]?.video?.uri
        if (uri) return uri
        if (out?.raiMediaFilteredCount) {
          const why = out.raiMediaFilteredReasons?.join(' ')
          throw new Error(`Video ditolak filter keamanan Gemini${why ? `: ${why}` : ''}. Ubah prompt atau gambar klip lalu coba lagi.`)
        }
        throw new Error('Gemini selesai tanpa file video')
      }
    }
    await sleep(5000 + Math.random() * 1000, signal)
  }
}

/** Downloads a finished Veo file. The key is only sent to Google's own host. */
export async function downloadVideo(uri: string, signal?: AbortSignal): Promise<{ bytes: Buffer; contentType: string }> {
  const host = new URL(uri).hostname
  if (!OVERRIDE && !host.endsWith('.googleapis.com')) throw new Error('Alamat hasil video tidak dikenal')
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(uri, { headers: { 'x-goog-api-key': requireSecret('gemini') }, signal })
      if (!res.ok) throw new ApiError(`Gagal mengunduh video (HTTP ${res.status})`, res.status, res.status >= 500)
      return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'video/mp4' }
    } catch (e) {
      lastErr = e
      if (signal?.aborted) throw e
      await sleep(1500 * (attempt + 1), signal)
    }
  }
  throw lastErr
}
