import json
from backend.services.product_service import search_products, get_product_by_id

class AgentBrain:
    def __init__(self):
        pass
        
    def process_transcript(self, text: str) -> dict:
        text = text.lower()
        
        # Simple intent matching
        if "search" in text or "show me" in text:
            query = text.replace("search for", "").replace("show me", "").strip()
            results = search_products(query)
            return {
                "command": "SEARCH",
                "payload": {"results": results},
                "spoken_response": f"I found {len(results)} items for {query}."
            }
            
        elif "compare" in text:
            return {
                "command": "COMPARE",
                "payload": {},
                "spoken_response": "Here is the comparison matrix for the top items."
            }
            
        elif "inspect" in text or "show item" in text:
            # Very basic extraction - in a real app use LLM here
            item_id = "1"
            if "item 2" in text: item_id = "2"
            
            product = get_product_by_id(item_id)
            if product:
                return {
                    "command": "INSPECT",
                    "payload": {"product": product},
                    "spoken_response": f"Looking closely at {product['name']}. {product['description']}"
                }
            
        elif "cart" in text and "add" in text:
            return {
                "command": "NAVIGATE_CART",
                "payload": {"action": "add"},
                "spoken_response": "I've added that to your cart."
            }
            
        elif "checkout" in text:
            return {
                "command": "CHECKOUT",
                "payload": {},
                "spoken_response": "Navigating to checkout."
            }
            
        return None
