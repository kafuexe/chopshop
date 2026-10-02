// Small, dependency-free DSP toolkit: FFT, filterbank STFT, masked resynthesis.

export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr; im[b] = im[a] - xi
        re[a] += xr; im[a] += xi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

export function ifft(re: Float64Array, im: Float64Array) {
  for (let i = 0; i < im.length; i++) im[i] = -im[i]
  fft(re, im)
  const n = re.length
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n }
}

export function hann(n: number) {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return w
}

/** Log-spaced band edges (in FFT bins), every band at least one bin wide. */
export function makeBands(fftSize: number, sampleRate: number, count: number, fLo = 35, fHi = 16000) {
  const binHz = sampleRate / fftSize
  const maxBin = fftSize / 2
  const edges: number[] = []
  for (let i = 0; i <= count; i++) {
    const f = fLo * Math.pow(fHi / fLo, i / count)
    let b = Math.min(maxBin, Math.max(1, Math.round(f / binHz)))
    if (edges.length && b <= edges[edges.length - 1]) b = edges[edges.length - 1] + 1
    edges.push(b)
  }
  const bands: { lo: number; hi: number; hz: number }[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    if (edges[i] >= maxBin) break
    const lo = edges[i]
    const hi = Math.min(edges[i + 1], maxBin)
    bands.push({ lo, hi, hz: ((lo + hi) / 2) * binHz })
  }
  const binToBand = new Int32Array(maxBin + 1).fill(-1)
  bands.forEach((b, k) => { for (let j = b.lo; j < b.hi; j++) binToBand[j] = k })
  // Bins below the first band borrow the first band, above the last borrow the last.
  for (let j = 0; j <= maxBin; j++) {
    if (binToBand[j] === -1) binToBand[j] = j < bands[0].lo ? 0 : bands.length - 1
  }
  return { bands, binToBand }
}

export interface BandFrames {
  /** frames × bands, band power */
  power: Float32Array
  /** per-frame RMS of the windowed signal */
  rms: Float32Array
  frames: number
  nBands: number
  hop: number
  size: number
  bandHz: number[]
}

export function bandStft(x: Float32Array, sampleRate: number, size = 1024, hop = 256, nBands = 48): BandFrames {
  const { bands, binToBand } = makeBands(size, sampleRate, nBands)
  const B = bands.length
  const frames = Math.max(1, Math.floor((x.length - size) / hop) + 1)
  const power = new Float32Array(frames * B)
  const rms = new Float32Array(frames)
  const w = hann(size)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  for (let t = 0; t < frames; t++) {
    const off = t * hop
    let e = 0
    for (let i = 0; i < size; i++) {
      const v = x[off + i] ?? 0
      e += v * v
      re[i] = v * w[i]
      im[i] = 0
    }
    rms[t] = Math.sqrt(e / size)
    fft(re, im)
    const row = t * B
    for (let j = 1; j <= size / 2; j++) {
      power[row + binToBand[j]] += re[j] * re[j] + im[j] * im[j]
    }
    for (let k = 0; k < B; k++) power[row + k] /= bands[k].hi - bands[k].lo
  }
  return { power, rms, frames, nBands: B, hop, size, bandHz: bands.map((b) => b.hz) }
}

/**
 * Resynthesize `x` through a time-varying band mask via STFT/overlap-add.
 * `maskAt(frameTimeSec, band)` returns a gain in [0, 1].
 */
export function maskedResynth(
  x: Float32Array,
  sampleRate: number,
  bandHz: number[],
  maskAt: (tSec: number, band: number) => number,
  size = 2048,
) {
  const hop = size / 4
  const B = bandHz.length
  // Each bin follows the analysis band nearest to it in log-frequency.
  const binToBand = new Int32Array(size / 2 + 1)
  const logHz = bandHz.map((h) => Math.log2(h))
  for (let j = 0, k = 0; j <= size / 2; j++) {
    const lf = Math.log2(Math.max(1, (j * sampleRate) / size))
    while (k < B - 1 && Math.abs(logHz[k + 1] - lf) <= Math.abs(logHz[k] - lf)) k++
    binToBand[j] = k
  }
  const w = hann(size)
  const pad = size
  const n = x.length + pad * 2
  const out = new Float64Array(n)
  const norm = new Float64Array(n)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const gains = new Float64Array(B)
  for (let off = 0; off + size <= n; off += hop) {
    for (let i = 0; i < size; i++) {
      const s = off + i - pad
      re[i] = (s >= 0 && s < x.length ? x[s] : 0) * w[i]
      im[i] = 0
    }
    fft(re, im)
    const tSec = (off + size / 2 - pad) / sampleRate
    for (let k = 0; k < B; k++) gains[k] = maskAt(tSec, k)
    for (let j = 0; j <= size / 2; j++) {
      const g = gains[binToBand[j]]
      re[j] *= g; im[j] *= g
      if (j > 0 && j < size / 2) { re[size - j] *= g; im[size - j] *= g }
    }
    ifft(re, im)
    for (let i = 0; i < size; i++) {
      out[off + i] += re[i] * w[i]
      norm[off + i] += w[i] * w[i]
    }
  }
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const d = norm[i + pad]
    y[i] = d > 1e-8 ? out[i + pad] / d : 0
  }
  return y
}

export const db = (p: number) => 10 * Math.log10(p + 1e-12)
