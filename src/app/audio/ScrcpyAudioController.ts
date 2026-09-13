import Util from '../Util';

// Adapted from Mel0nFish/ws-scrcpy-enhanced, rewired for the 4.0-ws2 fork
// where audio frames arrive interleaved with video on the same WebSocket.
//
// Device protocol (see server WebSocketStreamer.java):
//   scrcpy_audiobg + 4-byte codec id ("opus" / "flac" / "\0raw"), or disable flag (byte 3 = 1)
//   scrcpy_audiodt + 12-byte header + payload:
//       8-byte pts/flags (bit 62 = config packet, bit 61 = key frame)
//       4-byte payload size

const MAGIC_BYTES_AUDIO_BEGIN = Util.stringToUtf8ByteArray('scrcpy_audiobg');
const MAGIC_BYTES_AUDIO_DATA = Util.stringToUtf8ByteArray('scrcpy_audiodt');
const MAGIC_BYTES_LENGTH = MAGIC_BYTES_AUDIO_DATA.length;

const PACKET_FLAG_CONFIG = 4611686018427387904; // 1 << 62
const PACKET_FLAG_KEY_FRAME = 2305843009213693952; // 1 << 61

function equalArrays(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0, l = a.length; i < l; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

function readU32BE(data: Uint8Array, offset: number): number {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, false);
}

// 64-bit big-endian signed value as a JS number (safe for pts/flags, no BigInt needed)
function readI64BE(data: Uint8Array, offset: number): number {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const hi = view.getInt32(offset, false);
    const lo = view.getUint32(offset + 4, false);
    if (hi >= 0) {
        return hi * 4294967296 + lo;
    }
    const hiU = ~hi >>> 0;
    const loU = ~lo >>> 0;
    return -((hiU * 4294967296 + loU) + 1);
}

// OpusHead: "OpusHead" + ver(1) + channels(1) + preSkip(2 LE) + sampleRate(4 LE) + gain(2) + mapping(1)
function parseOpusHead(config: Uint8Array): { sampleRate: number; channels: number } | undefined {
    if (config.byteLength < 19) {
        return undefined;
    }
    if (Util.utf8ByteArrayToString(config.subarray(0, 8)) !== 'OpusHead') {
        return undefined;
    }
    const channels = config[9];
    const sampleRate = (config[12] | (config[13] << 8) | (config[14] << 16) | (config[15] << 24)) >>> 0;
    if (!sampleRate || channels < 1 || channels > 2) {
        return undefined;
    }
    return { sampleRate, channels };
}

function toAudioBuffer(ctx: AudioContext, audioData: AudioData): AudioBuffer {
    const frames = audioData.numberOfFrames;
    const channels = audioData.numberOfChannels;
    const format = typeof audioData.format === 'string' ? audioData.format : 'f32-planar';
    const isPlanar = format.indexOf('planar') !== -1;
    const buffer = ctx.createBuffer(channels, frames, audioData.sampleRate);

    const copyToFloat32 = (planeIndex: number, elements: number): Float32Array => {
        if (format === 'f32' || format === 'f32-planar') {
            const tmp = new Float32Array(elements);
            audioData.copyTo(tmp, { planeIndex });
            return tmp;
        }
        if (format === 's16' || format === 's16-planar') {
            const tmp = new Int16Array(elements);
            audioData.copyTo(tmp, { planeIndex });
            const out = new Float32Array(elements);
            for (let i = 0; i < elements; i++) {
                out[i] = tmp[i] / 32768;
            }
            return out;
        }
        const tmp = new Float32Array(elements);
        audioData.copyTo(tmp, { planeIndex });
        return tmp;
    };

    if (isPlanar) {
        for (let c = 0; c < channels; c++) {
            buffer.copyToChannel(copyToFloat32(c, frames), c);
        }
        return buffer;
    }

    const interleaved = copyToFloat32(0, frames * channels);
    for (let c = 0; c < channels; c++) {
        const tmp = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
            tmp[i] = interleaved[i * channels + c];
        }
        buffer.copyToChannel(tmp, c);
    }
    return buffer;
}

