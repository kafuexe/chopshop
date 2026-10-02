import { bandStft, db, maskedResynth } from './dsp'

export interface AnalyzeParams {
  /** 0..1 — how readily quiet or soft hits count as new sounds */
  sensitivity: number
  /** 0..1 — how different two hits must be before both are kept */
  similarity: number
  rolls: boolean
  overlaps: boolean
  tails: boolean
}

export const DEFAULT_PARAMS: AnalyzeParams = {
  sensitivity: 0.55,
  similarity: 0.5,
  rolls: true,
  overlaps: true,
  tails: true,
}

export type ItemKind = 'hit' | 'roll' | 'split'

export interface Variant {
  channels: Float32Array[]
  /** where it came from in the source, seconds */
  start: number
  end: number
  notes: string[]
}

export interface PackItem {
  debug?: Record<string, number>
  id: string
  name: string
  type: string
  kind: ItemKind
  /** how many times this sound occurs in the source */
  count: number
  /** [start, end] seconds of every occurrence */
  occurrences: [number, number][]
  variants: Variant[]
}

export interface AnalysisStats {
  onsets: number
  flams: number
  continuations: number
  rolls: number
  overlapsSplit: number
  tailsRecovered: number
  duplicatesFolded: number
}

export interface AnalysisResult {
  sampleRate: number
  duration: number
  /** interleaved min/max per column */
  overview: Float32Array
  items: PackItem[]
  stats: AnalysisStats
}

type Progress = (stage: string, pct: number) => void

interface Seg {
  start: number
  nominalEnd: number
  end: number
  peak: number
  peakDb: number
  strength: number
  cut: boolean
  /** level just before the onset relative to the peak: bleed from earlier sounds */
  pre: number
  decayMs: number
  tmpl: Float64Array
  shape: Float64Array
  cluster: number
  inRoll: boolean
  flam: boolean
}

interface Cluster {
  id: number
  members: number[]
  tmpl: Float64Array
  decayMs: number
  peakDb: number
  combo: null | { a: number; parts: [number, number]; weights: [number, number] } // parts are cluster ids, -1 = unknown residual
  residual: Float64Array | null
}

const OVERVIEW_COLUMNS = 1600
/** Takes kept per sound, best first: A, B, C, D, E */
export const MAX_TAKES = 5
const FFT = 1024
const HOP = 256
const BANDS = 48

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function percentile(arr: ArrayLike<number>, q: number) {
  const a = Array.from(arr).sort((x, y) => x - y)
  if (!a.length) return 0
  return a[clamp(Math.floor(q * (a.length - 1)), 0, a.length - 1)]
}

function median(a: number[]) {
  return percentile(a, 0.5)
}

