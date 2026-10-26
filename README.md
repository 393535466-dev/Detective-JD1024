# 图迹 PicTrace

上传一张照片，提取可观察线索，裁剪关键细节，检索相似图片和公开网页，再整理带来源的公共地点或公开对象候选。支持室内与室外场景，包括餐厅、商场、酒店、展馆、办公室、景点、建筑、街景、菜单、票据、屏幕、商品包装和装饰物；实际结果取决于画面辨识度和公开资料覆盖。

目前交付的是可本地启动、可调用真实服务的后端及一个联调页面，含 GitHub Pages 发布工作流和 Docker 部署配置。测试中的地点都是模拟样例。**尚未使用真实 API 密钥联调；上传代码与上线完整服务是不同步骤。**

[在 Render 连接此仓库部署后端](https://render.com/deploy?repo=https://github.com/393535466-dev/Detective-JD1024)。平台会要求登录、确认资源与填写环境变量，以实际创建页面为准。

## 需要开通什么

| 服务 | 配置项 | 用途 | 必需程度 |
| --- | --- | --- | --- |
| 阿里云百炼 | `DASHSCOPE_API_KEY`、`VISION_BASE_URL`、`VISION_MODEL` | 图像理解、可见文字提取、框选细节、整理检索证据 | 核心流程必需 |
| SerpAPI | `SERPAPI_KEY` | Google Lens 搜图、网页关键词检索 | 核心流程必需 |
| 高德开放平台 | `AMAP_KEY`，选择 **Web 服务** 类型 | 根据读到的明确店名/景点名查询地点、地址、可用照片 | 可选，国内地点建议配置 |
| 服务访问令牌 | `PICTRACE_API_TOKEN` | 保护公网接口；前端或 Dify 使用同一 Bearer Token | 公网部署时设置 |

百炼建议先选控制台可用的 `qwen3-vl-plus` 视觉模型。代码将模型名设为可配置项；如果该业务空间没有此型号，替换为文档中支持图像理解和 OpenAI 兼容调用的型号。**API Key、地域、业务空间和兼容地址必须对应**。`VISION_BASE_URL` 请复制控制台给出的地址，填到 `/v1`，不含 `/chat/completions`。不要直接照抄带 `{WorkspaceId}` 的文档占位地址。

SerpAPI 使用官方图片上传接口直接获取 `image_id`，不需要 ImgBB。上传 JPEG 会在本地压缩到 490,000 字节以内。每次调查最多整图 + 2 个细节搜图、4 次关键词搜索、2 次高德查询，以及 2 次模型调用。搜图/关键词请求消耗取决于账户套餐和服务规则，开通前检查当前额度和计费。当前不接 Hive，不要求另开 OpenAI 账户，也不要求美团账户。

高德的 `extensions=all` 可以请求照片信息，但具体地点可能没有照片。地图记录与同名门店不能单独证明上传图片拍摄于此处。美团接口能否提供所需跨商家检索及图片，需按其当前开放接口和账户权限单独确认；本版不依赖该接入。

不要把密钥发到聊天、写进网页或提交 Git。填本地 `.env` 或云平台环境变量。

## 本地运行

Python 3.12。已创建的项目环境可直接使用 `.venv/bin/python`。

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# 在编辑器中填 .env，然后运行
python main.py
```

打开 <http://127.0.0.1:8000/>。接口文档在 <http://127.0.0.1:8000/docs>。

无密钥时页面和图片校验可运行，返回 `needs_configuration`，不会生成示例搜索结果或伪造候选。改 `.env` 后需要重启进程。原图不写入服务器文件目录，分析用的图像不含原始 EXIF；报告会返回压缩预览和文件内时间线索。报告由浏览器持有，可下载 JSON。

## API

| 路径 | 用途 |
| --- | --- |
| `GET /health` | 存活检测；不代表外部服务权限/余额已验证 |
| `GET /api/status` | 配置是否齐全，不返回密钥 |
| `POST /api/investigate` | multipart：`file`、可选 `claimed_location`、`crops` |
| `POST /api/investigate-binary` | 原始图片二进制；可选 query `claimed_location`，适合 Dify |
| `POST /api/investigate-json` | JSON：`image_base64`、可选 `claimed_location`、`crops` |
| `GET /openapi.json` | OpenAPI 描述 |

设置服务令牌后，为调查和状态请求添加 `Authorization: Bearer <PICTRACE_API_TOKEN>`。`/health` 和说明页面保持可访问。

上传示例（已设置令牌）：

```bash
curl http://127.0.0.1:8000/api/investigate \
  -H "Authorization: Bearer $PICTRACE_API_TOKEN" \
  -F "file=@example.jpg" \
  -F 'claimed_location=杭州' \
  -F 'crops=[{"label":"店招","bbox":[100,100,700,500]}]'
```

`bbox` 是转正后图像的 `[左,上,右,下]`，归一化到 0–1000，最多两个。若未指定，模型从文字/地标/建筑线索中选取最多两个区域。待核对地点不会用作搜索硬过滤条件，避免遗漏别处的同名地点。

报告主要字段：

```json
{
  "status": "complete | partial | needs_configuration",
  "summary": "本次调查概况",
  "clues": [{"id": "C1", "kind": "text", "observation": "实际可见细节"}],
  "sources": [{"id": "S1", "url": "https://...", "title": "来源标题", "evidence_scope": "来源范围"}],
  "candidates": [{"name": "来源中出现的公共地点名", "verification": "unverified", "matches": [{"source_id": "S1", "clue_ids": ["C1"], "explanation": "模型整理的关联"}]}],
  "comparison": {"status": "unverified", "note": "候选仍需核对"},
  "steps": [{"name": "vision", "status": "complete"}]
}
```

`complete` 表示流程执行完毕，**不表示地点已确认**。服务端会剔除不存在的来源/线索引用，并要求候选名称出现在引用来源文字中；这仍不能替代语义核对。暂时只读取搜索摘要和地图记录，没有抓取网页全文、自动比对来源图片、确定分店或自动裁决地点说法。报告不提供真伪百分比，也不推断个人身份、私人住宅、当前行踪或精确拍摄时间。

图片最大 20MB、1600 万像素；每个进程最多同时执行两份调查，总超时默认 150 秒。单个外部服务失败返回执行记录，其余来源尽量保留。限流是单进程级；面向开放流量的正式版本还需要网关限流、任务队列和持久化任务状态。

## GitHub 与云部署

GitHub 仓库存代码，GitHub Pages 托管静态 HTML/CSS/JS，不能运行这个 FastAPI Python 服务。当前方案是 GitHub + 支持 Docker 的 Web 服务，页面与 API 同源。

也可用 Pages 前端配独立后端：仓库 Settings → Pages → Source 选择 GitHub Actions，然后运行 `Publish PicTrace frontend` 工作流。发布完成后以 Actions 的实际部署地址为准。在前端“连接与细节设置”中填后端 HTTPS 域名，并填写服务访问令牌。令牌不保存到浏览器存储。

后端设置 `CORS_ALLOWED_ORIGINS=https://393535466-dev.github.io` 允许该前端调用。多个允许来源用英文逗号分隔，填写 origin，不含仓库路径；默认未配置时不允许跨域。Dify 是服务器之间调用，不受浏览器跨域限制。

项目含 `Dockerfile`、`railway.json` 和 `render.yaml`：

1. 将本项目目录内容推到 GitHub。不要推父目录，不要提交 `.env`。
2. 在可用的云平台创建 Docker Web 服务并连接该仓库。若选择 Render，可导入 Blueprint；`render.yaml` 会提示填写核心配置并生成服务令牌，`AMAP_KEY` 后续可选添加。是否需要付费以平台创建页面为准。
3. 在平台环境变量填模型、搜图和可选高德配置。普通 Docker 服务需自行填 `PICTRACE_API_TOKEN`。端口读取平台 `PORT`，默认 8000，健康检查用 `/health`。
4. 部署完成后检查 `/health`、带认证的 `/api/status`，再用真实图片测试。不要把“已配置”当作已经验证模型可用。

当前本机没有 Docker，因此尚未执行镜像构建验证。Railway 之前注册尝试失败，尚无云项目或公网链接；拿到用户可用平台链接后继续接入，不能保证特定平台注册/部署成功。

## Dify 接入

可先用独立网页完成比赛展示。Dify 通过 HTTP 节点调用已部署的后端，仍需要后端公网地址，或自部署 Dify 能访问的内网地址。Dify Cloud 不能访问你电脑的 `127.0.0.1`。

1. 开始节点接收单张图片文件，另加可选文本 `claimed_location`。
2. 加 HTTP Request 节点，方法 `POST`，URL 为 `https://你的后端域名/api/investigate-binary`。
3. 请求体选 **Binary**，选择开始节点的图片文件变量。
4. 认证选择 API Key / Bearer，值使用 Dify Secret 环境变量保存的 `PICTRACE_API_TOKEN`。可选 query `claimed_location` 绑定开始节点文本。
5. 读取超时尽量覆盖 150 秒；若云平台限制更短，同步接口可能提前断开，需升级异步任务接口。比赛版先不自动重试整份调查，避免重复消耗搜图额度。
6. 输出 HTTP 响应 body 或解析 JSON 后映射到展示页面。保留候选、引用和不确定性，不让后续模型改写成已确认结论。

本版不包含已导入/运行的 Dify 工作流。需要你的工作区链接和访问条件后才能在对应空间联调。

## 验证

```bash
.venv/bin/python -m unittest discover -s tests -v
node --check static/app.js
```

测试使用 `httpx.MockTransport` 模拟视觉模型、SerpAPI 和高德，覆盖成功、超时、错误结构、缺少配置、无效/伪造引用、上传限制、坐标、跨域和认证。真实效果需要密钥和实际图片验收。旧版真假/ELA/OCR 代码及页面保存在本机 `legacy/`，不再作为当前服务入口，不上传 GitHub，也不包含在 Docker 镜像内。

## 官方资料

- [百炼图像理解](https://help.aliyun.com/zh/model-studio/vision/)、[API Key](https://help.aliyun.com/zh/model-studio/get-api-key)
- [SerpAPI 图片上传](https://serpapi.com/image-api)、[Google Lens](https://serpapi.com/google-lens-api)
- [高德 Web 服务地点搜索](https://lbs.amap.com/api/webservice/guide/api/search)
- [GitHub Pages 静态托管说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [Dify HTTP Request](https://docs.dify.ai/en/cloud/use-dify/nodes/http-request)

## 侦探分析元素与 Logo 检索

分析方法参考用户提供的 photo-geolocation-detective-kit：先记录可见事实，再提出区域假设、检索来源、比较候选与反证，输出下一步核对动作。

- 线索增加 Logo、交通、公共设施、光影、图片来源类型；记录清晰度、观察可靠性和独立证据组，可靠性不是地点命中的概率。
- 自动裁剪优先选择 Logo、可读文字、菜单和票据，最多两个细节；无文字 Logo 记录外观，经搜图核验品牌，品牌一致不确认具体分店。
- 来源类型为模型根据画面给出的未验证假设；EXIF 只读取品牌、型号、软件及时间等有限字段，不输出 GPS 或序列号，不从像素猜设备型号。
- 候选报告新增有引用的矛盾、至少两个反证问题、待核对空间关系和一个下一步动作。不存在的来源或线索引用会被剔除。
- 当前没有自动调用街景、验证拍摄视角；第二轮区域补搜也不等同于反证验证；报告中的空间核对与反证问题是调查建议。区域、来源类型和候选不代表已确认结论，不显示未经校准的置信度百分比。

Logo 核验沿用现有百炼和 SerpAPI，不新增 API。国内地址和门店记录可选接入高德 Web 服务。美团当前所查门店接口主要用于授权商家管理，不能据此当作任意餐厅 Logo 的公共检索库。

## 真实照片检索验收（2026-10-25）

使用用户明确授权的街景样本，验收答案仅用于核对，没有传入 claimed_location 或写入代码。初次查询已有相关来源但候选为空，确认存在来源筛选遗漏和多商户查询过长的问题。

修复包括：原图匹配独立保留、来源缩略图展示、每路结果数与查询记录、可读独特招牌独立查询、分店信息优先、中文店名不绑定不确定韩文、推理输入优先保留文字相关来源，并记录候选被过滤的原因。

修复后的完整请求返回候选“西塔街 / 沈阳”，耗时约89秒；后续用同次视觉识别得到的独立店招再次检索，返回青瓦餐厅西塔街店及百马江KTV的西塔街地址记录。该样本通过不代表所有场景已达标；未验证精确拍摄机位、街景空间对应或商户信息时效。

## 检索增强（2026-10-25）

对最多两处模糊文字区域并行复读，保留原始观察和备选读法，不把复读当成已确认文字；单次复读限时18秒。第一轮最多四条全局关键词，包含备选文字。第一轮有来源时，从引用标题或摘要中提取区域假设，程序核对区域确实出现在引用中，再执行最多两条区域补搜。原始全局搜索始终保留，用户填写的待核对地点不参与模型或搜索。区域规划限时18秒，不可用时回退第一轮结果。

这些新增步骤会增加调用量和延迟；仍受整体请求超时约束。当前通过模拟接口测试，新增流程尚未完成真实照片准确率对比。候选图片自动视觉核对尚未实现。

## 远处店招优化（2026-10-25）

整图识别后额外并行扫描原图左右上部两个重叠区域，最多增加四条非重复文字线索，总线索最多12条。坐标映射回原图后参与切块和搜索；不能保证发现所有小字，也不通过放大创造缺失像素。每路18秒超时后保留原始识别。

不同店名优先占用最多六条首轮关键词预算，剩余空间才给复读备选词。完整英文店名使用整句查询。报告增加 searched_terms，前端在更多细节内展示实际检索词、是否成功及结果数。品牌同名和明显业态冲突由综合模型继续筛查，尚无候选图片自动比对验证。新增逻辑经过模拟接口回归，未使用该失败照片进行真实接口重跑；额外扫描可能增加延迟和费用。
