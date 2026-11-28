# Antigravity 桌面端接入 · 阶段 A 探测与阻塞记录

- **探测日期**：2026-11-27
- **本机基线**：Antigravity App `hub-2.35.1`（`ANTIGRAVITY_LS_VERSION=hub-2.35.1`）、Windows 11 23H2
- **对应方案**：[MyIDE-Antigravity桌面端接入方案.md](../../../MyIDE-Antigravity桌面端接入方案.md)
- **阶段结论**：**阶段 A 未通过门禁，暂不进入阶段 B（MyIDE 面板代码接入）**。已按方案要求保留已脱敏的同 ID 调用与回执，并明确列出关键能力缺项与阻塞依据；现有 Antigravity（CLI）入口保持不变。

---

## 1. 能力核对总览

| 验证项 | 公开机制 / 探测对象 | 实测结果 | 阶段 A 判定 |
| --- | --- | --- | --- |
| 授权与身份 | `ANTIGRAVITY_LS_ADDRESS` + `ANTIGRAVITY_CSRF_TOKEN` + `product.v1.ConversationService` | 在宿主注入的 agent 环境中可直接调用；独立外部进程（MyIDE）无默认授权注入。官方 Sidecars 机制需用户在 `~/.gemini/config/config.json` 显式启用，仅公开 `agentapi` 与数据目录，未公开外部桌面控制授权协议。 | **部分通过（外部授权待定）** |
| 会话目录与元数据 | `ListConversations` / `GetConversation` / `CreateConversation` / `UpdateConversation` / `DeleteConversation` | 实测全部可用，可按 `projectId` 过滤并读写同 ID 会话状态与标注。 | **通过** |
| 原会话追加（续发） | `ConversationService` & `agentapi send-message` | `ConversationService` 无续发接口；`agentapi send-message` 实测为异步通知语义，对已创建的空会话调用后 `runState` 保持 `RUN_STATE_IDLE` 且未触发对话轮次或 `transcript.jsonl`。 | **阻塞** |
| 历史与实时观察 | `ConversationService` & `transcript.jsonl` | `ConversationService` 仅返回 `summary` 与 `runState`；本地 `transcript.jsonl` 存在结构化步骤记录，但无官方实时事件流、审批等待事件或增量同步协议。 | **未满足** |
| 原生审批与停止 | `ConversationService` / `agentapi` / `hooks.json` | 均无停止/取消运行中轮次（Stop/Cancel）接口，也无读取待审批请求并回传「仅允许本次 / 拒绝」的公开接口。`PreToolUse` 钩子不可用于绕过或替代 App 原生审批窗口。 | **阻塞** |
| UI Automation 兼容路径 | Windows `UIAutomationClient` | 当前探测会话处于受限桌面上下文，顶层可见窗口为 `0`（`Antigravity` 进程 `MainWindowHandle=0`），未能完成稳定控件 ID、不抢焦点与请求绑定的实机验证。 | **未验证 / 阻塞** |

---

## 2. 已脱敏的同 ID 调用与回执

> 所有 CSRF Token 与本地端口地址均已脱敏，未写入凭据或业务正文。

### 2.1 只读身份与目录探测

宿主注入环境（仅记录变量名与存在性）：
- `ANTIGRAVITY_LS_ADDRESS`（已注入，长度 15）
- `ANTIGRAVITY_CSRF_TOKEN`（已注入，长度 36，已脱敏）
- `ANTIGRAVITY_LS_VERSION=hub-2.35.1`
- `ANTIGRAVITY_PROJECT_ID=8c9b846d-...-14b60b1315c3`
- `ANTIGRAVITY_CONVERSATION_ID=d8018f89-...-f7fd514c9144`
- `ANTIGRAVITY_AGENTAPI_EXE`（已注入）

`POST /product.v1.ConversationService/GetConversation` 回执（脱敏）：
```json
{
  "id": "d8018f89-****-****-****-f7fd514c9144",
  "metadata": {
    "createTime": "2026-11-27T09:12:18.200145900Z",
    "projectId": "8c9b846d-****-****-****-14b60b1315c3",
    "rootConversationId": "d8018f89-****-****-****-f7fd514c9144"
  },
  "annotations": {
    "title": "MyIDE Antigravity Desktop Integration Plan"
  },
  "state": {
    "runState": "RUN_STATE_RUNNING",
    "updateTime": "2026-11-27T09:13:25.608731700Z"
  }
}
```

