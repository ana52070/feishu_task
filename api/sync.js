// api/sync.js — Vercel Serverless Function
// 接收 Base Workflow Webhook，自动同步任务清单
//
// 环境变量:
//   FEISHU_APP_ID            飞书应用 App ID（必填）
//   FEISHU_APP_SECRET        飞书应用 App Secret（必填）
//   FEISHU_REFRESH_TOKEN     用户 Refresh Token（必填，通过 /api/auth 获取）
//   FEISHU_BASE_URL          多维表格完整链接（必填，如 https://xxx.feishu.cn/base/xxx?table=tblxxx）

const FEISHU_HOST = "https://open.feishu.cn";

// ── 辅助函数 ─────────────────────────────────────────────────────

async function feishuFetch(path, options = {}) {
  const url = `${FEISHU_HOST}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
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

// 刷新 user_access_token
async function refreshUserToken() {
  const refreshToken = process.env.FEISHU_REFRESH_TOKEN;
  if (!refreshToken) throw new Error("FEISHU_REFRESH_TOKEN 未设置");

  const data = await feishuFetch("/open-apis/authen/v1/refresh_access_token", {
    method: "POST",
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (data.code !== 0) {
    throw new Error(`刷新 token 失败 (${data.code}): ${data.msg}。请重新访问 /api/auth 获取新 refresh_token`);
  }

  // 更新环境变量中存的 refresh_token（新 refresh_token 可能有更新）
  return data.data.access_token;
}

// 获取多维表格记录
async function getBaseRecords(accessToken, baseToken, tableId) {
  const records = [];
  let pageToken = "";

  do {
    let url = `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records?page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;

    const data = await feishuFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (data.code !== 0) throw new Error(`读取 Base 失败: ${data.msg}`);

    if (data.data?.items) {
      records.push(...data.data.items);
    }
    pageToken = data.data?.page_token || "";
  } while (pageToken);

  return records;
}

// 获取任务清单中的任务 GUID
async function getTasklistTasks(accessToken, tasklistGuid) {
  const tasks = [];
  let pageToken = "";

  do {
    let url = `/open-apis/task/v2/tasklists/${tasklistGuid}/tasks?page_size=100`;
    if (pageToken) url += `&page_token=${pageToken}`;

    const data = await feishuFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (data.code !== 0) throw new Error(`读取清单任务失败: ${data.msg}`);

    if (data.data?.items) {
      tasks.push(...data.data.items);
    }
    pageToken = data.data?.page_token || "";
  } while (pageToken);

  return tasks;
}

// 获取我负责的任务列表
async function getMyTasks(accessToken) {
  // 使用 Task v2 API 获取用户任务
  const tasks = [];
  let pageToken = "";

  do {
    let url = `/open-apis/task/v2/tasks?page_size=100`;
    if (pageToken) url += `&page_token=${pageToken}`;

    const data = await feishuFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (data.code !== 0) throw new Error(`获取任务列表失败: ${data.msg}`);

    if (data.data?.items) {
      tasks.push(...data.data.items);
    }
    pageToken = data.data?.page_token || "";
  } while (pageToken);

  return tasks;
}

// 添加任务到任务清单
async function addTaskToTasklist(accessToken, taskGuid, tasklistGuid) {
  const data = await feishuFetch(
    `/open-apis/task/v2/tasks/${taskGuid}/add_tasklist?user_id_type=open_id`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ tasklist_guid: tasklistGuid }),
    }
  );

  if (data.code !== 0) {
    // 如果错误是"已存在"，视为成功
    if (data.code === 114001 || data.code === 10001) return { already_exists: true };
    throw new Error(`添加任务到清单失败: ${data.msg}`);
  }
  return { ok: true };
}

