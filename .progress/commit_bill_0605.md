# feat: Kahoot 式計分 + 即時排行榜、修復「開始答題沒反應」、確認詳解 UI

## 摘要

這次提交聚焦在**功能面**，補上原始願景（PROJECT_CONTEXT）裡的計分與排行榜，並修掉一個上線版回報的互動 bug。三件事：

1. **修復「開始答題沒反應」** —— WebSocket 短暫斷線時主持端按鈕靜默失效的 UX bug。
2. **Kahoot 式計分** —— 答對才得分，且越快分數越高。
3. **即時排行榜** —— 主持端與參與者端都顯示累計分數排名。

部署模型不變：單實例、MySQL 為真實來源、Redis 為最佳化層（計分排行榜比照既有 summary 快取模式，不增加 N+1 壓力）。

## 本回合完成項目

### ① 修復「開始答題沒反應」（互動 bug）

**根因**：`useLiveSocket` 的 `send` 在 WebSocket 尚未 `OPEN` 時會靜默 `return false`（`src/client/App.tsx`），按鈕點了等於沒送出、畫面毫無回饋。手機/瀏覽器短暫斷線後，前端 1.2s 自動重連，重連後才又能按——對應使用者描述的「突然又可以按了」。

**做法**：主持畫面所有依賴 WebSocket 的按鈕（開始答題／上一題／下一題／顯示結果／記名明細）在 `!socket.connected` 時 `disabled`，並在 button-row 下方顯示「連線中，請稍候再操作…」。讓「不能操作」這件事變可見，不再無聲無息。`結束` 走 REST API 不受影響。

> 註：若上線版真實原因是 Caddy 沒轉發 `/ws`（連線燈會一直紅），此改動只讓原因「看得見」，不會自動修好代理；需另查 wss/Caddy。但依回報（會自行恢復）即為斷線重連時間差，已對症。

### ② Kahoot 式計分

- **Schema**：新增 `migrations/0002_response_score.sql`，為 `responses` 加上 `score INT NOT NULL DEFAULT 0`。檔案式 runner 會自動套用並記入 `schema_migrations`，對既有資料庫安全（只補欄位、跑一次）。
- **公式**（`src/server/store.ts` `computeScore`）：
  - 答錯 → 0 分。
  - 答對 → `round(1000 × (1 − (作答耗時 / 題目時限) / 2))`：瞬答 ≈ 1000，用滿時限仍得約 500。
  - 無時限題（`timeLimitSeconds <= 0`）答對 → 滿分 1000。
- **判定正確**（`isAnswerCorrect`）：沿用 summary 的正規化邏輯——選擇/是非比對 `correctAnswer.optionId`、簡答比對 `correctAnswer.text`、文字雲不計分；未設正確答案者一律 0 分。
- **鎖定時機**：分數在 `submitAnswer` 當下算好寫入該 response row。作答耗時 = `receivedAt − liveSession.currentActivityStartedAt`。重複作答（ON DUPLICATE）會以新 `receivedAt` 重算 `score`。

### ③ 即時排行榜（主持端 + 參與者端）

- **後端**（`src/server/store.ts`）：
  - 新增 `getLeaderboard(liveId)`：單一 `SUM(score)` group by participants（`LEFT JOIN responses`，含 0 分未作答者），依分數→作答數→加入時間排序，回傳含 `rank` 的清單。
  - 比照 summary 做 **3 秒短 TTL Redis 快取**（`cache:leaderboard:<liveId>`），並於 `submitAnswer` 連同 summary 一起失效（`cacheDel`）。避免 80 人廣播時每 client 一次 leaderboard 查詢的 N+1。
  - `getLiveState` 帶上 `leaderboard`（Top 10）、以及 participant 視角的 `myScore` / `myRank`。
  - `LiveState`、新增 `LeaderboardEntry` 型別（`src/server/types.ts`）。
- **前端**（`src/client/App.tsx`、`src/client/styles.css`）：
  - 新增 `Leaderboard` 元件（名次／暱稱／分數，自己那列高亮）。
  - **主持畫面**：即時結果下方常駐排行榜。
  - **參與者畫面**：公布答案後（`revealed`）顯示「你的分數 X 分 · 第 N 名」橫幅 + 排行榜。
