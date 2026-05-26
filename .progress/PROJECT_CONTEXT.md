# Project Slihoot
https://github.com/gc-octopis/slihoot

## 專案介紹
* 開源的 Slido, Kahoot,以及更多功能的整合 Web App
* 目的是讓使用者能夠 self-host 自己的活動,確保資料安全,也不受價格限制功能或人數上限。

## 主要功能

### 來自 Slido
1. 搶答
2. 討論
3. 文字雲
4. 投票
5. 掃QRCode 參與

### 來自 Kahoot
1. 選擇題
2. 是非題
3. 簡答題
4. 排序題
5. 教材穿插(上傳PDF)

### 額外添加
1. 響鈴
2. 浮動在投影片上的即時問答
   * a. 聊天室形式
3. Docker 安裝
4. 詳解功能
5. 匯出資料(xlsx?json?)

## 使用技術
* Web App 開發: BVHR (Bun, Vite, Hono, React)
* 以Docker Deploy
* 即時連線: WebSocket
* 資料庫: MySQL
* Cache & Pub/Sub: Redis Pub/Sub

## 名詞定義

| 名詞 | 定義 |
|---|---|
| admin | live session 主持人 |
| event | 一組事件的資料,可新增/排序 activity、編輯題目、上傳教材等等 |
| live (live session) | 某個正在進行的事件,有主持畫面、參與者可以加入 |
| activity | 事件內的「活動」,如投票、文字雲、遊戲等 |
| participant | live session參與者 |
| response | 參與者作答紀錄 |

## 網頁/API端點

### 前端
| 路徑 | 說明 |
|---|---|
| `/` | 首頁(可輸入活動代號) |
| `/admin` | 主持人管理頁面(需要密碼) |
| `/admin/dashboard` | 所有事件管理頁面 |
| `/admin/event/{event_hash}` | 事件設定頁面(可編輯活動內容、題目) |
| `/admin/live/{live_id}` | 主持 live session 頁面 |
| `/{live_id}` | 進入活動頁面 |

### 後端/api/...
| 路徑 | HTTP 方法 | 說明 |
|---|---|---|
| `/auth/login` | POST | Admin登入,核發JWT Token |
| `/events` | GET/POST | 取得所有活動列表/建立新活動 |
| `/events/{id}` | PUT/DELETE | 修改或刪除特定活動設定 |
| `/events/{id}/export` | GET | 匯出該活動的歷史數據(xlsx/json) |
| `/live/start` | POST | admin啟動一個live session,生成join_code |
| `/live/join` | POST | 參與者輸入join_code與暱稱加入,核發participant token |

### 後端 wss://
| 傳輸方向 | 動作 | 說明 |
|---|---|---|
| Client to Server | `submit_answer` | 提交選擇題答案或文字雲輸入 |
| Client to Server | `send_message` | 在即時問答聊天室發送訊息 |
| Server to Client | `state_change` | 主持人切換下一題、顯示解答或結束活動 |
| Server to Client | `leaderboard_update` | 更新當前積分排行榜 |
| Server to Client | `new_message` | 聊天室有新問題浮動出現 |
| Server to Client | `participant_joined` | 更新當前房間人數 |
| Server to Client | `moderation_action` | 訊息被隱藏或刪除 |

## 進階考量
* **斷線重連機制**: 參與者如果用手機瀏覽器,螢幕暗掉再打開WebSocket會斷線。前端需實作自動重連,並透過Participant Token恢復當前狀態。
  * **Flow**:
    1. participant 加入 live session
    2. server 發 participant token
    3. frontend 存入 localStorage
    4. websocket disconnect
    5. frontend 自動 reconnect
    6. reconnect event 帶上 participant token
    7. backend 恢復 participant 狀態
* **內容審查**: 針對文字雲與聊天室,建議加入主持人的隱藏/刪除按鈕,防止參與者惡意洗版或發布不當內容
* **防作弊設計**: 紀錄答題Timestamp,由後端收到請求的當下為主,以計算搶答的分數與名次。

## 團隊分工與負責範圍

### 開發者A(怡臻): 前端架構與後台管理 (Frontend - Admin & API Integration)
* **核心技術**: React, Vite
* **負責範圍**:
  * 建置前端專案基礎架構(Routing 規劃、全域狀態管理、共用UI元件庫設計)。
  * 實作 `/` (首頁)以及所有 `/admin` 相關的靜態與管理頁面(Dashboard、Event 設定)。
  * 串接後端 HTTP API 端點,處理 Admin 登入、新增/編輯/刪除 Event、上傳 PDF 教材等業務邏輯。
* **重點挑戰**: 確保管理介面的流暢度與表單資料驗證,並妥善處理 JWT Token 的儲存與請求攔截 (Interceptor)。

### 開發者B(冠辰): 前端即時互動與參與者體驗 (Frontend - Live & WebSocket)
* **核心技術**: React, WebSocket Client
* **負責範圍**:
  * 實作 `/admin/live/{live_id}` (主持畫面)與 `/{live_id}` (參與者畫面)。
  * 開發各類 Activity 的互動 UI(搶答按鈕、選擇題/排序題介面、文字雲視覺化、浮動即時問答聊天室)。
  * 處理 Server to Client 的 `state_change`,控制畫面切換、動畫與響鈴等即時回饋。
* **重點挑戰**: 實作文件提到的「斷線重連機制」,透過 localStorage 存取 Participant Token 讓手機端使用者能在喚醒螢幕後無縫恢復當前狀態。

### 開發者C(冠瑜): 後端 API 業務與資料庫 (Backend - REST API & Database)
* **核心技術**: Bun, Hono, MySQL
* **負責範圍**:
  * 設計與建置 MySQL 資料庫綱要(Schema),包含Admin, Event, Activity, Participant, Response 等關聯表。
  * 實作所有的HTTP API 端點(`/auth/login`, `/events` 相關的CRUD操作)。
  * 實作匯出特定活動歷史數據的功能(`/events/{id}/export`,轉出 Excel 或 JSON)。
* **重點挑戰**: 確保關聯式資料庫的查詢效率與資料一致性,以及處理密碼加密與 JWT 核發邏輯。

### 開發者D(Bill): 後端即時通訊與基礎設施 (Backend - Real-time & Infrastructure)
* **核心技術**: Bun, Hono WebSocket, Redis Pub/Sub, Docker
* **負責範圍**:
  * 建立 WebSocket Server,處理所有的即時事件(接收 `submit_answer`, `send_message`並廣播更新)。
  * 整合 Redis Pub/Sub 確保多人連線與分散式環境下(若未來擴充)的狀態同步與快取。
  * 實作內容審查機制(處理 `moderation_action`)與防作弊機制(精準紀錄後端收到請求的 Timestamp 來計算搶答分數與名次)。
* **重點挑戰**: WebSocket 的連線生命週期管理(房間人數統計),以及最後負責撰寫 Dockerfile 與 `docker-compose.yml` 將整套 BVHR 架構打包部署。