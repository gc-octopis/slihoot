# chore: 系統面建置 — CI、Redis 地基、Docker 強化、健康檢查

## 摘要

這次提交不碰功能,專注在「系統/維運面」的基礎建設,讓專案能穩定部署到 GCP 自架 VM(Compute Engine + 自己的 Docker/MySQL/Redis,不使用 GCP 託管服務)。本回合完成整個系統面 backlog 的前兩塊:**① CI** 與 **② Redis 地基 + Docker 強化(含健康檢查)**。

部署目標規模:單實例、約 80 人同時連線。Redis 採**單一實例、不做 pub/sub**,定位為「最佳化層」(快取 / 速率限制 / 在線統計),並非硬性相依。

## 本回合完成項目

### ① CI(GitHub Actions)
- 新增 `.github/workflows/ci.yml`,PR 與 push 到 `main` 時觸發。
- `verify` job:`bun install --frozen-lockfile` → `bun run typecheck` → `bun run build`,保護全組功能不互相弄壞。
- `docker` job:用 buildx 驗證 Docker image 能成功 build(不 push),帶 GHA cache 加速。
- 加上 `concurrency` 設定,同一分支新 push 會取消舊的執行。

### ② Redis 地基
- 新增 `src/server/redis.ts`:使用 **Bun 內建 `RedisClient`(零新增依賴)**,封裝成「優雅降級」的工具函式 —— Redis 停用或連不上時,所有操作都會安全 fallback(cache 視為 miss、rate limit 放行、presence no-op),app 仍可僅靠 MySQL 運作。
  - `cacheGet / cacheSet / cacheDel`:供「快取 Live State」使用(下一回合接線)。
  - `rateLimitHit`:固定視窗計數器,供「速率限制」使用。
  - `presenceTouch / presenceCount / presenceRemove`:以 per-room sorted set(score = last-seen 時間戳)做「參與者在線/心跳」,讀取時順手剔除過期成員,免背景清理程序。
  - `redisPing`:供健康檢查使用。
- `src/server/env.ts`:新增 `env.redis = { url, enabled }`(以是否有 `REDIS_URL` 判定啟用)。
- `.env.example`:新增 `REDIS_URL`(留空即停用 Redis)。

### ② Docker 強化
- `Dockerfile` 改為**多階段建置**:build 階段裝全部依賴並 `bun run build`;runtime 階段(`oven/bun:1.3.11-slim`)只裝 `--production` 依賴 + 複製 `dist` 與 `src`,並以非 root 的 `bun` 使用者執行。
- 新增 `.dockerignore`(排除 `node_modules`、`dist`、`.git`、`.env`、`.progress` 等),縮小 build context、避免把 secret 帶進 image。
- `docker-compose.yml`:
  - 新增 `redis` service(`redis:7-alpine`),設定為**純快取角色**:`--save ""`、`--appendonly no`、`--maxmemory 256mb`、`allkeys-lru`;port 僅綁 `127.0.0.1`(不對外)。
  - `app` 注入 `REDIS_URL=redis://redis:6379`,並 `depends_on` redis healthy;新增 app 自身的 `/healthz` healthcheck。
  - 三個 service 都加上 `restart: unless-stopped`。
  - MySQL root/使用者密碼與 app 的 `DB_PASSWORD` 改為可由 `.env` 覆寫(預設值僅供開發)。

### ② 健康檢查
- `src/server/index.ts` 新增 `GET /healthz`:同時檢查 MySQL(`SELECT 1`)與 Redis(`PING`),回傳 `{ status, redisEnabled, checks }`。MySQL 為硬相依(失敗回 503),Redis 為選用(不影響 status)。

### ③ Redis 功能 A:快取 Live State(`src/server/store.ts`)
**動機**:`broadcastState`(index.ts)是**逐一 client** 呼叫 `getLiveState`,80 人房間單次廣播 = 80× `getLiveState`,而每個 `getLiveState` 內部又重複查 `listActivities`(2 次)、`getResponseSummary`、`getEvent`。答題爆量(80 人同時送)會把這放大成數百次重複 DB 查詢——這是真正的熱點。

