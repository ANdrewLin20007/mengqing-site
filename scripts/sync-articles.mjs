#!/usr/bin/env node
/**
 * 梦晴工作室 · 公众号文章同步脚本（方案 A）
 *
 * 作用：调用微信公众平台接口，把「已发布」的图文拉下来，合并进 data/articles.json，
 *       同步刷新 index.html 里的内联兜底快照，可选地直接 commit + push 触发 Netlify 重建。
 *
 * 运行环境要求：一台有固定公网 IP 的机器（微信接口必须把该 IP 加入后台白名单）。
 *
 * 用法：
 *   node scripts/sync-articles.mjs              # 只更新本地文件
 *   node scripts/sync-articles.mjs --push       # 更新后自动 commit & push
 *   node scripts/sync-articles.mjs --dry-run    # 只打印将要新增的条目，不写文件
 *
 * 环境变量：
 *   WX_APPID   公众号 AppID
 *   WX_SECRET  公众号 AppSecret
 *   WX_PROXY   可选。填写后所有请求走这个前缀（例如 https://your-vps/wx），
 *              用于「脚本跑在无固定 IP 的机器、另有一台机器做代理」的场景。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'articles.json');
const INDEX_FILE = path.join(ROOT, 'index.html');
const TOKEN_FILE = path.join(ROOT, '.cache', 'wx-token.json');

const APPID = process.env.WX_APPID;
const SECRET = process.env.WX_SECRET;
const PROXY = (process.env.WX_PROXY || '').replace(/\/+$/, '');
const API_BASE = PROXY || 'https://api.weixin.qq.com';
const PUSH = process.argv.includes('--push');
const DRY = process.argv.includes('--dry-run');

const PAGE_SIZE = 20;
const MAX_PAGES = 10; // 最多回溯 200 篇，正常号够用

/* ------------------------------------------------------------------ 分类规则 */

const RULES = [
  { category: 'meetings', type: '会议纪实', re: /会议|例会|部署会|筹备会|打磨会|复盘会|座谈会|第[一二三四五六七八九十]+次/ },
  { category: 'awards', type: '获奖情况', re: /喜报|获奖|荣获|摘得|一等奖|二等奖|三等奖|金奖|银奖|铜奖|表彰|夺冠|桂冠|佳绩|入选/ },
  { category: 'members', type: '成员介绍', re: /成员介绍|逐梦同频|新成员|负责人|创始人|引领者|团队介绍|青春/ },
];

function classify(title = '') {
  for (const rule of RULES) {
    if (rule.re.test(title)) return { category: rule.category, type: rule.type };
  }
  return { category: 'activities', type: '参与活动' };
}

/* ------------------------------------------------------------------ 工具函数 */

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(message);
}

function idOf(url, title) {
  try {
    const params = new URL(url).searchParams;
    const mid = params.get('mid');
    if (mid) return `${mid}-${params.get('idx') || '1'}`;
  } catch {
    /* 非 mp.weixin 链接（例如搜狗检索页） */
  }
  return 'manual-' + crypto.createHash('sha1').update(title || url).digest('hex').slice(0, 10);
}

/** update_time（秒）转成北京时间 YYYY-MM-DDTHH:mm，与页面既有格式一致 */
function beijingTime(seconds) {
  if (!seconds) return '';
  const shifted = new Date((seconds + 8 * 3600) * 1000);
  return shifted.toISOString().slice(0, 16);
}

async function api(pathAndQuery, init) {
  const response = await fetch(`${API_BASE}${pathAndQuery}`, init);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    die(`接口返回的不是 JSON：${text.slice(0, 200)}`);
  }
  if (payload.errcode && payload.errcode !== 0) {
    die(`微信接口报错 ${payload.errcode}：${payload.errmsg}`);
  }
  return payload;
}

/* ------------------------------------------------------------------ 凭证缓存 */

async function getToken() {
  try {
    const cached = JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
    if (cached.token && cached.expiresAt > Date.now() + 60_000) return cached.token;
  } catch {
    /* 无缓存，继续取新的 */
  }

  const payload = await api(
    `/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(APPID)}&secret=${encodeURIComponent(SECRET)}`
  );
  if (!payload.access_token) die(`获取 access_token 失败：${JSON.stringify(payload)}`);

  await mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await writeFile(
    TOKEN_FILE,
    JSON.stringify({ token: payload.access_token, expiresAt: Date.now() + (payload.expires_in - 300) * 1000 }),
    'utf8'
  );
  return payload.access_token;
}

