# DeepSeek2API

> 一个纯 Node.js 的 DeepSeek Web 控制台 + OpenAI 兼容桥接服务。  
> 把本地用户体系、DeepSeek 账号绑定、API Key 管理、原生代理调试和管理后台放进同一个可直接运行的项目里。

## 功能概览

| 模块 | 能力 |
| --- | --- |
| 控制台 UI | 登录 / 注册、聊天工作区、历史会话、文件上传、主题切换、流式 / 非流式响应切换 |
| DeepSeek 账号层 | 绑定多个 DeepSeek Web 账号，按管理员 / 本地用户隔离可见范围 |
| OpenAI 兼容层 | 提供 `GET /v1/models` 和 `POST /v1/chat/completions` |
| 原生代理层 | 提供 `/proxy/*` 白名单转发，便于调试和复用 DeepSeek Web 接口 |
| 管理后台 | 注册开关、邀请码生成 / 删除、用户启用 / 禁用 / 删除、并发 / 速率限制 |
| 无痕模式 | 支持全局或用户级无痕，会话完成后自动清理 |
| 部署形态 | 无第三方 npm 运行时依赖，`npm start` 即可启动 |

## 项目特点

- 纯 Node.js 原生 HTTP 服务，无 Express、无数据库、无构建步骤
- 前后端都在一个仓库里，静态资源由服务端直接托管
- 运行状态统一保存在 `data/app.json`
- DeepSeek token 失效时会自动重新登录并刷新
- 遇到 PoW 保护接口时会自动获取 wasm 并求解挑战
- OpenAI 兼容层同时支持流式和非流式响应
- `deepseek-reasoner-*` 模型会把思维内容包裹在 `<think>...</think>`
- API Key 请求会在当前用户可见账号之间轮询，提高多账号利用率

## 运行要求

- Node.js 18+
- 服务端能够访问 `https://chat.deepseek.com`
- 浏览器在绑定 DeepSeek 账号时需要访问 `https://cdn.deepseek.com`
- 如触发 PoW 校验，服务端还需要访问 `https://fe-static.deepseek.com`

## 快速开始

### 1) 启动服务

```bash
npm start
```

默认监听地址：

```text
http://127.0.0.1:3000
```

### 2) 可选：创建本地配置

仓库不自带 `.env`。如需启用管理员入口或修改端口，可参考 `.env.example` 手动创建：

```bash
cp .env.example .env
```

Windows PowerShell 可以使用：

```powershell
Copy-Item .env.example .env
```

`.env.example` 内容：

```env
PORT=3000
APP_ADMIN_USERNAME=
APP_ADMIN_PASSWORD=
```

### 3) 打开控制台

浏览器访问 `http://127.0.0.1:3000`，然后按下面的典型流程使用：

1. 注册本地用户，或使用管理员账号登录
2. 在“账号”页绑定 DeepSeek 账号
3. 在“密钥”页创建 API Key
4. 使用内置聊天工作区，或通过 OpenAI 兼容接口接入你的客户端

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口 |
| `APP_ADMIN_USERNAME` | 空 | 管理员用户名 |
| `APP_ADMIN_PASSWORD` | 空 | 管理员密码 |

只有同时设置 `APP_ADMIN_USERNAME` 和 `APP_ADMIN_PASSWORD` 时，管理员入口才会启用。

## 控制台能力

### 聊天工作区

- 查看 DeepSeek 历史会话并加载消息记录
- 新建会话、继续会话、发送消息
- 上传文件并在聊天中引用
- 切换流式 / 非流式响应
- 切换快速 / 专家 / 推理 / 联网模型

### 账号与密钥

- 绑定 / 删除 DeepSeek Web 账号
- 为当前用户创建多个 API Key
- API Key 可指定自定义明文，留空则自动生成
- OpenAI 兼容调用默认使用所选账号起始，并在当前用户可见账号之间轮询

### 管理后台

- 管理本地注册开关
- 控制是否必须使用邀请码注册
- 生成、删除、批量删除邀请码
- 禁用、启用、删除本地用户
- 为用户设置并发上限和每分钟请求上限