**做法**:只快取「跨 viewer 共用、失效點清楚」的昂貴查詢,全部短 TTL + 寫入主動失效:
- `listActivities(eventId)`:TTL 10s。失效於 `createActivity / updateActivity / deleteActivity / reorderActivities`(`updateActivity`/`deleteActivity` 先取 `eventId` 再失效)。
- `getEvent(eventId)`:event 元資料 row 快取 TTL 10s,activities 仍走獨立快取。失效於 `updateEvent / deleteEvent`。
- `getResponseSummary(liveId, activity, flags)`:TTL 3s,key 含兩個輸出旗標。失效於 `submitAnswer`(以 `summaryKeysFor` 一次清掉 4 種旗標組合)。原運算邏輯抽成私有 `computeResponseSummary`,外層為快取 wrapper。

**刻意不快取**:`getLiveSession`(即時 UI 真實來源、單列 PK 查詢便宜、變動頻繁,快取風險 > 收益)、`getResponse / getParticipant`(per-participant)。

**降級保證**:Redis 沒開或連不上時,所有快取操作走 `redis.ts` 的 fallback(視為 miss / no-op),行為等同未加快取、直接查 MySQL。

**效果**:單次 80 人廣播中,`listActivities`(原 160 次)與 `getResponseSummary`(原 80 次)各收斂到約 1 次 DB 查詢,其餘命中 Redis。答題爆量時對 MySQL 的壓力大幅下降。實際數字待 ⑨ 負載測試量化。

### ④ Redis 功能 B:參與者在線/心跳
- `store.ts` `countParticipants` 改為**優先讀 Redis presence**(`presenceCount`),Redis 不可用時 fallback 回 MySQL 的累計加入數。
- 語意修正:原本 `countParticipants` 是「累計曾加入人數」(participants 列不會刪),現在是「**目前在線人數**」,更符合 live 場景。
- WS 生命週期(`index.ts`):連線時 `presenceTouch`,斷線(`onClose`/`onError` → 新 `handleDisconnect`)時 `presenceRemove` 並即時重播人數。
- 新增**伺服器端心跳**:每 30s 對所有連線中的參與者 `presenceTouch`,搭配 `PRESENCE_TTL_SECONDS=90`,讓在線集合反映實際連線,無需改 client。

### ⑤ Redis 功能 C:Rate limit
- 新增 `allowRateLimit(key, limit, windowSeconds)`(Redis 固定視窗,`rateLimitHit`;Redis 不可用時 fail-open 放行)。
- 套用點:`submit_answer`(每人 5s 內 10 次)、`send_message`(每人 2s 內 1 次)、`POST /api/live-sessions/join`(每 IP 60s 內 20 次,IP 由 `x-forwarded-for` 取得,適配 Caddy)。
- **移除**記憶體版 `messageRateLimits` Map(原 0528 的「Please wait...」殘留警告與此相關;伺服器端邏輯已換成 Redis)。

### ⑥ DB Migration 機制
- 新增 `migrations/0001_init.sql`(完整 baseline schema,所有 `CREATE TABLE IF NOT EXISTS`,對既有資料庫套用為安全 no-op)。
- 重寫 `db.ts`:檔案式版本化 runner,維護 `schema_migrations` 版本表,依檔名排序套用未執行的 `.sql`(去除 `--` 註解、以 `;` 切割)。移除原本手刻 `migrations` 陣列 + `addColumnIfMissing`。
- `Dockerfile` runtime 階段加 `COPY migrations ./migrations`(否則容器內讀不到)。
- 離線驗證:0001 正確切成 6 條 CREATE TABLE。

