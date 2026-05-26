# Slihoot MVP Plan

## 版本目標

第一版最小可運作模型(MVP)的目標是完成一條完整的即時互動活動流程:

> 主持人可以建立一場活動,參與者可以用代碼加入,主持人逐題推進,參與者即時作答與提問,主持人能看到結果並管理聊天室訊息。

MVP 不追求功能完整度,而是優先驗證 Slihoot 的核心價值:

1. 可以 self-host 的活動互動工具。
2. 活動建立、加入、作答、顯示結果是一條完整閉環。
3. 參與者手機端重新整理或短暫斷線後可以回到活動。
4. 聊天室以 Q&A 訊息牆形式輔助現場互動,但不做成完整社群聊天產品。

## MVP 功能範圍

### 1. Admin 登入

第一版只支援單一管理者。

功能:

1. Admin 輸入密碼登入。
2. 密碼透過環境變數設定。
3. 登入成功後核發 JWT。
4. Admin API 與 WebSocket 操作需驗證 JWT。

暫不實作:

1. 多帳號。
2. 註冊流程。
3. 角色權限。
4. 忘記密碼。

### 2. Event 管理

Event 是可重複啟動 live session 的活動模板。

功能:

1. 建立 event。
2. 查看 event 列表。
3. 編輯 event 標題與描述。
4. 刪除 event。
5. 在 event 內新增、編輯、刪除與排序 activity。

暫不實作:

1. 複製 event。
2. 匯入題庫。
3. 分類、標籤、搜尋。
4. 多人共同編輯。

### 3. Activity 題型

第一版只做低成本且能驗證核心流程的題型。

納入 MVP:

1. 選擇題: 單選,2 到 6 個選項。
2. 是非題: 可視為固定兩個選項的選擇題。
3. 簡答題: 純文字輸入,不自動評分。

暫不實作:

1. 排序題。
2. 搶答。
3. 文字雲。
4. PDF 教材穿插。
5. 詳解功能。
6. 自動計分與排行榜。

### 4. Live Session

Live session 是 event 的一次實際執行。

功能:

1. Admin 從 event 啟動 live session。
2. Server 產生 join code。
3. Admin 進入主持畫面。
4. Participant 輸入 join code 與暱稱加入。
5. Live session 記錄目前 activity index。
6. Admin 可切換上一題、下一題。
7. Admin 可顯示或隱藏目前題目的結果。
8. Admin 可結束 live session。

暫不實作:

1. 排程啟動。
2. 同一 event 多場 live session 的完整歷史比較。
3. 多主持人控制。
4. 大規模分散式部署。

### 5. 參與者作答

功能:

1. Participant 加入後看到目前 activity。
2. 選擇題與是非題可提交選項。
3. 簡答題可提交文字。
4. 每位 participant 每題只保留一次答案。
5. 後端收到答案的時間作為正式 timestamp。
6. Live session 結束後禁止提交答案。

暫不實作:

1. 多次作答紀錄。
2. 作答修改歷史。
3. 答題倒數計時。
4. 積分。
5. 防作弊排行榜。

### 6. 即時同步

第一版使用單機 WebSocket,不先導入 Redis Pub/Sub。

功能:

1. Participant 加入時更新主持畫面人數。
2. Admin 切題時同步所有 participant 畫面。
3. Participant 作答後即時更新主持畫面的回答數。
4. Admin 顯示結果時同步 participant 畫面。
5. WebSocket 斷線後前端自動重連。

暫不實作:

1. 多 server instance 的 WebSocket 同步。
2. Redis Pub/Sub。
3. 複雜 presence 狀態。

### 7. 結果顯示

功能:

1. 選擇題與是非題顯示每個選項的票數與比例。
2. 簡答題顯示文字回答列表。
3. Admin 可控制 participant 是否看到結果。

暫不實作:

1. 排行榜。
2. 答題速度排名。
3. 競賽動畫。
4. 資料匯出。

### 8. 聊天室 / Q&A 訊息牆

第一版聊天室定位為 live session 內的 Q&A 訊息牆,不是一般聊天產品。

功能:

1. Participant 可送出文字訊息。
2. Participant 可看到公開訊息。
3. Admin 可看到所有訊息。
4. Admin 可隱藏訊息。
5. Admin 可刪除訊息。
6. Admin 可釘選或取消釘選訊息。
7. Live session 結束後禁止傳送訊息。
8. Participant 重新整理後可載入最近訊息。

訊息狀態:

| 狀態 | 說明 |
|---|---|
| visible | 對 participant 與 admin 可見 |
| hidden | 只對 admin 可見 |
| deleted | 只保留資料紀錄,一般畫面不顯示 |

基本防護:

1. 後端 trim 訊息內容。
2. 拒絕空白訊息。
3. 限制訊息長度,建議 200 字。
4. 同一 participant 做簡單 rate limit,建議每 2 秒最多 1 則。
5. 前端渲染時不可使用未清理的 HTML。

暫不實作:

1. 私訊。
2. thread 回覆。
3. 圖片或檔案上傳。
4. emoji reaction。
5. upvote。
6. AI 內容審查。
7. 聊天室匯出。

### 9. 基本斷線恢復

功能:

1. Participant join 成功後取得 participant token。
2. 前端將 participant token 存入 localStorage。
3. WebSocket 重連時帶上 participant token。
4. 後端根據 participant token 恢復 participant 身分。
5. 重連後同步目前 live session 狀態、目前 activity、已提交答案與最近訊息。

暫不實作:

1. 跨裝置恢復。
2. 長期 refresh token。
3. 複雜 offline queue。

### 10. Docker 開發部署

功能:

1. 提供 Dockerfile。
2. 提供 docker-compose.yml。
3. docker-compose 至少包含 app 與 MySQL。
4. 環境變數可設定 admin 密碼、JWT secret、資料庫連線。

暫不實作:

1. Redis。
2. Nginx reverse proxy。
3. HTTPS 自動憑證。
4. Kubernetes 或雲端部署腳本。

## 建議資料模型

### admins

第一版可不一定需要資料表。如果採用單一環境變數密碼,可以不建立 admins table。

若建立資料表,欄位:

| 欄位 | 說明 |
|---|---|
| id | Admin ID |
| username | 登入名稱 |
| password_hash | 密碼 hash |
| created_at | 建立時間 |
| updated_at | 更新時間 |

### events

| 欄位 | 說明 |
|---|---|
| id | Event ID |
| title | 活動標題 |
| description | 活動描述 |
| created_at | 建立時間 |
| updated_at | 更新時間 |

### activities

| 欄位 | 說明 |
|---|---|
| id | Activity ID |
| event_id | 所屬 event |
| type | multiple_choice / true_false / short_answer |
| title | 題目標題 |
| description | 題目補充說明 |
| options_json | 選項資料,簡答題可為 null |
| correct_answer_json | MVP 可先保留欄位但不一定使用 |
| sort_order | 排序 |
| created_at | 建立時間 |
| updated_at | 更新時間 |

### live_sessions

| 欄位 | 說明 |
|---|---|
| id | Live session ID |
| event_id | 對應 event |
| join_code | 參與代碼 |
| status | waiting / active / ended |
| current_activity_id | 目前 activity |
| current_activity_index | 目前 activity index |
| show_results | 是否對 participant 顯示結果 |
| started_at | 開始時間 |
| ended_at | 結束時間 |
| created_at | 建立時間 |
| updated_at | 更新時間 |

### participants

| 欄位 | 說明 |
|---|---|
| id | Participant ID |
| live_session_id | 所屬 live session |
| nickname | 暱稱 |
| token_hash | participant token 的 hash |
| joined_at | 加入時間 |
| last_seen_at | 最後連線或互動時間 |

### responses

| 欄位 | 說明 |
|---|---|
| id | Response ID |
| live_session_id | 所屬 live session |
| activity_id | 對應 activity |
| participant_id | 對應 participant |
| answer_json | 答案內容 |
| received_at | 後端收到答案的時間 |
| created_at | 建立時間 |
| updated_at | 更新時間 |

限制:

1. 同一個 participant 在同一個 activity 只保留一筆 response。
2. 可用 unique(live_session_id, activity_id, participant_id) 達成。

