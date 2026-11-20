// Background music for the timelapse.
//
// Every clip gets one song from ./music, picked at random. The song is fetched
// when recording starts (so Stop doesn't wait on the network) but only decoded
// at Stop — a decoded 4-minute song is ~90 MB of samples, too much to hold
// through a multi-hour session. At Stop it's cut to the clip's length (looped
// if the clip runs longer), faded out, and encoded for the MP4's audio track.
//
// To add or remove a song, just add or remove a file in ./music.

const SONGS = Object.values(
  import.meta.glob('./music/*.{mp3,aac,m4a}', { query: '?url', import: 'default', eager: true }),
) as string[]

// 48 kHz is the one rate both AAC and Opus encoders take.
const SAMPLE_RATE = 48_000
const CHANNELS = 2
const BITRATE = 128_000
// AAC plays everywhere MP4 does; Opus covers browsers without an AAC encoder.
const CODECS: { codec: string; muxer: 'aac' | 'opus' }[] = [
  { codec: 'mp4a.40.2', muxer: 'aac' },
  { codec: 'opus', muxer: 'opus' },
]
const FADE_OUT_S = 2.5
// Samples handed to the encoder per AudioData (0.1s).
const BLOCK = SAMPLE_RATE / 10

export type AudioMuxCodec = 'aac' | 'opus'

export interface EncodedSoundtrack {
  codec: AudioMuxCodec
  chunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[]
}

// Starts fetching a random song. Resolves to its undecoded bytes, or null.
export function fetchSong(): Promise<ArrayBuffer | null> {
  if (SONGS.length === 0) return Promise.resolve(null)
  const url = SONGS[Math.floor(Math.random() * SONGS.length)]
  return fetch(url)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null)
}

async function pickCodec(): Promise<(typeof CODECS)[number] | null> {
  if (typeof AudioEncoder === 'undefined') return null
  for (const option of CODECS) {
    const config = {
      codec: option.codec,
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate: BITRATE,
    }
    try {
      if ((await AudioEncoder.isConfigSupported(config)).supported) return option
    } catch {
      // Unparseable config counts as unsupported.
    }
  }
  return null
}

// Decode the song, fit it to `durationUs`, and encode it. Null when this
// browser can't (no audio encoder, undecodable file) — the clip goes silent.
export async function encodeSoundtrack(
  song: ArrayBuffer,
  durationUs: number,
): Promise<EncodedSoundtrack | null> {
  const codec = await pickCodec()
  if (!codec) return null

  // An OfflineAudioContext decodes straight to its own sample rate, so any
  // song comes out at 48 kHz whatever it was recorded at.
  const decoder = new OfflineAudioContext(CHANNELS, 1, SAMPLE_RATE)
  const buffer = await decoder.decodeAudioData(song)
  const source = Array.from({ length: CHANNELS }, (_, c) =>
    buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)),
  )
  const songLength = buffer.length
  const total = Math.floor((durationUs / 1_000_000) * SAMPLE_RATE)
  // Short clips get a shorter fade, so the music isn't fading the whole time.
  const fade = Math.min(FADE_OUT_S * SAMPLE_RATE, Math.floor(total / 4))

  const chunks: EncodedSoundtrack['chunks'] = []
  let failure: Error | null = null
  const encoder = new AudioEncoder({
    output: (chunk, meta) => chunks.push({ chunk, meta }),
    error: (e) => {
      failure = e
    },
  })
  encoder.configure({
    codec: codec.codec,
    sampleRate: SAMPLE_RATE,
    numberOfChannels: CHANNELS,
    bitrate: BITRATE,
  })

  for (let start = 0; start < total && !failure; start += BLOCK) {
    const frames = Math.min(BLOCK, total - start)
    // Planar: all of channel 0, then all of channel 1.
    const data = new Float32Array(frames * CHANNELS)
    for (let c = 0; c < CHANNELS; c++) {
      for (let i = 0; i < frames; i++) {
        const at = start + i
        const fromEnd = total - at
        const gain = fromEnd < fade ? fromEnd / fade : 1
        data[c * frames + i] = source[c][at % songLength] * gain // loops if short
      }
    }
    const audio = new AudioData({
      format: 'f32-planar',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: frames,
      numberOfChannels: CHANNELS,
      timestamp: Math.round((start / SAMPLE_RATE) * 1_000_000),
      data,
    })
    try {
      encoder.encode(audio)
    } finally {
      audio.close()
    }
  }
  if (!failure) await encoder.flush()
  if (encoder.state !== 'closed') encoder.close()
  if (failure || chunks.length === 0) {
    console.error('soundtrack encode error', failure)
    return null
  }
  return { codec: codec.muxer, chunks }
}
