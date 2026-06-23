// SPDX-License-Identifier: GPL-3.0-or-later
// ElevenLabs Speech-to-Text: extract audio from video at 16 kHz mono, upload to Scribe v1,
// return word-level timestamps. The extraction step keeps the upload small (< 10 MB per 10 min)
// and uses 16 kHz — adequate for speech, far above the 8 kHz sync path.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ffmpegBinary } from '../ffmpeg/binary'

const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text'

export interface TranscriptWord {
  text: string
  startMs: number
  endMs: number
  type: 'word' | 'spacing' | 'audio_event'
  speakerId: string | null
}

export interface TranscribeOptions {
  languageCode?: string
  diarize?: boolean
}

/** Extract audio at 16 kHz mono mp3 to `outDir`, return the temp file path. */
async function extractAudio16k(videoPath: string, outDir: string): Promise<string> {
  const outPath = join(outDir, `transcript-${randomUUID()}.mp3`)
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(ffmpegBinary(), [
      '-y',
      '-i', videoPath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'libmp3lame',
      '-b:a', '48k',
      outPath
    ])
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))))
    ff.on('error', reject)
  })
  return outPath
}

/** Upload an audio file to ElevenLabs Scribe and return word-level timestamps. */
export async function transcribeMedia(
  videoPath: string,
  apiKey: string,
  outDir: string,
  opts: TranscribeOptions = {}
): Promise<{ text: string; words: TranscriptWord[] }> {
  const audioPath = await extractAudio16k(videoPath, outDir)
  try {
    const audioBuffer = await readFile(audioPath)
    const form = new FormData()
    form.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'audio.mp3')
    form.append('model_id', 'scribe_v1')
    form.append('timestamps_granularity', 'word')
    if (opts.languageCode) form.append('language_code', opts.languageCode)
    if (opts.diarize) form.append('diarize', 'true')

    const res = await fetch(ELEVENLABS_STT_URL, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`ElevenLabs ${res.status}: ${body}`)
    }
    const data = (await res.json()) as {
      text: string
      words: { text: string; start_time: number; end_time: number; type: string; speaker_id?: string }[]
    }
    return {
      text: data.text,
      words: (data.words ?? []).map((w) => ({
        text: w.text,
        startMs: Math.round(w.start_time * 1000),
        endMs: Math.round(w.end_time * 1000),
        type: (w.type ?? 'word') as TranscriptWord['type'],
        speakerId: w.speaker_id ?? null
      }))
    }
  } finally {
    await rm(audioPath, { force: true })
  }
}
