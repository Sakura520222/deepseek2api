# DeepSeek2API 项目概述

## 项目简介

DeepSeek2API 是一个纯 Node.js 构建的 DeepSeek Web 控制台与 OpenAI 兼容桥接服务。它将本地用户体系、DeepSeek 账号绑定、API Key 管理、原生代理调试和管理后台集成在同一个可直接运行的项目中，无需第三方运行时依赖即可部署。

## 技术栈

项目采用前后端一体的纯原生技术方案，未引入任何框架或构建工具。

**后端：** 纯 Node.js 原生 HTTP 服务，使用内置 `http` 模块处理请求路由和响应。无 Express、无数据库、无构建步骤。数据持久化通过读取和写入 `data/app.json` 文件实现，服务状态完全以 JSON 格式保存在单文件中。

**前端：** 原生 JavaScript + CSS + HTML，静态资源由服务端直接托管和响应。所有 UI 交互、会话管理、主题切换等功能均由浏览器端 JavaScript 完成，不依赖任何前端框架或打包工具。

**鉴权与安全：** DeepSeek 账号 token 管理、自动刷新机制；PoW（工作量证明）挑战自动求解，调用 WebAssembly 模块完成；API Key 生成与校验均在服务端原生实现。

**部署环境：** 要求 Node.js 18 以上版本。服务端需能够访问 `chat.deepseek.com`、`cdn.deepseek.com` 及 `fe-static.deepseek.com`。

## 项目结构

项目根目录包含入口配置和静态资源目录，核心模块分为前端公共资源与后端源码两部分。

```
deepseek2api/
├── .env.example          # 环境变量示例配置
├── .gitignore
├── LICENSE
├── README.md
├── package.json          # 项目描述与启动脚本
├── data/
│   └── .gitkeep          # 运行数据目录，data/app.json 在此生成
├── public/               # 前端静态资源，由服务端直接托管
│   ├── app.js            # 前端主入口
│   ├── api.js            # 前端 API 请求封装
│   ├── app-constants.js  # 前端常量定义
│   ├── app-services.js   # 前端业务服务层
│   ├── auth-ui.js        # 登录/注册界面逻辑
│   ├── account-display.js   # 账号展示组件
│   ├── account-list-view.js # 账号列表视图
│   ├── admin-ui.js       # 管理后台界面
│   ├── admin-actions.js  # 管理操作逻辑
│   └── actions.js        # 通用操作处理
└── src/                  # 后端源码
    ├── server.js         # HTTP 服务启动入口
    ├── config.js         # 配置加载与解析
    ├── routes/           # 路由处理模块
    ├── services/         # 核心业务逻辑层
    ├── storage/          # 数据存储与读写
    └── utils/            # 工具函数
```

**前端模块（public/）：** 所有文件均为浏览器可直接执行的 JavaScript。`app.js` 作为主入口协调各 UI 模块，`api.js` 封装对后端接口的调用，`auth-ui.js`、`admin-ui.js`、`account-display.js` 等负责各自功能区域的界面渲染与交互。`app-services.js` 承担前端业务逻辑，`app-constants.js` 集中管理常量。

**后端模块（src/）：** `server.js` 负责创建 HTTP 服务、分发请求；`config.js` 读取环境变量并提供配置项；`routes/` 目录定义各 API 路由的处理函数；`services/` 包含账号管理、API Key 轮询、DeepSeek 接口调用、PoW 求解等核心业务；`storage/` 负责 `app.json` 的读写与数据一致性维护；`utils/` 提供通用辅助函数。

**数据目录（data/）：** 项目运行时自动生成 `app.json`，存储用户账号、API Key、DeepSeek 绑定信息、邀请码、系统配置等全部状态数据。仓库仅保留 `.gitkeep` 占位。

## 开发约定

从代码结构可以推断项目遵循以下开发规范：

**前后端分离但同仓存放。** 前端代码全部位于 `public/` 目录，每个文件按功能领域命名，如 `auth-ui.js` 专责认证界面、`admin-ui.js` 专责管理界面。单文件承担单一职责，通过 `app.js` 引入协调。

**模块化职责划分。** 后端在 `src/` 下按层次拆分：路由层（routes）仅负责请求分发和参数提取，不写入业务逻辑；业务逻辑集中在 services 层处理；数据存储封装在 storage 层，对外暴露统一的读写接口，调用方不直接操作文件系统。

**配置外部化。** 仅通过 `.env` 文件和环境变量管理可变配置（端口、管理员凭证），不硬编码在代码中。`.env.example` 提供模板，降低部署配置成本。

**无构建依赖。** 项目不依赖 Webpack、Vite 等打包工具，也不使用 TypeScript。前端直接写原生 ES Module 或全局脚本方式组织代码，服务端以 CommonJS 或 ES Module 原生运行，确保零构建步骤即可启动。

**数据持久化极简化。** 全部状态存储于单个 JSON 文件，避免引入数据库。存储层需自行处理文件锁、备份恢复等一致性保障，调用方无需关心存储介质。

**错误处理与容错机制内聚。** DeepSeek token 失效自动刷新、PoW 挑战自动求解等功能均在 services 层内部闭环处理，调用层无感。API Key 多账号轮询逻辑也在 services 内实现，对上层路由处理透明。