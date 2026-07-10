// api/auth.js — Vercel Serverless Function
// 飞书 OAuth 授权码流程：获取 Refresh Token
//
// 端点:
//   GET /api/auth              — 重定向到飞书授权页
//   GET /api/auth/callback     — 飞书回调，获取 refresh_token
//   GET /api/auth?setup=1      — 配置指引页面
//
// 环境变量:
//   FEISHU_APP_ID      飞书应用 App ID（必填）
//   FEISHU_APP_SECRET  飞书应用 App Secret（必填）
//   FEISHU_REFRESH_TOKEN  用户 Refresh Token（通过本页获取后设置）

const FEISHU_HOST = "https://open.feishu.cn";
const SCOPES = "task:task:read,task:task:write,base:record:read,task:tasklist:read";

function getRedirectUri(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}/api/auth/callback`;
}

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
  const { setup } = req.query;

  // ── 配置指引页面 ──
  if (setup === "1") {
    return res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;line-height:1.6">
        <h1>Vercel 飞书任务同步 — 配置指引</h1>
        <h3>环境变量要求：</h3>
        <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
          <tr><th>变量名</th><th>说明</th><th>来源</th></tr>
          <tr><td><code>FEISHU_APP_ID</code></td><td>App ID</td><td>开发者后台 → 凭证与基础信息</td></tr>
          <tr><td><code>FEISHU_APP_SECRET</code></td><td>App Secret</td><td>开发者后台 → 凭证与基础信息</td></tr>
          <tr><td><code>FEISHU_REFRESH_TOKEN</code></td><td>授权后获取</td><td>先设前两项，访问 <code>/api/auth</code></td></tr>
          <tr><td><code>FEISHU_BASE_URL</code></td><td>Base 链接</td><td>你的多维表格 URL</td></tr>
        </table>
        <h3>回调 URL 配置</h3>
        <p>在飞书开发者后台 →「安全设置」中，将以下地址添加到「重定向 URL」：</p>
        <pre id="callback-url">加载中...</pre>
        <p>然后 <a href="/api/auth">👉 开始授权</a></p>
        <script>
        fetch('/api/auth/callback?detect=1').then(r=>r.text()).then(url => {
          document.getElementById('callback-url').textContent = url;
        });
        </script>
      </body></html>
    `);
  }

  // ── 发起 OAuth 授权 ──
  const redirectUri = getRedirectUri(req);
  const authUrl =
    `${FEISHU_HOST}/open-apis/authen/v1/index?` +
    `app_id=${process.env.FEISHU_APP_ID}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=${SCOPES}`;

  return res.redirect(authUrl);
}
