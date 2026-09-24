import asyncio
import json
import assemblyai as aai
from fastapi import WebSocket
from backend.config import settings
from backend.services.agent_brain import AgentBrain

aai.settings.api_key = settings.ASSEMBLYAI_API_KEY

class AssemblyAIService:
    def __init__(self, websocket: WebSocket):
        self.websocket = websocket
        self.transcriber = None
        self.brain = AgentBrain()
        self.is_connected = False

    def on_open(self, session_opened: aai.RealtimeSessionOpened):
        print("AssemblyAI session opened:", session_opened.session_id)
        self.is_connected = True

    def on_data(self, transcript: aai.RealtimeTranscript):
        if not transcript.text:
            return

        if isinstance(transcript, aai.RealtimeFinalTranscript):
            print(f"Final Transcript: {transcript.text}")
            
            # Send interruption signal immediately if we get speech
            asyncio.create_task(self.websocket.send_json({
                "type": "INTERRUPT"
            }))
            
            # Process intent
            response = self.brain.process_transcript(transcript.text)
            if response:
                response["type"] = "COMMAND"
                asyncio.create_task(self.websocket.send_json(response))
                
        elif isinstance(transcript, aai.RealtimePartialTranscript):
            # Send partial transcript to frontend to display what the user is saying live
            asyncio.create_task(self.websocket.send_json({
                "type": "PARTIAL_TRANSCRIPT",
                "text": transcript.text
            }))
            # Signal interruption on partial speech to stop agent immediately
            asyncio.create_task(self.websocket.send_json({
                "type": "INTERRUPT"
            }))

    def on_error(self, error: aai.RealtimeError):
        print(f"AssemblyAI Error: {error}")

    def on_close(self):
        print("AssemblyAI session closed")
        self.is_connected = False

    async def start(self):
        self.transcriber = aai.RealtimeTranscriber(
            sample_rate=16000,
            on_data=self.on_data,
            on_error=self.on_error,
            on_open=self.on_open,
            on_close=self.on_close,
        )
        self.transcriber.connect()
        
        try:
            while True:
                # Receive audio data from client websocket
                data = await self.websocket.receive_bytes()
                if self.is_connected:
                    self.transcriber.stream(data)
        except Exception as e:
            print(f"WebSocket Error: {e}")
        finally:
            self.transcriber.close()

    async def close(self):
        if self.transcriber:
            self.transcriber.close()
