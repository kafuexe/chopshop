// Run the analyzer on a local WAV from the command line: npx tsx scripts/probe.ts file.wav
import { readFileSync } from 'node:fs'
import { analyze, DEFAULT_PARAMS } from '../src/engine/analyze'

const buf = readFileSync(process.argv[2])
let off = 12
let fmt = { ch: 2, sr: 44100, bits: 16 }
let data: Buffer | null = null
while (off + 8 <= buf.length) {
  const id = buf.toString('ascii', off, off + 4)
  const size = buf.readUInt32LE(off + 4)
  if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(off + 10), sr: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) }
  if (id === 'data') { data = buf.subarray(off + 8, off + 8 + size); break }
  off += 8 + size
}
const n = data!.length / 2 / fmt.ch
const chans = Array.from({ length: fmt.ch }, () => new Float32Array(n))
for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) chans[c][i] = data!.readInt16LE((i * fmt.ch + c) * 2) / 32768

const params = { ...DEFAULT_PARAMS, ...JSON.parse(process.argv[3] ?? '{}') }
const t0 = performance.now()
const r = analyze(chans, fmt.sr, params)
console.log(`${(performance.now() - t0).toFixed(0)} ms, ${r.duration.toFixed(1)} s audio`)
console.log(r.stats)
for (const it of r.items) {
  console.log(
    `${it.name.padEnd(14)} ${it.kind.padEnd(5)} x${String(it.count).padEnd(3)} ` +
      (it.debug ? Object.entries(it.debug).map(([k,v])=>k+'='+(+v).toPrecision(3)).join(' ') + '  ' : '') + it.variants.map((v) => `[${v.start.toFixed(3)}-${v.end.toFixed(3)} ${v.notes.join(',')}]`).join(' '),
  )
}
