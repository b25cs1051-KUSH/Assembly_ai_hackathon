class AudioRecorder {
    constructor(onAudioData) {
        this.onAudioData = onAudioData;
        this.audioContext = null;
        this.stream = null;
        this.processor = null;
    }

    async start() {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        
        const source = this.audioContext.createMediaStreamSource(this.stream);
        this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
        
        source.connect(this.processor);
        this.processor.connect(this.audioContext.destination);
        
        this.processor.onaudioprocess = (e) => {
            const float32Array = e.inputBuffer.getChannelData(0);
            const pcm16 = this.floatTo16BitPCM(float32Array);
            this.onAudioData(pcm16.buffer);
        };
    }

    floatTo16BitPCM(float32Array) {
        const buffer = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            let s = Math.max(-1, Math.min(1, float32Array[i]));
            buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return buffer;
    }

    stop() {
        if (this.processor) {
            this.processor.disconnect();
            this.processor = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
        }
        if (this.audioContext) {
            this.audioContext.close();
        }
    }
}

window.AudioRecorder = AudioRecorder;