// 查找任务清单 GUID
async function searchTasklist(accessToken, name) {
  const data = await feishuFetch(
    `/open-apis/task/v2/tasklists?page_size=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (data.code !== 0) throw new Error(`搜索任务清单失败: ${data.msg}`);

  const found = (data.data?.items || []).find((t) => t.name === name);
  return found ? found.guid : null;
}

// ── 主同步逻辑 ─────────────────────────────────────────────────

async function runSync(baseUrl) {
  const accessToken = await refreshUserToken();

  // 1. 从 URL 解析 base_token 和 table_id
  let baseToken, tableId;

  if (baseUrl) {
    // 从 URL 解析 base_token 和 table_id，无需额外 API 调用
    // URL 格式: https://xxx.feishu.cn/base/BaseToken?table=TableId&view=ViewId
    try {
      const parsed = new URL(baseUrl);
      const pathMatch = parsed.pathname.match(/\/base\/([^\/\?]+)/);
      if (pathMatch) baseToken = pathMatch[1];
      tableId = parsed.searchParams.get("table") || process.env.FEISHU_TABLE_ID;
    } catch {
      throw new Error("无法解析 Base URL，请在 Vercel 环境变量中设置 FEISHU_BASE_TOKEN 和 FEISHU_TABLE_ID");
    }
  }

  if (!baseToken || !tableId) throw new Error("无法确定 Base Token 和 Table ID");

  // 2. 获取多维表格中的字段信息
  const fieldResp = await feishuFetch(
    `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/fields`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (fieldResp.code !== 0) throw new Error(`获取字段信息失败: ${fieldResp.msg}`);

  const fields = fieldResp.data?.items || [];
  const taskNameFieldId = fields.find((f) => f.field_name === "任务名称")?.field_id;
  const tasklistFieldId = fields.find((f) => f.field_name === "任务清单")?.field_id;
  const statusFieldId = fields.find((f) => f.field_name === "任务状态")?.field_id;

  if (!taskNameFieldId || !tasklistFieldId) {
    throw new Error("未找到「任务名称」或「任务清单」字段");
  }

  // 3. 读取 Base 全部记录
  const records = await getBaseRecords(accessToken, baseToken, tableId);

  // 构建 任务名 -> {部门列表, 状态} 映射
  const baseMapping = {};
  for (const r of records) {
    const fields = r.fields || {};
    const taskName = fields[taskNameFieldId] || "";
    if (!taskName) continue;

    const tasklistVal = fields[tasklistFieldId] || [];
    const departments = Array.isArray(tasklistVal)
      ? new Set(tasklistVal.filter((v) => typeof v === "string"))
      : new Set([String(tasklistVal)]);

    let taskStatus = "";
    const statusVal = statusFieldId ? fields[statusFieldId] : null;
    if (Array.isArray(statusVal)) taskStatus = statusVal[0] || "";
    else if (typeof statusVal === "string") taskStatus = statusVal;

    baseMapping[taskName] = { departments, status: taskStatus };
  }

  // 4. 搜索/确认任务清单
  const allDepartments = new Set();
  for (const info of Object.values(baseMapping)) {
    info.departments.forEach((d) => allDepartments.add(d));
  }

  const tasklistGuidMap = {};
  for (const dept of allDepartments) {
    const guid = await searchTasklist(accessToken, dept);
    if (guid) tasklistGuidMap[dept] = guid;
  }

  if (Object.keys(tasklistGuidMap).length === 0) {
    throw new Error("未找到任何可用任务清单");
  }

  // 5. 检查各清单中已有的任务 GUID
  const assignedGuids = new Set();
  for (const tlGuid of Object.values(tasklistGuidMap)) {
    const tasks = await getTasklistTasks(accessToken, tlGuid);
    tasks.forEach((t) => {
      if (t.guid) assignedGuids.add(t.guid);
    });
  }

  // 6. 获取我负责的任务列表
  const myTasks = await getMyTasks(accessToken);

  const myTaskMap = {};
  for (const t of myTasks) {
    const summary = t.summary || "";
    const guid = t.guid || "";
    const completed = t.completed_at && t.completed_at !== "0";
    if (summary && guid) {
      if (!myTaskMap[summary] || !completed) {
        myTaskMap[summary] = { guid, completed };
      }
    }
  }

  // 找出未分配的任务
  const unassignedNames = Object.entries(myTaskMap)
    .filter(([, info]) => !assignedGuids.has(info.guid))
    .map(([name]) => name);

  // 7. 执行同步
  const syncResults = [];
  for (const taskName of unassignedNames) {
    const info = baseMapping[taskName];
    if (!info || info.departments.size === 0) continue;

    const taskGuid = myTaskMap[taskName].guid;
    for (const dept of info.departments) {
      const tlGuid = tasklistGuidMap[dept];
      if (!tlGuid) continue;

      try {
        const result = await addTaskToTasklist(accessToken, taskGuid, tlGuid);
        syncResults.push({
          task: taskName,
          tasklist: dept,
          status: result.already_exists ? "already_exists" : "ok",
        });
      } catch (err) {
        syncResults.push({
          task: taskName,
          tasklist: dept,
          status: "failed",
          error: err.message,
        });
      }
    }
  }

  return {
    stats: {
      total_unassigned: unassignedNames.length,
      synced: syncResults.filter((r) => r.status === "ok").length,
      already_exists: syncResults.filter((r) => r.status === "already_exists").length,
      failed: syncResults.filter((r) => r.status === "failed").length,
    },
    details: syncResults,
  };
}

// ── HTTP Handler ────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const effectiveBaseUrl = req.body?.base_url || process.env.FEISHU_BASE_URL || "";

    const result = await runSync(effectiveBaseUrl);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("Sync error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
