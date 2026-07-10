/**
 * 自动化插件本地测试入口
 *
 * 使用方式:
 *   npm run build && npm test
 *
 * 修改下面的模拟参数来测试不同场景
 */
// 模拟自动化流程传入的参数
const mockArgs = {
    taskName: 'ai培训课程备课',
    tasklistValue: '宣传部',
    tasklistGuids: JSON.stringify({
        '学培部': '09132845-3bb2-43f6-9441-1849acee2bb4',
        '组织部': '17bd8f58-cb80-4bf7-a75f-ec4c2cab78a9',
        '宣传部': '799c5d11-ae8a-488e-9f9e-45c2be8ee249',
    }),
};
// 模拟 context（fetch 会在有 tenantAccessToken 时远程调用）
const mockContext = {
    tenantAccessToken: process.env.TENANT_ACCESS_TOKEN || '',
    fetch: async (url, options) => {
        console.log(`[Fetch] ${options?.method || 'GET'} ${url}`);
        return {
            json: async () => ({
                code: -1,
                msg: '请在飞书自动化预览中测试，本地无法模拟 task API',
            }),
        };
    },
};
async function main() {
    console.log('=== 自动化插件测试 ===');
    console.log('入参:', JSON.stringify(mockArgs, null, 2));
    console.log('');
    if (!mockContext.tenantAccessToken) {
        console.log('⚠️  未设置 TENANT_ACCESS_TOKEN 环境变量');
        console.log('   本地测试只能验证参数解析逻辑');
        console.log('   真正的功能测试请使用 npm run preview\n');
    }
    // 编译后直接 import 会报错，这里只是展示测试框架
    console.log('=== 测试框架说明 ===');
    console.log('1. npm run build    - 编译 TypeScript');
    console.log('2. npm run upload   - 上传到飞书');
    console.log('3. npm run preview  - 在线预览调试');
    console.log('');
    console.log('=== 模拟执行结果 ===');
    console.log('taskName:', mockArgs.taskName);
    console.log('departments:', mockArgs.tasklistValue);
    console.log('GUID map keys:', Object.keys(JSON.parse(mockArgs.tasklistGuids)));
}
main().catch(console.error);
