import { useEffect, useRef } from 'react'
import type { AnalysisResult, PackItem } from '@/engine/analyze'
import type { Phase, SourceInfo } from '@/hooks/useChopper'

interface Props {
  phase: Phase
  source: SourceInfo | null
  result: AnalysisResult | null
  /** sound whose occurrences light up */
  focus: PackItem | null
  /** the region currently sounding, in source seconds */
  playing: { start: number; end: number; startedAt: number } | null
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

export function Lcd({ phase, source, result, focus, playing }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    let raf = 0
    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w = el.clientWidth
      const h = el.clientHeight
      if (el.width !== Math.round(w * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr) }
      const g = el.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      const ink = css('--lcd-ink')
      const dim = css('--lcd-dim')
      const mid = h / 2

      if (!result) {
        g.fillStyle = dim
        for (let x = 0; x < w; x += 3) g.fillRect(x, mid, 2, 1)
        return
      }

      const { overview, duration } = result
      const cols = overview.length / 2
      const x = (sec: number) => (sec / duration) * w
      const occ = focus?.occurrences ?? []

      // Spans where the focused sound occurs
      if (occ.length) {
        g.fillStyle = 'rgba(181, 209, 106, 0.16)'
        for (const [s, e] of occ) g.fillRect(x(s), 0, Math.max(2, x(e) - x(s)), h)
      }

      // Waveform as 2px LCD dots, lit where the focused sound plays
      const step = 3
      for (let px = 0; px < w; px += step) {
        const c0 = Math.floor((px / w) * cols)
        const c1 = Math.max(c0 + 1, Math.floor(((px + step) / w) * cols))
        let mn = 0
        let mx = 0
        for (let c = c0; c < c1 && c < cols; c++) { mn = Math.min(mn, overview[c * 2]); mx = Math.max(mx, overview[c * 2 + 1]) }
        const sec = (px / w) * duration
        const lit = occ.some(([s, e]) => sec >= s - duration / w && sec <= e)
        g.fillStyle = !focus || lit ? ink : dim
        const top = mid - mx * (mid - 4)
        const bot = mid - mn * (mid - 4)
        g.fillRect(px, top, step - 1, Math.max(1, bot - top))
      }

      // Every hit in the pack gets a tick along the bottom edge
      g.fillStyle = dim
      for (const it of result.items) for (const [s] of it.occurrences) g.fillRect(x(s), h - 5, 1, 5)
      if (occ.length) {
        g.fillStyle = ink
        for (const [s] of occ) g.fillRect(x(s) - 0.5, h - 9, 2, 9)
      }

      if (playing) {
        const t = (performance.now() - playing.startedAt) / 1000
        const pos = playing.start + t
        if (pos <= playing.end) {
          g.fillStyle = css('--lit')
          g.fillRect(x(pos), 0, 2, h)
          raf = requestAnimationFrame(draw)
        }
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(el)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [result, focus, playing])

  const s = result?.stats
  const hits = result ? result.items.filter((i) => i.kind !== 'roll').reduce((n, i) => n + i.count, 0) : 0

  return (
    <div className="lcd-glass rounded-md bg-lcd p-3 text-lcd-ink sm:p-4" role="status" aria-live="polite">
      <div className="font-lcd flex min-h-6 items-baseline justify-between gap-4 text-[15px] leading-6">
        <span className="truncate">{headline(phase, source)}</span>
        {source?.duration ? <span className="shrink-0 text-lcd-ink/70">{fmtTime(source.duration)}</span> : null}
      </div>

      <div className="relative mt-2 h-28 sm:h-36">
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-hidden />
        {phase.kind === 'busy' && <ProgressBlocks pct={phase.pct} />}
      </div>

      <div className="font-lcd mt-2 flex min-h-6 flex-wrap gap-x-5 gap-y-1 text-[13px] leading-6 text-lcd-ink/80">
        {phase.kind === 'ready' && s ? (
          <>
            <Stat value={hits} one="hit" many="hits" />
            <Stat value={result!.items.length} one="sound" many="sounds" />
            {s.duplicatesFolded > 0 && <Stat value={s.duplicatesFolded} one="repeat folded" many="repeats folded" />}
            {s.rolls > 0 && <Stat value={s.rolls} one="roll" many="rolls" />}
            {s.flams > 0 && <Stat value={s.flams} one="flam" many="flams" />}
            {s.continuations > 0 && <Stat value={s.continuations} one="continuation joined" many="continuations joined" />}
            {s.overlapsSplit > 0 && <Stat value={s.overlapsSplit} one="overlap split" many="overlaps split" />}
            {s.tailsRecovered > 0 && <Stat value={s.tailsRecovered} one="tail recovered" many="tails recovered" />}
          </>
        ) : phase.kind === 'error' ? (
          <span className="text-lcd-ink">{phase.message}</span>
        ) : phase.kind === 'idle' ? (
          <span>Drum breaks, solos and fills work best.</span>
        ) : (
          phase.kind === 'busy' && <span>{phase.stage}…</span>
        )}
      </div>
    </div>
  )
}

function Stat({ value, one, many }: { value: number; one: string; many: string }) {
  return (
    <span>
      <span className="text-lcd-ink">{value}</span> {value === 1 ? one : many}
    </span>
  )
}

function ProgressBlocks({ pct }: { pct: number | null }) {
  const n = 24
  return (
    <div className="absolute inset-x-0 bottom-0 flex h-3 gap-[3px] overflow-hidden">
      {pct === null ? (
        <div className="lcd-scan h-full w-1/5 bg-lcd-ink" />
      ) : (
        Array.from({ length: n }, (_, i) => (
          <div key={i} className={`h-full flex-1 ${i < Math.round(pct * n) ? 'bg-lcd-ink' : 'bg-lcd-dim/50'}`} />
        ))
      )}
    </div>
  )
}

function headline(phase: Phase, source: SourceInfo | null) {
  if (phase.kind === 'idle') return 'Paste a YouTube link to begin'
  if (phase.kind === 'error' && !source) return 'Nothing loaded'
  return source?.title ?? 'Loading'
}

function fmtTime(sec: number) {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
