# 项目记忆

## 仓库信息
- 仓库名: Sakura520222/deepseek2api
- 累计反思次数: 9

## 常见代码模式与审查要点
- **工具调用门控陷阱**：多处仅当 `tools` 非空才触发提取；修改后须复查所有调用点的门控条件。适配类 Issue 必须追问：若客户端未声明 `tools` 却返回 `tool_calls`，契约能否保证下游不崩溃。
- **模型同步影响模块**：新增模型需检查前端列表、后端映射、请求头版本号、`model_type` 四维一致性；对未公开 API 须产出 Warning，列明待确认项。
- **桥接服务一致性**：多桥接的 system/tool prompt 构建、认证解析、错误转换须统一。流式与非流式输出路径必须对比输出结构，确保 `output` 数组元素、条件分支一致；工具参数字段（`parameters`/`input_schema`/`inputSchema`）应约定标准中间表示（如 `inputSchema`），在入口处规范转换。
- **流式输出尾部完整性**：流式收尾逻辑必须验证最终 output 结构与流式事件对应；提取共享收尾函数，避免重复与遗漏。任何涉及流式解析的 PR 均需强制检查是否遗漏 output 项及条件分支匹配非流式路径。
- **自动生成变体审查**：`createModelVariant` 衍生 `-search` 变体时，需确认不会错误继承或覆盖 `thinkingEnabled`；审查时附上全量属性表格。
- **边缘保护**：参数语义冲突（如 `tool_choice=required` 但无 tools）须返回 4xx，不得静默忽略。
- **未使用变量与死代码**：标记为 minor/suggestion；建议启用 lint `no-unused-vars` 为 error。调试环境变量（`DEBUG_*`）仅用于日志，不得影响核心分支逻辑。

## Issue 分析与优先级模式
- **标签推荐**：适配类 Issue 必须推荐 `compatibility` 或 `area/api-compatibility`；展示类问题建议附加 `area/frontend` 或 `area/user-experience`。
- **重复检测**：必须给出相似度分数与摘要对比，禁止模糊结论；信息不足时声明“需人工复核”。
- **优先级因子**：外部依赖退役日期可提升优先级；当功能阻断明确时（如特定客户端完全无法使用），应从 medium 上调至 medium-high 或 high。
- **分层分析**：对格式类问题区分数据格式（API）与表现格式（UI），分别定位根源再综合判断。

## 经验教训与规范建议
- 多桥接重构易引入细节偏差，须留意参数传递与默认行为。
- 流式尾部构建是重复犯错高发区，提取公共收尾函数可避免遗漏；增量审查中必须基于代码事实而非修复标签进行验证。
- 任何涉及工具调用解析的修改，需同步补充“无 tools 时兜底解析”的测试用例。
- 遇到错误或异常展示，应追问“这是用户看到的，还是代码打印的？”以区分 bug 与内部调试信息，必要时立即提升优先级。
- 外部 API 兼容性审查应明确风险边界并给出验证步骤。

## 需特别关注的领域
- `openai-bridge.js` 工具调用门控、`createModelVariant` 生成逻辑
- `completion-core.js` 流处理与尾部事件构建
- `responses-bridge`、`anthropic-bridge` 输出组装一致性（含流式与非流式路径对比）
- 模型列表 / 版本头常量同步
- 外部客户端（如 OpenClaw）适配与请求格式解析，以及前端渲染路径 `public/deepseek-message.js`
- 新增调试开关 `DEBUG_TOOL_CALL` 周边逻辑，确保不影响业务分支