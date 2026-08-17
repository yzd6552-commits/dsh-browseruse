// 验证修复：模拟「残留 Chrome 占用 profile → 启动失败 → 清理 → 重试成功」
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const profileDir = join(homedir(), '.dsh', '.browseruse', 'chrome-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killResidualChrome(dir) {
  try {
    if (process.platform === 'win32') {
      spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*user-data-dir=${dir.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
        { stdio: 'ignore', timeout: 10000 });
    } else {
      spawnSync('pkill', ['-f', `user-data-dir=${dir}`], { stdio: 'ignore', timeout: 10000 });
    }
  } catch { /* ignore */ }
}

// 0) 清场
killResidualChrome(profileDir);
await sleep(500);

// 1) 模拟残留：启动一个占用该 profile 的裸 Chrome 进程（无 playwright 接管）
console.log('[1] 启动残留 Chrome 进程占用 profile ...');
const ghost = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--user-data-dir=' + profileDir, '--no-first-run', '--no-default-browser-check', 'about:blank'],
  { stdio: 'ignore', detached: true });
await sleep(2500);
let ghosts = spawnSync('pgrep', ['-f', `user-data-dir=${profileDir}`], { encoding: 'utf8' });
const ghostCountBefore = ghosts.stdout.trim().split('\n').filter(Boolean).length;
console.log(`     残留进程数: ${ghostCountBefore}`);
if (ghostCountBefore === 0) { console.log('!! 未能创建残留进程，测试中止'); process.exit(2); }

// 2) 模拟修复前：直接 launchPersistentContext 应失败（profile 被锁）
console.log('[2] 尝试直接启动（应失败）...');
let firstFailed = false;
try {
  await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless: false, viewport: null, acceptDownloads: true, args: ['--disable-notifications'],
  });
  console.log('     意外成功（说明残留未锁 profile，测试环境差异）');
} catch (e) {
  firstFailed = true;
  console.log('     符合预期失败: ' + String(e.message).slice(0, 120));
}
if (firstFailed) {
  // 3) 模拟修复：清理残留后重试
  console.log('[3] 清理残留进程并重试 ...');
  killResidualChrome(profileDir);
  await sleep(800);
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless: false, viewport: null, acceptDownloads: true, args: ['--disable-notifications'],
  });
  console.log('[4] 重试成功，浏览器已接管 profile');
  await context.close();
  console.log('=== 测试通过：修复逻辑有效 ===');
  process.exit(0);
} else {
  // 残留未锁时直接成功：尝试 close 掉我们刚启动的 context 再收尾
  console.log('=== 测试跳过（环境未复现锁） ===');
  process.exit(3);
}
