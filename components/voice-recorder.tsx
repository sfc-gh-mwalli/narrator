"use client"

/**
 * Lossless in-browser recorder for enrollment takes.
 *
 * Captures raw PCM through an AudioWorklet and encodes WAV client-side, rather
 * than using MediaRecorder (which yields lossy Opus — see the worklet file for
 * why that matters for a speaker embedding).
 *
 * The live level and clipping meter is the point of the UI: it surfaces a bad
 * input chain while the user is still setting up, instead of after they have
 * read a whole passage.
 */
import { useCallback, useEffect, useRef, useState } from "react"

const TARGET_SAMPLE_RATE = 24_000

/** Interleave nothing (mono) and write a 44-byte RIFF header + PCM16 body. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(8, "WAVE")
  writeAscii(12, "fmt ")
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // format = PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, "data")
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }

  return new Blob([buffer], { type: "audio/wav" })
}

export interface VoiceRecorderProps {
  disabled?: boolean
  onRecorded: (wav: Blob, seconds: number) => void
}

export function VoiceRecorder({ disabled, onRecorded }: VoiceRecorderProps) {
  const [state, setState] = useState<
    "idle" | "arming" | "armed" | "recording" | "done"
  >("idle")
  const [peak, setPeak] = useState(0)
  const [clipped, setClipped] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const startedAtRef = useRef<number>(0)

  const teardown = useCallback(() => {
    nodeRef.current?.disconnect()
    nodeRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    ctxRef.current?.close().catch(() => {})
    ctxRef.current = null
  }, [])

  useEffect(() => teardown, [teardown])

  const arm = useCallback(async () => {
    setError(null)
    setState("arming")
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Leave the signal alone: these processors are tuned for intelligibility
          // on calls, not for preserving the timbre a voice clone depends on.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      streamRef.current = stream

      const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      ctxRef.current = ctx
      await ctx.audioWorklet.addModule("/pcm-capture-worklet.js")

      const source = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, "pcm-capture")
      nodeRef.current = node

      node.port.onmessage = (event) => {
        const data = event.data
        if (data.type === "level" || data.type === "chunk") {
          setPeak(data.peak)
          if (data.peak >= 0.999) setClipped(true)
        }
        if (data.type === "chunk") {
          chunksRef.current.push(data.samples)
          setSeconds((Date.now() - startedAtRef.current) / 1000)
        }
      }

      source.connect(node)
      // Not connected to destination: no monitoring, so no feedback loop.
      setState("armed")
    } catch (e) {
      console.error("[recorder] failed to arm", e)
      setError(
        e instanceof Error
          ? `Could not access the microphone: ${e.message}`
          : "Could not access the microphone.",
      )
      setState("idle")
      teardown()
    }
  }, [teardown])

  const start = useCallback(() => {
    chunksRef.current = []
    setClipped(false)
    setSeconds(0)
    startedAtRef.current = Date.now()
    nodeRef.current?.port.postMessage({ command: "start" })
    setState("recording")
  }, [])

  const stop = useCallback(() => {
    nodeRef.current?.port.postMessage({ command: "stop" })

    const total = chunksRef.current.reduce((n, c) => n + c.length, 0)
    const merged = new Float32Array(total)
    let offset = 0
    for (const c of chunksRef.current) {
      merged.set(c, offset)
      offset += c.length
    }
    const rate = ctxRef.current?.sampleRate ?? TARGET_SAMPLE_RATE
    onRecorded(encodeWav(merged, rate), merged.length / rate)
    chunksRef.current = []

    // Release the microphone and freeze the meter. Previously the worklet kept
    // streaming level updates after Stop, so the meter went on twitching at room
    // noise and the browser's mic indicator stayed lit — both of which read as
    // "still recording". Re-arming is now an explicit action.
    teardown()
    setPeak(0)
    setState("done")
  }, [onRecorded, teardown])

  const pct = Math.min(100, Math.round(peak * 100))
  const meterColor = clipped ? "bg-red-500" : pct > 85 ? "bg-amber-500" : "bg-emerald-500"

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        {state === "idle" && (
          <button
            type="button"
            onClick={arm}
            disabled={disabled}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Enable microphone
          </button>
        )}
        {state === "arming" && <span className="text-sm text-muted-foreground">Requesting microphone…</span>}
        {state === "armed" && (
          <button
            type="button"
            onClick={start}
            disabled={disabled}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Start recording
          </button>
        )}
        {state === "recording" && (
          <button
            type="button"
            onClick={stop}
            className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white"
          >
            Stop ({seconds.toFixed(1)}s)
          </button>
        )}
        {state === "done" && (
          <>
            <span className="text-sm text-muted-foreground">
              Recording stopped — microphone released. Review it below.
            </span>
            <button
              type="button"
              onClick={arm}
              disabled={disabled}
              className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              Record again
            </button>
          </>
        )}
      </div>

      {state !== "idle" && state !== "done" && (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded bg-muted">
            <div
              className={`h-full transition-[width] duration-75 ${meterColor}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {clipped
              ? "Clipping detected — lower your input gain and record again."
              : state === "armed"
                ? "Check your level before starting: aim high without touching the top."
                : "Aim for the meter to sit high without touching the top."}
          </p>
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  )
}