### ⑦ 可觀測性
- `index.ts` 加 `hono/logger` 請求記錄中介層(`/healthz` 已於 ② 完成)。
- `docker-compose.yml` 以 YAML anchor 對所有 service 套用 `json-file` log rotation(`max-size 10m`、`max-file 3`),避免 log 撐爆磁碟。

### ⑧ 部署自動化 + HTTPS(Caddy)
- 新增 `Caddyfile`:`reverse_proxy app:3000`,自動轉發 WebSocket(`/ws` → `wss://`);`DOMAIN` 設為真實網域即自動申請 Let's Encrypt 憑證,未設則 `:80` 純 HTTP(本機/測試用)。
- `docker-compose.yml` 新增 `caddy` service(80/443、`caddy-data`/`caddy-config` volume);**app port 改綁 `127.0.0.1:3000`**(不對公網直接暴露,由 Caddy 前置);MySQL/Redis 也僅綁 localhost。
- 新增 `scripts/startup.sh`:GCE startup-script,冪等地安裝 Docker + compose 並 `docker compose up -d --build`。
- `.env.example` 補 `MYSQL_ROOT_PASSWORD`、`DOMAIN`。

### ⑨ 負載測試
- 新增 `scripts/loadtest.ts`(`bun run loadtest`):模擬 N 個參與者加入同一場 live session、連 WS、對當前開放題目**同時送出答案**,量測 answer 延遲 p50/p95/max、throughput、錯誤數。
- 用 `BASE_URL` / `JOIN_CODE` / `COUNT`(預設 80)/ `ACTIVITY_ID` 設定。可用來比較「Redis 開 vs 關」對 ③ 快取效果的實際影響。
- 前提:server 已啟動、admin 已開始該題(否則送答案會被拒)。

## 動到的檔案
- 新增:`.github/workflows/ci.yml`、`.dockerignore`、`src/server/redis.ts`、`migrations/0001_init.sql`、`Caddyfile`、`scripts/startup.sh`、`scripts/loadtest.ts`
- 修改:`Dockerfile`、`docker-compose.yml`、`.env.example`、`package.json`、`src/server/env.ts`、`src/server/index.ts`、`src/server/store.ts`、`src/server/db.ts`

## 驗證
- `bun run typecheck`(`bunx tsc --noEmit`)通過 —— 含 Bun `RedisClient` 型別。
- `bun run build`(`bunx vite build`)通過。
- 尚未實際以 `docker compose up` 跑起整套(需在有 Docker 的環境),CI 的 `docker` job 會驗證 image build。

## 系統面 backlog 進度
- [x] ① CI(typecheck + build + docker build)
- [x] ② Redis 地基 + Docker 強化 + 健康檢查
- [x] ③ Redis 功能 A:快取 Live State(`store.ts`,共用昂貴查詢 + 寫入失效)
- [x] ④ Redis 功能 B:參與者在線/心跳(`presence*`,WS handler + 伺服器心跳)
- [x] ⑤ Redis 功能 C:Rate limit(join / 送答案 / 留言,已移除記憶體版)
- [x] ⑥ DB Migration 機制(檔案式版本化 runner + `schema_migrations`)
- [x] ⑦ 可觀測性(`hono/logger` + compose log rotation;`/healthz` 已完成)
- [x] ⑧ 部署自動化 + HTTPS(Caddy 反向代理、startup-script)
- [x] ⑨ 負載測試(`scripts/loadtest.ts`,模擬 N 個 WS client 同時答題)

> 不做:② 備份、(原清單)⑧ 測試基建 —— 依需求排除。
> **全部系統面 backlog 完成。**

## 追加(同日,實機驗證 + CD + 健壯度)

### 端到端驗證(實際 `docker compose up`)
- 整套 build + 起 mysql/redis/app 成功;`/healthz` 回 `200 {"status":"ok","redisEnabled":true,"checks":{"mysql":true,"redis":true}}`。
- Migration runner 實際套用並記錄 `0001_init.sql`(log:`applied migration 0001_init.sql`)。
- **80 人答題爆量負載測試**(`scripts/loadtest.ts`):80 人同時送答案,**0 錯誤**,延遲 p50/p95/max = 36/40/41 ms,burst 51 ms,~1567 answers/s。印證 e2-small/n4 機型綽綽有餘。

