/** 24-bit PCM WAV. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const nCh = channels.length
  const n = channels[0]?.length ?? 0
  const bytes = 3
  const dataSize = n * nCh * bytes
  const buf = new ArrayBuffer(44 + dataSize)
  const v = new DataView(buf)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * bytes, true)
  v.setUint16(32, nCh * bytes, true); v.setUint16(34, bytes * 8, true)
  str(36, 'data'); v.setUint32(40, dataSize, true)
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]))
      const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff)
      v.setUint8(o, x & 0xff); v.setUint8(o + 1, (x >> 8) & 0xff); v.setUint8(o + 2, (x >> 16) & 0xff)
      o += 3
    }
  }
  return new Blob([buf], { type: 'audio/wav' })
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled'
}