### live_messages

| 欄位 | 說明 |
|---|---|
| id | Message ID |
| live_session_id | 所屬 live session |
| participant_id | 發訊息的 participant |
| content | 訊息內容 |
| status | visible / hidden / deleted |
| pinned | 是否釘選 |
| created_at | 建立時間 |
| updated_at | 更新時間 |
| moderated_at | 管理時間 |

## REST API 規劃

所有 API 以 `/api` 開頭。

### Auth

| 路徑 | 方法 | 權限 | 說明 |
|---|---|---|---|
| `/api/auth/login` | POST | public | Admin 登入 |
| `/api/auth/me` | GET | admin | 驗證目前 admin token |

### Events

| 路徑 | 方法 | 權限 | 說明 |
|---|---|---|---|
| `/api/events` | GET | admin | 取得 event 列表 |
| `/api/events` | POST | admin | 建立 event |
| `/api/events/:eventId` | GET | admin | 取得單一 event 與 activities |
| `/api/events/:eventId` | PUT | admin | 更新 event |
| `/api/events/:eventId` | DELETE | admin | 刪除 event |

### Activities

| 路徑 | 方法 | 權限 | 說明 |
|---|---|---|---|
| `/api/events/:eventId/activities` | POST | admin | 新增 activity |
| `/api/activities/:activityId` | PUT | admin | 更新 activity |
| `/api/activities/:activityId` | DELETE | admin | 刪除 activity |
| `/api/events/:eventId/activities/reorder` | PUT | admin | 更新 activity 排序 |

### Live Sessions

| 路徑 | 方法 | 權限 | 說明 |
|---|---|---|---|
| `/api/events/:eventId/live-sessions` | POST | admin | 從 event 啟動 live session |
| `/api/live-sessions/:liveId` | GET | admin | 取得 live session 狀態 |
| `/api/live-sessions/:liveId/end` | POST | admin | 結束 live session |
| `/api/live-sessions/join` | POST | public | Participant 使用 join code 加入 |
| `/api/live-sessions/:liveId/messages` | GET | participant/admin | 取得最近訊息 |

## WebSocket 規劃

WebSocket endpoint:

```text
/ws
```

連線時由 query 或第一個 message 帶入身分:

```json
{
  "role": "admin",
  "token": "admin-jwt",
  "liveId": "live-session-id"
}
```

```json
{
  "role": "participant",
  "participantToken": "participant-token",
  "liveId": "live-session-id"
}
```

### Client to Server

#### submit_answer

```json
{
  "type": "submit_answer",
  "payload": {
    "liveId": "live-session-id",
    "activityId": "activity-id",
    "answer": {
      "optionId": "option-id"
    }
  }
}
```

簡答題:

```json
{
  "type": "submit_answer",
  "payload": {
    "liveId": "live-session-id",
    "activityId": "activity-id",
    "answer": {
      "text": "我的回答"
    }
  }
}
```

#### change_activity

Admin only.

```json
{
  "type": "change_activity",
  "payload": {
    "liveId": "live-session-id",
    "activityId": "activity-id"
  }
}
```

#### set_results_visibility

Admin only.

```json
{
  "type": "set_results_visibility",
  "payload": {
    "liveId": "live-session-id",
    "showResults": true
  }
}
```

#### send_message

Participant only.

```json
{
  "type": "send_message",
  "payload": {
    "liveId": "live-session-id",
    "content": "想請問這題可以再說明一次嗎?"
  }
}
```

#### moderate_message

Admin only.

```json
{
  "type": "moderate_message",
  "payload": {
    "liveId": "live-session-id",
    "messageId": "message-id",
    "action": "hide"
  }
}
```

允許 action:

1. hide
2. show
3. delete
4. pin
5. unpin

### Server to Client

#### state_change

```json
{
  "type": "state_change",
  "payload": {
    "liveId": "live-session-id",
    "status": "active",
    "currentActivity": {},
    "showResults": false
  }
}
```

#### response_summary_update

```json
{
  "type": "response_summary_update",
  "payload": {
    "liveId": "live-session-id",
    "activityId": "activity-id",
    "responseCount": 12,
    "summary": {}
  }
}
```

