from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from pictrace import MAX_UPLOAD_BYTES, Crop, Providers, Settings, investigate

load_dotenv()
BASE_DIR = Path(__file__).resolve().parent
logger = logging.getLogger("pictrace")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
bearer = HTTPBearer(auto_error=False)


class JsonInvestigation(BaseModel):
    image_base64: str = Field(min_length=1, max_length=28_000_000)
    claimed_location: str = Field(default="", max_length=300)
    crops: list[Crop] = Field(default_factory=list, max_length=2)


def create_app(settings: Settings | None = None, transport=None):
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(timeout=httpx.Timeout(45, connect=10), transport=transport,
                                     limits=httpx.Limits(max_connections=10)) as client:
            app.state.providers = Providers(settings, client)
            yield

    app = FastAPI(title="图迹 PicTrace 公共地点线索 API", version="0.4.0", lifespan=lifespan,
                  description="图片线索、细节搜图与公开地点候选。候选不代表已确认的拍摄位置。")
    app.state.settings = settings
    origins = [origin.strip() for origin in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",") if origin.strip()]
    if origins:
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"],
                           allow_headers=["Authorization", "Content-Type"])
    slots = asyncio.Semaphore(2)
    app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

    async def authenticate(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
        if settings.service_token and (not credentials or not secrets.compare_digest(credentials.credentials, settings.service_token)):
            raise HTTPException(401, "请提供有效的服务访问令牌", headers={"WWW-Authenticate": "Bearer"})

    async def run(raw, claimed_location, crops):
        try:
            async with asyncio.timeout(settings.request_timeout):
                async with slots:
                    return await investigate(raw, claimed_location.strip(), crops, settings, app.state.providers)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except TimeoutError as exc:
            raise HTTPException(504, "调查超时，请稍后重试或减少裁剪区域") from exc
        except Exception as exc:
            logger.error("Investigation failed: %s", type(exc).__name__)
            raise HTTPException(500, "调查服务暂时失败，请稍后重试") from exc

    @app.get("/", response_class=HTMLResponse)
    async def index():
        return (BASE_DIR / "static/index.html").read_text(encoding="utf-8")

    @app.get("/style.css", include_in_schema=False)
    async def stylesheet():
        from fastapi.responses import FileResponse
        return FileResponse(BASE_DIR / "static/style.css", media_type="text/css")

    @app.get("/app.js", include_in_schema=False)
    async def javascript():
        from fastapi.responses import FileResponse
        return FileResponse(BASE_DIR / "static/app.js", media_type="application/javascript")

    @app.get("/health")
    async def health():
        return {"ok": True, "version": app.version}

    @app.get("/api/status", dependencies=[Depends(authenticate)])
    async def status():
        return settings.status()

    @app.post("/api/investigate", dependencies=[Depends(authenticate)], operation_id="investigatePhoto")
    async def investigate_photo(
        file: UploadFile = File(...),
        claimed_location: str = Form("", max_length=300),
        crops: str = Form("[]", max_length=2000, description="最多2个裁剪，JSON 数组，bbox 是0–1000相对坐标"),
    ):
        try:
            raw = await file.read(MAX_UPLOAD_BYTES + 1)
        finally:
            await file.close()
        try:
            parsed = json.loads(crops)
            if not isinstance(parsed, list) or len(parsed) > 2:
                raise ValueError()
            crop_models = [Crop.model_validate(c) for c in parsed]
        except (ValueError, TypeError, ValidationError) as exc:
            raise HTTPException(400, "crops 应为最多2个合法的裁剪对象，bbox 为0–1000坐标") from exc
        return await run(raw, claimed_location, crop_models)

    @app.post("/api/investigate-json", dependencies=[Depends(authenticate)], operation_id="investigatePhotoBase64")
    async def investigate_json(payload: JsonInvestigation):
        encoded = payload.image_base64
        if encoded.startswith("data:image/") and "," in encoded:
            encoded = encoded.split(",", 1)[1]
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise HTTPException(400, "image_base64 格式无效") from exc
        return await run(raw, payload.claimed_location, payload.crops)

    @app.post("/api/investigate-binary", dependencies=[Depends(authenticate)], operation_id="investigatePhotoBinary",
              openapi_extra={"requestBody": {"required": True, "content": {
                  "image/jpeg": {"schema": {"type": "string", "format": "binary"}},
                  "image/png": {"schema": {"type": "string", "format": "binary"}},
                  "image/webp": {"schema": {"type": "string", "format": "binary"}},
              }}})
    async def investigate_binary(request: Request, claimed_location: str = Query("", max_length=300)):
        """Dify HTTP 节点：选择 Binary 请求体，直接传递上传的图片文件。"""
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "图片不能超过 20MB")
            raw.extend(chunk)
        return await run(bytes(raw), claimed_location, [])

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
