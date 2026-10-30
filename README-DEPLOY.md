# 部署说明（方案 A：采集在外，Netlify 只托管）

## 目录结构

```
梦晴/
├── index.html                  # 站点本体，数据从 data/articles.json 读取
├── data/articles.json          # 唯一数据源，由同步脚本自动维护
├── scripts/sync-articles.mjs   # 采集脚本（跑在固定 IP 的机器上）
├── netlify.toml                # Netlify 配置（纯静态，publish = "."）
├── .env.example                # 环境变量示例
├── bgm.mp3 / bgm-prompt.md
└── 微信图片_2026-10-26_224712_411.jpg   # 首屏与开始界面的品牌图
```

页面加载时先 `fetch('./data/articles.json')`；如果失败（本地双击打开、离线、断网），
自动退回 `index.html` 里的内联快照，所以**本地预览永远有内容**。同步脚本会同时更新这两处。

## 前置条件

1. **公众号管理员权限**：后台 → 设置与开发 → 基本配置，能拿到 `AppID` / `AppSecret`
2. **一台有固定公网 IP 的机器**：微信接口要求把服务器 IP 加进「IP 白名单」。
   Netlify、Vercel、Cloudflare Workers 的出站 IP 都不固定，**不能直接调用**。
3. 一个 GitHub 仓库 + 一个 Netlify 站点（免费版足够）

## 一、把站点接上 Netlify

```bash
cd 梦晴
git init
git add -A
git commit -m "init: 梦晴工作室官网"
git remote add origin git@github.com:<你的账号>/mengqing-site.git
git push -u origin main
```

Netlify → Add new site → Import from GitHub → 选仓库：

- Build command：**留空**
- Publish directory：`.`（就是仓库根目录）
- 其余默认，Deploy

之后每次 `git push`，Netlify 会在十几秒内自动重建。

## 二、在固定 IP 的机器上准备采集

```bash
# 1. 装 Node 18+ 并克隆同一个仓库
git clone git@github.com:<你的账号>/mengqing-site.git
cd mengqing-site

# 2. 配置凭证
cp .env.example .env
vi .env          # 填 WX_APPID / WX_SECRET

# 3. 把本机公网 IP 加到公众号后台的白名单
curl -s https://api.ipify.org; echo    # 看到的这个 IP 填进「IP 白名单」

# 4. 先干跑一次，确认能拉到数据
set -a && . ./.env && set +a
node scripts/sync-articles.mjs --dry-run
```

没有报错且列出了文章，就正式跑一次：

```bash
node scripts/sync-articles.mjs            # 只改本地 data/articles.json 和 index.html
node scripts/sync-articles.mjs --push     # 改完自动 commit & push，触发 Netlify 部署
```

## 三、加定时任务

```bash
crontab -e
```

```cron
# 每 6 小时同步一次；日志写到 sync.log 方便排查
0 */6 * * * cd /opt/mengqing-site && set -a && . ./.env && set +a && /usr/bin/node scripts/sync-articles.mjs --push >> sync.log 2>&1
```

> 微信接口每天约有 2000 次配额，一天 4 次调用完全够用。
> access_token 缓存在 `.cache/wx-token.json`（已 gitignore），不会反复取。

## 四、数据格式

`data/articles.json`：

```json
{
  "schema": 1,
  "updated_at": "2026-10-30T10:20",
  "source": "梦晴-育新联萌",
  "article_count": 30,
  "articles": [
    {
      "id": "2247486292-1",
      "title": "新成员介绍｜少年怀热忱，同行启新章",
      "url": "https://mp.weixin.qq.com/s?__biz=...&mid=2247486292&idx=1&sn=...",
      "date": "2026-10-26T08:49",
      "category": "members",
      "type": "成员介绍",
      "description": "……",
      "tags": ["新成员", "团队协作"],
      "keywords": "黄耀锋 杨湘源 ……",
      "source": "auto"
    }
  ]
}
```

- `id`：`mid-idx`，去重键；搜狗跳转链接这类没有 mid 的用 `manual-<hash>`
- `category`：`members` / `awards` / `activities` / `meetings`，决定筛选与计数
- `source`：`manual` 表示人工校订过（脚本不会覆盖），`auto` 是脚本自动生成的

**人工校订**：直接改 `data/articles.json` 里对应条目的 `description` / `tags` / `category`，
把 `source` 改成 `manual`，之后脚本不会再动它。

## 五、常见报错

| 报错 | 原因 | 处理 |
|---|---|---|
| `40164 invalid ip` | 出口 IP 不在白名单 | 把当前公网 IP 加入后台白名单 |
| `40001 invalid credential` | AppSecret 错，或 token 被别处顶掉 | 重新生成密钥；确保只有一个进程刷新 token |
| `45009 api freq out of limit` | 当日调用超限 | 降低频率，检查是否在循环里重复取 token |
| `48001 api unauthorized` | 该接口未授权（账号类型限制） | 需认证的服务号/订阅号，个人订阅号部分接口不可用 |
| 页面显示 30 条但没更新 | 打开了本地文件（走兜底快照） | 用 http 访问，或在同步后刷新 |

## 六、本地验证

```bash
python -m http.server 8899
# 浏览器打开 http://127.0.0.1:8899/
```

直接双击 `index.html` 也能开，但走的是内联快照；要看真实 JSON 效果请用 http。
