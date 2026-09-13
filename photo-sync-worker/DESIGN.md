# FranVision Photo Sync Worker — 设计文档

> 状态：**待批准**。批准后按本文实现。
> 分支：`photo-sync-worker`（从 `job-generator-updates` 切出）。

## 1. 目标

一个独立的 Cloudflare Worker，把 Dropbox 里 job 文件夹内的成品照片，自动同步一份
**压缩缩略图**到 Supabase，供 Gallery 和 Feature Sheet Builder 共用展示。

- 缩略图是**展示缓存 + 索引**，不承担存档职责。
- 原图高清件永远留在 Dropbox；每条照片记录存 `dropboxFileId` 指回原图，供以后打印级 PDF 使用。
- Supabase Storage 即使被清空也无数据丢失 —— 重跑 backfill 即可从 Dropbox 全部重建。

## 2. 讨论已确定的决策

| # | 决策 |
|---|---|
| 缩略图生成 | 用 **Dropbox 缩略图 API**（`get_thumbnail_batch`），Worker 零图片计算。长边 ≤1024px JPEG。 |
| Cloudflare plan | **Workers 付费版 $5/月 + Queues**（一次 job 可能 150+ 张、8-9 job/天并发，免费版 50 子请求/次不够；Queues 提供逐张重试/自动分批/限流）。 |
| Dropbox app 范围 | **Full Dropbox**。job 文件夹建在 Dropbox 根目录下。 |
| 扫描起点 | 监听根目录 + 靠 `jobId` 标签过滤；做成环境变量 `DROPBOX_JOBS_ROOT`（默认空=根），以后收进统一父文件夹时改配置即可。 |
| 回填 | 手动触发接口 `POST /admin/backfill`（带 `ADMIN_TOKEN`），可全量或单 job。**不自动跑**。v1 只处理上线后的新变化，旧 job 等以后做数据迁移。 |
| 并发安全 | 加 Postgres 原子函数 `photos_upsert` / `photos_mark_pending`，避免多批次并发 + Feature Sheet Builder 同时写 `projects.data` 互相覆盖丢照片。 |
| 同步文件夹 | `SYNC_FOLDERS = MLS, HDR Photos, Virtual Staging, Floorplan, Local Report`（及其子目录里的 `.jpg/.jpeg/.png/.webp`）。非图片（PDF/文档）自动跳过。`Home Report` 不同步（它是房屋详情报告，Local Report 是周边配套报告，两个不同目录）。`MLS` 和 `HDR Photos` 都列进去是因为 job-generator 在 2026-09-12 把这个固定文件夹从 `MLS` 改名成了 `HDR Photos`（纯改名，行为不变）——2026-09-12 之前建的 job 文件夹下还是叫 `MLS`，两个名字都得同步才不会漏掉旧 job。 |
| Video / VLOG | **v1 不碰**。Dropbox 视频直链在 Wix 里播放不可靠（预览页非裸文件、流量限制、Range 支持差）。等定了视频托管（Vimeo / YouTube）再做独立小后续。 |
| MLS 可下载交付图集（方案二 A-lite） | 展示与交付**两条压缩管线**：① Supabase/Gallery 用 `w1024h768`（`THUMB_SIZE`）；② Dropbox `MLS for download/` 交付集用 `w2048h1536`（`DOWNLOAD_THUMB_SIZE`，Dropbox 最大档，3:2 横幅 → 2048×1365，~0.4–0.9MB）。都由 Dropbox 缩略图 API 生成，Worker 不做图像计算。只有 `MLS` 有交付镜像。原图被删 → 镜像副本**一并硬删**（纯派生物，可重建），Supabase 记录照常置 `pending_review`。批量端点若不接受 `w2048h1536`，逐张回退 `get_thumbnail_v2`。 |

Property Template：名字 `FranVision Job`，`template_id = ptid:R599LCPosWEAAAAAAAAIFA`，字段 `jobId`（字符串）。

## 3. Supabase（复用 Feature Sheet Builder 的项目）

复用现有 `projects` 表和 `photos` bucket，路径规则不变：
- 缩略图：`photos/<jobId>/<photoId>_thumb.jpg`

### 3.1 `data.photos[]` 每条记录（本 Worker 写入的字段）