/* ------------------------------------------------------------------ 拉取文章 */

async function fetchPublished(token) {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await api(`/cgi-bin/freepublish/batchget?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset: page * PAGE_SIZE, count: PAGE_SIZE, no_content: 1 }),
    });
    const batch = payload.item || [];
    all.push(...batch);
    log(`  第 ${page + 1} 页：${batch.length} 条（累计 ${all.length} / 总数 ${payload.total_count ?? '?'}）`);
    if (batch.length < PAGE_SIZE) break;
    if (payload.total_count && all.length >= payload.total_count) break;
  }
  return all;
}

function toArticle(node, updateTime) {
  const title = (node.title || '').trim();
  const url = node.url || '';
  const meta = classify(title);
  const digest = (node.digest || '').replace(/\s+/g, ' ').trim();
  return {
    id: idOf(url, title),
    title,
    url,
    date: beijingTime(updateTime),
    category: meta.category,
    type: meta.type,
    description: digest || title,
    tags: [meta.type],
    keywords: `${title} ${digest}`.trim(),
    source: 'auto',
  };
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  if (!APPID || !SECRET) {
    die('缺少环境变量 WX_APPID / WX_SECRET。可先 `export WX_APPID=... WX_SECRET=...` 或写进 .env 后 source。');
  }

  const store = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  const existing = store.articles || [];
  const byId = new Map(existing.map(item => [item.id, item]));
  const byTitle = new Map(existing.map(item => [item.title, item]));

  log('→ 获取 access_token');
  const token = await getToken();

  log('→ 拉取已发布图文');
  const list = await fetchPublished(token);

  const added = [];
  for (const group of list) {
    for (const node of group.content?.news_item || []) {
      if (!node.title) continue;
      const article = toArticle(node, group.update_time);
      if (!article.date) continue;
      if (byId.has(article.id) || byTitle.has(article.title)) continue;
      added.push(article);
      byId.set(article.id, article);
      byTitle.set(article.title, article);
    }
  }

  if (added.length) {
    log(`→ 新增 ${added.length} 篇：`);
    added.forEach(item => log(`   + ${item.date}  ${item.title}`));
  } else {
    log('→ 没有新文章');
  }

  const articles = [...existing, ...added].sort((a, b) => b.date.localeCompare(a.date));
  const payload = {
    ...store,
    schema: store.schema || 1,
    updated_at: beijingTime(Math.floor(Date.now() / 1000)),
    article_count: articles.length,
    articles,
  };

  if (DRY) {
    log('→ --dry-run：不写入文件');
    return;
  }

  await writeFile(DATA_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  log(`→ 已写入 ${path.relative(ROOT, DATA_FILE)}（${articles.length} 条）`);

  // 同步刷新 index.html 的内联兜底快照，保证直接双击打开也有最新数据
  const html = await readFile(INDEX_FILE, 'utf8');
  const compact = JSON.stringify(payload);
  const next = html.replace(
    /(<script type="application\/json" id="articles-fallback">)[\s\S]*?(<\/script>)/,
    `$1${compact}$2`
  );
  if (next === html) {
    log('！未找到内联兜底快照标记，跳过 index.html 更新');
  } else {
    await writeFile(INDEX_FILE, next, 'utf8');
    log('→ 已刷新 index.html 内联快照');
  }

  if (PUSH) {
    const stamp = payload.updated_at.slice(0, 16).replace('T', ' ');
    execFileSync('git', ['add', 'data/articles.json', 'index.html'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['commit', '-m', `chore(articles): 同步公众号文章 ${stamp}`], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['push'], { cwd: ROOT, stdio: 'inherit' });
    log('→ 已推送到远端，Netlify 将自动重建');
  } else {
    log('→ 未推送。确认无误后执行 `git add -A && git commit -m "chore: sync articles" && git push`');
  }
}

main().catch(error => die(error.stack || String(error)));
