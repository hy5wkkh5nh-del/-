# 空间再编排 · 公用工作区

公用站点：https://spatial-reframe-copy.onrender.com/

此仓库只负责 Render 公用版本。2026-11-11 按操作者要求清理为新一轮作品的独立起点。原本机项目、源模型和本机网站不属于此仓库的清理范围。

## 当前状态

- 首页显示作品更新准备页；旧工作台和旧模型入口已移除。
- 旧业务 API 返回 410；旧资产、卷宗和模型文件不再由服务提供。
- 运行时不加载旧项目数据，不写入旧卷宗，不调用 AI 或本机服务。
- 新版本没有外部依赖；后续作品功能在此仓库中逐步接入。

## 部署

沿用已有 Render 服务和网址。

- 构建：`npm install && npm run build`
- 启动：`node server/index.mjs`
- 健康检查：`GET /api/health`
- 启动日志 `[public-reset] READY` 包含提交版本、页面 SHA256 和六项路由自检结果。

## 回退

清理前提交：`668f9f19f45cc5bd3cbee9672c45b4e6c48a54b4`。

Git 历史保留原版。需要恢复时可在 Render 回滚到部署 `dep-dbc4uurrjlhs73arqp8g`，或者从上述提交恢复所需文件并正常提交；无需复制本机大体积归档。