function toInterleavedFloat32(audioData: AudioData): Float32Array {
    const frames = audioData.numberOfFrames;
    const channels = audioData.numberOfChannels;
    const format = typeof audioData.format === 'string' ? audioData.format : 'f32-planar';
    const isPlanar = format.indexOf('planar') !== -1;

    const copyToFloat32 = (planeIndex: number, elements: number): Float32Array => {
        if (format === 'f32' || format === 'f32-planar') {
            const tmp = new Float32Array(elements);
            audioData.copyTo(tmp, { planeIndex });
            return tmp;
        }
        if (format === 's16' || format === 's16-planar') {
            const tmp = new Int16Array(elements);
            audioData.copyTo(tmp, { planeIndex });
            const out = new Float32Array(elements);
            for (let i = 0; i < elements; i++) {
                out[i] = tmp[i] / 32768;
            }
            return out;
        }
        const tmp = new Float32Array(elements);
        audioData.copyTo(tmp, { planeIndex });
        return tmp;
    };

    if (!isPlanar) {
        return copyToFloat32(0, frames * channels);
    }

    const out = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c++) {
        const plane = copyToFloat32(c, frames);
        for (let i = 0; i < frames; i++) {
            out[i * channels + c] = plane[i] || 0;
        }
    }
    return out;
}

function supportsAudioWorklet(ctx: AudioContext): boolean {
    return typeof AudioWorkletNode === 'function' && !!ctx.audioWorklet;
}

