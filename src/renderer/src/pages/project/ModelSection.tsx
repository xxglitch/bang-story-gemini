import { useMemo, type ReactNode } from 'react'
import { Film, Image as ImageIcon, Move, Users } from 'lucide-react'
import {
  IMAGE_MODELS,
  VIDEO_MODELS,
  effectiveResolution,
  estimateUsd,
  fitDuration,
  getImageModel,
  getVideoModel,
  maxRefs,
  modelOptions,
  resolutionOptions
} from '@shared/media'
import type { Project } from '@shared/types'
import { ModelLogo } from '../../components/ModelLogo'
import { ModelPicker } from '../../components/ModelPicker'
import { Segmented } from '../../components/ui'
import { usdLabel } from '../../lib/format'

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line-2 bg-surface p-3">
      <span className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
        {icon}
        {title}
      </span>
      {children}
    </div>
  )
}

/** Which Gemini models draw and animate this project's clips. Prices are estimates from Google's price list. */
export function ModelSection({
  project,
  clipCount,
  perClip,
  onChange
}: {
  project: Project
  clipCount: number
  perClip: number
  onChange: (patch: { imageModel?: string; videoModel?: string; videoResolution?: string | null }) => void
}) {
  const image = getImageModel(project.imageModel)
  const video = getVideoModel(project.videoModel)
  const resolutions = resolutionOptions(video)
  const resolution = effectiveResolution(video, project.videoResolution)
  const seconds = fitDuration(video, perClip, resolution) ?? perClip
  const imageUsd = estimateUsd(image)
  const videoUsd = estimateUsd(video, resolution, perClip)

  const imageModels = useMemo(() => modelOptions('image'), [])
  const videoModels = useMemo(() => modelOptions('video', { resolution, seconds: perClip }), [resolution, perClip])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold">Model AI</span>
        <span className="text-[13px] text-muted">
          {IMAGE_MODELS.length} model gambar dan {VIDEO_MODELS.length} model video dari Google Gemini
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Card icon={<ImageIcon className="size-4" />} title="Gambar klip">
          <ModelPicker
            value={image.id}
            models={imageModels}
            footerNote="harga perkiraan per gambar"
            renderIcon={(m) => <ModelLogo family={m.family} />}
            detail="description"
            tagFilters={['Rekomendasi', 'Referensi', 'Hemat', 'Kualitas tertinggi']}
            menuClassName="w-[430px]"
            onChange={(id) => onChange({ imageModel: id })}
          />
          <p className="text-[12.5px] leading-snug text-ink-2">
            {imageUsd == null ? (
              <span className="text-muted">Perkiraan harga belum tersedia.</span>
            ) : (
              <>
                ≈ {usdLabel(imageUsd)} per gambar · {clipCount} gambar ≈ <b className="font-semibold text-ink">{usdLabel(imageUsd * clipCount)}</b>
              </>
            )}
          </p>
          <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-muted">
            <Users className="mt-px size-3.5 shrink-0" />
            {maxRefs(image)
              ? 'Pakai lembar karakter, jadi wajah dan kostum tokoh tetap sama di tiap klip.'
              : 'Tanpa lembar karakter, jadi tampilan tokoh bisa sedikit berubah antar klip.'}
          </p>
        </Card>
        <Card icon={<Film className="size-4" />} title="Video AI">
          <ModelPicker
            value={video.id}
            models={videoModels}
            footerNote={`harga perkiraan per video untuk klip ±${perClip} detik`}
            renderIcon={(m) => <ModelLogo family={m.family} />}
            detail="description"
            tagFilters={['Rekomendasi', 'Hemat', '4K', 'Kualitas tertinggi']}
            align="right"
            menuClassName="w-[430px]"
            onChange={(id) => onChange({ videoModel: id })}
          />
          {resolutions.length > 1 ? (
            <div className="flex items-center gap-2.5">
              <span className="shrink-0 text-[12.5px] font-medium text-ink-2">Resolusi</span>
              <Segmented
                size="sm"
                value={resolution}
                onChange={(v) => onChange({ videoResolution: v })}
                options={resolutions.map((r) => ({ id: r, label: r === '4k' ? '4K' : r }))}
                className="min-w-0 flex-1"
              />
            </div>
          ) : (
            <p className="text-[12.5px] text-ink-2">Resolusi {resolution} (satu-satunya pilihan model ini)</p>
          )}
          <p className="text-[12.5px] leading-snug text-ink-2">
            {videoUsd == null ? (
              <span className="text-muted">Perkiraan harga belum tersedia.</span>
            ) : (
              <>
                ≈ {usdLabel(videoUsd)} per video {seconds} detik, {resolution}
              </>
            )}
          </p>
          {video.longOnly.includes(resolution) && (
            <p className="text-[12.5px] leading-snug text-muted">Di {resolution === '4k' ? '4K' : resolution}, Veo selalu membuat video {seconds} detik.</p>
          )}
          <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-muted">
            <Move className="mt-px size-3.5 shrink-0" />
            Hanya untuk klip yang kamu jadikan Video AI. Gerak kamera tetap gratis.
          </p>
        </Card>
      </div>
    </div>
  )
}
