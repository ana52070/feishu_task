// api/auth.js — Vercel Serverless Function
// 设备 OAuth 授权流程：获取 Refresh Token
//
// 用法:
//   GET  /api/auth              — 发起设备授权，返回二维码链接
//   GET  /api/auth?poll=1&device_code=xxx — 轮询授权结果，返回 refresh_token
//   GET  /api/auth?setup=1      — 显示完整的配置指引
//
// 环境变量:
//   FEISHU_APP_ID      飞书应用 App ID（必填）
//   FEISHU_APP_SECRET  飞书应用 App Secret（必填）

const FEISHU_HOST = "https://open.feishu.cn";

async function feishuFetch(path, options = {}) {
  const url = `${FEISHU_HOST}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(options.headers || {}),
    },
  });
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { poll, device_code, setup } = req.query;

  // ── 配置指引页面 ──────────────────────────────────────────────
  if (setup === "1") {
    return res.status(200).send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto">
        <h1>👋 Vercel 飞书任务同步 — 配置指引</h1>
        <h3>需要设置的环境变量：</h3>
        <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
          <tr><th>变量名</th><th>说明</th><th>来源</th></tr>
          <tr>
            <td><code>FEISHU_APP_ID</code></td>
            <td>应用 App ID</td>
            <td>开发者后台 → 凭证与基础信息</td>
          </tr>
          <tr>
            <td><code>FEISHU_APP_SECRET</code></td>
            <td>应用 App Secret</td>
            <td>开发者后台 → 凭证与基础信息</td>
          </tr>
          <tr>
            <td><code>FEISHU_REFRESH_TOKEN</code></td>
            <td>用户 Refresh Token</td>
            <td>先设置前两项，然后访问 <code>/api/auth</code></td>
          </tr>
          <tr>
            <td><code>FEISHU_BASE_URL</code></td>
            <td>多维表格链接</td>
            <td>你的 Base 链接</td>
          </tr>
        </table>
        <p style="margin-top:20px">
          <a href="/api/auth">👉 开始授权，获取 Refresh Token</a>
        </p>
      </body></html>
    `);
  }

  // ── 轮询授权结果 ──────────────────────────────────────────────
  if (poll === "1" && device_code) {
    const data = await feishuFetch("/open-apis/passport/v1/token/device/code/login", {
      method: "POST",
      body: JSON.stringify({
        grant_type: "device_code",
        device_code,
        client_id: process.env.FEISHU_APP_ID,
        client_secret: process.env.FEISHU_APP_SECRET,
      }),
    });

    if (data.code !== 0) {
      const errMsg = data.error || data.msg || "授权失败";
      // 如果是 authorization_pending，说明用户还没扫码
      if (data.error === "authorization_pending" || data.error === "slow_down") {
        return res.status(200).json({
          ok: false,
          status: "pending",
          message: "等待用户授权中，请稍后再试",
        });
      }
      return res.status(400).json({ ok: false, error: errMsg });
    }

    // 授权成功，返回 refresh_token
    return res.status(200).json({
      ok: true,
      status: "completed",
      refresh_token: data.data?.refresh_token || data.refresh_token,
      access_token: data.data?.access_token || data.access_token,
      expires_in: data.data?.expires_in || data.expires_in,
      hint: "请将 refresh_token 复制到 Vercel 环境变量 FEISHU_REFRESH_TOKEN 中",
    });
  }

  // ── 发起设备授权 ──────────────────────────────────────────────
  try {
    // 1. 先获取 tenant_access_token
    const tokenResp = await feishuFetch("/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: JSON.stringify({
        app_id: process.env.FEISHU_APP_ID,
        app_secret: process.env.FEISHU_APP_SECRET,
      }),
    });

    if (tokenResp.code !== 0) {
      return res.status(500).send(`
        <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto">
          <h1>❌ 配置错误</h1>
          <p>FEISHU_APP_ID 或 FEISHU_APP_SECRET 无效</p>
          <pre>${tokenResp.msg || "未知错误"}</pre>
          <p>请检查 Vercel 环境变量设置。</p>
        </body></html>
      `);
    }

    const tenantToken = tokenResp.tenant_access_token;

    // 2. 发起设备授权流程
    const deviceResp = await feishuFetch("/open-apis/passport/v1/token/device/code/create", {
      method: "POST",
      headers: { Authorization: `Bearer ${tenantToken}` },
      body: JSON.stringify({
        app_id: process.env.FEISHU_APP_ID,
        scope: "task:task:read task:task:write base:record:read",
      }),
    });

    if (deviceResp.code !== 0) {
      return res.status(500).send(`
        <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto">
          <h1>❌ 设备授权启动失败</h1>
          <pre>${deviceResp.msg || JSON.stringify(deviceResp)}</pre>
        </body></html>
      `);
    }

    const { device_code, user_code, verification_url, expires_in } =
      deviceResp.data || deviceResp;

    // 3. 返回授权页面（含自动轮询脚本）
    return res.status(200).send(`
      <html>
      <head>
        <meta charset="utf-8">
        <title>飞书授权</title>
        <style>
          body { font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center; }
          .step { background: #f5f5f5; padding: 20px; border-radius: 12px; margin: 20px 0; }
          .url { font-size: 16px; word-break: break-all; color: #3370ff; }
          .pending { color: #666; }
          .done { color: #00a854; font-weight: bold; font-size: 18px; }
          pre { background: #f0f0f0; padding: 12px; border-radius: 8px; text-align: left; overflow-x: auto; }
        </style>
      </head>
      <body>
        <h1>🔐 飞书授权</h1>
        <p>请用飞书扫码或在浏览器打开以下链接完成授权</p>

        <div class="step">
          <p class="url">
            <a href="${verification_url}" target="_blank">${verification_url}</a>
          </p>
          <p>用户码: <strong>${user_code}</strong></p>
        </div>

        <p>授权完成后，页面会自动获取 Refresh Token</p>
        <div id="status" class="pending">⏳ 等待授权中...</div>
        <div id="result" style="display:none"></div>

        <script>
        const deviceCode = "${device_code}";
        let attempts = 0;
        const maxAttempts = ${Math.floor(expires_in / 3)}; // 轮询到过期

        async function poll() {
          try {
            const r = await fetch('/api/auth?poll=1&device_code=' + deviceCode);
            const data = await r.json();

            if (data.ok && data.status === 'completed') {
              document.getElementById('status').innerHTML = '<p class="done">✅ 授权成功!</p>';
              document.getElementById('result').style.display = 'block';
              document.getElementById('result').innerHTML = \`
                <p>请将以下 Token 添加到 Vercel 环境变量 <code>FEISHU_REFRESH_TOKEN</code>:</p>
                <pre>$\{data.refresh_token}</pre>
                <p style="color:#999;font-size:14px">Token 有效期: $\{data.expires_in || 7200} 秒</p>
              \`;
              return;
            }

            if (data.status === 'pending') {
              attempts++;
              if (attempts < maxAttempts) {
                const delay = attempts < 10 ? 2000 : 5000;
                setTimeout(poll, delay);
              } else {
                document.getElementById('status').innerHTML = '<p style="color:red">⏰ 授权超时，请刷新页面重试</p>';
              }
              return;
            }

            document.getElementById('status').innerHTML = '<p style="color:red">❌ 授权失败: ' + (data.error || '未知错误') + '</p>';
          } catch(e) {
            document.getElementById('status').innerHTML = '<p style="color:red">❌ 网络错误，请刷新页面重试</p>';
          }
        }

        // 开始轮询
        setTimeout(poll, 2000);
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    return res.status(500).send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto">
        <h1>❌ 服务器错误</h1>
        <pre>${err.message}</pre>
      </body></html>
    `);
  }
}
