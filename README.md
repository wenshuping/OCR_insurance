# OCR Insurance

独立保单 OCR 项目，包含前端、独立 API、Paddle OCR 服务和保险责任查询。

## 目录

- `src/`：前端页面
- `server/`：账号、保单、短信、保险责任查询 API
- `ocr-service/`：本地 Paddle OCR 服务
- `tests/`：后端流程测试

## 启动

推荐把本机开发和本机生产分开跑。别人正在使用时，只启动或重启开发环境，不会影响生产端口和生产数据。

生产 ECS + AutoDL 发布步骤见：`docs/production-release-wiki.md`。

### 开发环境

一条命令启动前端、API、OCR：

```bash
npm run local:dev
```

开发环境默认地址：

- 前端：http://localhost:3014
- API：http://localhost:4207
- OCR：http://localhost:4109
- 数据目录：`.runtime/local/`
- 短信：mock，默认验证码 `123456`

开发环境状态和停止：

```bash
npm run local:dev:status
npm run local:dev:stop
```

Agent 语义解析默认以 `enforced` 模式启用。可将 `POLICY_AGENT_SEMANTIC_MODE` 设为 `off`，仅暂停新的 semantic proposal 请求；已有 legacy candidate 请求不受影响。应用代码显式传入的 `agentSemanticMode` 优先于环境变量，且配置只接受 `enforced` 或 `off`，其他值会导致服务启动失败。

如果要分别开三个终端调试：

```bash
npm run dev:ocr
npm run dev:api
npm run dev
```

### 本机生产环境

这套是给别人访问的本机生产服务，使用生产端口、生产数据目录和 `.env.local` 中的真实配置。

```bash
npm run local:prod
```

生产环境默认地址：

- 前端：http://localhost:3013
- API：http://localhost:4206
- OCR：http://localhost:4105
- 数据目录：`.runtime/`

生产环境状态和停止：

```bash
npm run local:prod:status
npm run local:prod:stop
```

同时查看两套环境：

```bash
npm run local:status
```

首次使用先执行：

```bash
npm install
```

## 微信公众号/小程序 WebView 发布

- 公众号菜单可配置为跳转网页：`https://app.poptonic.cn/`
- 公众号后台需要配置 `JS接口安全域名`：`app.poptonic.cn`。如后台要求上传校验文件，把 `MP_verify_*.txt` 放到 `public/` 目录后重新执行 `npm run local:prod`。
- 公众号后台还需要把当前 API 出口 IP 加入 IP 白名单；当前本机出口 IP 检测为 `122.231.228.251`。
- `.env.local` 需要配置 `WECHAT_H5_APP_ID` 和 `WECHAT_H5_APP_SECRET`。代码不会把 `appsecret` 返回到前端。
- 小程序内可先用 `web-view` 打开同一个地址。
- 目前公众号和小程序 WebView 内固定走系统相册/拍照上传，避免 JS-SDK `chooseImage` 返回微信临时图片导致拍照不进入手机相册。