```jsonc
{
  "photoId":       "…",              // = base64url(sha256(jobId + '/' + 相对路径)).slice(0,22)，路径派生、稳定
  "filename":      "DSC_0001.jpg",
  "width":         6000,             // 原图尺寸，取自 Dropbox media_info；拿不到则 null
  "height":        4000,
  "hasThumb":      true,
  "dropboxFileId": "id:aBcD…",       // 新增字段，关联 Dropbox 原图高清件
  "dropboxPath":   "/2026… _Smith/MLS/DSC_0001.jpg",
  "dropboxRev":    "0123…",
  "folder":        "MLS",            // 顶层 job 文件夹下的直接子目录名
  "status":        "ok",             // "ok" | "pending_review"
  "downloadDropboxPath": "/2026… _Smith/MLS for download/DSC_0001.jpg",  // 仅 MLS：压缩交付副本；其他文件夹无此字段
  "syncedAt":      "2026-09-07T…Z"
}
```

**合并写，不整条覆盖**：`role`、排序等 Feature Sheet Builder 自己加的字段原样保留，Worker 只覆盖上面这几个 key。

### 3.2 新增数据库对象（`supabase/schema.sql`，在 Supabase SQL 编辑器跑一次）

1. **`public.photo_sync_state`** — 单行表，存 Dropbox delta cursor + 租约锁（`cursor`, `locked_until`, `last_run_at`）。仅 service role 访问。
2. **`public.photos_upsert(p_project_id text, p_photo jsonb)`** — 原子 upsert：
   - `projects` 行不存在则建空行（`data = {"photos": []}`）。
   - 行级 `SELECT … FOR UPDATE` 串行化同一 job 的并发写。
   - 按 `photoId` 找现有项：存在则 `existing || p_photo` 浅合并（Worker 字段覆盖，FSB 字段保留）；不存在则追加。
   - **自愈**：现有项 `status` 为 `pending_review`、且新记录带不同 `dropboxFileId` → 置回 `ok`（浅合并自动完成）。
3. **`public.photos_mark_pending(p_project_id text, p_photo_id text)`** — 把某条照片 `status` 置 `pending_review`，其余不动；不删行、不删缩略图。

## 4. Cloudflare 资源

- **1 个 Worker**：`franvision-photo-sync`（独立于 FSB 那个 `franvision` assets Worker）。
- **1 个 Queue**：`photo-sync-jobs`（生产者+消费者绑定在同一 Worker），外加死信队列 `photo-sync-dlq`。
- **Cron**：`*/2 * * * *` —— 每 2 分钟对账一次，兜底丢失的 webhook。
- **Secrets**（`wrangler secret put`，代码里只按名引用）：
  `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` /
  `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `ADMIN_TOKEN`
- **Vars**（`wrangler.jsonc`，非机密）：
  `DROPBOX_JOBS_ROOT=""` / `SYNC_FOLDERS="MLS,HDR Photos,Virtual Staging,Floorplan,Local Report"` /
  `THUMB_SIZE="w1024h768"` / `DOWNLOAD_THUMB_SIZE="w2048h1536"` /
  `DROPBOX_TEMPLATE_ID="ptid:R599LCPosWEAAAAAAAAIFA"` /
  `DOWNLOAD_SET_FOLDERS="MLS,HDR Photos"` / `DOWNLOAD_SUBFOLDER="MLS for download"`

Webhook 验证用 `DROPBOX_APP_SECRET` 对请求体做 HMAC-SHA256，比对 `X-Dropbox-Signature`。

## 5. HTTP 端点（`fetch` handler）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/webhook?challenge=…` | Dropbox 验证握手，原样返回 `challenge`（`text/plain`）。 |
| POST | `/webhook` | 校验签名 → 往 Queue 塞一条 `{type:"delta"}` → 立刻回 200。不内联处理。 |
| POST | `/admin/backfill` | `Authorization: Bearer <ADMIN_TOKEN>`。body `{jobId?}`。入队 `{type:"backfill", jobId?}`。 |
| GET | `/admin/status` | 鉴权。返回 cursor / 上次运行 / 滞后 / 计数，便于排查。 |
| GET | `/` | 健康检查。 |

## 6. Queue 消费者 —— 同步引擎

消息类型：`{type:"delta"}` / `{type:"backfill", jobId?}` / `{type:"photo-batch", jobId, entries}`

### 6.1 `delta`

