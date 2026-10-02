import { useEffect, useRef, useState } from 'react'
import { Download, PenLine } from 'lucide-react'
import type { PackItem, Variant } from '@/engine/analyze'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface Props {
  item: PackItem
  name: string
  sampleRate: number
  variantIndex: number
  keyHint?: string
  lit: boolean
  onPlay: () => void
  onVariant: (i: number) => void
  onDownload: () => void
  onRename: (name: string) => void
  onFocus: (on: boolean) => void
}

const takeLetter = (i: number) => String.fromCharCode(65 + i)
const takeLabel = (i: number) => (i === 0 ? 'Best take' : i === 1 ? 'Runner-up take' : `Take ${takeLetter(i)}`)

const KIND_LABEL: Record<PackItem['kind'], string | null> = {
  hit: null,
  roll: 'Roll',
  split: null, // the take's own note already says it was separated
}

export function Pad({ item, name, sampleRate, variantIndex, keyHint, lit, onPlay, onVariant, onDownload, onRename, onFocus }: Props) {
  const variant = item.variants[variantIndex] ?? item.variants[0]
  const [editing, setEditing] = useState(false)
  const kind = KIND_LABEL[item.kind]
  const len = variant.channels[0].length / sampleRate

  return (
    <div
      className="pad group relative flex flex-col rounded-[10px]"
      data-lit={lit}
      onMouseEnter={() => onFocus(true)}
      onMouseLeave={() => onFocus(false)}
    >
      <button
        type="button"
        onClick={onPlay}
        onFocus={() => onFocus(true)}
        onBlur={() => onFocus(false)}
        className="flex flex-col gap-2 rounded-t-[10px] px-3 pt-3 pb-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-lit/70"
        aria-label={`Play ${name}`}
      >
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0">
            {!editing && <span className="block truncate text-[15px] leading-5 font-semibold">{name}</span>}
            <span className="block text-[12px] leading-4 text-ink-soft">
              {item.kind === 'roll' ? `${item.count} ${item.count === 1 ? 'roll' : 'rolls'}` : `${item.count} ${item.count === 1 ? 'hit' : 'hits'}`}
              {' in source, '}
              {len < 1 ? `${Math.round(len * 1000)} ms` : `${len.toFixed(2)} s`}
            </span>
          </span>
          {keyHint && (
            <kbd className="font-lcd shrink-0 rounded-[3px] border border-pad-edge px-1 text-[11px] leading-4 text-ink-soft group-data-[lit=true]:border-ink/30">
              {keyHint}
            </kbd>
          )}
        </span>
        <MiniWave variant={variant} />
      </button>

      {editing && (
        <input
          autoFocus
          defaultValue={name}
          aria-label="Sound name"
          className="absolute top-2.5 left-2 w-[calc(100%-3.5rem)] rounded-sm border border-ink/30 bg-pad px-1 text-[15px] leading-6 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-lit"
          onBlur={(e) => { onRename(e.target.value); setEditing(false) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setEditing(false)
            e.stopPropagation()
          }}
        />
      )}

      <div className="flex items-center gap-1.5 border-t border-pad-edge/80 px-2 py-1.5 group-data-[lit=true]:border-ink/15">
        {item.variants.length > 1 ? (
          <div role="group" aria-label="Take" className="flex rounded-md border border-pad-edge bg-chassis/40 p-0.5 group-data-[lit=true]:border-ink/20">
            {item.variants.map((_, i) => (
              <Tooltip key={i}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-pressed={variantIndex === i}
                      aria-label={`${takeLabel(i)} of ${name}`}
                      onClick={() => { onVariant(i); }}
                      className={cn(
                        'h-6 w-6 rounded-[4px] text-[12px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-lit',
                        variantIndex === i ? 'bg-ink text-pad' : 'text-ink-soft hover:text-ink',
                      )}
                    />
                  }
                >
                  {takeLetter(i)}
                </TooltipTrigger>
                <TooltipContent>{takeLabel(i)}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        ) : (
          <span className="px-1 text-[12px] text-ink-soft">One take</span>
        )}

        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-soft">
          {[kind, ...variant.notes].filter(Boolean).join(', ')}
        </span>

        <Button
          variant="ghost"
          size="icon-sm"
          className="text-ink-soft hover:bg-chassis/60 hover:text-ink"
          onClick={() => setEditing(true)}
          aria-label={`Rename ${name}`}
        >
          <PenLine />
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-ink hover:bg-chassis/60"
                onClick={onDownload}
                aria-label={`Download ${name} as WAV`}
              />
            }
          >
            <Download />
          </TooltipTrigger>
          <TooltipContent>Download WAV</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

function MiniWave({ variant }: { variant: Variant }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const dpr = window.devicePixelRatio || 1
    const w = el.clientWidth
    const h = el.clientHeight
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
    const g = el.getContext('2d')!
    g.scale(dpr, dpr)
    const x = variant.channels[0]
    const y = variant.channels[1] ?? x
    const cols = Math.floor(w / 2)
    const per = Math.max(1, Math.floor(x.length / cols))
    g.fillStyle = getComputedStyle(el).color
    // RMS per column, relative to the loudest column: reads as the sound's envelope.
    const env = new Float32Array(cols)
    let top = 1e-9
    for (let c = 0; c < cols; c++) {
      let e = 0
      let k = 0
      for (let i = c * per; i < (c + 1) * per && i < x.length; i++) { const s = (x[i] + y[i]) / 2; e += s * s; k++ }
      env[c] = Math.sqrt(e / Math.max(1, k))
      top = Math.max(top, env[c])
    }
    for (let c = 0; c < cols; c++) {
      const bh = Math.max(1, Math.sqrt(env[c] / top) * (h - 2))
      g.fillRect(c * 2, (h - bh) / 2, 1.4, bh)
    }
  }, [variant])
  return <canvas ref={ref} className="h-10 w-full text-ink/75 group-data-[lit=true]:text-ink" aria-hidden />
}
