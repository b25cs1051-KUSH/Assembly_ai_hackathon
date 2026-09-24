import os
from pydantic import BaseSettings

class Settings(BaseSettings):
    ASSEMBLYAI_API_KEY: str = os.getenv("ASSEMBLYAI_API_KEY", "")
    PORT: int = int(os.getenv("PORT", 8000))
    HOST: str = os.getenv("HOST", "0.0.0.0")

    class Config:
        env_file = ".env"

settings = Settings()
