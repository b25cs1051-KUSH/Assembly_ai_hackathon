class WebSocketClient {
    constructor(url) {
        this.url = url;
        this.ws = null;
        this.onMessage = null;
    }

    connect() {
        this.ws = new WebSocket(this.url);
        
        this.ws.onopen = () => {
            console.log("WebSocket connected");
            document.getElementById('voice-indicator').classList.add('listening');
        };
        
        this.ws.onmessage = (event) => {
            if (this.onMessage) {
                const data = JSON.parse(event.data);
                this.onMessage(data);
            }
        };
        
        this.ws.onclose = () => {
            console.log("WebSocket disconnected");
            document.getElementById('voice-indicator').classList.remove('listening');
        };
    }

    sendAudio(audioData) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(audioData);
        }
    }
}

window.WebSocketClient = WebSocketClient;
