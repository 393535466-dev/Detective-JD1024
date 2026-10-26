import json
import unittest
import httpx
from fastapi.testclient import TestClient
from test_backend import FakeServices, CONFIG, image_bytes
from main import create_app
from pictrace import prepare_image


class IndoorServices(FakeServices):
    def __call__(self, request):
        response = super().__call__(request)
        if request.url.host != 'vision.test':
            return response
        body = json.loads(request.content)
        has_image = any(c.get('type') == 'image_url' for c in body['messages'][-1]['content'])
        content = json.loads(response.json()['choices'][0]['message']['content'])
        if has_image:
            content.update(image_origin={'category':'screenshot','observations':['顶部可见状态栏']},
                           spatial_observations=['招牌位于入口左侧'], region_hypothesis='证据不足')
            content['clues'] = [
                {'kind':'interior','observation':'木质桌椅','bbox':[0,0,300,300]},
                {'kind':'menu','observation':'菜单写着示例咖啡馆','bbox':[300,300,600,600]},
                {'kind':'logo','observation':'圆形图案与示例咖啡馆字样','bbox':[600,0,1000,300],
                 'clarity':'clear','reliability':'high','independence_group':'sign-1', 'geolocation_value':'high'},
            ]
        else:
            content['candidates'][0].update(
                contradictions=[{'source_id':'S999','clue_ids':['C1'],'explanation':'假反证'},
                                {'source_id':'S1','clue_ids':['C999'],'explanation':'假线索'}],
                falsification_questions=['是否为同品牌另一分店？','入口布局是否不同？'],
                spatial_checks=['核对入口与招牌相对位置'], next_action='核对公开门店照片')
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps(content)}}]})


class DetectiveTests(unittest.TestCase):
    def test_logo_priority_and_unverified_spatial_report(self):
        services = IndoorServices()
        with TestClient(create_app(CONFIG, httpx.MockTransport(services))) as client:
            data = client.post('/api/investigate', files={'file':('indoor.jpg',image_bytes())}).json()
        self.assertEqual(data['status'],'complete')
        self.assertEqual([c['clue_id'] for c in data['crops']],['C3','C2'])
        self.assertEqual(data['image_origin']['verification'],'unverified')
        self.assertEqual(data['spatial_observations'],['招牌位于入口左侧'])
        candidate = data['candidates'][0]
        self.assertEqual(candidate['contradictions'],[])
        self.assertEqual(candidate['spatial_verification'],'not_performed')
        self.assertEqual(len(candidate['falsification_questions']),2)
        self.assertEqual(data['clues'][2]['independence_group'],'sign-1')

    def test_no_invented_device_or_gps_in_report(self):
        metadata = prepare_image(image_bytes()).metadata
        self.assertEqual(metadata['device'],{})
        self.assertNotIn('gps',metadata)
        self.assertEqual(metadata['file_format'],'JPEG')


if __name__ == '__main__':
    unittest.main()

class RetrievalTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_match_survives_many_visual_matches(self):
        from pictrace import Providers, select_synthesis_sources
        def transport(request):
            if request.url.path == '/image':
                return httpx.Response(200,json={'image_id':'fixture'})
            return httpx.Response(200,json={
                'visual_matches':[{'title':str(i),'link':f'https://example.com/v{i}'} for i in range(20)],
                'exact_matches':[{'title':'exact','link':'https://example.com/exact',
                                  'thumbnail':'https://example.com/t.jpg','image':'https://example.com/full.jpg'}]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            results = await Providers(CONFIG,client).lens(b'fixture')
        self.assertEqual(results[0]['kind'],'exact_match')
        self.assertEqual(results[0]['image_url'],'https://example.com/full.jpg')
        self.assertEqual(len(results),13)
        sources = [{'id':f'S{i}', 'kind':'visual_match', 'discovered_by':['lens_whole_image']} for i in range(25)]
        sources.append({'id':'S25','kind':'web_search','discovered_by':['keyword_1']})
        self.assertIn('S25',[s['id'] for s in select_synthesis_sources(sources)])

class SourceSelectionTests(unittest.TestCase):
    def test_readable_sign_and_late_relevant_source_survive(self):
        from pictrace import VisionResult,build_search_queries,select_synthesis_sources
        v=VisionResult(scene='fixture',clues=[{'kind':'text','observation':'招牌写着‘示例餐厅 分店名’','search_text':'示例餐厅 分店名','geolocation_value':'high'}],search_queries=['过长的多个商家组合描述'])
        self.assertEqual(build_search_queries(v)[0],'"示例餐厅" "分店名"')
        sources=[{'id':f'S{i}','title':'generic travel','snippet':'','kind':'visual_match','discovered_by':['whole']} for i in range(30)]
        sources.append({'id':'S30','title':'示例餐厅','snippet':'','kind':'web_search','discovered_by':['keyword']})
        chosen=select_synthesis_sources(sources,clues=[c.model_dump() for c in v.clues])
        self.assertEqual(chosen[0]['id'],'S30')

class QueryPriorityTests(unittest.TestCase):
    def test_branch_before_common_logo_and_mixed_script(self):
        from pictrace import VisionResult,build_search_queries
        v=VisionResult(scene='test',clues=[
            {'kind':'text','observation':'商场','search_text':'示例商场 한명쇼핑','geolocation_value':'high'},
            {'kind':'text','observation':'分店','search_text':'示例餐厅 示例街店','geolocation_value':'high'},
            {'kind':'text','observation':'店招','search_text':'示例KTV','geolocation_value':'high'}])
        queries=build_search_queries(v)
        self.assertEqual(queries[0],'"示例餐厅" "示例街店"')
        self.assertEqual(queries[1],'"示例商场"')
        self.assertEqual(queries[2],'"示例" KTV')
