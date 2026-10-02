import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { FolderArchive, Layers, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Lcd } from '@/components/app/Lcd'
import { Pad } from '@/components/app/Pad'
import { useChopper } from '@/hooks/useChopper'
import { play } from '@/lib/audio'
import type { AnalyzeParams, PackItem, Variant } from '@/engine/analyze'

const KEYS = '1234567890qwertyuiop'.split('')
const NO_ITEMS: PackItem[] = []

export default function App() {
  const c = useChopper()
  const [url, setUrl] = useState('')
  const [hovered, setHovered] = useState<PackItem | null>(null)
  const [playing, setPlaying] = useState<{ id: string; start: number; end: number; startedAt: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [zipping, setZipping] = useState<null | 'pack' | 'takes'>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const busy = c.phase.kind === 'busy'
  const items = c.result?.items ?? NO_ITEMS
  const sampleRate = c.result?.sampleRate ?? 44100

  const zip = async (kind: 'pack' | 'takes') => {
    setZipping(kind)
    try { await c.downloadAll(kind === 'takes') } finally { setZipping(null) }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (url.trim()) void c.loadUrl(url.trim())
  }

  const playVariant = useCallback((it: PackItem, v: Variant) => {
    const dur = play(v.channels, sampleRate, () => setPlaying((p) => (p?.id === it.id ? null : p)))
    setPlaying({ id: it.id, start: v.start, end: v.start + dur, startedAt: performance.now() })
  }, [sampleRate])

  const { variantOf } = c
  const trigger = useCallback((it: PackItem) => playVariant(it, variantOf(it)), [playVariant, variantOf])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return
      const i = KEYS.indexOf(e.key.toLowerCase())
      if (i >= 0 && items[i]) { e.preventDefault(); trigger(items[i]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, trigger])

  const playingItem = playing ? items.find((i) => i.id === playing.id) ?? null : null
  const focus = hovered ?? playingItem

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) void c.loadFile(f)
  }

  return (
    <TooltipProvider delay={400}>
      <div
        className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 pt-8 pb-10 sm:px-8 sm:pt-12"
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false) }}
        onDrop={onDrop}
      >
        <header className="mb-6 flex flex-wrap items-end justify-between gap-x-8 gap-y-2 sm:mb-8">
          <h1 className="wordmark text-[44px] sm:text-[64px]">Chopshop</h1>
          <p className="max-w-[34ch] pb-1 text-[15px] leading-snug text-ink-soft">
            Turn a YouTube drum video into a sample pack, one pad per sound.
          </p>
        </header>

        <section
          aria-label="Source"
          className={`rounded-xl border border-border bg-chassis-deep/60 p-3 shadow-[inset_0_1px_0_rgb(255_255_255/0.45)] sm:p-5 ${dragging ? 'ring-3 ring-lit' : ''}`}
        >
          <form onSubmit={submit} className="mb-3 flex flex-col gap-2 sm:mb-4 sm:flex-row">
            <Label htmlFor="url" className="sr-only">YouTube link</Label>
            <Input
              id="url"
              type="url"
              inputMode="url"
              placeholder="https://www.youtube.com/watch?v=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="h-11 flex-1 border-ink/25 bg-pad text-[15px] focus-visible:border-ink/40"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !url.trim()} className="h-11 flex-1 px-5 text-[15px] font-semibold sm:flex-none">
                Chop it
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 border-ink/25 bg-transparent px-3 text-[15px] hover:bg-pad/60"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
              >
                <Upload /> Open file
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="audio/*,video/*"
                hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void c.loadFile(f); e.target.value = '' }}
              />
            </div>
          </form>

          <Lcd phase={c.phase} source={c.source} result={c.result} focus={focus} playing={playing} />

          <Controls params={c.params} onChange={c.updateParams} disabled={busy} />
        </section>

        {items.length > 0 && (
          <section aria-labelledby="pads-heading" className="mt-8 sm:mt-10">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="pads-heading" className="text-[22px] leading-7 font-bold [font-stretch:112%]">
                  {items.length} sounds
                </h2>
                <p className="text-[14px] text-ink-soft">
                  Click a pad or press its key to hear it. The letters switch between takes of the same sound, A being the cleanest.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="h-10 border-ink/25 bg-transparent px-4 text-[15px] font-semibold hover:bg-pad/60"
                  disabled={busy || !!zipping}
                  onClick={() => zip('takes')}
                >
                  <Layers /> {zipping === 'takes' ? 'Packing…' : 'All takes (.zip)'}
                </Button>
                <Button className="h-10 px-4 text-[15px] font-semibold" disabled={busy || !!zipping} onClick={() => zip('pack')}>
                  <FolderArchive /> {zipping === 'pack' ? 'Packing…' : 'Download pack (.zip)'}
                </Button>
              </div>
            </div>

            <div className={`grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3 ${busy ? 'pointer-events-none opacity-50' : ''}`}>
              {items.map((it, i) => (
                <Pad
                  key={it.id}
                  item={it}
                  name={c.nameOf(it)}
                  sampleRate={sampleRate}
                  variantIndex={c.choice[it.id] ?? 0}
                  keyHint={KEYS[i]?.toUpperCase()}
                  lit={playing?.id === it.id}
                  onPlay={() => trigger(it)}
                  onVariant={(v) => { c.setVariant(it.id, v); playVariant(it, it.variants[v]) }}
                  onDownload={() => c.downloadOne(it)}
                  onRename={(n) => c.rename(it.id, n)}
                  onFocus={(on) => setHovered(on ? it : null)}
                />
              ))}
            </div>
          </section>
        )}

        <footer className="mt-auto pt-12 text-[13px] leading-relaxed text-ink-soft">
          Audio is fetched by your own machine with yt-dlp and never leaves it. Only sample videos you have the rights to use.
        </footer>
      </div>
    </TooltipProvider>
  )
}

