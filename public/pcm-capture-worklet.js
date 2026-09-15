/**
 * AudioWorklet processor: forwards raw Float32 PCM frames to the main thread.
 *
 * This exists so enrollment audio can be captured LOSSLESSLY. MediaRecorder —
 * the obvious choice — produces WebM/Opus, which is lossy. That matters here not
 * because a human would hear the difference, but because the voice model derives
 * a speaker embedding from this audio, and lossy codecs discard exactly the
 * high-frequency and phase detail those features are computed from. The result
 * would be a quietly worse clone with no visible cause.
 *
 * Served from /public so it can be loaded by URL via addModule().
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._recording = false
    this.port.onmessage = (event) => {
      if (event.data?.command === "start") this._recording = true
      if (event.data?.command === "stop") this._recording = false
    }
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const channel = input[0]
    if (!channel) return true

    // Peak for the live level meter. Sent every block regardless of whether we
    // are recording, so the meter works while the user is still setting up —
    // catching a bad input chain BEFORE the take rather than after it.
    let peak = 0
    for (let i = 0; i < channel.length; i++) {
      const a = channel[i] < 0 ? -channel[i] : channel[i]
      if (a > peak) peak = a
    }

    if (this._recording) {
      // Copy: the underlying buffer is reused by the audio thread.
      this.port.postMessage({ type: "chunk", peak, samples: new Float32Array(channel) })
    } else {
      this.port.postMessage({ type: "level", peak })
    }

    return true
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor)
