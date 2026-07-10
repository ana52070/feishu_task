// src/index.js — 飞书任务清单同步服务 (fly.io)
// 接收 Base Workflow Webhook，自动同步任务到所属清单
//
// 环境变量:
//   FEISHU_APP_ID            必填
//   FEISHU_APP_SECRET        必填
//   FEISHU_REFRESH_TOKEN     首次部署时必填，之后自动续期

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const FEISHU_HOST = 'https://open.feishu.cn';
const TOKEN_FILE = path.join(__dirname, '..', 'data', 'token_store.json');

// ── Token 持久化 ───────────────────────────────────────────────

function loadRefreshToken() {
  // 优先从文件读取（自动续期后的新 token）
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (data.refresh_token) return data.refresh_token;
    }
  } catch {}
  // 回退到环境变量
  return process.env.FEISHU_REFRESH_TOKEN || '';
}

function saveRefreshToken(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: token, updated_at: Date.now() }), 'utf8');
  } catch (err) {
    console.error('保存 refresh_token 失败:', err.message);
  }
}

// ── 飞书 API 调用 ─────────────────────────────────────────────

async function feishuFetch(path, options = {}) {
  const targetUrl = `${FEISHU_HOST}${path}`;
  const res = await fetch(targetUrl, {
    ...options,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`飞书 API 返回非 JSON (${res.status}): ${text.slice(0, 200)}`);
  }
}

async function refreshUserToken() {
  let refreshToken = loadRefreshToken();
  if (!refreshToken) throw new Error('FEISHU_REFRESH_TOKEN 未设置');

  const data = await feishuFetch('/open-apis/authen/v1/access_token', {
    method: 'POST',
    body: JSON.stringify({
      grant_type: 'refresh_token',
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
      refresh_token: refreshToken,
    }),
  });

  if (data.code !== 0) {
    throw new Error(`刷新 token 失败 (${data.code}): ${data.msg || data.error_description}。请重新设置 FEISHU_REFRESH_TOKEN`);
  }

  const newToken = data.data?.access_token || data.access_token;
  const newRefresh = data.data?.refresh_token || data.refresh_token;

  // 持久化新的 refresh_token（自动续期）
  if (newRefresh && newRefresh !== refreshToken) {
    saveRefreshToken(newRefresh);
    console.log('refresh_token 已自动续期');
  }

  return newToken;
}

/**
 * 分页获取全部数据
 */
async function fetchAll(path, token) {
  const all = [];
  let pageToken = '';
  do {
    const sep = path.includes('?') ? '&' : '?';
    let url = `${path}${pageToken ? sep + 'page_token=' + pageToken : ''}`;
    const data = await feishuFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (data.code !== 0) throw new Error(`API ${data.code}: ${data.msg}`);
    const items = data.data?.items || data.data?.task || [];
    if (Array.isArray(items)) all.push(...items);
    else if (items) all.push(items);
    pageToken = data.data?.page_token || '';
  } while (pageToken);
  return all;
}

// ── 同步逻辑 ───────────────────────────────────────────────────