- **更新時機**：排行榜資料隨 `broadcastState`（開始題目／切題／公布／時間到／加入／結束）一起送達，符合 Kahoot「每題公布後刷新排名」的節奏。

## 動到的檔案

- 新增：`migrations/0002_response_score.sql`
- 修改：`src/server/types.ts`（`LeaderboardEntry` + `LiveState` 三個欄位）、`src/server/store.ts`（計分常數/公式、`isAnswerCorrect`、`submitAnswer` 寫入 score、`getLeaderboard`、`getLiveState` 帶 leaderboard）、`src/client/App.tsx`（`Leaderboard` 元件、兩頁渲染、斷線 disable 按鈕）、`src/client/styles.css`（leaderboard / my-score 樣式）

## 驗證

- `bun run typecheck`（`bunx tsc --noEmit`）通過。
- `bun run build`（`bunx vite build`）通過。
- **完整 docker stack 實機驗證**：`docker compose up -d --build mysql redis app`，`/healthz` 回 `{"status":"ok","redis":true}`；log 顯示 `applied migration 0002_response_score.sql`；`SHOW COLUMNS FROM responses` 確認 `score` 欄位存在。
- `bun run smoke`（join → start → submit）通過 —— 連帶驗證新版 `getLiveState`（含 leaderboard 查詢）不會 crash。
- **計分端到端實測**（臨時腳本，驗後刪除）：限時 30s 選擇題、設正確答案、參與者瞬答答對 → 排行榜 `score=986, rank=1`，`answers=1`，符合公式（耗時 ≈0.87s）。

## 功能面 backlog 進度（更新）

- [x] 計分系統（Kahoot 式：答對 + 速度）
- [x] 即時排行榜（主持 + 參與者）
- [x] 詳解 UI（確認原已具備）
- [x] 排序題（ranking）
- [x] 匯出資料（JSON / CSV，`/api/events/:id/export`）
- [ ] 教材穿插 / PDF 上傳（其他人進行中）
- [ ] 多管理者帳號 / 角色權限（暫不需要）
- [ ] 響鈴 / 音效（留給其他人）

## 注意事項

- 計分依賴題目「有設正確答案 + 有時間限制」才有鑑別度；無時限題答對給滿分（速度不計）。
- 排行榜暱稱固定顯示（Kahoot 性質），不受「記名/匿名明細」開關影響——該開關只管每題回答明細表。
- 尚未 commit；working tree 為上述修改 + 一個新 migration。

---

## 追加：排序題（ranking）+ 匯出資料

### ⑤ 排序題（ranking）

新題型「排序題」：主持人輸入一組項目並以「由上到下」決定正確順序；參與者看到的是**打散後**的項目，拖動（上/下移）排成自己的答案；完全符合正確順序才算對，計分沿用既有 Kahoot 時間公式。

- **資料模型**：沿用既有 `activities` 結構，不需 migration。`options` = 項目清單（含 id），`correctAnswer = { order: [optionId...] }`。
- **後端**（`src/server/store.ts`、`src/server/types.ts`）：
  - `ActivityType` 新增 `"ranking"`；`activityTypes` 同步。
  - `normalizeCorrectAnswer`：ranking 的正確答案**由項目輸入順序自動推導**（`options.map(o => o.id)`），主持人不需另填；create/update 的「至少兩個項目」守則套用到 ranking。
  - `publicActivity`：ranking 在公布前以**穩定的種子洗牌**（`seededShuffle`，seed = activity.id，xfnv1a→mulberry32→Fisher-Yates）打散項目並抹除 `correctAnswer`/`explanation`，避免項目順序本身洩漏答案，且不會每次廣播都跳動。
  - `validateAnswer`：ranking 要求 `order` 為所有 option id 的**排列**（不重不漏）。
  - `isAnswerCorrect`：ranking 比對整段順序相等。
  - `computeResponseSummary`：ranking 分支輸出 `correctAnswerText`（正確順序字串）、`correctCount`、每位參與者的順序字串 + 對錯。
  - 計分：作答時 `isAnswerCorrect` 已支援 ranking → 既有 `computeScore` 直接生效。
