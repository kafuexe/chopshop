// Tiny bridge between the browser and YouTube: yt-dlp fetches the audio stream,
// ffmpeg decodes it to 44.1 kHz stereo WAV. All slicing happens in the browser.
import { spawn, spawnSync } from 'node:child_process'
import express from 'express'

const PORT = Number(process.env.PORT ?? 8787)
const MAX_SECONDS = Number(process.env.MAX_SECONDS ?? 900)
// Lets yt-dlp solve YouTube's JS challenges with the Node runtime we're already in.
const JS_RT = ['--js-runtimes', `node:${process.execPath}`]

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
])

function resolveYtDlp() {
  const candidates = [
    ['yt-dlp', []],
    ['py', ['-m', 'yt_dlp']],
    ['python', ['-m', 'yt_dlp']],
    ['python3', ['-m', 'yt_dlp']],
  ]
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8' })
    if (r.status === 0) return { cmd, pre }
  }
  return null
}

const ytdlp = resolveYtDlp()
if (!ytdlp) console.warn('[chopshop] yt-dlp not found. Install it with: pip install yt-dlp')
else console.log(`[chopshop] using yt-dlp via "${[ytdlp.cmd, ...ytdlp.pre].join(' ')}"`)

function parseVideoUrl(raw) {
  let url
  try { url = new URL(String(raw ?? '').trim()) } catch { return null }
  if (!/^https?:$/.test(url.protocol) || !YT_HOSTS.has(url.hostname)) return null
  return url.toString()
}

const app = express()

app.get('/api/info', (req, res) => {
  const url = parseVideoUrl(req.query.url)
  if (!url) return res.status(400).json({ error: 'That doesn’t look like a YouTube link.' })
  if (!ytdlp) return res.status(500).json({ error: 'yt-dlp is not installed on the server. Run: pip install yt-dlp' })

  const p = spawn(ytdlp.cmd, [...ytdlp.pre, '-J', '--no-playlist', '--no-warnings', ...JS_RT, url])
  let out = ''
  let err = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (err += d))
  p.on('error', (e) => {
    console.error('[chopshop] could not start yt-dlp:', e.message)
    if (!res.headersSent) res.status(500).json({ error: `Could not start yt-dlp: ${e.message}` })
  })
  p.on('close', (code) => {
    if (res.headersSent) return
    if (code !== 0) {
      console.error(`[chopshop] yt-dlp exited with ${code} for ${url}\n${err.trim()}`)
      return res.status(502).json({ error: cleanError(err) || `yt-dlp failed (exit code ${code}). Check the server log.` })
    }
    try {
      const j = JSON.parse(out)
      if (j.duration && j.duration > MAX_SECONDS) {
        return res.status(413).json({
          error: `This video is ${Math.round(j.duration / 60)} min long. The limit is ${Math.round(MAX_SECONDS / 60)} min.`,
        })
      }
      res.json({ id: j.id, title: j.title, duration: j.duration, channel: j.channel ?? j.uploader, thumbnail: j.thumbnail })
    } catch {
      res.status(502).json({ error: 'Could not read video details.' })
    }
  })
})

app.get('/api/audio', (req, res) => {
  const url = parseVideoUrl(req.query.url)
  if (!url) return res.status(400).json({ error: 'That doesn’t look like a YouTube link.' })
  if (!ytdlp) return res.status(500).json({ error: 'yt-dlp is not installed on the server. Run: pip install yt-dlp' })

  const dl = spawn(ytdlp.cmd, [
    ...ytdlp.pre, '-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '--quiet', ...JS_RT, '-o', '-', url,
  ])
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', String(MAX_SECONDS),
    '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1',
  ])

  let dlErr = ''
  dl.stderr.on('data', (d) => (dlErr += d))
  const startFailed = (what) => (e) => {
    console.error(`[chopshop] could not start ${what}:`, e.message)
    if (!res.headersSent) res.status(500).json({ error: `Could not start ${what}: ${e.message}` })
  }
  dl.on('error', startFailed('yt-dlp'))
  ff.on('error', startFailed('ffmpeg'))
  dl.stdout.pipe(ff.stdin)
  ff.stdin.on('error', () => {})

  // Buffer the WAV so the header carries a correct length, then send it in one go.
  const chunks = []
  ff.stdout.on('data', (c) => chunks.push(c))
  ff.on('close', (code) => {
    if (res.headersSent) return
    if (code !== 0 || chunks.length === 0) {
      console.error(`[chopshop] audio failed for ${url} (ffmpeg exit ${code})\n${dlErr.trim()}`)
      return res.status(502).json({ error: cleanError(dlErr) || 'Could not decode the audio.' })
    }
    const wav = Buffer.concat(chunks)
    fixWavHeader(wav)
    res.setHeader('Content-Type', 'audio/wav')
    res.setHeader('Content-Length', wav.length)
    res.end(wav)
  })

  req.on('close', () => {
    if (!res.writableEnded) { dl.kill(); ff.kill() }
  })
})

// ffmpeg writes placeholder sizes when its output is a pipe.
function fixWavHeader(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return
  buf.writeUInt32LE(buf.length - 8, 4)
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    if (id === 'data') { buf.writeUInt32LE(buf.length - off - 8, off + 4); return }
    off += 8 + buf.readUInt32LE(off + 4)
  }
}

function cleanError(s) {
  const line = s.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ERROR')).pop()
  if (line) return line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, '')
  return s.split('\n').map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 300) ?? ''
}

app.listen(PORT, () => console.log(`[chopshop] audio server on http://localhost:${PORT}`))
