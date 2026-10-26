import json
import unittest

import httpx
from fastapi.testclient import TestClient

from main import create_app
from pictrace import SearchPlan, followup_queries
from test_backend import CONFIG, FakeServices, image_bytes


class RefinementServices(FakeServices):
    def __call__(self, request):
        if request.url.host == 'vision.test':
            prompt = json.loads(request.content)['messages'][-1]['content'][0]['text']
            if '"readings"' in prompt:
                self.requests.append(request)
                result = {'readings': ['示例咖啡馆', '示例咖啡屋'], 'unclear': True}
                return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(result)}}]})
            if '"regions"' in prompt:
                self.requests.append(request)
                result = {'regions': [{'region': '杭州市', 'source_ids': ['S1']},
                                      {'region': '虚构城市', 'source_ids': ['S1']}]}
                return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(result)}}]})
        return super().__call__(request)


class SearchRefinementTests(unittest.TestCase):
    def test_two_round_search_and_no_claim_leak(self):
        services = RefinementServices()
        with TestClient(create_app(CONFIG, httpx.MockTransport(services))) as client:
            response = client.post('/api/investigate',
                                   files={'file': ('test.jpg', image_bytes())},
                                   data={'claimed_location': '用户猜测的绝密区域'})
        self.assertEqual(response.status_code, 200)
        report = response.json()
        self.assertEqual(report['clues'][0]['text_review']['readings'], ['示例咖啡馆', '示例咖啡屋'])
        self.assertEqual(report['clues'][0]['observation'], '店招写着示例咖啡馆')
        queries = [dict(r.url.params).get('q', '') for r in services.requests if r.url.host == 'serpapi.com']
        self.assertIn('示例咖啡馆', queries)
        self.assertTrue(any('杭州市' in q for q in queries))
        self.assertFalse(any('虚构城市' in q for q in queries))
        self.assertTrue(any(s['name'].startswith('keyword_round2_') for s in report['steps']))
        self.assertEqual(len(report['search_refinement']['queries']), 2)
        for request in services.requests:
            self.assertNotIn('用户猜测的绝密区域', str(request.url))
            self.assertNotIn('用户猜测的绝密区域', request.content.decode(errors='replace'))

    def test_uncited_region_rejected_and_original_queries_preserved(self):
        sources = [{'id': 'S1', 'title': '某咖啡馆', 'snippet': '杭州市商业街'}]
        plan = SearchPlan(regions=[{'region': '北京市', 'source_ids': ['S1']},
                                   {'region': '杭州市', 'source_ids': ['S999']}])
        self.assertEqual(followup_queries(plan, sources, ['咖啡馆']), [])

    def test_unsupported_refinement_falls_back(self):
        services = FakeServices()
        with TestClient(create_app(CONFIG, httpx.MockTransport(services))) as client:
            report = client.post('/api/investigate', files={'file': ('test.jpg', image_bytes())}).json()
        self.assertEqual(report['status'], 'complete')
        self.assertTrue(report['candidates'])
        self.assertEqual(report['clues'][0]['text_review']['readings'], [])
        self.assertEqual(report['search_refinement']['queries'], [])

class EnglishSignTests(unittest.TestCase):
    def test_complete_english_shop_name_kept_as_phrase(self):
        from pictrace import VisionResult, build_search_queries
        vision = VisionResult(scene='商业空间', clues=[
            {'kind': 'logo', 'observation': '短品牌', 'search_text': 'JOYO', 'geolocation_value': 'high'},
            {'kind': 'text', 'observation': '远处店招', 'search_text': 'GENIUSES LINK', 'geolocation_value': 'high'}])
        queries = build_search_queries(vision)
        self.assertEqual(queries[0], '"GENIUSES LINK"')
        self.assertIn('"JOYO"', queries)

class DistantSignServices(RefinementServices):
    def __call__(self, request):
        if request.url.host == 'vision.test':
            prompt = json.loads(request.content)['messages'][-1]['content'][0]['text']
            if '这是原图局部' in prompt:
                self.requests.append(request)
                result = {'clues': [{'kind': 'text', 'observation': '远处英文招牌',
                                    'search_text': 'DISTANT ART SPACE', 'bbox': [100, 200, 500, 600],
                                    'geolocation_value': 'high', 'clarity': 'clear'}]}
                return httpx.Response(200, json={'choices': [{'message': {'content': json.dumps(result)}}]})
        return super().__call__(request)


class DistantSignTests(unittest.TestCase):
    def test_tile_sign_is_remapped_deduplicated_and_searched(self):
        services = DistantSignServices()
        with TestClient(create_app(CONFIG, httpx.MockTransport(services))) as client:
            response = client.post('/api/investigate', files={'file': ('test.jpg', image_bytes())})
        self.assertEqual(response.status_code, 200)
        report = response.json()
        clues = [c for c in report['clues'] if c['search_text'] == 'DISTANT ART SPACE']
        self.assertEqual(len(clues), 1)
        self.assertEqual(clues[0]['bbox'], [60, 150, 300, 450])
        terms = [q['text'] for q in report['searched_terms']]
        self.assertIn('"DISTANT ART SPACE"', terms)
        self.assertLessEqual(len([s for s in report['steps'] if s['name'].startswith('keyword_') and not s['name'].startswith('keyword_round2_')]), 6)
