# Commit 1 Progress

## 目標

依照 `.progress/MVP_PLAN.md` 完成 Slihoot 第一版 MVP 的可運作骨架。

本階段重點是先做出完整主流程:

1. Admin 可以登入與管理活動。
2. Admin 可以建立題目並啟動 live session。
3. Participant 可以用 join code 加入活動。
4. Admin 可以逐題主持、查看即時結果、結束活動。
5. Participant 可以作答、重連恢復、使用 Q&A 訊息牆。

## 已建立專案結構

新增 Bun + Hono + Vite + React 專案骨架:

| 檔案 / 目錄 | 說明 |
|---|---|
| `package.json` | Bun scripts 與 dependencies |
| `tsconfig.json` | TypeScript 設定 |
| `vite.config.ts` | Vite + React + dev proxy 設定 |
| `index.html` | 前端入口 |
| `src/server/` | 後端 API、WebSocket、資料層 |
| `src/client/` | React 前端 |
| `.env.example` | 環境變數範例 |
| `Dockerfile` | App container |
| `docker-compose.yml` | App + MySQL |
| `.gitignore` | 忽略 node_modules、dist、.env、暫存檔 |

## Backend 已實作

### Server

使用 Bun + Hono:

1. HTTP API。
2. WebSocket endpoint `/ws`。
3. 靜態服務 Vite build 後的 `dist`。
4. CORS 設定。
5. `/api/health` health check。

### Auth

已實作單一 admin 登入:

1. `POST /api/auth/login`
2. `GET /api/auth/me`
3. 使用 `ADMIN_PASSWORD` 驗證。
4. 登入後核發 JWT。
5. Admin API 與 admin WebSocket 操作需驗證 JWT。

### Database

使用 MySQL + `mysql2/promise`。

已建立 migration:

1. `events`
2. `activities`
3. `live_sessions`
4. `participants`
5. `responses`
6. `live_messages`

後續補上的欄位:

1. `live_sessions.show_participant_names`

已修正 migration 相容性:

