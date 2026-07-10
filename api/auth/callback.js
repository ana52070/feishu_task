// api/auth/callback.js — 飞书 OAuth 回调处理
// 接收授权 code，换取 access_token 和 refresh_token

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
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`飞书 API 返回非 JSON: ${text.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  const { code, detect } = req.query;

  // ── 探针：返回回调 URL ──
  if (detect === "1") {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || "https";
    return res.status(200).send(`${proto}://${host}/api/auth/callback`);
  }

  // ── 缺少 code ──
  if (!code) {
    return res.status(400).setHeader("Content-Type", "text/html; charset=utf-8").send(`
      <html><body style="font-family:sans-serif;max-width:500px;margin:40px auto">
        <h1>❌ 授权失败</h1>
        <p>未收到授权 code。请重新 <a href="/api/auth">发起授权</a></p>
      </body></html>
    `);
  }

  try {
    // ── 用 code 换取 token ──
    const tokenResp = await feishuFetch("/open-apis/authen/v1/access_token", {
      method: "POST",
      body: JSON.stringify({
        app_id: process.env.FEISHU_APP_ID,
        app_secret: process.env.FEISHU_APP_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });

    if (tokenResp.code !== 0) {
      return res.status(400).setHeader("Content-Type", "text/html; charset=utf-8").send(`
        <html><body style="font-family:sans-serif;max-width:500px;margin:40px auto">
          <h1>❌ Token 换取失败</h1>
          <p>错误码: ${tokenResp.code}</p>
          <p>消息: ${tokenResp.msg}</p>
          <p>可能原因：回调 URL 未在开发者后台配置</p>
          <hr>
          <p>请将回调 URL 添加到开发者后台 → 安全设置 → 重定向 URL：</p>
          <pre>${req.headers["x-forwarded-proto"] || "https"}://${req.headers["x-forwarded-host"] || req.headers.host}/api/auth/callback</pre>
          <p><a href="/api/auth">重新授权</a></p>
        </body></html>
      `);
    }

    const { access_token, refresh_token, expires_in } = tokenResp.data;
    const userName = tokenResp.data.name || "未知用户";

    // ── 显示 refresh_token ──
    return res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(`
      <html>
      <head><meta charset="utf-8"><title>授权成功</title>
      <style>
        body { font-family: sans-serif; max-width: 550px; margin: 50px auto; line-height: 1.6; }
        .success { background: #e8f5e9; border: 1px solid #4caf50; padding: 20px; border-radius: 12px; }
        pre { background: #f5f5f5; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 13px; word-break: break-all; }
        .step { background: #e3f2fd; padding: 12px; border-radius: 8px; margin: 12px 0; }
        code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; }
      </style>
      </head>
      <body>
        <div class="success">
          <h1>✅ 授权成功！</h1>
          <p>用户：${userName}</p>
        </div>

        <div class="step">
          <h3>下一步：设置 Vercel 环境变量</h3>
          <p>将以下 refresh_token 复制到 Vercel 项目环境变量 <code>FEISHU_REFRESH_TOKEN</code>：</p>
          <pre id="token">${refresh_token}</pre>
          <button onclick="copyToken()" style="padding:8px 16px;cursor:pointer">复制 Token</button>
          <span id="copied" style="display:none;color:#4caf50;margin-left:8px">已复制!</span>
        </div>

        <div class="step">
          <h3>还需要设置的环境变量</h3>
          <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
            <tr><td><code>FEISHU_REFRESH_TOKEN</code></td><td>✅ 已获取（如上）</td></tr>
            <tr><td><code>FEISHU_BASE_URL</code></td><td>你的多维表格完整链接</td></tr>
            <tr><td><code>FEISHU_TASKLIST_GUIDS</code></td><td>（可选）清单 GUID 映射 JSON</td></tr>
          </table>
        </div>

        <p style="color:#999">Token 有效期: ${expires_in || 7200} 秒，过期后自动通过 refresh_token 续期</p>

        <script>
        function copyToken() {
          const t = document.getElementById('token');
          navigator.clipboard.writeText(t.textContent).then(() => {
            document.getElementById('copied').style.display = 'inline';
            setTimeout(() => document.getElementById('copied').style.display = 'none', 2000);
          });
        }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    return res.status(500).setHeader("Content-Type", "text/html; charset=utf-8").send(`
      <html><body style="font-family:sans-serif;max-width:500px;margin:40px auto">
        <h1>❌ 服务器错误</h1>
        <pre>${err.message}</pre>
      </body></html>
    `);
  }
}
