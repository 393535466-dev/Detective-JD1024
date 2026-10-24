# 图迹 PicTrace

从照片提取公共地点线索，裁剪细节检索相似图片，整理带来源和不确定性的候选地点。支持餐厅、风景、建筑和街景。

项目正在上传。后端使用 Python FastAPI，不能由 GitHub Pages 运行。GitHub Pages 发布前端；后端需要支持 Python/Docker 的服务。

必需配置：阿里云百炼视觉模型 API（DASHSCOPE_API_KEY、VISION_BASE_URL、VISION_MODEL）、SERPAPI_KEY。可选 AMAP_KEY（高德 Web 服务）。密钥应放在后端环境变量，不要提交到仓库。

目前本地接口与模拟集成测试已通过，尚未使用真实 API 密钥联调，尚未确认公网部署。
