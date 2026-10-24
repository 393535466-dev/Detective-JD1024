import base64
import io
import json
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from main import create_app
from pictrace import Crop, SEARCH_IMAGE_BYTES, Settings, prepare_image


def image_bytes(size=(400, 300), orientation=None):
    image = Image.new("RGB", size, "teal")
    buf = io.BytesIO()
    exif = Image.Exif()
    if orientation:
        exif[274] = orientation
        exif[306] = "2026:10:24 10:00:00"
    image.save(buf, "JPEG", exif=exif)
    return buf.getvalue()


class FakeServices:
    """Fixtures represent public places; they are not live search results."""
    def __init__(self, fail_search=False, bad_model=False):
        self.requests = []
        self.fail_search = fail_search
        self.bad_model = bad_model

    def __call__(self, request):
        self.requests.append(request)
        if request.url.host == "vision.test":
            body = json.loads(request.content)
            has_image = any(c.get("type") == "image_url" for c in body["messages"][-1]["content"])
            if self.bad_model:
                return httpx.Response(200, json={"choices": [{"message": {"content": "not JSON"}}]})
            content = {
                "scene": "街边咖啡馆", "clues": [{"kind": "text", "observation": "店招写着示例咖啡馆", "bbox": [10, 20, 700, 500]}],
                "search_queries": ["示例咖啡馆"], "place_names": ["示例咖啡馆"], "limitations": [],
            } if has_image else {"candidates": [
                {"name": "示例咖啡馆", "area": "杭州市", "matches": [
                    {"source_id": "S1", "clue_ids": ["C1"], "explanation": "店名一致，分店待确认"},
                    {"source_id": "S999", "clue_ids": ["C1"], "explanation": "虚构引用应被剔除"},
                    {"source_id": "S1", "clue_ids": ["C999"], "explanation": "虚构线索应被剔除"},
                ], "uncertainties": ["尚未核对现场"]},
                {"name": "无来源的场所", "matches": [{"source_id": "S999", "clue_ids": ["C1"], "explanation": "无效"}]},
                {"name": "编造新地点", "matches": [{"source_id": "S1", "clue_ids": ["C1"], "explanation": "引用有效但名称编造"}]},
            ]}
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content)}}]})
        if request.url.host == "serpapi.com":
            if self.fail_search:
                raise httpx.ReadTimeout("contains-secret-dont-echo", request=request)
            if request.url.path == "/image":
                assert len(request.content) < 500_000
                assert b'name="image"' in request.content
                return httpx.Response(200, json={"image_id": "fixture-image"})
            if request.url.params.get("engine") == "google_lens":
                assert request.url.params["image_id"] == "fixture-image"
                return httpx.Response(200, json={"visual_matches": [
                    {"title": "示例咖啡馆 杭州市", "link": "https://example.com/cafe"},
                    {"title": "unsafe", "link": "javascript:alert(1)"},
                ], "exact_matches": False})
            return httpx.Response(200, json={"organic_results": [{"title": "示例咖啡馆", "link": "https://example.com/cafe", "snippet": "杭州市某公开商业街"}]})
        if request.url.host == "restapi.amap.com":
            assert "city" not in request.url.params  # Claimed location must not hide alternatives.
            assert request.url.params["extensions"] == "all"
            return httpx.Response(200, json={"status": "1", "pois": [{"id": "BTEST", "name": "示例咖啡馆", "cityname": "杭州市", "address": [], "location": "120,30", "photos": [{"url": "https://example.com/photo.jpg"}]}]})
        raise AssertionError("Unexpected network request")


CONFIG = Settings(vision_key="secret-vision", vision_base_url="https://vision.test/v1", serpapi_key="secret-search", amap_key="secret-map")


class ImageTests(unittest.TestCase):
    def test_orientation_and_metadata_removed(self):
        prepared = prepare_image(image_bytes((400, 300), 6))
        self.assertEqual(prepared.image.size, (300, 400))
        self.assertEqual(prepared.metadata["embedded_time"], "2026:10:24 10:00:00")
        with Image.open(io.BytesIO(prepared.jpeg)) as image:
            self.assertFalse(image.getexif())
        crop = prepared.crop(Crop(bbox=[0, 0, 500, 500]))
        with Image.open(io.BytesIO(crop)) as image:
            self.assertEqual(image.size, (150, 200))

    def test_image_budget(self):
        image = Image.effect_noise((2000, 2000), 100).convert("RGB")
        buf = io.BytesIO(); image.save(buf, "PNG")
        self.assertLessEqual(len(prepare_image(buf.getvalue()).jpeg), SEARCH_IMAGE_BYTES)

    def test_invalid_image_and_pixels(self):
        for raw, pixels in [(b"not-image", 1000), (image_bytes(), 100), (b"", 1000)]:
            with self.assertRaises(ValueError):
                prepare_image(raw, pixels)

    def test_invalid_crop(self):
        for bbox in [[-1, 0, 10, 20], [20, 0, 10, 20], [0, 0, 1001, 1000], [0, 0, float('nan'), 100], [1, 2, 3]]:
            with self.assertRaises(ValidationError):
                Crop(bbox=bbox)


