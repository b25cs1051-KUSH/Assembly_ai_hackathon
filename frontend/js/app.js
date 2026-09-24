document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('start-mic-btn');
    
    let wsClient = null;
    let recorder = null;

    startBtn.addEventListener('click', async () => {
        startBtn.innerText = "Connecting...";
        
        // Ensure SpeechSynthesis is active by triggering a silent utterance on user interaction
        window.agentSpeaker.speak("Welcome to VoiceCart AI.");
        
        wsClient = new window.WebSocketClient('ws://localhost:8000/ws/voice');
        
        wsClient.onMessage = (msg) => {
            if (msg.type === 'PARTIAL_TRANSCRIPT') {
                window.UIRenderer.updateTranscript(msg.text);
            } 
            else if (msg.type === 'INTERRUPT') {
                window.agentSpeaker.cancel();
            }
            else if (msg.type === 'COMMAND') {
                console.log("Received Command:", msg.command);
                if (msg.spoken_response) {
                    window.agentSpeaker.speak(msg.spoken_response);
                }
                
                if (msg.command === 'SEARCH') {
                    window.UIRenderer.renderProducts(msg.payload.results);
                }
                // Handle other commands...
            }
        };

        wsClient.connect();

        // Wait a bit for WS connection, then start audio
        setTimeout(async () => {
            recorder = new window.AudioRecorder((audioData) => {
                wsClient.sendAudio(audioData);
            });
            await recorder.start();
            startBtn.style.display = 'none';
            document.querySelector('.voice-panel').style.display = 'block';
        }, 500);
    });
});