export function analyze(channels: Float32Array[], sampleRate: number, params: AnalyzeParams, progress: Progress = () => {}): AnalysisResult {
  const SR = sampleRate
  const len = channels[0].length
  const mono = new Float32Array(len)
  for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += ch[i] / channels.length

  const overview = buildOverview(mono)

  progress('Reading the spectrum', 0.05)
  const bf = bandStft(mono, SR, FFT, HOP, BANDS)
  const { power, rms, frames: T, nBands: B, bandHz } = bf
  const frameAt = (s: number) => clamp(Math.round((s - FFT / 2) / HOP), 0, T - 1)
  const frameMs = (HOP / SR) * 1000

  // ── 1. Onset detection: SuperFlux-style spectral flux on log band energies ──
  progress('Finding hits', 0.3)
  let meanPow = 0
  for (let i = 0; i < power.length; i++) meanPow += power[i]
  meanPow = meanPow / power.length || 1e-9
  const L = new Float32Array(T * B)
  for (let i = 0; i < L.length; i++) L[i] = Math.log1p(power[i] / (meanPow * 1e-3))

  const flux = new Float32Array(T)
  for (let t = 1; t < T; t++) {
    let s = 0
    for (let b = 0; b < B; b++) {
      const prev = Math.max(
        L[(t - 1) * B + b],
        b > 0 ? L[(t - 1) * B + b - 1] : 0,
        b < B - 1 ? L[(t - 1) * B + b + 1] : 0,
      )
      const d = L[t * B + b] - prev
      if (d > 0) s += d
    }
    flux[t] = s
  }

  const maxRms = Math.max(1e-9, ...sampleMax(rms))
  const p95 = percentile(flux, 0.95) || 1
  const delta = lerp(0.5, 0.06, params.sensitivity) * p95
  const gate = maxRms * Math.pow(10, -lerp(28, 48, params.sensitivity) / 20)
  const W = Math.round(150 / frameMs)
  const prefix = new Float64Array(T + 1)
  for (let t = 0; t < T; t++) prefix[t + 1] = prefix[t] + flux[t]
  const minGap = Math.max(2, Math.round(18 / frameMs))

  const onsetFrames: number[] = []
  for (let t = 2; t < T - 2; t++) {
    const v = flux[t]
    let isMax = true
    for (let k = -3; k <= 3 && isMax; k++) if (k && flux[t + k] > v) isMax = false
    if (!isMax) continue
    const lo = Math.max(0, t - W)
    const hi = Math.min(T, t + W + 1)
    const thr = (prefix[hi] - prefix[lo]) / (hi - lo) + delta
    if (v < thr) continue
    let loud = 0
    for (let k = 0; k < 5 && t + k < T; k++) loud = Math.max(loud, rms[t + k])
    if (loud < gate) continue
    if (onsetFrames.length && t - onsetFrames[onsetFrames.length - 1] < minGap) {
      if (v > flux[onsetFrames[onsetFrames.length - 1]]) onsetFrames[onsetFrames.length - 1] = t
      continue
    }
    onsetFrames.push(t)
  }

  // Sample-accurate onset: steepest rise of a short peak envelope around the frame centre.
  const onsets = onsetFrames.map((t, i) => {
    const centre = t * HOP + FFT / 2
    const from = Math.max(i ? onsetFrames[i - 1] * HOP + FFT / 2 : 0, centre - 768)
    const to = Math.min(len, centre + 512)
    return { sample: refineOnset(mono, from, to), strength: flux[t] }
  })

  // ── 2. Flams: two strikes within ~38 ms are one gesture ──
  const flamGap = 0.03 * SR
  const merged: { sample: number; strength: number; flam: boolean }[] = []
  let flams = 0
  for (const o of onsets) {
    const last = merged[merged.length - 1]
    if (last && o.sample - last.sample < flamGap) {
      last.strength = Math.max(last.strength, o.strength)
      last.flam = true
      flams++
    } else merged.push({ ...o, flam: false })
  }

  // ── 3. Segments ──
  progress('Measuring each hit', 0.45)
  const maxLen = 3 * SR
  const makeSeg = (start: number, nominalEnd: number, strength: number, flam: boolean): Seg => {
    const s = {
      start, nominalEnd, end: nominalEnd, peak: 0, peakDb: 0, strength, cut: false, pre: 0, decayMs: 100,
      tmpl: new Float64Array(B), shape: new Float64Array(B), cluster: -1, inRoll: false, flam,
    }
    measure(s)
    return s
  }

  function measure(s: Seg) {
    const f0 = frameAt(s.start)
    const fHead = Math.max(f0 + 1, frameAt(s.start + 0.06 * SR))
    let peak = 0
    let peakF = f0
    for (let f = f0; f <= fHead && f < T; f++) if (rms[f] > peak) { peak = rms[f]; peakF = f }
    s.peak = peak
    s.peakDb = 20 * Math.log10(peak / maxRms + 1e-12)

    // Level already ringing before this hit (another sound's tail). Once we're back down
    // near it, this hit itself has died away.
    const fPre = f0 - 3
    const preLevel = fPre >= 0 ? rms[fPre] : 0
    const fNom = Math.max(peakF + 1, frameAt(s.nominalEnd))
    const floor = Math.max(peak * Math.pow(10, -48 / 20), preLevel * 1.15)
    s.end = s.nominalEnd
    for (let f = peakF; f < fNom && f < T; f++) {
      if (rms[f] < floor) { s.end = Math.min(s.nominalEnd, f * HOP + FFT / 2); break }
    }
    const lastF = Math.min(T - 1, Math.max(peakF, fNom - 1))
    s.cut = s.end === s.nominalEnd && rms[lastF] > Math.max(peak * Math.pow(10, -24 / 20), preLevel * 1.6)

    let decayF = -1
    const decayFloor = Math.max(peak * 0.1, preLevel * 1.15)
    for (let f = peakF; f <= lastF; f++) if (rms[f] < decayFloor) { decayF = f; break }
    if (decayF >= 0) {
      // Scale to a full -20 dB decay when we stopped early at the bleed floor.
      const reached = 20 * Math.log10(peak / (rms[decayF] + 1e-12))
      s.decayMs = ((decayF - peakF) * frameMs * 20) / clamp(reached, 6, 20)
    }
    else {
      // Never reached -20 dB before the next hit: extrapolate, or give up if there's too little to go on.
      const drop = 20 * Math.log10(peak / (rms[lastF] + 1e-12))
      const spanMs = (lastF - peakF) * frameMs
      s.decayMs = drop >= 4 && spanMs >= 25 ? (spanMs * 20) / drop : NaN
    }
    if (!Number.isNaN(s.decayMs)) s.decayMs = clamp(s.decayMs, 20, 3000)

    s.pre = fPre >= 0 ? clamp(rms[fPre] / (peak + 1e-12), 0, 1) : 0

    // Head template minus whatever was already ringing before the onset.
    const nh = clamp(frameAt(s.end) - f0, 2, 14)
    s.tmpl.fill(0)
    for (let f = f0 + 1; f <= f0 + nh && f < T; f++) for (let b = 0; b < B; b++) s.tmpl[b] += power[f * B + b] / nh
    if (fPre >= 0) {
      for (let b = 0; b < B; b++) {
        s.tmpl[b] = Math.max(s.tmpl[b] - 0.9 * power[fPre * B + b], 0.05 * s.tmpl[b])
      }
    }
    s.shape = shapeOf(s.tmpl)
  }

  let segs: Seg[] = merged.map((o, i) => {
    const next = merged[i + 1]?.sample ?? len
    return makeSeg(o.sample, Math.min(next, o.sample + maxLen, len), o.strength, o.flam)
  })

  // ── 4. Continuations: a "new" onset with no real energy jump that sounds like the tail it sits on ──
  let continuations = 0
  {
    const strengthMed = median(segs.map((s) => s.strength))
    const out: Seg[] = []
    for (const s of segs) {
      const prev = out[out.length - 1]
      if (prev) {
        const fPreOn = frameAt(s.start - 0.01 * SR)
        const before = rms[fPreOn]
        const ringing = before > prev.peak * Math.pow(10, -30 / 20)
        const riseDb = 20 * Math.log10((s.peak + 1e-12) / (before + 1e-12))
        if (ringing && riseDb < 1.5 && s.strength < strengthMed) {
          const tail = new Float64Array(B)
          for (let k = 1; k <= 3; k++) {
            const f = Math.max(0, fPreOn - k + 1)
            for (let b = 0; b < B; b++) tail[b] += power[f * B + b]
          }
          const headRaw = new Float64Array(B)
          const f0 = frameAt(s.start)
          for (let k = 1; k <= 3; k++) for (let b = 0; b < B; b++) headRaw[b] += power[Math.min(T - 1, f0 + k) * B + b]
          if (cosine(shapeOf(tail), shapeOf(headRaw)) > 0.96) {
            prev.nominalEnd = s.nominalEnd
            measure(prev)
            continuations++
            continue
          }
        }
      }
      out.push(s)
    }
    segs = out
  }

  // Drop near-silent fragments.
  segs = segs.filter((s) => s.peakDb > -lerp(36, 52, params.sensitivity) && s.end - s.start > 0.02 * SR)

  // ── 5. Group similar hits ──
  progress('Grouping similar sounds', 0.6)
  const thr = lerp(3.2, 9, params.similarity)
  const dist = (a: Seg, b: Seg) => shapeDistance(a.shape, b.shape, a.decayMs, b.decayMs)
  const labels = agglomerate(segs, dist, thr)
  absorbSingletons(segs, labels, dist, thr * 1.35)
  const clusterMap = new Map<number, number[]>()
  labels.forEach((l, i) => {
    segs[i].cluster = l
    if (!clusterMap.has(l)) clusterMap.set(l, [])
    clusterMap.get(l)!.push(i)
  })
  const clusters: Cluster[] = []
  for (const [id, members] of clusterMap) {
    const tmpl = new Float64Array(B)
    for (const m of members) {
      const t = segs[m].tmpl
      let sum = 0
      for (let b = 0; b < B; b++) sum += t[b]
      for (let b = 0; b < B; b++) tmpl[b] += t[b] / (sum + 1e-20) / members.length
    }
    clusters.push({
      id, members, tmpl,
      decayMs: knownDecay(members.map((m) => segs[m].decayMs)),
      peakDb: Math.max(...members.map((m) => segs[m].peakDb)),
      combo: null, residual: null,
    })
  }
  const byId = new Map(clusters.map((c) => [c.id, c]))

  // ── 6. Overlaps: clusters whose spectrum is two other sounds stacked ──
  progress('Untangling overlapping hits', 0.72)
  let overlapsSplit = 0
  if (params.overlaps && clusters.length >= 2) {
    detectCombos(clusters, bandHz)
    for (const c of clusters) if (c.combo) overlapsSplit += c.members.length
  }

  // Residual sounds that turn out to match an existing cluster become a plain pair.
  const residualItems: { tmpl: Float64Array; shape: Float64Array; decayMs: number; combos: Cluster[] }[] = []
  for (const c of clusters) {
    if (!c.combo || c.combo.parts[1] !== -1 || !c.residual) continue
    const shape = shapeOf(c.residual)
    let best: Cluster | null = null
    let bestD = Infinity
    for (const o of clusters) {
      if (o.combo || o === c) continue
      const d = shapeDistance(shape, shapeOf(o.tmpl), c.decayMs, o.decayMs)
      if (d < bestD) { bestD = d; best = o }
    }
    if (best && bestD <= thr) { c.combo.parts[1] = best.id; continue }
    const twin = residualItems.find((r) => shapeDistance(shape, r.shape, c.decayMs, r.decayMs) <= thr)
    if (twin) twin.combos.push(c)
    else residualItems.push({ tmpl: c.residual, shape, decayMs: c.decayMs, combos: [c] })
  }

  // ── 7. Rolls: fast, even runs of the same sound ──
  progress('Spotting rolls', 0.8)
  const rolls: { from: number; to: number; cluster: number }[] = []
  if (params.rolls) {
    let i = 0
    while (i < segs.length - 2) {
      let j = i
      while (j + 1 < segs.length) {
        const ioi = (segs[j + 1].start - segs[j].start) / SR
        if (ioi > 0.15) break
        if (j > i) {
          const r = ioi / ((segs[j].start - segs[j - 1].start) / SR)
          if (r < 0.5 || r > 2) break
        }
        // Alternating sticks sound slightly different, so compare neighbours, not the first stroke.
        const a = segs[j + 1]
        const same = a.cluster === segs[j].cluster || a.cluster === segs[i].cluster || dist(a, segs[j]) <= thr * 1.5
        if (!same) break
        j++
      }
      if (j - i + 1 >= 3) {
        const last = rolls[rolls.length - 1]
        // A short breath inside one long roll shouldn't split it in two.
        if (last && (segs[i].start - segs[last.to].start) / SR < 0.22 && dist(segs[i], segs[last.to]) <= thr * 1.5) last.to = j
        else rolls.push({ from: i, to: j, cluster: segs[i].cluster })
        for (let k = i; k <= j; k++) segs[k].inRoll = true
        i = j + 1
      } else i++
    }
    // Name a roll after its most common sound.
    for (const r of rolls) {
      const count = new Map<number, number>()
      for (let k = r.from; k <= r.to; k++) count.set(segs[k].cluster, (count.get(segs[k].cluster) ?? 0) + 1)
      r.cluster = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0]
    }
  }

  // ── 8. Build the pack ──
  progress('Cutting samples', 0.86)
  const toSec = (s: number) => s / SR
  let tailsRecovered = 0
  const items: (PackItem & { order: number })[] = []

  const quality = (si: number, c: Cluster, medoidShape: Float64Array) => {
    const s = segs[si]
    const d = shapeDistance(s.shape, medoidShape, s.decayMs, c.decayMs) / thr
    let q = -d - 3 * s.pre + (s.peakDb - c.peakDb) / 12
    if (s.cut) q -= params.tails ? 0.3 : 1
    if (s.inRoll) q -= 1.5
    if (s.flam) q -= 0.4
    return q
  }

  const renderRegion = (from: number, to: number, mask?: (tSec: number, band: number) => number) => {
    const out = channels.map((ch) => {
      const x = ch.subarray(from, to)
      return mask ? maskedResynth(x, SR, bandHz, mask) : Float32Array.from(x)
    })
    finish(out, SR)
    return out
  }

  const renderHit = (si: number, c: Cluster): Variant => {
    const s = segs[si]
    const notes: string[] = []
    if (s.flam) notes.push('Flam')
    const next = segs[si + 1]
    if (params.tails && s.cut && next) {
      const rec = recoverTail(si)
      if (rec) {
        tailsRecovered++
        notes.push('Tail recovered')
        return { channels: rec.channels, start: toSec(s.start), end: toSec(rec.end), notes }
      }
    }
    if (s.cut) notes.push('Cut by next hit')
    if (s.pre > 0.3) notes.push('Some bleed')
    void c
    return { channels: renderRegion(s.start, s.end), start: toSec(s.start), end: toSec(s.end), notes }
  }

  // Let a sound that was cut off ring on: keep the part of the mix that matches its decaying spectrum.
  function recoverTail(si: number) {
    const s = segs[si]
    const next = segs[si + 1]
    const nextNext = segs[si + 2]?.start ?? len
    const fCut = frameAt(next.start) - 3
    if (fCut < 0) return null
    const tail = new Float64Array(B)
    for (let b = 0; b < B; b++) tail[b] = power[fCut * B + b]
    const levelDb = 20 * Math.log10(rms[fCut] / (s.peak + 1e-12))
    const rateA = 20 / (Number.isNaN(s.decayMs) ? byId.get(s.cluster)!.decayMs : s.decayMs) // dB per ms (level)
    const remainMs = (45 + levelDb) / rateA
    if (remainMs < 30) return null
    const end = Math.min(len, nextNext, s.start + maxLen, next.start + Math.round((remainMs / 1000) * SR))
    if (end - next.start < 0.03 * SR) return null
    const nextCluster = byId.get(next.cluster)
    const rateB = 20 / (nextCluster?.decayMs ?? 250)
    const tCut = (next.start - s.start) / SR
    const mask = (tSec: number, b: number) => {
      if (tSec < tCut) return 1
      const dt = (tSec - tCut) * 1000
      const a = tail[b] * Math.pow(10, (-rateA * dt) / 10)
      const o = next.tmpl[b] * Math.pow(10, (-rateB * dt) / 10)
      return a / (a + o + 1e-20)
    }
    return { channels: renderRegion(s.start, end, mask), end }
  }

  // Separate one part out of an overlapped hit.
  const renderSplit = (si: number, c: Cluster, target: Float64Array, targetDecay: number, other: Float64Array, otherDecay: number): Variant => {
    const s = segs[si]
    const sumT = sumOf(target)
    const sumO = sumOf(other)
    const [wt, wo] = c.combo!.weights
    const mask = (tSec: number, b: number) => {
      const ms = tSec * 1000
      const a = (wt * target[b]) / sumT * Math.pow(10, (-(20 / targetDecay) * ms) / 10)
      const o = (wo * other[b]) / sumO * Math.pow(10, (-(20 / otherDecay) * ms) / 10)
      return a / (a + o + 1e-20)
    }
    return {
      channels: renderRegion(s.start, s.end, mask),
      start: toSec(s.start),
      end: toSec(s.end),
      notes: ['Separated from overlap'],
    }
  }

  const occ = (si: number): [number, number] => [toSec(segs[si].start), toSec(segs[si].end)]

  // Regular hits
  const usable = clusters.filter((c) => !c.combo)
  for (const c of usable) {
    const medoid = medoidOf(c.members, segs, dist)
    const ranked = [...c.members].sort((a, b) => quality(b, c, segs[medoid].shape) - quality(a, c, segs[medoid].shape))
    const occurrences = c.members.map(occ)
    for (const combo of clusters) {
      if (combo.combo && combo.combo.parts.includes(c.id)) occurrences.push(...combo.members.map(occ))
    }
    occurrences.sort((a, b) => a[0] - b[0])
    const type = classify(c.tmpl, bandHz, c.decayMs)
    items.push({
      debug: classifyFeatures(c.tmpl, bandHz, c.decayMs),
      id: `c${c.id}`, name: type, type, kind: 'hit', count: occurrences.length, occurrences,
      variants: ranked.slice(0, MAX_TAKES).map((si) => renderHit(si, c)),
      order: TYPE_ORDER.indexOf(type) * 1000 - occurrences.length,
    })
  }

  // Sounds that only ever appear layered under something else
  residualItems.forEach((r, k) => {
    const members: { si: number; c: Cluster }[] = []
    for (const c of r.combos) for (const si of c.members) members.push({ si, c })
    members.sort((a, b) => segs[a.si].pre - segs[b.si].pre + (segs[b.si].peakDb - segs[a.si].peakDb) / 24)
    const type = classify(r.tmpl, bandHz, r.decayMs)
    const occurrences = members.map((m) => occ(m.si)).sort((a, b) => a[0] - b[0])
    items.push({
      debug: classifyFeatures(r.tmpl, bandHz, r.decayMs),
      id: `r${k}`, name: type, type, kind: 'split', count: occurrences.length, occurrences,
      variants: members.slice(0, MAX_TAKES).map(({ si, c }) => {
        const base = byId.get(c.combo!.parts[0])!
        return renderSplit(si, c, r.tmpl, r.decayMs, base.tmpl, base.decayMs)
      }),
      order: TYPE_ORDER.indexOf(type) * 1000 - occurrences.length + 500,
    })
  })

  // Rolls, grouped by the sound they're made of
  // Rolls of the same kind of drum are near-duplicates of each other: keep the longest two.
  const rollGroups = new Map<string, typeof rolls>()
  for (const r of rolls) {
    const c = byId.get(r.cluster)!
    const type = c.combo ? 'Mixed' : classify(c.tmpl, bandHz, c.decayMs)
    if (!rollGroups.has(type)) rollGroups.set(type, [])
    rollGroups.get(type)!.push(r)
  }
  for (const [type, group] of rollGroups) {
    group.sort((a, b) => b.to - b.from - (a.to - a.from))
    const occurrences = group
      .map((r): [number, number] => [toSec(segs[r.from].start), toSec(segs[r.to].end)])
      .sort((a, b) => a[0] - b[0])
    items.push({
      id: `roll-${type}`, name: `${type} roll`, type, kind: 'roll', count: group.length, occurrences,
      variants: group.slice(0, MAX_TAKES).map((r) => ({
        channels: renderRegion(segs[r.from].start, segs[r.to].end),
        start: toSec(segs[r.from].start),
        end: toSec(segs[r.to].end),
        notes: [`${r.to - r.from + 1} strokes`],
      })),
      order: 90000 - group.length,
    })
  }

  items.sort((a, b) => a.order - b.order)
  const counters = new Map<string, number>()
  for (const it of items) {
    const n = (counters.get(it.name) ?? 0) + 1
    counters.set(it.name, n)
  }
  const seen = new Map<string, number>()
  for (const it of items) {
    if ((counters.get(it.name) ?? 0) > 1) {
      const n = (seen.get(it.name) ?? 0) + 1
      seen.set(it.name, n)
      it.name = `${it.name} ${n}`
    }
  }

  progress('Done', 1)
  const hitItems = items.filter((i) => i.kind !== 'roll').length
  return {
    sampleRate: SR,
    duration: len / SR,
    overview,
    items: items.map(({ order: _order, ...rest }) => rest),
    stats: {
      onsets: onsets.length,
      flams,
      continuations,
      rolls: rolls.length,
      overlapsSplit,
      tailsRecovered,
      duplicatesFolded: Math.max(0, segs.length - hitItems),
    },
  }
}