1. 抢 `photo_sync_state` 租约锁（TTL ~60s）。已被占用且未过期 → 延迟重入队，退出。
2. 读 `cursor`。为空 → `files/list_folder/get_latest_cursor`（根目录、recursive、`include_media_info=true`）拿到「此刻」的 cursor 存下，退出（从现在起才开始处理）。
3. 循环 `files/list_folder/continue({cursor})` 收 `entries`，直到 `has_more=false` 或达单次上限（如 2000 条，超了存 cursor 再入队一条 `delta`）。
4. **折叠**：按 `path_lower` 只留最后一条状态（Dropbox delta 有序）。
5. **过滤**：路径去掉 `DROPBOX_JOBS_ROOT` 前缀后，第 2 段（job 文件夹下的子目录）∈ `SYNC_FOLDERS`（忽略大小写），且为 web 图片扩展名；`DeletedMetadata` 同形状保留（供自愈）。其余丢弃。
6. 按**顶层 job 文件夹名**（第 1 段）分组。
7. 每个 job 文件夹：`files/get_metadata({path, include_property_groups: filter_some:[TEMPLATE_ID]})` 取 `jobId`，按批缓存。无 `jobId` → 整组丢弃。
8. 每个 `(jobId, entries)` → 入队一条 `{type:"photo-batch", jobId, entries}`。
9. 写回新 `cursor` 到 `photo_sync_state`，释放锁。`has_more` 仍为真则再入队一条 `delta`。

### 6.2 `photo-batch`（`{jobId, entries}`）

1. 拆成 `upserts`（FileMetadata）与 `deletes`（DeletedMetadata）。
2. **展示缩略图**：`files/get_thumbnail_batch`（≤25/次，分块），`format=jpeg`，`size=THUMB_SIZE`（`w1024h768`），`mode=bestfit`。逐条结果：成功拿 base64 缩略图；失败（格式不支持/过大）→ 记日志跳过，继续。
3. 每张成功的：
   - `photoId = base64url(sha256(jobId + '/' + 相对 job 文件夹路径)).slice(0,22)`。
   - `PUT {SUPABASE_URL}/storage/v1/object/photos/{jobId}/{photoId}_thumb.jpg`，`x-upsert: true`，service role key。
   - 组装记录（§3.1）。`width/height` 先取 delta entry 的 `media_info.metadata.dimensions`；Dropbox 上传后 media_info 是**异步生成**的，delta 里常常还没有 → 此时补调一次 `get_metadata`（`include_media_info=true`）重取；仍拿不到就存 `null`，绝不因此让照片失败。
   - 子目录 ∈ `DOWNLOAD_SET_FOLDERS`（即 `MLS`）时，记录里带上 `downloadDropboxPath`（交付副本在第 5 步单独生成）。
   - 调 `photos_upsert(jobId, 记录)`。若命中 `pending_review` 且 `dropboxFileId` 变化 → 视为自愈，记日志。记录成功的 item，供第 5 步用。
4. **交付图集（仅 `DOWNLOAD_SET_FOLDERS`，只对第 3 步成功的 item）**：单独一趟 `get_thumbnail_batch`，`size=DOWNLOAD_THUMB_SIZE`（`w2048h1536`）→ `files/upload`（`mode=overwrite`，自动建父目录）到 `/<jobFolder>/<DOWNLOAD_SUBFOLDER>/<原文件名>.jpg`。批量条目失败 → 逐张回退 `get_thumbnail_v2`。**整趟纯尽力而为**：Gallery 记录已在第 3 步落库，这里失败只记 `download_copy_failed` / `delivery_batch_failed`，下次 sync/backfill 补。
6. `deletes`：同公式算 `photoId` → 调 `photos_mark_pending(jobId, photoId)`。
   - **若属 `DOWNLOAD_SET_FOLDERS`**：`files/delete_v2` 硬删 `/<jobFolder>/<DOWNLOAD_SUBFOLDER>/<原文件名>.jpg`（纯派生物；`not_found` 忽略）。Supabase 记录仍照常置 `pending_review`。
   - 之后同路径再出现新文件 → 同 `photoId` → §6.2.3 自动把 `status` 置回 `ok`，第 4 步重建交付副本（**自愈天然成立**）。
   - 「删了但没有同名新文件」→ 一直 `pending_review`，等人工处理（符合需求）。
