# Cloud Clipboard

一个用于手机、电脑间快速共享文本和文件的在线剪贴板。本仓库基于 [cloud-clipboard](https://github.com/TransparentLC/cloud-clipboard) 改造。

## 功能

- 实时同步文本与文件，支持 WebSocket 通知
- 支持选择、拖拽或粘贴上传文件和截图
- 大文件分片上传；在同一浏览器重新选择同一文件可尝试断点续传
- 未完成上传记录保留 24 小时，之后自动清理（清理任务按小时运行）
- 支持图片预览、视频 Range 播放、压缩包目录浏览
- Office 文档和 PowerPoint 可转换为 PDF 预览
- React + Ant Design X 前端，Node.js + Koa 服务端；Office 转换由独立 LibreOffice worker 处理

## 部署

需要 Docker Compose。当前 `compose.yaml` 使用外部 Docker 网络连接反向代理。部署前确认 `cpamp_default` 网络已存在；否则将 Compose 文件中的网络名改为反向代理所在网络。

准备运行配置及数据目录：

```bash
mkdir -p runtime/data/uploads runtime/data/previews
```

创建 `runtime/config.json`，按需设置服务端和文件存储配置。运行配置和数据目录不纳入版本控制。构建并启动：

```bash
docker compose up -d --build
```

应用监听容器内 9501 端口，Compose 不直接映射公网端口。反向代理应连接到 `cloud-clipboard` 容器的 9501 端口。LibreOffice 预览 worker 需要额外 CPU 与内存资源。

## 续传与代理限制

网络中断后，可在原浏览器中重新选择同一文件尝试续传。服务端保留已完成分片及续传记录，最多 24 小时。分片上传不能突破 Cloudflare 等代理对单次请求大小或超时的限制；请根据代理限制调整分片大小。

## 安全提示

剪贴板内容可能对能够访问服务的用户公开。不要上传敏感信息；需要限制访问时，请在应用或反向代理层配置认证，并限制服务的网络访问范围。

## 测试

```bash
node --test server-node/test/*.test.js
npm --prefix client test
npm --prefix client run build
```

预览 worker 测试：

```bash
docker compose run --rm --no-deps preview-worker pytest -q /app/test_app.py
```