// ───────────────────────── helpers ─────────────────────────

const TYPE_ORDER = ['Kick', 'Snare', 'Clap', 'Rim', 'Closed hat', 'Open hat', 'Ride', 'Crash', 'Tom', 'Perc', 'Bass', 'Tone']

function buildOverview(mono: Float32Array) {
  const cols = OVERVIEW_COLUMNS
  const out = new Float32Array(cols * 2)
  const per = Math.max(1, Math.floor(mono.length / cols))
  for (let c = 0; c < cols; c++) {
    let mn = 0
    let mx = 0
    const from = c * per
    const to = Math.min(mono.length, from + per)
    for (let i = from; i < to; i++) {
      const v = mono[i]
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    out[c * 2] = mn
    out[c * 2 + 1] = mx
  }
  return out
}

function sampleMax(a: Float32Array) {
  let m = 0
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]
  return [m]
}

function refineOnset(x: Float32Array, from: number, to: number) {
  const blk = 32
  const n = Math.max(1, Math.floor((to - from) / blk))
  const env = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    let m = 0
    for (let i = from + k * blk; i < from + (k + 1) * blk && i < x.length; i++) m = Math.max(m, Math.abs(x[i]))
    env[k] = m
  }
  let peakK = 0
  for (let k = 1; k < n; k++) if (env[k] > env[peakK]) peakK = k
  let base = env[peakK]
  for (let k = 0; k <= peakK; k++) base = Math.min(base, env[k])
  const level = base + 0.3 * (env[peakK] - base)
  let k = 0
  while (k < peakK && env[k] < level) k++
  return Math.max(0, from + k * blk - 64)
}

