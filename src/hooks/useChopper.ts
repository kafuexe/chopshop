import { useCallback, useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import { DEFAULT_PARAMS, type AnalysisResult, type AnalyzeParams, type PackItem } from '@/engine/analyze'
import type { WorkerIn, WorkerOut } from '@/engine/worker'
import { decode } from '@/lib/audio'
import { encodeWav, safeName, saveBlob } from '@/lib/wav'

export interface SourceInfo {
  title: string
  channel?: string
  duration?: number
  url?: string
}

export type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; stage: string; pct: number | null }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

export function useChopper() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [source, setSource] = useState<SourceInfo | null>(null)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [params, setParams] = useState<AnalyzeParams>(DEFAULT_PARAMS)
  const paramsRef = useRef(params)
  const [choice, setChoice] = useState<Record<string, number>>({})
  const [names, setNames] = useState<Record<string, string>>({})

  const audio = useRef<{ channels: Float32Array[]; sampleRate: number } | null>(null)
  const worker = useRef<Worker | null>(null)
  const jobId = useRef(0)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    const w = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    return () => w.terminate()
  }, [])

  const runAnalysis = useCallback((p: AnalyzeParams) => {
    const a = audio.current
    const w = worker.current
    if (!a || !w) return
    const id = ++jobId.current
    setPhase({ kind: 'busy', stage: 'Finding hits', pct: 0 })
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data
      if (m.id !== jobId.current) return
      if (m.type === 'progress') setPhase({ kind: 'busy', stage: m.stage, pct: m.pct })
      else if (m.type === 'error') setPhase({ kind: 'error', message: `Analysis failed: ${m.message}` })
      else {
        setResult(m.result)
        setChoice({})
        setNames({})
        setPhase(m.result.items.length ? { kind: 'ready' } : {
          kind: 'error',
          message: 'No distinct hits found. Try raising sensitivity, or use a video where the drums are more upfront.',
        })
      }
    }
    const msg: WorkerIn = { id, channels: a.channels.map((c) => c.slice()), sampleRate: a.sampleRate, params: p }
    w.postMessage(msg, msg.channels.map((c) => c.buffer))
  }, [])

  const loadDecoded = useCallback(async (data: ArrayBuffer) => {
    setPhase({ kind: 'busy', stage: 'Decoding audio', pct: null })
    try {
      audio.current = await decode(data)
    } catch {
      setPhase({ kind: 'error', message: 'That file couldn’t be decoded. Try a WAV, MP3, FLAC or M4A.' })
      return
    }
    runAnalysis(paramsRef.current)
  }, [runAnalysis])

  const loadUrl = useCallback(async (url: string) => {
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    setResult(null)
    setPhase({ kind: 'busy', stage: 'Looking up the video', pct: null })
    try {
      const infoRes = await fetch(`/api/info?url=${encodeURIComponent(url)}`, { signal: ac.signal })
      const info = await infoRes.json().catch(() => ({ error: 'The audio server isn’t responding. Is it running?' }))
      if (!infoRes.ok) throw new Error(info.error)
      setSource({ title: info.title, channel: info.channel, duration: info.duration, url })
      setPhase({ kind: 'busy', stage: 'Pulling the audio from YouTube', pct: null })
      const audioRes = await fetch(`/api/audio?url=${encodeURIComponent(url)}`, { signal: ac.signal })
      if (!audioRes.ok) {
        const j = await audioRes.json().catch(() => ({}))
        throw new Error(j.error ?? 'Could not download the audio.')
      }
      await loadDecoded(await audioRes.arrayBuffer())
    } catch (err) {
      if (ac.signal.aborted) return
      const message = err instanceof Error && err.message ? err.message : 'Something went wrong while loading the video.'
      setPhase({ kind: 'error', message: message === 'Failed to fetch' ? 'The audio server isn’t responding. Start it with npm run dev.' : message })
    }
  }, [loadDecoded])

  const loadFile = useCallback(async (file: File) => {
    abort.current?.abort()
    setResult(null)
    setSource({ title: file.name.replace(/\.[^.]+$/, '') })
    await loadDecoded(await file.arrayBuffer())
  }, [loadDecoded])

  const updateParams = useCallback((patch: Partial<AnalyzeParams>) => {
    const next = { ...paramsRef.current, ...patch }
    paramsRef.current = next
    setParams(next)
    if (audio.current) runAnalysis(next)
  }, [runAnalysis])

  const nameOf = useCallback((it: PackItem) => names[it.id]?.trim() || it.name, [names])
  const variantOf = useCallback((it: PackItem) => it.variants[choice[it.id] ?? 0] ?? it.variants[0], [choice])

  const downloadOne = useCallback((it: PackItem) => {
    if (!result) return
    saveBlob(encodeWav(variantOf(it).channels, result.sampleRate), `${safeName(nameOf(it))}.wav`)
  }, [result, nameOf, variantOf])

  /** The chosen take of every sound, or with `allTakes` every take named "Kick 1 A", "Kick 1 B", … */
  const downloadAll = useCallback(async (allTakes = false) => {
    if (!result) return
    const zip = new JSZip()
    const folder = safeName(`${source?.title ?? 'Chopshop'} ${allTakes ? 'all takes' : 'pack'}`)
    const dir = zip.folder(folder)!
    const used = new Set<string>()
    for (const it of result.items) {
      let base = safeName(nameOf(it))
      for (let n = 2; used.has(base.toLowerCase()); n++) base = `${safeName(nameOf(it))} (${n})`
      used.add(base.toLowerCase())
      if (allTakes) {
        it.variants.forEach((v, i) => dir.file(`${base} ${String.fromCharCode(65 + i)}.wav`, encodeWav(v.channels, result.sampleRate)))
      } else {
        dir.file(`${base}.wav`, encodeWav(variantOf(it).channels, result.sampleRate))
      }
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
    saveBlob(blob, `${folder}.zip`)
  }, [result, source, nameOf, variantOf])

  return {
    phase, source, result, params, choice,
    loadUrl, loadFile, updateParams,
    setVariant: (id: string, v: number) => setChoice((c) => ({ ...c, [id]: v })),
    rename: (id: string, name: string) => setNames((n) => ({ ...n, [id]: name })),
    nameOf, variantOf, downloadOne, downloadAll,
  }
}
