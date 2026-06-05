# feat(scoring): 開放「0 秒＝不限時」並改為答對順序計分

## 摘要

延續 `commit_bill_0605.md` 的 Kahoot 式計分，這回調整**不限時題目**的規則。先前為了保住速度鑑別度，後端把 `timeLimitSeconds <= 0` 一律擋掉（「秒數必填」），但前端編輯器其實還留著「限時」拉桿（取消勾選會送 `0`），形成矛盾——拉桿關掉就存不了。

這次把矛盾收斂掉，並改掉「不限時答對就給滿分 1000」這種沒有鑑別度的做法：

1. **0 秒＝不限時，重新合法**：後端不再因 `<= 0` 丟錯。
2. **限時開著但秒數空白 → 前端 alert**：不再自動補 30 蓋過使用者意圖。
3. **不限時改為「答對順序計分」**：越早答對分數越高（限時題維持原速度公式）。
4. **CI 同步**：smoke 測試補上 0 秒案例；本文件記錄規則變更。

> 拉桿外觀不動，只改其行為與後端對 `0` 的解讀。

## 規則變更

### 計分公式（`src/server/store.ts` `computeScore`）

| 情境 | 計分 |
|------|------|
| 答錯（任何題型） | **0 分**（不變） |
| 答對・**限時**題（`limitSeconds > 0`） | `round(1000 × (1 − 耗時/時限 / 2))`：瞬答 ≈ 1000、用滿時限約 500（不變） |
| 答對・**不限時**題（`limitSeconds <= 0`） | **遞減固定分**：第 1 名答對 `1000`，之後每名 `−100`，保底 `100` |

- 新常數：`SCORE_STEP = 100`、`MIN_CORRECT_SCORE = 100`。
- `computeScore` 新增第 4 參數 `correctRank`（在答對者中的 1-based 名次）。

### 名次來源（`submitAnswer`）

- 只有「答對且不限時」才查名次：`COUNT(*)` 該題目前 `score > 0`（即已答對）且非本人的 response，`+1` 即為本次名次。
- 對不限時題，`score > 0 ⟺ 答對`，所以用 `score > 0` 當「已答對」代理判斷是安全的。
- 排除本人 `participant_id`，避免重複作答（`ON DUPLICATE KEY UPDATE`）把自己舊紀錄算進名次。
- 分數一樣是**作答當下鎖定**，不需事後重算；高併發下近乎同時送出可能名次相鄰，屬可接受誤差。

### 驗證放寬（`createActivity` / `updateActivity`）

- 移除 `if (timeLimitSeconds <= 0) throw "請設定作答秒數（需大於 0）。"`。
- `clampTimeLimit` 仍把負數/空值正規化為 `0`，`0` 代表不限時、合法寫入。

### 前端（`src/client/App.tsx`）

- 秒數輸入框：`value` 改為 `draft.timeLimitSeconds || ""`、`onChange` 不再 `|| 30` 自動補值，允許真正清空（顯示空白）。
- `saveActivity`：送出前若 `hasTimeLimit` 為真但秒數 `< 1` → `window.alert("請輸入作答秒數，或關閉「限時」改為不限時。")` 並中止。
- 「限時」拉桿外觀與既有開關邏輯不變（勾選自 0 起跳預設 30；取消送 0）。

## CI 變更

- `scripts/smoke.ts`：在既有「建立 30 秒題」之後新增 **step 4b**，以 `timeLimitSeconds: 0` 建立不限時題並斷言 `id` 存在、`timeLimitSeconds === 0`。這正是先前因「秒數必填」會被擋掉的路徑，現在必須通過。
- `.github/workflows/ci.yml` 不需改動（仍跑 typecheck / build / docker / e2e-smoke）。

## 公布答案 / 結束作答（不限時 vs 限時）

延伸不限時的設計，把「結束作答 + 公布答案 + 算分」的觸發點講清楚：

- **不限時題**：主持人按 **「公布答案」**。按下後 → 公布答案、顯示排行榜，並**鎖定該題作答**（禁止參與者繼續送答）。按鈕為**單向、一次性**：送出後立即變灰停用，不再是「顯示結果／隱藏結果」來回切換。
- **限時題**：**不再顯示**這顆按鈕。時間到（`timeExpired`）會自動公布答案並停止作答，主持人不需手動操作。

### 後端（`src/server/store.ts`）

- `submitAnswer` 新增**作答關閉硬擋**：
  - 該題已在 `completedActivityIds`（已被略過/已鎖定）→ 擋。
  - 限時題：`now − startedAt >= 時限` → 擋。
  - 不限時題：`liveSession.showResults` 為真 → 擋。
  - 觸發時丟 `「這一題已結束作答。」`。避免 client UI 之外的遲到/偽造 WS 訊息鑽進來。
- `setResultsVisibility`：當 `showResults=true` 時，把當前 `currentActivityId` 加入 `completedActivityIds`，使「公布即鎖定」為**終態**；再 toggle 回 false 也不會解鎖作答。

### 前端（`src/client/App.tsx`）

- 主持畫面：新增 `isTimedActivity`（`timeLimitSeconds > 0`）。「公布答案」按鈕在**限時題或文字雲**時 `hidden`；不限時題才出現。
- 按鈕改為**單向**：只送 `showResults: true`，`showResults` 為真後 `disabled`（變灰不可再按）；移除「顯示結果／隱藏結果」toggle 與舊的「倒數結束後才能公布」disable 條件。title 改為「公布答案並結束本題作答」。
- 參與者作答表單的 `disabled` 既有判斷（`closed` / `revealed` / `timeUp`）已能在公布後停用輸入，無需另改；後端硬擋為第二道防線。

## 影響範圍 / 檔案

- `src/server/store.ts`：`computeScore`（+常數/`correctRank`）、`submitAnswer`（名次查詢 + 作答關閉硬擋）、`createActivity`/`updateActivity`（移除 `<= 0` 擋擋）、`setResultsVisibility`（公布即鎖定）。
- `src/client/App.tsx`：秒數輸入框、`saveActivity` 空白守門、`isTimedActivity` 控制「公布答案」按鈕只在不限時題出現、按鈕改為單向一次性（按下變灰）。
- `scripts/smoke.ts`：新增不限時建立案例。
- 本文件。

## 驗證

- `bun run typecheck` ✅
- smoke 需在起好的 stack（mysql+redis+app）上跑：`BASE_URL=… ADMIN_PASSWORD=… bun scripts/smoke.ts`。