function knownDecay(ds: number[]) {
  const known = ds.filter((d) => !Number.isNaN(d))
  return known.length ? median(known) : 250
}

/** A hit that matches nothing exactly is usually a sloppy version of its nearest group. */
function absorbSingletons<T>(items: T[], labels: number[], dist: (a: T, b: T) => number, limit: number) {
  const groups = new Map<number, number[]>()
  labels.forEach((l, i) => { if (!groups.has(l)) groups.set(l, []); groups.get(l)!.push(i) })
  for (const [l, members] of groups) {
    if (members.length !== 1) continue
    const i = members[0]
    let best = -1
    let bd = Infinity
    for (const [o, om] of groups) {
      if (o === l || om.length < 2) continue
      let d = 0
      for (const m of om) d += dist(items[i], items[m]) / om.length
      if (d < bd) { bd = d; best = o }
    }
    if (best >= 0 && bd <= limit) labels[i] = best
  }
}

function sumOf(v: Float64Array) {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i]
  return s + 1e-20
}

/** Loudness-normalised log spectrum, smoothed and floored so noise doesn't count. */
function shapeOf(tmpl: Float64Array) {
  const B = tmpl.length
  const d = new Float64Array(B)
  for (let b = 0; b < B; b++) d[b] = db(tmpl[b])
  const sm = new Float64Array(B)
  for (let b = 0; b < B; b++) {
    const l = d[Math.max(0, b - 1)]
    const r = d[Math.min(B - 1, b + 1)]
    sm[b] = (l + 2 * d[b] + r) / 4
  }
  let mx = -Infinity
  for (let b = 0; b < B; b++) mx = Math.max(mx, sm[b])
  let mean = 0
  for (let b = 0; b < B; b++) { sm[b] = Math.max(sm[b], mx - 45); mean += sm[b] / B }
  for (let b = 0; b < B; b++) sm[b] -= mean
  return sm
}

