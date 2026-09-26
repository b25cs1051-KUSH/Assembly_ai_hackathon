from pydantic import BaseModel


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
    pros: list[str]
    cons: list[str]
    image_url: str
