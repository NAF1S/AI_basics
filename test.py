from collections.abc import AsyncIterable

import json
import os

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.sse import EventSourceResponse, ServerSentEvent
from pydantic import BaseModel

load_dotenv()

DEEPSEEK_API_KEY = os.getenv("API_KEY")
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"

if not DEEPSEEK_API_KEY:
    raise RuntimeError("API_KEY not found. Add it to the .env file.")

app = FastAPI()

# Allow browser frontends (different origins) to call this API.
# In production, restrict this to your actual frontend origin(s).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Item(BaseModel):
    name: str
    description: str | None


class ChatRequest(BaseModel):
    message: str
    model: str = DEEPSEEK_MODEL


items = [
    Item(name="Plumbus", description="A multi-purpose household device."),
    Item(name="Portal Gun", description="A portal opening device."),
    Item(name="Meeseeks Box", description="A box that summons a Meeseeks."),
]


@app.get("/items/stream", response_class=EventSourceResponse)
async def sse_items() -> AsyncIterable[Item]:
    for item in items:
        yield item


@app.get("/deepseek/health")
async def health() -> dict:
    return {"status": "ok", "model": DEEPSEEK_MODEL}


@app.post("/deepseek/query")
async def deepseek_query_without_streaming(payload: ChatRequest) -> dict:
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "model": payload.model,
        "messages": [{"role": "user", "content": payload.message}],
    }
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{DEEPSEEK_BASE_URL}/chat/completions",
                headers=headers,
                json=body,
            )
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=exc.response.text,
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    content = data["choices"][0]["message"]["content"]
    return {"model": payload.model, "content": content}


@app.post("/deepseek/query/stream", response_class=EventSourceResponse)
async def deepseek_query_stream(payload: ChatRequest) -> AsyncIterable[ServerSentEvent]:
    """Stream the DeepSeek reply token-by-token over Server-Sent Events."""
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "model": payload.model,
        "messages": [{"role": "user", "content": payload.message}],
        "stream": True,
    }
    async with httpx.AsyncClient(timeout=60) as client:
        async with client.stream(
            "POST",
            f"{DEEPSEEK_BASE_URL}/chat/completions",
            headers=headers,
            json=body,
        ) as response:
            response.raise_for_status()
            # DeepSeek (OpenAI-compatible) streams SSE lines like:
            #   data: {"choices":[{"delta":{"content":"Hello"}}]}
            # and terminates with the sentinel:
            #   data: [DONE]
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                choices = chunk.get("choices", [])
                if not choices:
                    continue
                delta = choices[0].get("delta", {})
                content = delta.get("content")
                if content:
                    # raw_data keeps the token as plain text (no JSON quotes).
                    yield ServerSentEvent(raw_data=content)
