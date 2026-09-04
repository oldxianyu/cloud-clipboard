# cloud-clipboard 本地增强版

基于 [TransparentLC/cloud-clipboard](https://github.com/TransparentLC/cloud-clipboard) 的本地部署版本，包含自定义 Ant Design 前端、Docker 部署脚本以及文件预览和上传完整性增强。

## 功能增强

- 文件分片上传
- 每个分片 SHA-256 校验
- 上传偏移量校验，防止分片丢失、重复或乱序
- 完整文件大小和 SHA-256 校验
- 视频、音频、图片、PDF 预览
- MP4 Range 请求支持
- 视频预览独立于下载接口
- ZIP/RAR/7z 内容列表预览
- Docker 本地部署

## 目录

```text
antd-ui/                 Ant Design 前端源码和构建产物
server-patch/            Node 服务端增强补丁
Dockerfile.local         本地镜像构建文件
ctl.sh                   build/start/stop/restart/status 管理脚本
```

## 本地部署

```bash
./ctl.sh build
./ctl.sh start
./ctl.sh status
```

默认监听：`http://127.0.0.1:9501`

## 安全说明

运行时数据、上传文件、认证密码和依赖目录不会提交到 Git 仓库。请通过环境变量、挂载文件或部署平台 Secret 配置认证信息。

## 验证

```bash
cd antd-ui
npm run lint
npm run build

node --check ../server-patch/http-router.js
node --check ../server-patch/uploaded-file.js
```

## 上游项目

本项目不是官方 TransparentLC/cloud-clipboard 仓库，增强代码仅用于本地部署和实验环境。请根据实际需求审查认证、公开分享链接和存储策略。