#### participant_joined

```json
{
  "type": "participant_joined",
  "payload": {
    "liveId": "live-session-id",
    "participantCount": 24
  }
}
```

#### new_message

```json
{
  "type": "new_message",
  "payload": {
    "message": {
      "id": "message-id",
      "participantName": "小明",
      "content": "想請問這題可以再說明一次嗎?",
      "status": "visible",
      "pinned": false,
      "createdAt": "2026-05-26T12:00:00.000Z"
    }
  }
}
```

#### message_updated

```json
{
  "type": "message_updated",
  "payload": {
    "messageId": "message-id",
    "status": "hidden",
    "pinned": false
  }
}
```

#### error

```json
{
  "type": "error",
  "payload": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid message content."
  }
}
```

## 前端頁面規劃

### `/`

Participant 首頁。

功能:

1. 輸入 join code。
2. 輸入暱稱。
3. 加入 live session。
4. 若 localStorage 有可恢復的 participant token,可嘗試恢復。

### `/admin`

Admin 登入頁。

功能:

1. 輸入密碼。
2. 登入後導向 dashboard。

### `/admin/dashboard`

Event 管理頁。

功能:

1. 查看 event 列表。
2. 建立 event。
3. 編輯 event。
4. 刪除 event。
5. 啟動 live session。

### `/admin/event/:eventId`

Event 編輯頁。

功能:

1. 編輯 event 標題與描述。
2. 新增 activity。
3. 編輯 activity。
4. 刪除 activity。
5. 調整 activity 順序。

### `/admin/live/:liveId`

主持畫面。

功能:

1. 顯示 join code。
2. 顯示 participant 人數。
3. 顯示目前 activity。
4. 切換上一題、下一題。
5. 顯示或隱藏結果。
6. 查看回答數與統計。
7. 查看聊天室訊息。
8. 隱藏、刪除、釘選聊天室訊息。
9. 結束 live session。

### `/live/:liveId`

Participant 活動畫面。

功能:

1. 顯示目前 activity。
2. 提交答案。
3. 在 admin 開放時查看結果。
4. 查看公開聊天室訊息。
5. 發送聊天室訊息。
6. 斷線後自動重連。

## 技術決策

### 第一版採用

1. Bun
2. Hono
3. Vite
4. React
5. MySQL
6. WebSocket
7. Docker / docker-compose

### 第一版暫緩

1. Redis Pub/Sub。
2. 多 app instance。
3. xlsx 匯出。
4. PDF 處理。
5. AI 審查。

## 開發順序

### Phase 1: 專案骨架

1. 建立 Bun + Hono backend。
2. 建立 Vite + React frontend。
3. 建立 MySQL 連線。
4. 建立基本 Dockerfile 與 docker-compose.yml。

完成標準:

1. 本機可以啟動前後端。
2. Backend health check 可回應。
3. Frontend 可連到 backend。

### Phase 2: Auth 與 Event CRUD

1. 實作 admin login。
2. 實作 JWT middleware。
3. 實作 event CRUD。
4. 實作 dashboard。

完成標準:

1. Admin 可以登入。
2. Admin 可以建立、查看、編輯、刪除 event。

### Phase 3: Activity 編輯器

1. 實作 activities schema。
2. 實作 activity CRUD。
3. 支援選擇題、是非題、簡答題。
4. 支援 activity 排序。

完成標準:

1. Admin 可以在 event 內建立多題。
2. Admin 可以調整題目順序。

### Phase 4: Live Session 與 Join

1. 實作啟動 live session。
2. 實作 join code。
3. 實作 participant join。
4. 實作 participant token。

完成標準:

1. Admin 可以啟動活動並取得 join code。
2. Participant 可以輸入 join code 與暱稱加入。

### Phase 5: WebSocket 與作答

1. 實作 WebSocket 身分驗證。
2. 實作 state_change。
3. 實作 submit_answer。
4. 實作 response_summary_update。
5. 實作 participant_joined。

完成標準:

1. Admin 切題後 participant 畫面會同步更新。
2. Participant 作答後 admin 可以即時看到回答數與結果。

### Phase 6: 聊天室 / Q&A 訊息牆