function shapeDistance(a: Float64Array, b: Float64Array, decayA: number, decayB: number) {
  let s = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  const dShape = Math.sqrt(s / a.length)
  // Decay is a weaker cue than timbre and is unknown for hits cut short.
  const dDecay = Number.isNaN(decayA) || Number.isNaN(decayB) ? 0 : Math.min(2, Math.abs(Math.log2(decayA / decayB)))
  return Math.hypot(dShape, 1.6 * dDecay)
}

function cosine(a: Float64Array, b: Float64Array) {
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i] }
  return ab / Math.sqrt(aa * bb + 1e-20)
}

/** Average-linkage agglomerative clustering with a nearest-neighbour cache. */
function agglomerate<T>(items: T[], dist: (a: T, b: T) => number, thr: number) {
  const n = items.length
  const labels = Array.from({ length: n }, (_, i) => i)
  if (n < 2) return labels
  const D = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dist(items[i], items[j])
      D[i * n + j] = d
      D[j * n + i] = d
    }
  }
  const alive = new Uint8Array(n).fill(1)
  const size = new Float64Array(n).fill(1)
  const nn = new Int32Array(n)
  const nnd = new Float64Array(n)
  const refresh = (i: number) => {
    let best = -1
    let bd = Infinity
    for (let j = 0; j < n; j++) {
      if (j === i || !alive[j]) continue
      const d = D[i * n + j]
      if (d < bd) { bd = d; best = j }
    }
    nn[i] = best
    nnd[i] = bd
  }
  for (let i = 0; i < n; i++) refresh(i)

  for (;;) {
    let bi = -1
    let bd = Infinity
    for (let i = 0; i < n; i++) if (alive[i] && nnd[i] < bd) { bd = nnd[i]; bi = i }
    if (bi < 0 || bd > thr) break
    const i = bi
    const j = nn[i]
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === i || k === j) continue
      const d = (D[i * n + k] * size[i] + D[j * n + k] * size[j]) / (size[i] + size[j])
      D[i * n + k] = d
      D[k * n + i] = d
    }
    size[i] += size[j]
    alive[j] = 0
    for (let k = 0; k < n; k++) if (labels[k] === j) labels[k] = i
    for (let k = 0; k < n; k++) {
      if (!alive[k]) continue
      if (k === i || nn[k] === i || nn[k] === j) refresh(k)
      else if (D[k * n + i] < nnd[k]) { nnd[k] = D[k * n + i]; nn[k] = i }
    }
  }
  return labels
}