- **前端**（`src/client/App.tsx`、`src/client/styles.css`）：
  - 題型下拉新增「排序題」；新增**排序項目編輯器**（上/下移定義正確順序、新增/移除/改名），題目卡片以編號顯示順序。
  - `AnswerForm` 新增 ranking 分支：上/下移排序、送出 `{ order }`，公布後顯示正確順序；新增 `submittedOrder` prop 讓斷線重連可恢復已送出的順序。
  - `SummaryView` 的 short_answer 分支擴充為同時處理 ranking（顯示「正確順序」+ 每人順序與對錯）。
  - `correctAnswerOrder` 前端輔助函式；`.ranking-list` / `.ranking-item` 樣式。

### ⑥ 匯出資料（JSON / CSV）

`GET /api/events/:eventId/export?format=json|csv`（admin），匯出該 event **跨所有場次**的完整作答歷史。**零新增依賴**（不引入 xlsx 套件；CSV 帶 UTF-8 BOM，Excel 可正確開啟中文）。

- **後端**（`src/server/store.ts`、`src/server/index.ts`）：
  - `exportEventData(eventId)`：彙整 event 基本資料、所有 activities（含正確答案）、所有 live sessions、以及每一筆 response（join code、第幾題、題目、暱稱、可讀答案、對錯、分數、時間）。`answerToText` 把各題型答案轉成可讀字串（選項標籤 / 文字 / 文字雲合併 / ranking 以「→」串接）。對錯以 `score > 0` 判定。
  - 路由依 `format` 回 JSON 或 CSV，`Content-Disposition` 走附件下載。**修掉一個 bug**：檔名含中文會讓 HTTP header 非法（`TypeError: Header has invalid value`）——改為 ASCII-safe `filename` + RFC 5987 `filename*=UTF-8''…` 雙寫，瀏覽器取得友善中文檔名、header 仍合法。
  - `exportToCsv`：一列一筆作答，欄位含 `join_code, question_number, activity_title, activity_type, participant, answer, correct, score, received_at`；值含逗號/引號/換行時正確跳脫。
- **前端**（`src/client/App.tsx`）：事件編輯頁新增「匯出 CSV / 匯出 JSON」按鈕；因 GET 需帶 admin token，以 `fetch` + Authorization header 取得 blob 後觸發下載（不能用單純 `<a href>`）。

### 動到的檔案（追加）

- 修改：`src/server/types.ts`（`ActivityType` 加 ranking、`EventExport` 介面）、`src/server/store.ts`（ranking 全套 + `seededShuffle` + `answerToText` + `exportEventData`）、`src/server/index.ts`（export 路由 + `exportToCsv` + 匯入 `exportEventData`）、`src/client/App.tsx`（ranking 編輯器/作答/結果、`correctAnswerOrder`、匯出按鈕與 `downloadExport`）、`src/client/styles.css`（ranking 樣式）

### 驗證（追加）

- `bun run typecheck`、`bun run build` 通過。
- 重建 docker app 容器後實機驗證（臨時腳本，驗後刪除）：
  - 排序題：正確順序由項目順序推導 ✓；參與者看到的項目被打散且 `correctAnswer` 為 null（答案隱藏）✓；送出正確順序得分 986、rank 1 ✓。
  - 匯出：JSON 含該筆 response，Bob 的答案為 `"A → B → C"`、`correct=true`、`score=986` ✓；CSV 有表頭與排序答案、`Content-Type: text/csv` ✓。
- `bun run smoke` 仍通過（無回歸）。

---

## 追加修訂：拖曳排序 + xlsx 匯出

依需求調整兩點：排序改用**拖曳**（不要上下箭頭）、匯出補上 **xlsx**（json 保留、csv 仍提供）。

### 排序題改為拖曳

