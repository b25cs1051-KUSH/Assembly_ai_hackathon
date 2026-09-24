from pydantic import BaseModel
from typing import Optional, List

class ProductSpecs(BaseModel):
    frame_material: str
    canopy_size_inches: int
    wind_rating_mph: int
    weight_oz: int
    automatic_open: bool

class Product(BaseModel):
    id: str
    name: str
    brand: str
    price: float
    rating: float
    review_count: int
    specs: ProductSpecs
    description: str
    reviews_summary: str
    image_url: str

class VoiceCommandResponse(BaseModel):
    command: str
    payload: dict
    spoken_response: str