1. 原本使用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`。
2. 目前改為先查 `information_schema.COLUMNS`。
3. 欄位不存在才執行一般 `ALTER TABLE ... ADD COLUMN`。
4. 避免 MySQL 版本不支援 `ADD COLUMN IF NOT EXISTS` 導致啟動失敗。

### Event / Activity API

已實作:

| API | 說明 |
|---|---|
| `GET /api/events` | 取得活動列表 |
| `POST /api/events` | 建立活動 |
| `GET /api/events/:eventId` | 取得單一活動與題目 |
| `PUT /api/events/:eventId` | 更新活動 |
| `DELETE /api/events/:eventId` | 刪除活動 |
| `POST /api/events/:eventId/activities` | 新增題目 |
| `PUT /api/activities/:activityId` | 更新題目 |
| `DELETE /api/activities/:activityId` | 刪除題目 |
| `PUT /api/events/:eventId/activities/reorder` | 調整題目順序 |

已支援題型:

1. 選擇題 `multiple_choice`
2. 是非題 `true_false`
3. 簡答題 `short_answer`

已支援正確答案:

1. 選擇題可儲存 `correctAnswer.optionId`。
2. 是非題可儲存 `correctAnswer.optionId`。
3. 簡答題目前不自動判分。

### Live Session API

已實作:

| API | 說明 |
|---|---|
| `POST /api/events/:eventId/live-sessions` | 啟動 live session |
| `GET /api/live-sessions/:liveId` | 取得主持用 live state |
| `POST /api/live-sessions/:liveId/end` | 結束 live session |
| `POST /api/live-sessions/join` | Participant 使用 join code 加入 |
| `GET /api/live-sessions/:liveId/messages` | 取得 Q&A 訊息 |

已修正:

1. `GET /api/events` 現在會回傳目前 active live session 摘要。
2. Dashboard 可以知道某個 event 是否已有進行中的 live session。
3. 若 event 已有 active live session,再次啟動會回傳既有 session,避免不小心建立多場造成統計分散。

### WebSocket

WebSocket endpoint:

```text
/ws
```

已實作 client to server event:

1. `submit_answer`
2. `change_activity`
3. `set_results_visibility`
4. `set_participant_name_visibility`
5. `send_message`
6. `moderate_message`

已實作 server to client event:

1. `state_change`
2. `participant_joined`
3. `response_summary_update`
4. `answer_recorded`
5. `new_message`
6. `message_updated`
7. `error`

### 作答與統計

已實作:

1. Participant 每題只能保留一筆回答。
2. 重送同一題會更新原回答。
3. 後端收到答案的時間作為正式 timestamp。
4. 選擇題 / 是非題會彙整票數與百分比。
5. 簡答題可回傳文字回答列表。
6. Admin 可看作答明細。
7. Admin 可切換是否記名顯示作答明細。
8. 選擇題 / 是非題可判斷答案是否正確。

已處理統計分散風險:

1. Dashboard 會顯示 active live session,降低 admin 重複開 session 的機率。
2. `startLiveSession` 會優先回傳該 event 既有 active session。
3. Activity options 現在在前端以 option object 編輯,保留 option id,避免單純用文字重建選項導致既有回答 optionId 對不上。

### Q&A 訊息牆

已實作:

1. Participant 發送訊息。
2. Participant 查看 visible 訊息。
3. Admin 查看 visible / hidden 訊息。
4. Admin 隱藏訊息。
5. Admin 顯示 hidden 訊息。
6. Admin 刪除訊息。
7. Admin 釘選 / 取消釘選訊息。
8. Participant 每 2 秒最多送 1 則訊息。
9. 訊息長度限制 200 字。
10. 空白訊息拒絕。

已修正:

1. deleted 訊息不再出現在 admin 訊息列表。
2. deleted 訊息不再提供「顯示」復原入口。
3. 後端也避免對 deleted 訊息做 show / pin / unpin。

## Frontend 已實作

### Participant

已實作頁面:

| 路徑 | 說明 |
|---|---|
| `/` | Join page |
| `/live/:liveId` | Participant live page |

功能:

1. 輸入 join code。
2. 輸入暱稱。
3. 加入 live session。
4. 儲存 participant token 到 localStorage。
5. 可回到上一場活動。
6. WebSocket 自動重連。
7. 顯示目前題目。
8. 選擇題 / 是非題作答。
9. 簡答題作答。
10. Admin 開放結果後可看統計。
11. 可看 Q&A 訊息。
12. 可發送 Q&A 訊息。
13. 現在會顯示自己的暱稱。

### Admin

已實作頁面:

| 路徑 | 說明 |
|---|---|
| `/admin` | Admin login |
| `/admin/dashboard` | Event dashboard |
| `/admin/event/:eventId` | Event editor |
| `/admin/live/:liveId` | Host live page |

Dashboard 功能:

1. 查看 event 列表。
2. 建立 event。
3. 編輯 event。
4. 刪除 event。
5. 啟動 live session。
6. 若 event 有進行中的 live session,顯示 join code、參與人數與狀態。
7. 可從 dashboard 回到主持畫面。
8. 可從 dashboard 結束 live session。

Event editor 功能:

1. 編輯 event 標題與描述。
2. 新增題目。
3. 編輯題目。
4. 刪除題目。
5. 上移 / 下移題目。
6. 選擇題可新增 / 移除選項。
7. 選擇題保留 option id。
8. 是非題固定選項為「是 / 否」。
9. 選擇題 / 是非題可設定正確答案。

Host live 功能:

1. 顯示 join code。
2. 顯示 participant 人數。
3. 顯示目前題目。
4. 上一題 / 下一題。
5. 顯示 / 隱藏結果。
6. 記名明細 / 匿名明細切換。
7. 顯示即時統計。
8. 顯示每位參與者作答明細。
9. 顯示答案是否正確。
10. 管理 Q&A 訊息。
11. 結束 live session。

## Docker / DevOps

已新增:

1. `Dockerfile`
2. `docker-compose.yml`
3. `.env.example`

Docker Compose 服務:

1. `app`
2. `mysql`

環境變數:

1. `PORT`
2. `ADMIN_PASSWORD`
3. `JWT_SECRET`
4. `DB_HOST`
5. `DB_PORT`
6. `DB_USER`
7. `DB_PASSWORD`
8. `DB_NAME`
9. `DB_AUTO_MIGRATE`

## 已執行過的驗證

先前已執行過:

1. `bun run typecheck`
2. `bun run build`
3. `docker compose config`
4. 後端 smoke test:
   - `/api/health`
   - 靜態首頁 HTML

最近一次依使用者要求,沒有重新執行測試或啟動服務。

## 已知限制

1. 尚未補自動化測試。
2. 尚未做完整端到端測試。
3. 尚未驗證 Docker full stack 實際啟動後的完整活動流程。
4. 目前仍是單機 WebSocket,尚未導入 Redis Pub/Sub。
5. 目前沒有多 admin 帳號。
6. 目前沒有 activity 匯入 / 匯出。
7. 目前沒有 response 匯出。
8. 簡答題沒有自動判分。
9. Participant 只能使用 localStorage token 做同瀏覽器恢復。
10. Q&A 刪除目前是 soft delete,資料仍保留在 DB,但 UI 與 API 列表不顯示。

## 下一步建議

1. 實際跑一次完整 demo:
   - Admin 建 event。
   - 建選擇題 / 是非題 / 簡答題。
   - 啟動 live session。
   - 兩個不同瀏覽器 participant 加入。
   - 分別作答。
   - 確認 admin 統計與明細。
   - 確認 Q&A 管理。
   - 確認 dashboard 可回到 active live session 並結束。
2. 補 backend store/API 測試。
3. 補 WebSocket 多 participant 測試。
4. 補 README 的功能截圖或 demo 操作流程。
5. 視需求加入 response export。