- 新增通用 `SortableList` 元件（`src/client/App.tsx`）：以 **Pointer Events** 實作，滑鼠與**手機觸控**皆可拖曳；受控元件，拖放後以 `onReorder(orderedIds)` 回拋新順序。拖曳中項目移到指標 Y 通過的目標位置即時換位（依各方塊 bounding rect 中線判定），並用 `setPointerCapture` 確保移出元素仍持續追蹤。項目方塊 `touch-action: none` 避免觸控時頁面捲動搶走手勢。
- 取代了原本主持端編輯器與參與者作答的「↑/↓ 按鈕」。
  - **編輯器**：整個方塊可拖；方塊內的 label `input` 與「移除」按鈕在 `pointerdown` 時 `stopPropagation`，避免點輸入框/按鈕誤觸發拖曳。
  - **參與者作答**：整個方塊可拖（純標籤、無內嵌輸入），鎖定後 `disabled` 不可拖。
- 樣式：移除 `.ranking-*`，改用 `.sortable-list` / `.sortable-item`（含 `.dragging` 抬升陰影、`.drag-handle` 握把 ⠿）。

### 匯出補 xlsx

- 新增相依 **`xlsx`（SheetJS 0.18.5）**，僅由 `src/server/index.ts` 在伺服器端使用（不影響前端 bundle）。
- `exportToXlsx(data)`：產生雙工作表活頁簿 —— **「作答紀錄」**（中文表頭：場次代碼/題號/題目/題型/參與者/答案/答對/分數/作答時間，一列一筆）＋ **「題目」**（題號/題目/題型/秒數）。
- 匯出路由新增 `format=xlsx` 分支，回 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`，沿用同一套 ASCII + RFC 5987 檔名。
- 前端事件編輯頁按鈕改為 **匯出 Excel（主）／JSON／CSV**。

### 驗證（追加修訂）

- `bun run typecheck`、`bun run build` 通過。
- 重建 docker app（含 xlsx 相依）後實測 xlsx 匯出：HTTP 200、正確 content-type、檔案為合法 zip（`PK` 開頭）、含「作答紀錄」「題目」兩工作表；排序題作答列為「甲 → 乙」、答對=是、分數 990。`Content-Disposition` 以 `filename*` 帶中文檔名。
- 拖曳為前端互動，typecheck/build 通過；建議在瀏覽器（含手機）實際操作確認手感。

### 追加修訂 2：排序題視覺打磨

依需求再調整排序題的觀感：

- **方塊更立體浮動**：`.sortable-item` 加上雙層陰影、hover 抬升、圓角加大；拖曳中 `scale(1.04)` + 強化陰影 + 提高 `z-index`，並對 `box-shadow/transform` 做 transition，抓起放下都有浮起感。
- **拖曳絲滑（FLIP 動畫）**：`SortableList` 以 `useLayoutEffect` 記錄前一幀各方塊位置，重排後對**非拖曳中的方塊**用 Web Animations API 從舊位置滑到新位置（180ms ease），交換時平滑滑動而非瞬間跳位；拖曳中的方塊保持即時跟手不加動畫。尊重 `prefers-reduced-motion`。
- **公布結果改方塊呈現**：`ResponseSummary` 新增 `correctOrderLabels`（後端 `computeResponseSummary` 帶出正確順序的標籤陣列）；`SummaryView` 的 ranking 從共用 short_answer 文字版**獨立出來**，正確順序以一疊 `.result-order-item` 色塊（編號＋標籤）呈現，標題顯示「答對 X / Y 人」。
- **移除多餘的灰底「正確順序」**：參與者 `AnswerForm` ranking 在公布後的 `answer-reveal` 區塊刪除（下方結果面板已用方塊呈現正確順序），連帶移除未使用的 `correctAnswerOrder` 前端輔助函式。
- 驗證：重建容器後確認 ranking 的 `responseSummary.correctOrderLabels` 正確帶出（如 `["第一","第二","第三"]`、答對 1/1）；`typecheck`/`build` 通過。

### 追加修訂 3：拖曳手感修正 + 匯出位置調整

- **編輯器打字/新增選項時跳動** → 修正。根因是 FLIP 動畫之前**每次 render 都跑**（打字、新增選項都會 render 而誤觸發）。改為以「項目 id 序列」當 key，**只在順序真的改變時才播動畫**；取消殘留動畫的清理也只在真正重排時做，不干擾打字/hover 當下的 CSS transition。
- **動畫太過火** → 降低強度。拖曳放大 `1.04 → 1.02`、陰影大幅減輕、移除 hover 抬升、transition `0.18s → 0.12s`、重排滑動 `180ms → 130ms ease-out`。
- **往下拖出現殘影** → 修正。根因是 `handlePointerMove` 讀**即時 DOM 位置**判斷插入點，會掃到「被放大的拖曳方塊」與「正在 FLIP 滑動的鄰居」，下拖時時序剛好誤判而殘影。改為**拖曳開始時擷取各槽位固定中線**（`slotMidpointsRef`），之後只比對指標 Y 與這組不變的中線決定目標索引；上下拖對稱、不再讀動畫中的位置。
- **匯出按鈕移到主持畫面**：依需求把「匯出 Excel / JSON / CSV」從活動編輯頁移到主持畫面（排行榜下方），eventId 取自當前 live session 的 `state.event.id`，主持當下即可匯出。

### 動到的檔案（總計，本日）

- 新增：`migrations/0002_response_score.sql`、`.progress/commit_bill_0605.md`
- 修改：`src/server/types.ts`、`src/server/store.ts`、`src/server/index.ts`、`src/client/App.tsx`、`src/client/styles.css`、`package.json` / `bun.lock`（新增 `xlsx` 相依，僅伺服器端使用）

### GCP 可運行性

- `xlsx` 列於 `dependencies`，Dockerfile runtime 階段 `bun install --production` 會安裝；與 CI build、`deploy.yml` 部署到 GCE VM 走同一份 Dockerfile。
- 已實際 `docker compose up -d --build` 重建容器並在容器內驗證 xlsx 匯出、排序題、計分、smoke 全數通過 —— 即與 GCP 部署相同的 image。
- migration `0002` 於開機 `DB_AUTO_MIGRATE` 自動套用（已實測 `applied migration 0002_response_score.sql`）。

### 追加修訂 4：排序編號跟著選項、結果同款編號、秒數必填

承前一次 commit 之後再依需求調整（這批為第二次 commit 內容）：

- **排序方塊編號「跟著選項」**：`SortableList` 左側編號改為**依選項首次出現順序給的固定編號**（存於 `numberByIdRef`，以選項 id 為 key），拖曳重排時編號跟著方塊走（原本 1,2,3,4,5 拖成 1,3,2,4,5 就顯示 1,3,2,4,5），不再每次依位置重編。切換題目（id 整組更換）時自動重置。
- **公布結果用同款固定編號**：`ResponseSummary` 的 ranking 由 `correctOrderLabels: string[]` 改為 `correctOrder: { number, label }[]`。`number` 由**與發給參與者相同的 `seededShuffle`（呈現順序）**算出，因此結果區方塊掛的編號＝參與者作答時看到/拖曳的編號（實測：呈現順序 `[A,C,B,D,E]` → 正確順序 `A,B,C,D,E` 顯示編號 `1,3,2,4,5`，與參與者端一致）。主持端逐人明細的順序字串也改用此固定編號。
- **關閉「0 秒＝不限時」**：無時限會讓 Kahoot 計分失去速度鑑別度。`createActivity`/`updateActivity` 在 `timeLimitSeconds <= 0` 時丟錯「請設定作答秒數（需大於 0）。」，所有題型一律必填秒數；client `saveActivity` 既有 catch 會 `window.alert` 顯示。
- **修正秒數輸入框卡 0**：編輯器秒數欄改 `min={1}` + placeholder「例如 30」，值為 0 時顯示空字串而非 `0`，清空欄位不再卡一個 0、重打也不會出現前導 `05`。標籤改「作答秒數（必填，需大於 0）」。
- 驗證：`typecheck`/`build` 通過；重建容器後實測 0 秒/未填秒數回 `400 請設定作答秒數`、秒數=20 成功；結果固定編號與參與者呈現順序一致（`MATCH: true`）。