function Controls({ params, onChange, disabled }: { params: AnalyzeParams; onChange: (p: Partial<AnalyzeParams>) => void; disabled: boolean }) {
  return (
    <div className="mt-4 grid gap-x-8 gap-y-5 sm:mt-5 md:grid-cols-[1fr_1fr_auto]">
      <Fader
        label="Sensitivity"
        lo="Clear hits only"
        hi="Ghost notes too"
        value={params.sensitivity}
        onCommit={(v) => onChange({ sensitivity: v })}
        disabled={disabled}
      />
      <Fader
        label="Merge similar"
        lo="Keep subtle differences"
        hi="Only clearly different"
        value={params.similarity}
        onCommit={(v) => onChange({ similarity: v })}
        disabled={disabled}
      />
      <div className="flex flex-col gap-2.5">
        <Toggle id="rolls" label="Find rolls" checked={params.rolls} onChange={(v) => onChange({ rolls: v })} disabled={disabled} />
        <Toggle id="overlaps" label="Split overlapping hits" checked={params.overlaps} onChange={(v) => onChange({ overlaps: v })} disabled={disabled} />
        <Toggle id="tails" label="Recover cut-off tails" checked={params.tails} onChange={(v) => onChange({ tails: v })} disabled={disabled} />
      </div>
    </div>
  )
}

function Fader({ label, lo, hi, value, onCommit, disabled }: {
  label: string; lo: string; hi: string; value: number; onCommit: (v: number) => void; disabled: boolean
}) {
  const [v, setV] = useState(value)
  const [synced, setSynced] = useState(value)
  if (synced !== value) { setSynced(value); setV(value) }
  const first = (nv: number | readonly number[]) => (typeof nv === 'number' ? nv : nv[0])
  return (
    <div>
      <div className="mb-2 text-[14px] font-semibold">{label}</div>
      <Slider
        aria-label={label}
        min={0}
        max={1}
        step={0.01}
        value={[v]}
        disabled={disabled}
        onValueChange={(nv) => setV(first(nv))}
        onValueCommitted={(nv) => onCommit(first(nv))}
        className="[&_[data-slot=slider-range]]:bg-ink [&_[data-slot=slider-thumb]]:size-4 [&_[data-slot=slider-thumb]]:border-ink [&_[data-slot=slider-thumb]]:bg-pad [&_[data-slot=slider-track]]:h-1.5 [&_[data-slot=slider-track]]:bg-ink/15"
      />
      <div className="mt-1.5 flex justify-between text-[12px] text-ink-soft">
        <span>{lo}</span>
        <span>{hi}</span>
      </div>
    </div>
  )
}

function Toggle({ id, label, checked, onChange, disabled }: {
  id: string; label: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="data-checked:bg-ink data-unchecked:bg-ink/20" />
      <Label htmlFor={id} className="text-[14px] font-medium">{label}</Label>
    </div>
  )
}