async function runSync(baseUrl) {
  const logs = [];
  const userToken = await refreshUserToken();
  logs.push('获取 user_access_token 成功');

  // 1. 解析 base_url 取 token/tableId
  let baseToken, tableId;
  try {
    const parsed = new URL(baseUrl);
    const match = parsed.pathname.match(/\/base\/([^\/\?]+)/);
    if (match) baseToken = match[1];
    tableId = parsed.searchParams.get('table') || '';
  } catch {
    throw new Error('无法解析 Base URL');
  }
  if (!baseToken || !tableId) throw new Error('无法解析 Base Token 和 Table ID');

  // 2. 获取字段信息
  const fieldResp = await feishuFetch(`/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/fields`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (fieldResp.code !== 0) throw new Error(`获取字段失败: ${fieldResp.msg}`);

  const fields = fieldResp.data?.items || [];
  const taskNameFieldId = fields.find(f => f.field_name === '任务名称')?.field_id;
  const tasklistFieldId = fields.find(f => f.field_name === '任务清单')?.field_id;

  if (!taskNameFieldId || !tasklistFieldId) {
    throw new Error('未找到「任务名称」或「任务清单」字段');
  }

  // 3. 读取全部记录
  const records = await fetchAll(
    `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records?page_size=500`,
    userToken
  );

  // 构建 任务名 -> { 部门列表 }
  const baseMapping = {};
  const allDepartments = new Set();
  for (const r of records) {
    const f = r.fields || {};
    const taskName = f[taskNameFieldId] || '';
    if (!taskName) continue;
    const deptVal = f[tasklistFieldId] || [];
    const depts = Array.isArray(deptVal)
      ? new Set(deptVal.filter(v => typeof v === 'string'))
      : new Set([String(deptVal)]);
    depts.forEach(d => allDepartments.add(d));
    baseMapping[taskName] = { departments: depts };
  }

  logs.push('Base 记录数: ' + records.length + '，涉及部门: ' + [...allDepartments].join('、'));

  // 4. 搜索所有任务清单
  const guidMap = {};
  const lists = await fetchAll('/open-apis/task/v2/tasklists?page_size=50', userToken);
  for (const item of lists) {
    if (item.name && item.guid) guidMap[item.name] = item.guid;
  }
  logs.push('搜索到 ' + Object.keys(guidMap).length + ' 个清单');

  // 检查所有清单是否都有 GUID
  for (const dept of allDepartments) {
    if (!guidMap[dept]) {
      // 尝试创建
      try {
        const createResp = await feishuFetch('/open-apis/task/v2/tasklists', {
          method: 'POST',
          headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: dept }),
        });
        if (createResp.code === 0 && createResp.data?.tasklist?.guid) {
          guidMap[dept] = createResp.data.tasklist.guid;
          logs.push('已创建清单: ' + dept);
        }
      } catch (err) {
        logs.push('创建清单失败「' + dept + '」: ' + err.message);
      }
    }
  }

  const stillMissing = [...allDepartments].filter(d => !guidMap[d]);
  if (stillMissing.length > 0) {
    throw new Error('以下部门无法找到或创建清单: ' + stillMissing.join('、'));
  }

  // 5. 搜索所有任务
  const allTasks = await fetchAll('/open-apis/task/v2/tasks?page_size=100', userToken);
  logs.push('搜索到 ' + allTasks.length + ' 个任务');

  // 6. 获取每个清单已有任务 GUID
  const assignedGuids = new Set();
  for (const [dept, tlGuid] of Object.entries(guidMap)) {
    try {
      const tasks = await fetchAll(`/open-apis/task/v2/tasklists/${tlGuid}/tasks?page_size=100`, userToken);
      for (const t of tasks) if (t.guid) assignedGuids.add(t.guid);
      logs.push(`清单「${dept}」已有 ${tasks.length} 个任务`);
    } catch {}
  }

  // 7. 找出未分配的任务并同步
  const results = [];
  let syncCount = 0;
  let existsCount = 0;
  let failCount = 0;

  for (const [taskName, info] of Object.entries(baseMapping)) {
    const matched = allTasks.find(t => t.summary === taskName);
    if (!matched?.guid) continue;
    if (assignedGuids.has(matched.guid)) continue;

    for (const dept of info.departments) {
      const tlGuid = guidMap[dept];
      if (!tlGuid) continue;

      try {
        const resp = await feishuFetch(
          `/open-apis/task/v2/tasks/${matched.guid}/add_tasklist?user_id_type=open_id`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ tasklist_guid: tlGuid }),
          }
        );
        if (resp.code === 0) {
          syncCount++;
          results.push({ task: taskName, tasklist: dept, status: 'ok' });
        } else if (resp.code === 114001 || resp.code === 10001) {
          existsCount++;
          results.push({ task: taskName, tasklist: dept, status: 'already_exists' });
        } else {
          failCount++;
          results.push({ task: taskName, tasklist: dept, status: 'failed', error: resp.msg });
        }
      } catch (err) {
        failCount++;
        results.push({ task: taskName, tasklist: dept, status: 'failed', error: err.message });
      }
    }
  }

  return {
    ok: true,
    stats: {
      total_records: records.length,
      total_departments: allDepartments.size,
      total_tasks_in_feishu: allTasks.length,
      synced: syncCount,
      already_exists: existsCount,
      failed: failCount,
    },
    details: results,
    logs: logs,
  };
}

// ── HTTP 服务 ───────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.end();

  const parsed = url.parse(req.url, true);

  // 健康检查
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      token_persisted: fs.existsSync(TOKEN_FILE),
    }));
  }

  // 同步接口
  if (parsed.pathname === '/sync') {
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end('Method Not Allowed');
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { base_url } = body ? JSON.parse(body) : {};
        const effectiveUrl = base_url || process.env.FEISHU_BASE_URL;
        if (!effectiveUrl) throw new Error('请提供 base_url 或设置 FEISHU_BASE_URL 环境变量');

        const result = await runSync(effectiveUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 配置指引
  if (parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto">
      <h1>飞书任务清单同步服务</h1>
      <p>状态: <span style="color:green">运行中</span></p>
      <p>POST <code>/sync</code> — 执行同步</p>
      <p>GET <code>/health</code> — 健康检查</p>
      <hr>
      <h3>Base Workflow 配置</h3>
      <p>方法: <code>POST</code></p>
      <p>URL: <code>https://你的应用.fly.dev/sync</code></p>
      <p>Body: <code>{"base_url":"你的Base链接"}</code></p>
    </body></html>`);
  }

  res.writeHead(404);
  res.end('Not Found');
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Sync: POST http://localhost:${PORT}/sync`);
  if (fs.existsSync(TOKEN_FILE)) {
    console.log('Token store: 已持久化');
  } else {
    console.log('Token store: 未初始化（首次运行将自动创建）');
  }
});
