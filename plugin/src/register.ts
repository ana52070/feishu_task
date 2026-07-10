import { basekit, ParamType, Component } from '@lark-opdev/block-basekit-server-api';

// 国际化
basekit.setI18n({
  defaultLocale: 'zh-CN',
  messages: {
    'zh-CN': {
      task_name_label: '任务名称',
      task_name_placeholder: '从触发器中映射「任务名称」字段',
      tasklist_label: '任务清单（所属清单）',
      tasklist_placeholder: '从触发器中映射「任务清单」字段',
      guids_label: '清单GUID映射',
      guids_placeholder: '{"学培部":"guid","组织部":"guid","宣传部":"guid"}',
      result_success: '同步结果',
      result_detail: '详情',
    },
    'en-US': {
      task_name_label: 'Task Name',
      task_name_placeholder: 'Map the task name field from trigger',
      tasklist_label: 'Tasklist (Department)',
      tasklist_placeholder: 'Map the tasklist field from trigger',
      guids_label: 'Tasklist GUID Mapping',
      guids_placeholder: '{"dept_name":"guid",...}',
      result_success: 'Sync Result',
      result_detail: 'Details',
    },
  },
});

/**
 * 解析任务清单值，支持字符串(逗号分隔)和数组
 */
function parseDepartments(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((v: any) => typeof v === 'string' && v.trim());
  }
  if (typeof value === 'string') {
    return value.split(/[,，、\s]+/).filter(Boolean);
  }
  return [];
}

/**
 * 分页拉取所有任务
 */
async function fetchAllTasks(baseUrl: string, token: string, fetchFn: any): Promise<any[]> {
  const allTasks: any[] = [];
  let pageToken = '';

  do {
    let url = `${baseUrl}/open-apis/task/v2/tasks?page_size=100`;
    if (pageToken) url += `&page_token=${pageToken}`;

    const resp = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();

    if (data.code !== 0) {
      throw new Error(`获取任务列表失败: ${data.code} ${data.msg}`);
    }

    if (data.data?.items) {
      allTasks.push(...data.data.items);
    }
    pageToken = data.data?.page_token || '';
  } while (pageToken);

  return allTasks;
}

// ── 注册自动化操作 ──────────────────────────────────────────────

basekit.addAction({
  // 使用应用身份（tenant_access_token），无需用户 OAuth
  useTenantAccessToken: true,
  // 需要文档权限（用于读取关联的多维表格）
  permission: { type: 2 },

  // ── 表单配置 ────────────────────────────────────────────────
  formItems: [
    {
      itemId: 'taskName',
      label: '任务名称',
      component: Component.Input,
      componentProps: {
        placeholder: '从触发器中映射「任务名称」字段',
      },
    },
    {
      itemId: 'tasklistValue',
      label: '任务清单（所属清单）',
      component: Component.Input,
      componentProps: {
        placeholder: '从触发器中映射「任务清单」字段',
      },
    },
    {
      itemId: 'tasklistGuids',
      label: '清单GUID映射',
      component: Component.Input,
      componentProps: {
        placeholder: '{"学培部":"09132845-...","组织部":"17bd8f58-...","宣传部":"799c5d11-..."}',
      },
    },
  ],

  // ── 执行逻辑 ────────────────────────────────────────────────
  execute: async function (args: any, context: any) {
    const { taskName, tasklistValue, tasklistGuids } = args;
    const { fetch } = context;

    // 1. 校验入参
    if (!taskName) {
      return { success: false, message: '任务名称为空，请在流程中映射「任务名称」字段' };
    }

    const departments = parseDepartments(tasklistValue);
    if (departments.length === 0) {
      return { success: false, message: '任务清单为空，请在流程中映射「任务清单」字段' };
    }

    // 2. 解析 GUID 映射
    let guidMap: Record<string, string> = {};
    if (tasklistGuids) {
      try {
        guidMap = typeof tasklistGuids === 'string'
          ? JSON.parse(tasklistGuids)
          : tasklistGuids;
      } catch {
        return {
          success: false,
          message: '清单GUID映射格式错误，需要JSON格式，如 {"学培部":"guid1","组织部":"guid2"}',
        };
      }
    }

    if (Object.keys(guidMap).length === 0) {
      return {
        success: false,
        message: '请配置清单GUID映射，格式: {"学培部":"09132845-...","组织部":"17bd8f58-...","宣传部":"799c5d11-..."}',
      };
    }

    // 3. 获取所有任务，找到匹配的任务
    const baseUrl = 'https://open.feishu.cn';
    let tasks: any[];
    try {
      tasks = await fetchAllTasks(baseUrl, context.tenantAccessToken, fetch);
    } catch (err: any) {
      return { success: false, message: err.message || '获取任务列表异常' };
    }

    const matchedTask = tasks.find((t: any) => t.summary === taskName);
    if (!matchedTask?.guid) {
      return {
        success: false,
        message: `未在飞书任务中找到「${taskName}」，请确认任务名称一致`,
      };
    }

    const taskGuid = matchedTask.guid;

    // 4. 逐个添加到对应部门清单
    const results: any[] = [];
    for (const dept of departments) {
      const tlGuid = guidMap[dept];
      if (!tlGuid) {
        results.push({
          department: dept,
          status: 'skipped',
          reason: `未配置「${dept}」的GUID映射`,
        });
        continue;
      }

      try {
        const addResp = await fetch(
          `${baseUrl}/open-apis/task/v2/tasks/${taskGuid}/add_tasklist?user_id_type=open_id`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${context.tenantAccessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ tasklist_guid: tlGuid }),
          }
        );
        const addData = await addResp.json();

        if (addData.code === 0) {
          results.push({ department: dept, status: 'ok' });
        } else if (addData.code === 114001 || addData.code === 10001) {
          results.push({ department: dept, status: 'already_exists' });
        } else {
          results.push({
            department: dept,
            status: 'failed',
            error: addData.msg || `错误码: ${addData.code}`,
          });
        }
      } catch (err: any) {
        results.push({
          department: dept,
          status: 'failed',
          error: err.message || '请求异常',
        });
      }
    }

    // 5. 统计结果
    const ok = results.filter((r) => r.status === 'ok');
    const exists = results.filter((r) => r.status === 'already_exists');
    const failed = results.filter((r) => r.status === 'failed');

    const summary = [
      ok.length ? `成功 ${ok.length}` : '',
      exists.length ? `已存在 ${exists.length}` : '',
      failed.length ? `失败 ${failed.length}` : '',
    ]
      .filter(Boolean)
      .join('，');

    return {
      success: failed.length === 0,
      message: `「${taskName}」${summary}`,
      details: JSON.stringify(results),
    };
  },

  // ── 返回值类型 ──────────────────────────────────────────────
  resultType: {
    type: ParamType.Object,
    properties: {
      success: { type: ParamType.Boolean, label: '是否成功' },
      message: { type: ParamType.String, label: '结果信息' },
      details: { type: ParamType.String, label: '详细情况' },
    },
  },
});
