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

## 钉钉顾问身份绑定配置

服务端身份绑定默认关闭并拒绝请求。启用时通过运行环境提供以下变量：

- `DINGTALK_IDENTITY_SERVICE_TOKEN`：悟空/渠道服务调用身份接口时使用的 Bearer token。
- `DINGTALK_IDENTITY_ALLOWED_USER_IDS`：允许绑定的 OCR Insurance 用户 ID，使用英文逗号分隔。
- `DINGTALK_CORP_ID`、`DINGTALK_APP_KEY`、`DINGTALK_APP_SECRET`：钉钉企业与应用凭据。
- `DINGTALK_MOBILE_FINGERPRINT_KEY`：至少 32 字节的独立服务端密钥，用于手机号 HMAC 指纹；当前仅支持活动版本 `v1`，轮换时已有待确认挑战会安全失效。
- `DINGTALK_API_BASE_URL`：可选，默认使用钉钉开放平台 API 地址。
- `DINGTALK_IDENTITY_TIMEOUT_MS`：可选，钉钉 HTTP 请求超时，范围 50–30000 毫秒，默认 10000 毫秒。

不要把凭据提交到仓库；生产进程应从受控运行环境注入这些变量。

生产环境还必须配置 `FAMILY_SALES_MEMORY_CURSOR_KEY`（至少 32 个字符），用于绑定并签名家庭销售记忆分页游标。开发环境未配置时会使用进程内随机密钥，重启后旧游标会自然失效。