function medoidOf<T>(members: number[], items: T[], dist: (a: T, b: T) => number) {
  if (members.length <= 2) return members[0]
  const sample = members.length > 60 ? members.filter((_, i) => i % Math.ceil(members.length / 60) === 0) : members
  let best = members[0]
  let bd = Infinity
  for (const m of sample) {
    let s = 0
    for (const o of sample) s += dist(items[m], items[o])
    if (s < bd) { bd = s; best = m }
  }
  return best
}

/** dB error of `fit` against `c`, over the bands that matter in `c`. */
function fitErrDb(c: Float64Array, fit: Float64Array) {
  let mx = 0
  for (let b = 0; b < c.length; b++) mx = Math.max(mx, c[b])
  let s = 0
  let n = 0
  for (let b = 0; b < c.length; b++) {
    if (c[b] < mx * 1e-4) continue
    const d = clamp(db(fit[b]) - db(c[b]), -20, 20)
    s += d * d
    n++
  }
  return Math.sqrt(s / Math.max(1, n))
}

function weightsFor(c: Float64Array) {
  let mx = 0
  for (let b = 0; b < c.length; b++) mx = Math.max(mx, c[b])
  return Array.from(c, (v) => 1 / Math.pow(Math.max(v, mx * 1e-4), 2))
}