7. **单张失败不影响整批**：逐张 try/catch，结构化 `console.log` 记录，继续。只有整批级基础设施故障（Supabase/Dropbox 宕、鉴权失效）才让该 Queue 消息走重试+退避。

> **防回环**：`DOWNLOAD_SUBFOLDER`（`MLS for download`）不在 `SYNC_FOLDERS` 里，所以 Worker 写进去的图触发的 webhook 会在 §6.1 步骤 5 被过滤掉，不会被再处理。

### 6.3 `backfill`（`{jobId?}`）

- 给了 `jobId`：`file_properties/properties/search`（按 `jobId` 字段值）定位文件夹 → `list_folder({path, recursive:true})` → 走 §6.1 的过滤/分组/入队。
- 没给：`list_folder({path: DROPBOX_JOBS_ROOT, recursive:true})` 分页遍历 → 同上。
- backfill **不动** delta cursor。

## 7. 幂等 & 容错

- 同一 webhook 重发 → delta 折叠 + 按 `photoId` upsert + Storage `x-upsert` → 无重复数据。
- Dropbox access token：模块级内存缓存 `{token, expiresAt}`，用 refresh token 换，过期前 5 分钟刷新；遇 401 强刷一次重试。
- Queue：`max_retries: 5` + 指数退避 + 死信队列 `photo-sync-dlq`。
- 租约锁：保证同一时刻只有一个 delta 在推进 cursor（防并发重复处理 / cursor 竞态）。

## 8. 目录结构

```
photo-sync-worker/
  README.md            部署步骤 / 运维手册
  DESIGN.md            本文
  package.json
  wrangler.jsonc       独立 Worker 配置（不动仓库根那个 FSB 的）
  .dev.vars.example    本地机密模板（.dev.vars 已 gitignore）
  .gitignore
  src/
    index.js           fetch（webhook + admin）+ queue + scheduled 三个 handler
    dropbox.js         auth / list_folder(continue) / get_metadata / get_thumbnail_batch / upload / delete_v2 / properties.search
    supabase.js        storage 上传 / RPC / sync_state 读写 + 租约锁
    sync.js            delta 折叠 / 过滤 / 分组 / 自愈编排
    paths.js           路径解析：jobFolder / 子目录 / 相对路径 / 扩展名 / SYNC_FOLDERS 匹配
    photo-id.js        稳定 hash
    webhook.js         签名校验 + challenge 握手
  supabase/
    schema.sql         §3.2 的 3 个对象 + grant
  test/
    paths.test.js  photo-id.test.js  collapse.test.js
    webhook-signature.test.js  sync.test.js（假 Dropbox + 假 Supabase）
```

依赖：**零运行时依赖**。Dropbox 和 Supabase 都用裸 `fetch` 调 REST/RPC —— Worker 环境下冷启动更快、无打包兼容风险、测试只需 mock `fetch`。（Job Generator 用官方 `dropbox` SDK 是因为它是 Node 长驻进程，取舍不同。）
测试用内置 `node --test`，`devDependencies` 只有 `wrangler`。

## 9. 验收对照

1. Job Generator 建测试 job → Dropbox 文件夹 + jobId 标签。
2. 往 `…/MLS/` 传一张图 → webhook → 入队 → 消费者：continue delta → 过滤命中（MLS ∈ SYNC_FOLDERS）→ 取 jobId → `get_thumbnail_batch` → 传 `photos/<jobId>/<photoId>_thumb.jpg` → `photos_upsert`。
3. 数秒内：`projects` 出现 `id=<jobId>` 行，`data.photos[]` 有该记录，Storage 有 1024 缩略图，且 Dropbox `…/MLS for download/` 里出现同名的 2048×1365 交付图，记录带 `downloadDropboxPath`。
4. 删文件 → `status: pending_review` 且 `MLS for download/` 里的副本被删除；重传**同名** → 同 `photoId` → 恢复 `ok` 且副本重建（日志标记自愈）；重传**不同名** → 旧记录保持 `pending_review`。

## 10. 已知延后项（非 v1）

- Video / VLOG 链接接入（等定视频托管）。
- Storage 保留策略（免费版 1GB）：以后加一个 cron，删除超过 N 个月的旧 job 的缩略图+行（原图在 Dropbox，backfill 可重建）。
- `pending_review` 的人工可见入口（属于 Gallery / Feature Sheet Builder UI 范畴）。
- 纯重命名按「删+加」处理（可接受）。
