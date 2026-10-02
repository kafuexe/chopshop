let ctx: AudioContext | null = null

export function audioContext() {
  if (!ctx) ctx = new AudioContext({ sampleRate: 44100 })
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

export async function decode(data: ArrayBuffer) {
  const buffer = await audioContext().decodeAudioData(data)
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, i) => buffer.getChannelData(i).slice())
  return { channels, sampleRate: buffer.sampleRate }
}

let current: AudioBufferSourceNode | null = null

/** Play once; starting a new sound chokes the previous one, like a sampler's mono mode. */
export function play(channels: Float32Array[], sampleRate: number, onEnd?: () => void) {
  const ac = audioContext()
  const buf = ac.createBuffer(channels.length, channels[0].length, sampleRate)
  channels.forEach((ch, i) => buf.copyToChannel(ch as Float32Array<ArrayBuffer>, i))
  current?.stop()
  const src = ac.createBufferSource()
  src.buffer = buf
  src.connect(ac.destination)
  src.onended = () => { if (current === src) current = null; onEnd?.() }
  src.start()
  current = src
  return buf.duration
}