function fitSingle(c: Float64Array, a: Float64Array) {
  const w = weightsFor(c)
  let num = 0
  let den = 0
  for (let b = 0; b < c.length; b++) { num += w[b] * a[b] * c[b]; den += w[b] * a[b] * a[b] }
  const k = Math.max(0, num / (den + 1e-30))
  return fitErrDb(c, a.map((v) => v * k))
}

function fitPair(c: Float64Array, a: Float64Array, bv: Float64Array) {
  const w = weightsFor(c)
  let aa = 0, ab = 0, bb = 0, ac = 0, bc = 0
  for (let b = 0; b < c.length; b++) {
    aa += w[b] * a[b] * a[b]; ab += w[b] * a[b] * bv[b]; bb += w[b] * bv[b] * bv[b]
    ac += w[b] * a[b] * c[b]; bc += w[b] * bv[b] * c[b]
  }
  const det = aa * bb - ab * ab
  if (Math.abs(det) < 1e-40) return null
  const ka = (ac * bb - bc * ab) / det
  const kb = (bc * aa - ac * ab) / det
  if (ka <= 0 || kb <= 0) return null
  const fit = new Float64Array(c.length)
  let domA = 0
  let domB = 0
  let mx = 0
  for (let b = 0; b < c.length; b++) mx = Math.max(mx, c[b])
  for (let b = 0; b < c.length; b++) {
    fit[b] = ka * a[b] + kb * bv[b]
    if (c[b] < mx * 1e-4) continue
    if (ka * a[b] > kb * bv[b]) domA++
    else domB++
  }
  const tot = domA + domB || 1
  return { err: fitErrDb(c, fit), ka, kb, shareA: domA / tot, shareB: domB / tot }
}

function log2Centroid(t: Float64Array, hz: number[]) {
  let s = 0
  let w = 0
  for (let b = 0; b < t.length; b++) { s += Math.log2(hz[b]) * t[b]; w += t[b] }
  return s / (w + 1e-30)
}

