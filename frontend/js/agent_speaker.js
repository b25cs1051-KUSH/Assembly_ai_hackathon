class AgentSpeaker {
    constructor() {
        this.synth = window.speechSynthesis;
    }

    speak(text) {
        if (!this.synth) return;
        
        // Cancel any ongoing speech immediately before starting new
        this.cancel();
        
        const utterance = new SpeechSynthesisUtterance(text);
        
        // Try to pick a natural English voice
        const voices = this.synth.getVoices();
        const preferredVoice = voices.find(v => v.lang.includes('en') && v.name.includes('Google'));
        if (preferredVoice) {
            utterance.voice = preferredVoice;
        }
        
        this.synth.speak(utterance);
    }

    cancel() {
        if (this.synth && this.synth.speaking) {
            this.synth.cancel();
            console.log("Agent speech interrupted by user.");
        }
    }
}

window.agentSpeaker = new AgentSpeaker();