`POST /product.v1.ConversationService/ListConversations`（`{"pageSize":5,"projectId":"<current>"}`）：成功返回当前 `projectId` 下会话列表，字段与 `GetConversation` 一致。

### 2.2 临时会话新建、续发探测与清理

1. **创建空会话**（`CreateConversation`，指定 `projectId`、`title="PhaseA-Temp-Probe"`、`tags=["myide-phase-a-probe"]`）：
   - 返回新会话 ID：`396c65cd-****-****-****-3df87211cd6a`
   - `state.runState`：`RUN_STATE_IDLE`
2. **校验 `agentapi` 可用子命令**（`C:/Users/Administrator/.gemini/antigravity/bin/agentapi.bat --help`）：
   - 仅支持 3 个子命令：`get-conversation-metadata`、`new-conversation`、`send-message`；无 `stop`/`cancel`/`approve` 等子命令。
3. **对同一 ID 执行 `agentapi send-message`**：
   - 命令：`agentapi send-message <temp-id> "Phase A probe: reply with only OK"`
   - 退出码：`0`
   - 输出：
     ```json
     {
       "response": {
         "sendMessage": {
           "recipientId": "396c65cd-****-****-****-3df87211cd6a",
           "content": "Phase A probe: reply with only OK"
         }
       }
     }
     ```
   - 等待 4 秒后再次调用 `GetConversation`：`state.runState` 仍为 `RUN_STATE_IDLE`；对应 `transcript.jsonl` 不存在（`TRANSCRIPT_EXISTS=False`）。
   - 结合 `agentapi send-message --help` 说明（*"Send messages to another conversation or yourself (useful for async notifications)"*），确认其不属于向已有会话追加用户输入并驱动新轮次的公开接口。
4. **清理**：调用 `DeleteConversation` 删除该临时会话，返回成功（`DELETED_OK=True`）。

### 2.3 官方文档与本地能力核对

已核对以下官方公开文档（2026-11-27）：
- `conversations` 内置技能说明：`ConversationService` 仅包含 `CreateConversation`、`ListConversations`、`GetConversation`、`UpdateConversation`、`DeleteConversation`。
- `https://antigravity.google/docs/sidecars.md`：Sidecars 支持由 App 托管生命周期与 `agentapi`（`new-conversation` / `send-message`），不提供续发、停止或交互审批接口。
- `https://antigravity.google/docs/changelog.md`（截至 v2.35.2）：v2.35.0 引入上述 Conversation Management API，v2.35.1/v2.35.2 未新增原会话续发、流式读取、审批回传或停止接口。

---

## 3. 阻塞项与后续推进条件

依据方案第 6 节与结尾要求，在以下四项未获得受支持且实测通过的宿主能力之前，不进入阶段 B 开发，也不在 MyIDE 中承诺可用的「Antigravity（桌面端）」模式：

1. **独立进程宿主授权**：外部 MyIDE 如何在不绕过安全边界的前提下，通过 Antigravity 官方支持机制获取本机连接授权。
2. **原会话用户输入续发**：向已存在的桌面会话追加真实用户 prompt 并触发同一会话新轮次。
3. **可靠历史与运行态观察**：获得完整消息、角色、工具请求、等待审批与终态，而非仅摘要或截断视图。
4. **绑定请求的原生审批与停止**：在 MyIDE 可信窗口内展示真实工具详情并回传「仅允许本次 / 拒绝」，以及可靠停止当前活动轮次并核对宿主终态。

### 可选下一步
- **继续使用现有 Antigravity（CLI）模式**：已通过实机验收（见 [Antigravity原生连接与验收.md](Antigravity原生连接与验收.md)），支持原生会话加载/恢复、审批、停止与队列。
- **等待官方桌面 API 补齐**：待 Antigravity App 公开支持原会话续发、消息流、审批回传与停止接口后，再重新执行阶段 A 并进入阶段 B。
- **若需补充评估 Windows UI Automation 兼容路径**：需在用户交互桌面的普通 PowerShell（非隔离窗口站）中对运行中的 Antigravity App 窗口执行只读 UIA 树探测，优先验证是否具备稳定的语义 `AutomationId`（而非仅标题或坐标）、能否不抢焦点、以及能否绑定具体审批请求与会话。