function detectCombos(clusters: Cluster[], hz: number[]) {
  const B = hz.length
  const evaluate = (c: Cluster, bases: Cluster[]) => {
    let e1 = Infinity
    for (const a of bases) if (a !== c) e1 = Math.min(e1, fitSingle(c.tmpl, a.tmpl))
    if (e1 < 4.5) return null
    let best: Cluster['combo'] = null
    let bestErr = Infinity
    for (let i = 0; i < bases.length; i++) {
      const A = bases[i]
      if (A === c) continue
      for (let j = i + 1; j < bases.length; j++) {
        const Bc = bases[j]
        if (Bc === c) continue
        const p = fitPair(c.tmpl, A.tmpl, Bc.tmpl)
        if (!p || p.shareA < 0.15 || p.shareB < 0.15) continue
        if (p.err <= 3 && p.err <= e1 - 3 && p.err < bestErr) {
          bestErr = p.err
          best = { a: 0, parts: [A.id, Bc.id], weights: [p.ka, p.kb] }
        }
      }
    }
    return best
  }

  // Pass 1 against everything, pass 2 only against clusters that aren't combos themselves.
  const first = new Map(clusters.map((c) => [c, evaluate(c, clusters)]))
  const bases = clusters.filter((c) => !first.get(c))
  for (const c of clusters) c.combo = first.get(c) ? evaluate(c, bases) : null

  // Known sound + something we've never heard on its own.
  const plain = clusters.filter((c) => !c.combo)
  for (const c of plain) {
    let cMax = 0
    for (let b = 0; b < B; b++) cMax = Math.max(cMax, c.tmpl[b])
    let best: { A: Cluster; k: number; R: Float64Array; score: number } | null = null
    for (const A of plain) {
      if (A === c || A.members.length < 2) continue
      let aMax = 0
      for (let b = 0; b < B; b++) aMax = Math.max(aMax, A.tmpl[b])
      const dom: number[] = []
      for (let b = 0; b < B; b++) if (A.tmpl[b] >= aMax * Math.pow(10, -15 / 10)) dom.push(b)
      if (!dom.length) continue
      const k = percentile(dom.map((b) => c.tmpl[b] / (A.tmpl[b] + 1e-30)), 0.3)
      if (k * aMax < cMax * Math.pow(10, -12 / 10)) continue // A would only be a faint ghost in c
      const R = new Float64Array(B)
      for (let b = 0; b < B; b++) R[b] = Math.max(c.tmpl[b] - k * A.tmpl[b], c.tmpl[b] * 0.02)
      let resid = 0
      for (const b of dom) resid += R[b] / (c.tmpl[b] + 1e-30) / dom.length
      if (resid > 0.35) continue
      let uBands = 0
      for (let b = 0; b < B; b++) if (R[b] > k * A.tmpl[b] && R[b] >= cMax * Math.pow(10, -25 / 10)) uBands++
      if (uBands / B < 0.2) continue
      if (Math.abs(log2Centroid(R, hz) - log2Centroid(A.tmpl, hz)) < 1.5) continue
      if (!best || resid < best.score) best = { A, k, R, score: resid }
    }
    if (best) {
      c.combo = { a: best.k, parts: [best.A.id, -1], weights: [1, best.k] }
      c.residual = best.R
    }
  }
}

export function classifyFeatures(t: Float64Array, hz: number[], decayMs: number) {
  let tot = 0, sub = 0, low = 0, high = 0
  for (let b = 0; b < t.length; b++) { tot += t[b]; if (hz[b] < 90) sub += t[b]; if (hz[b] < 160) low += t[b]; if (hz[b] > 4000) high += t[b] }
  let lg = 0, ar = 0, n = 0
  for (let b = 0; b < t.length; b++) { if (hz[b] < 80 || hz[b] > 10000) continue; lg += Math.log(t[b] + 1e-30); ar += t[b]; n++ }
  return { sub: sub / tot, low: low / tot, high: high / tot, centroid: Math.pow(2, log2Centroid(t, hz)), flat: Math.exp(lg / n) / (ar / n), decayMs }
}

function classify(t: Float64Array, hz: number[], decayMs: number) {
  let tot = 0, low = 0, sub = 0, mid = 0, high = 0, air = 0
  for (let b = 0; b < t.length; b++) {
    const f = hz[b]
    const p = t[b]
    tot += p
    if (f < 90) sub += p
    if (f < 160) low += p
    else if (f < 2500) mid += p
    if (f > 4000) high += p
    if (f > 8000) air += p
  }
  tot += 1e-30
  const lowF = low / tot
  const highF = high / tot
  const centroid = Math.pow(2, log2Centroid(t, hz))
  // Flatness over the body of the sound: noisy (snare/hat) vs tonal (tom/bass).
  let lg = 0, ar = 0, n = 0
  for (let b = 0; b < t.length; b++) {
    if (hz[b] < 80 || hz[b] > 10000) continue
    lg += Math.log(t[b] + 1e-30); ar += t[b]; n++
  }
  const flat = Math.exp(lg / n) / (ar / n + 1e-30)

  if (lowF > 0.45 && centroid < 230 && decayMs < 1500) return 'Kick'
  if (highF > 0.35 || centroid > 4500) {
    if (decayMs < 140) return 'Closed hat'
    if (decayMs < 500) return 'Open hat'
    return air / tot > 0.15 ? 'Crash' : 'Ride'
  }
  if (lowF > 0.55) return decayMs >= 1500 ? 'Bass' : 'Kick'
  if (flat < 0.05 && centroid < 600) return decayMs > 600 ? 'Tone' : 'Tom'
  if (centroid > 900 && decayMs < 90 && flat > 0.12) return 'Rim'
  if (mid / tot > 0.3 || flat > 0.08) return 'Snare'
  return 'Perc'
}

/** Short fades and peak-normalise to -1 dBFS. */
function finish(chs: Float32Array[], SR: number) {
  const n = chs[0]?.length ?? 0
  const fin = Math.min(n, Math.round(0.0005 * SR))
  const fout = Math.min(n, Math.round(Math.min(0.012, (n / SR) * 0.15) * SR))
  let peak = 0
  for (const ch of chs) {
    for (let i = 0; i < fin; i++) ch[i] *= i / fin
    for (let i = 0; i < fout; i++) ch[n - 1 - i] *= i / fout
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ch[i]))
  }
  if (peak > 1e-6) {
    const g = 0.891 / peak
    for (const ch of chs) for (let i = 0; i < n; i++) ch[i] *= g
  }
}