1. 實作 live_messages schema。
2. 實作 send_message。
3. 實作 new_message。
4. 實作 message history API。
5. 實作 admin moderate_message。
6. 加入訊息長度限制、空白拒絕與 rate limit。

完成標準:

1. Participant 可以發送與查看公開訊息。
2. Admin 可以查看、隱藏、刪除、釘選訊息。
3. 被隱藏或刪除的訊息不會顯示在 participant 畫面。

### Phase 7: 斷線恢復

1. Participant token 存入 localStorage。
2. WebSocket 自動重連。
3. 重連後恢復目前 live session 狀態。
4. 重連後恢復已作答狀態與最近訊息。

完成標準:

1. Participant 重新整理後仍可回到目前活動。
2. 手機瀏覽器短暫斷線後可恢復。

### Phase 8: 收尾與驗收

1. 補基本錯誤處理。
2. 補 loading 與 empty state。
3. 補基本測試。
4. 整理 README。
5. 確認 Docker 啟動流程。

完成標準:

1. 可以從乾淨環境用 docker-compose 啟動。
2. 可以完整 demo 一場活動。

## 驗收情境

### 情境 1: 建立活動並作答

1. Admin 登入。
2. Admin 建立 event。
3. Admin 新增三題: 選擇題、是非題、簡答題。
4. Admin 啟動 live session。
5. Participant A 與 B 用 join code 加入。
6. Admin 切到第一題。
7. Participant A 與 B 作答。
8. Admin 看到回答數與統計。
9. Admin 顯示結果。
10. Participant A 與 B 看到結果。

### 情境 2: 聊天室管理

1. Participant A 發送問題。
2. Participant B 看到問題。
3. Admin 看到問題。
4. Admin 釘選該問題。
5. Participant A 與 B 看到釘選狀態。
6. Admin 隱藏該問題。
7. Participant A 與 B 不再看到該問題。
8. Admin 仍可在管理視角看到該問題。

### 情境 3: 斷線恢復

1. Participant A 加入活動。
2. Participant A 完成目前題目作答。
3. Participant A 重新整理頁面。
4. 系統使用 localStorage 內的 participant token 恢復身分。
5. Participant A 回到目前題目。
6. Participant A 仍顯示已作答狀態。
7. Participant A 可看到最近聊天室訊息。

## 第一版不做清單

為了確保 MVP 能完成,以下功能明確延後:

1. 文字雲。
2. 搶答。
3. 排序題。
4. PDF 上傳與教材穿插。
5. 詳解功能。
6. 排行榜。
7. 積分系統。
8. xlsx/json 匯出。
9. Redis Pub/Sub。
10. 多 admin 帳號。
11. 多主持人協作。
12. AI 內容審查。
13. 聊天室 upvote。
14. 聊天室 thread。
15. 圖片或檔案上傳。

## 風險與對策

| 風險 | 對策 |
|---|---|
| MVP 範圍過大 | 嚴格遵守不做清單,先完成完整主流程 |
| WebSocket 狀態與資料庫狀態不一致 | 重要操作以資料庫為準,WebSocket 只負責通知 |
| Participant 手機端斷線 | MVP 內建 token 恢復與自動重連 |
| 聊天室被洗版 | 字數限制、空白拒絕、rate limit、admin moderation |
| 題型資料格式混亂 | activity 使用 type + options_json + answer_json,先統一 contract |
| Docker 啟動流程複雜 | 第一版只包含 app 與 MySQL,Redis 延後 |

## MVP 完成定義

MVP 完成時,應該可以 demo 以下流程:

1. 使用 docker-compose 啟動系統。
2. Admin 登入。
3. Admin 建立 event 與三個 activity。
4. Admin 啟動 live session。
5. 兩位 participant 使用 join code 加入。
6. Admin 逐題切換。
7. Participant 即時作答。
8. Admin 即時看到回答數與結果。
9. Participant 在 admin 開放後看到結果。
10. Participant 發送聊天室訊息。
11. Admin 隱藏、刪除、釘選聊天室訊息。
12. Participant 重新整理後可恢復活動狀態。
13. Admin 結束 live session。
