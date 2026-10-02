import { analyze, type AnalyzeParams } from './analyze'

export type WorkerIn = { id: number; channels: Float32Array[]; sampleRate: number; params: AnalyzeParams }
export type WorkerOut =
  | { id: number; type: 'progress'; stage: string; pct: number }
  | { id: number; type: 'done'; result: ReturnType<typeof analyze> }
  | { id: number; type: 'error'; message: string }

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const { id, channels, sampleRate, params } = e.data
  const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)
  try {
    const result = analyze(channels, sampleRate, params, (stage, pct) => post({ id, type: 'progress', stage, pct }))
    const transfer: Transferable[] = [result.overview.buffer]
    for (const it of result.items) for (const v of it.variants) for (const ch of v.channels) transfer.push(ch.buffer)
    post({ id, type: 'done', result }, transfer)
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