### 🐛 修正:join 限流誤傷同 NAT 觀眾
- 驗證時發現原本 join「每 IP 20/60s」會**卡死同一間教室共用 NAT 出口 IP 的真人**(80 人同 IP 直接被擋)。
- 改為可調的 `RATE_LIMIT_JOIN_PER_MIN`(預設 300/分),足夠整間教室、又能擋腳本狂刷。`env.ts` 新增 `rateLimit.joinPerMinute`。

### 健壯度:graceful shutdown
- `index.ts`:`SIGTERM`/`SIGINT` 時停收連線、關閉所有 WS(1001)、清 heartbeat/reveal timer、`server.stop(true)`、`pool.end()`、`closeRedis()`。
- `redis.ts` 新增 `closeRedis()`。
- 實測 `docker compose stop app`:log 顯示「shutting down gracefully → shutdown complete」,秒退(未觸發 10s 強殺)。

### CD 自動部署
- 新增 `.github/workflows/deploy.yml`:CI 在 main 綠燈後(`workflow_run`)經 SSH 上 VM 執行 `git pull --ff-only && docker compose up -d --build`。
- 需在 repo 設 secrets:`DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY`;選用變數 `DEPLOY_DIR`(預設 `/opt/slihoot`)。

### 追加動到的檔案
- 新增:`.github/workflows/deploy.yml`
- 修改:`src/server/index.ts`(graceful shutdown、join 限流可調)、`src/server/redis.ts`(`closeRedis`)、`src/server/env.ts`(`rateLimit`)

## 追加(README + GCP 部署 + 重開機自動重啟)

### README 重寫
- `README.MD` 全面更新:功能、架構圖、技術棧、**環境變數表**、本機開發、Docker 全套、維運(healthz/logs/migration/loadtest)、**GCP VM 逐步部署教學**、重開機自動重啟、CI/CD secrets 設定。

### GCP 部署教學(自架 Docker,不用託管服務)
- 步驟:建 VM(建議 n4-standard-2,Hyperdisk;e2-small 也夠)→ 防火牆只開 80/443/22 → 裝 Docker + clone 到 `/opt/slihoot` → 用 `openssl` 產生強密碼寫入 `.env` → `scripts/startup.sh` 起整套 → 設 DNS A record + `DOMAIN` 由 Caddy 自動 HTTPS → `/healthz` 驗證。

### 重開機自動重啟(本次重點需求)
- 新增 `deploy/slihoot.service`(systemd oneshot + `RemainAfterExit`):開機時 `docker compose up -d --build`,停機 `down`。`systemctl enable` 後重開機整套自動回來。
- 兩層機制:**systemd unit = 重開機恢復的主要保證(不依賴 Docker restart policy)**;`restart: unless-stopped` = VM 不重開時的當機自動拉回。
- ⚠️ **驗證限制**:本機沙箱 Docker(`Live Restore: false`)不執行 restart policy —— 實測 `docker kill` 後容器與對照容器都 `restarts=0` 不重啟。確認是**此 daemon 的行為**(compose 設定正確、policy 有掛上),正式 GCE VM 的標準 Docker Engine 會正常運作。因此 README 將 systemd 列為重開機恢復的主路徑。graceful shutdown 已實測通過。

## 注意事項 / 待辦
- ⑤ 上線後,記得移除 `index.ts` 既有的記憶體版 `messageRateLimits`(0528 文件記錄的「Please wait...」殘留警告 bug 可一併處理)。
- Redis 目前設計為「連不上就降級」;若日後要把它變成硬相依(例如真的要靠它擋流量),需另外加上連線重試與更明確的告警。