function createPcmWorkletModuleUrl(): string {
    const code = `
class WsScrcpyPcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.channels = 2;
    this.maxQueuedFrames = sampleRate * 2;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'reset') {
        this.queue.length = 0;
        this.channels = 2;
        return;
      }
      if (msg.type !== 'push') return;
      const channels = msg.channels | 0;
      const frames = msg.frames | 0;
      const startTime = +msg.startTime;
      const buf = msg.data;
      if (!channels || !frames || !isFinite(startTime) || !(buf instanceof ArrayBuffer)) return;
      const data = new Float32Array(buf);
      const startFrame = Math.max(0, Math.round(startTime * sampleRate));
      this.channels = channels;
      this.queue.push({ startFrame, frames, channels, data, offset: 0 });
      let total = 0;
      for (let i = 0; i < this.queue.length; i++) total += this.queue[i].frames;
      while (total > this.maxQueuedFrames && this.queue.length) {
        const dropped = this.queue.shift();
        total -= dropped ? dropped.frames : 0;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const outCh = out.length;
    const blockFrames = out[0].length;
    for (let c = 0; c < outCh; c++) out[c].fill(0);
    if (!this.queue.length) return true;
    const currentFrame = Math.round(currentTime * sampleRate);
    let chunk = this.queue[0];
    if (!chunk) return true;
    const lateBy = currentFrame - chunk.startFrame;
    if (lateBy > 0 && chunk.offset === 0) {
      const skip = Math.min(chunk.frames, lateBy);
      chunk.offset = skip;
    }
    for (let i = 0; i < blockFrames; i++) {
      const frameIndex = currentFrame + i;
      chunk = this.queue[0];
      if (!chunk) break;
      if (frameIndex < chunk.startFrame) continue;
      const rel = frameIndex - chunk.startFrame;
      if (rel < chunk.offset) continue;
      const sampleIndex = rel * chunk.channels;
      if (rel >= chunk.frames) {
        this.queue.shift();
        i--;
        continue;
      }
      for (let c = 0; c < outCh; c++) {
        const srcC = c < chunk.channels ? c : 0;
        out[c][i] = chunk.data[sampleIndex + srcC] || 0;
      }
      if (rel + 1 >= chunk.frames) {
        this.queue.shift();
      }
    }
    return true;
  }
}
registerProcessor('ws-scrcpy-pcm-player', WsScrcpyPcmPlayerProcessor);
`;
    const blob = new Blob([code], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
}

export class ScrcpyAudioController {
    public static isSupported(): boolean {
        return (
            typeof AudioContext === 'function' &&
            typeof AudioDecoder === 'function' &&
            typeof EncodedAudioChunk === 'function'
        );
    }

    private enabled = false;
    private sessionId = 0;
    private decoderSessionId = 0;
    private audioConfig?: Uint8Array;
    private decoder?: AudioDecoder;
    private ctx?: AudioContext;
    private gain?: GainNode;
    private workletNode?: AudioWorkletNode;
    private workletModuleUrl?: string;
    private scheduled: AudioBufferSourceNode[] = [];
    private nextStartTime = 0;

    public setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) {
            this.stop();
        }
    }

    public pushFrame(data: Uint8Array): void {
        if (!this.enabled || data.byteLength <= MAGIC_BYTES_LENGTH) {
            return;
        }
        const magic = data.subarray(0, MAGIC_BYTES_LENGTH);
        if (equalArrays(magic, MAGIC_BYTES_AUDIO_BEGIN)) {
            this.handleBegin(data.subarray(MAGIC_BYTES_LENGTH));
            return;
        }
        if (equalArrays(magic, MAGIC_BYTES_AUDIO_DATA)) {
            this.handlePacket(data.subarray(MAGIC_BYTES_LENGTH));
        }
    }

    private handleBegin(bytes: Uint8Array): void {
        if (bytes.byteLength < 4) {
            return;
        }
        const codecBytes = bytes.subarray(0, 4);
        const codecId = Util.utf8ByteArrayToString(codecBytes).replace(/\0+$/g, '');
        const disabled = (codecBytes[3] & 1) === 1;
        if (disabled || codecId !== 'opus') {
            this.stop();
            return;
        }
        this.ensureOutput().catch(() => {
            this.stop();
        });
    }

    private handlePacket(bytes: Uint8Array): void {
        if (bytes.byteLength < 12) {
            return;
        }
        const ptsAndFlags = readI64BE(bytes, 0);
        const size = readU32BE(bytes, 8);
        const payload = bytes.subarray(12);
        if (payload.byteLength !== size) {
            this.stop();
            return;
        }
        const isConfig = ptsAndFlags >= PACKET_FLAG_CONFIG;
        const isKeyFrame = !isConfig && ptsAndFlags >= PACKET_FLAG_KEY_FRAME;
        const pts = ptsAndFlags - (isConfig ? PACKET_FLAG_CONFIG : 0) - (isKeyFrame ? PACKET_FLAG_KEY_FRAME : 0);

        if (isConfig) {
            this.audioConfig = payload.slice();
            if (this.decoder) {
                try {
                    this.decoder.close();
                } catch (_e) {}
                this.decoder = undefined;
            }
            this.decoderSessionId = 0;
            this.ensureConfigured();
            return;
        }

        if (!this.decoder) {
            return;
        }
        this.decoder.decode(
            new EncodedAudioChunk({
                type: isKeyFrame ? 'key' : 'delta',
                timestamp: pts > 0 ? pts : 0,
                data: payload,
            }),
        );
    }

    private async ensureOutput(): Promise<void> {
        if (this.ctx) {
            if (this.ctx.state !== 'running') {
                await this.ctx.resume();
            }
            return;
        }
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        this.ctx = ctx;
        const gain = ctx.createGain();
        gain.gain.value = 1;
        gain.connect(ctx.destination);
        this.gain = gain;
        if (ctx.state !== 'running') {
            await ctx.resume();
        }
        await this.ensureWorklet();
    }

    private async ensureWorklet(): Promise<void> {
        if (!this.ctx || !this.gain || this.workletNode || !supportsAudioWorklet(this.ctx)) {
            return;
        }
        const sid = this.sessionId;
        if (!this.workletModuleUrl) {
            this.workletModuleUrl = createPcmWorkletModuleUrl();
        }
        await this.ctx.audioWorklet.addModule(this.workletModuleUrl);
        if (sid !== this.sessionId || !this.ctx || !this.gain || this.workletNode) {
            return;
        }
        const node = new AudioWorkletNode(this.ctx, 'ws-scrcpy-pcm-player', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });
        node.connect(this.gain);
        this.workletNode = node;
    }

    private ensureConfigured(): void {
        if (!this.ctx || !this.audioConfig || this.decoder) {
            return;
        }
        const sid = this.sessionId;
        const head = parseOpusHead(this.audioConfig);
        const config: AudioDecoderConfig = {
            codec: 'opus',
            sampleRate: head ? head.sampleRate : 48000,
            numberOfChannels: head ? head.channels : 2,
            description: this.audioConfig,
        };
        if (typeof AudioDecoder.isConfigSupported === 'function') {
            AudioDecoder.isConfigSupported(config)
                .then((result) => {
                    if (sid !== this.sessionId) {
                        return;
                    }
                    if (!result.supported) {
                        this.stop();
                        return;
                    }
                    this.configureDecoder(config);
                })
                .catch((_e: unknown) => {
                    if (sid !== this.sessionId) {
                        return;
                    }
                    this.stop();
                });
            return;
        }
        this.configureDecoder(config);
    }

    private configureDecoder(config: AudioDecoderConfig): void {
        if (!this.ctx || this.decoder) {
            return;
        }
        const sid = this.sessionId;
        const decoder = new AudioDecoder({
            output: (audioData: AudioData) => {
                if (this.decoderSessionId !== sid) {
                    audioData.close();
                    return;
                }
                this.onDecoded(audioData);
            },
            error: (_e: DOMException) => {
                this.stop();
            },
        });
        decoder.configure(config);
        this.decoder = decoder;
        this.decoderSessionId = sid;
    }

    private onDecoded(audioData: AudioData): void {
        if (!this.ctx) {
            audioData.close();
            return;
        }
        const startAtMin = this.ctx.currentTime + 0.01;
        const startAt = Math.max(startAtMin, this.nextStartTime);
        const frames = audioData.numberOfFrames;
        const channels = audioData.numberOfChannels;
        const duration = frames / audioData.sampleRate;
        this.nextStartTime = startAt + duration;

        if (this.workletNode) {
            const interleaved = toInterleavedFloat32(audioData);
            audioData.close();
            this.workletNode.port.postMessage(
                { type: 'push', startTime: startAt, channels, frames, data: interleaved.buffer },
                [interleaved.buffer],
            );
            return;
        }

        const audioBuffer = toAudioBuffer(this.ctx, audioData);
        audioData.close();
        const source = this.ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gain!);
        source.onended = () => {
            const idx = this.scheduled.indexOf(source);
            if (idx >= 0) {
                this.scheduled.splice(idx, 1);
            }
        };
        this.scheduled.push(source);
        source.start(startAt);
    }

    private stop(): void {
        this.sessionId++;
        if (this.workletNode) {
            try {
                this.workletNode.port.postMessage({ type: 'reset' });
            } catch (_e) {}
        }
        while (this.scheduled.length) {
            const n = this.scheduled.shift();
            if (n) {
                try {
                    n.stop();
                } catch (_e) {}
                try {
                    n.disconnect();
                } catch (_e) {}
            }
        }
        if (this.decoder) {
            try {
                this.decoder.close();
            } catch (_e) {}
            this.decoder = undefined;
        }
        this.decoderSessionId = 0;
        this.audioConfig = undefined;
        this.nextStartTime = 0;
    }

    public release(): void {
        this.stop();
        if (this.ctx) {
            this.ctx.close().catch((_e: unknown) => {});
        }
        this.ctx = undefined;
        this.gain = undefined;
        this.workletNode = undefined;
    }
}