### 无痕模式

- 管理员可以开启全局无痕
- 普通用户可以只为自己开启无痕
- 开启后，聊天完成后会自动清理相关 DeepSeek 会话

## OpenAI 兼容接口

### 支持的接口

- `GET /v1/models`
- `POST /v1/chat/completions`

### 请求示例

```bash
curl http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer <YOUR_API_KEY>"
```

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat-fast",
    "messages": [
      { "role": "user", "content": "hello" }
    ],
    "stream": false
  }'
```

### 模型说明

- 默认模型：`deepseek-chat-fast`
- 联网能力通过模型后缀 `-search` 控制
- 不支持 `web_search_options`；请改用 `*-search` 模型

<details>
<summary>展开查看支持的模型 ID</summary>

- `deepseek-chat-fast`
- `deepseek-chat-fast-search`
- `deepseek-reasoner-fast`
- `deepseek-reasoner-fast-search`
- `deepseek-chat-expert`
- `deepseek-chat-expert-search`
- `deepseek-reasoner-expert`
- `deepseek-reasoner-expert-search`

</details>

## 原生代理接口

### 支持的接口

- `GET /proxy/...`
- `POST /proxy/...`

### 使用说明

- `/proxy/*` 走的是登录态会话，不是 API Key 鉴权
- 如果存在多个可用账号，可通过请求头 `x-proxy-account-id` 指定账号
- 只允许转发白名单路径，白名单定义在 `src/config.js`

<details>
<summary>展开查看当前白名单路径</summary>

- `/api/v0/chat/completion`
- `/api/v0/chat/continue`
- `/api/v0/chat/create_pow_challenge`
- `/api/v0/chat/edit_message`
- `/api/v0/chat/history_messages`
- `/api/v0/chat/message_feedback`
- `/api/v0/chat/regenerate`
- `/api/v0/chat/resume_stream`
- `/api/v0/chat/stop_stream`
- `/api/v0/chat_session/create`
- `/api/v0/chat_session/delete`
- `/api/v0/chat_session/delete_all`
- `/api/v0/chat_session/fetch_page`
- `/api/v0/chat_session/update_pinned`
- `/api/v0/chat_session/update_title`
- `/api/v0/client/settings`
- `/api/v0/download_export_history`
- `/api/v0/export_all`
- `/api/v0/file/fetch_files`
- `/api/v0/file/preview`
- `/api/v0/file/upload_file`
- `/api/v0/share/content`
- `/api/v0/share/create`
- `/api/v0/share/delete`
- `/api/v0/share/fork`
- `/api/v0/share/list`
- `/api/v0/users`
- `/api/v0/users/settings`
- `/api/v0/users/update_settings`

</details>

## 本地接口总览

<details>
<summary>展开查看完整接口清单</summary>

### 公共接口

- `GET /api/me`
- `GET /api/discovery`
- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/logout`

### 登录后接口

- `GET /api/accounts`
- `POST /api/accounts`
- `DELETE /api/accounts/:id`
- `POST /api/incognito`
- `GET /api/api-keys`
- `POST /api/api-keys`
- `DELETE /api/api-keys/:id`

### 管理接口

- `POST /api/admin/registration`
- `POST /api/admin/invites`
- `POST /api/admin/invites/batch-delete`
- `DELETE /api/admin/invites/:id`
- `PATCH /api/admin/users/:id`
- `DELETE /api/admin/users/:id`
- `POST /api/admin/users/batch-disable`
- `POST /api/admin/users/batch-delete`

</details>

## 项目结构

```text
.
├─ data/                  # 运行时数据目录
├─ public/                # 前端控制台静态资源
├─ src/
│  ├─ routes/             # 公共 / 私有 / 管理 / 代理路由
│  ├─ services/           # 账号、用户、桥接、PoW、限流等核心逻辑
│  ├─ storage/            # JSON 文件存储
│  └─ utils/              # HTTP、SSE、ID、Prompt 等工具
├─ .env.example
├─ package.json
└─ README.md
```

## License

This project is licensed under the [MIT License](./LICENSE).