class ApiTests(unittest.TestCase):
    def test_pages_origin_and_relative_assets(self):
        with patch.dict('os.environ', {'CORS_ALLOWED_ORIGINS': 'https://393535466-dev.github.io'}):
            with TestClient(create_app(Settings())) as client:
                allowed = client.options('/api/investigate', headers={
                    'Origin': 'https://393535466-dev.github.io',
                    'Access-Control-Request-Method': 'POST',
                    'Access-Control-Request-Headers': 'Authorization',
                })
                self.assertEqual(allowed.status_code, 200)
                self.assertEqual(allowed.headers['access-control-allow-origin'], 'https://393535466-dev.github.io')
                denied = client.options('/api/investigate', headers={
                    'Origin': 'https://other.example', 'Access-Control-Request-Method': 'POST',
                })
                self.assertEqual(denied.status_code, 400)
                self.assertNotIn('access-control-allow-origin', denied.headers)
                self.assertIn('./app.js', client.get('/').text)
                self.assertEqual(client.get('/app.js').status_code, 200)
                self.assertEqual(client.get('/style.css').status_code, 200)

    def test_missing_configuration_is_honest_and_uploads_not_public(self):
        services = FakeServices()
        with TestClient(create_app(Settings(), httpx.MockTransport(services))) as client:
            response = client.post('/api/investigate', files={"file": ("a.jpg", image_bytes(), "image/jpeg")})
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertEqual(data["status"], "needs_configuration")
            self.assertEqual(data["candidates"], [])
            self.assertEqual(services.requests, [])
            self.assertEqual(client.get('/uploads/test.jpg').status_code, 404)
            self.assertTrue(client.get('/health').json()['ok'])

    def test_full_pipeline_deduplicates_and_rejects_fabricated_citations(self):
        services = FakeServices()
        with TestClient(create_app(CONFIG, httpx.MockTransport(services))) as client:
            response = client.post('/api/investigate', files={"file": ("a.jpg", image_bytes(), "image/jpeg")}, data={"claimed_location": "北京市"})
            self.assertEqual(response.status_code, 200)
            data = response.json()
            self.assertEqual(data["status"], "complete")
            self.assertEqual(len(data["crops"]), 1)
            self.assertEqual(len(data["sources"]), 2)
            self.assertEqual(len(data["candidates"]), 1)
            self.assertEqual(len(data["candidates"][0]["matches"]), 1)
            self.assertEqual(data["candidates"][0]["verification"], "unverified")
            self.assertNotIn("confidence", data["candidates"][0])
            self.assertEqual(data["comparison"]["status"], "unverified")
            self.assertEqual(data["sources"][1]["photos"], ["https://example.com/photo.jpg"])
            self.assertEqual(len([r for r in services.requests if r.url.path == '/image']), 2)
            self.assertNotIn('secret-', response.text)

    def test_timeouts_return_partial_without_secret_leak(self):
        services = FakeServices(fail_search=True)
        with TestClient(create_app(CONFIG, httpx.MockTransport(services))) as client:
            data = client.post('/api/investigate', files={"file": ("a.jpg", image_bytes())}).json()
            self.assertEqual(data["status"], "partial")
            self.assertTrue(any(s["status"] == "failed" for s in data["steps"]))
            self.assertNotIn("contains-secret", json.dumps(data))

    def test_invalid_model_still_returns_search_sources(self):
        with TestClient(create_app(CONFIG, httpx.MockTransport(FakeServices(bad_model=True)))) as client:
            data = client.post('/api/investigate', files={"file": ("a.jpg", image_bytes())}).json()
            self.assertEqual(data["status"], "partial")
            self.assertTrue(data["sources"])
            self.assertEqual(data["candidates"], [])

    def test_token_and_base64_tool_interface(self):
        config = Settings(service_token="local-test-token")
        with TestClient(create_app(config)) as client:
            self.assertEqual(client.get('/api/status').status_code, 401)
            headers = {"Authorization": "Bearer local-test-token"}
            self.assertEqual(client.get('/api/status', headers=headers).status_code, 200)
            response = client.post('/api/investigate-json', headers=headers, json={"image_base64": base64.b64encode(image_bytes()).decode()})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(client.post('/api/investigate-json', headers=headers, json={"image_base64": "!!!"}).status_code, 400)
            self.assertIn("HTTPBearer", client.get('/openapi.json').json()["components"]["securitySchemes"])

    def test_bad_upload_and_crop_are_rejected(self):
        with TestClient(create_app(Settings())) as client:
            for crop in ['{', '{}', '[{"bbox":[0,0,1100,1000]}]']:
                response = client.post('/api/investigate', files={"file": ("a.jpg", image_bytes())}, data={"crops": crop})
                self.assertEqual(response.status_code, 400)
            self.assertEqual(client.post('/api/investigate', files={"file": ("a.jpg", b'fake')}).status_code, 400)

    def test_dify_binary_upload(self):
        with TestClient(create_app(Settings())) as client:
            response = client.post('/api/investigate-binary?claimed_location=杭州', content=image_bytes(), headers={"Content-Type": "image/jpeg"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['claimed_location'], '杭州')
            self.assertEqual(client.post('/api/investigate-binary', content=b'invalid').status_code, 400)


if __name__ == '__main__':
    unittest.main()
