// dsh-browseruse: browser-use 风格的浏览器自动化插件
// 通过 playwright-core 驱动一个专用 Google Chrome 实例（独立资料目录，cookie 持久，
// 不影响用户日常 Chrome）。可作为 dsh profile bundle（dsh plugin add）或 agent 预设
// 插件行（相对路径）安装。
// 只消费宿主服务（tools/llm/userQuestions/attachments/jobs），不发布服务。
// License: MIT

import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const name = 'dsh-browseruse';
export const inject = ['tools', 'llm'];

const PLUGIN_ID = 'dsh-browseruse';

// ---------- 规则常量 ----------
const DANGER_TEXT_PATTERNS = [
  /支付/, /付款/, /立即购买/, /马上购买/, /提交订单/, /确认订单/, /确认下单/, /去结算/,
  /收银台/, /删除账号/, /注销账户/, /注销账号/, /解绑/, /退订/, /永久删除/, /确认支付/,
  /checkout/i, /place\s*order/i, /confirm\s*payment/i, /pay\s*now/i,
];
const DANGER_URL_PATTERNS = [/(pay|payment|checkout|cashier)/i, /order\/(confirm|submit)/i];
const CAPTCHA_PATTERNS = [/验证码/, /人机验证/, /安全验证/, /拖动滑块/, /拖动下方滑块/, /verify\s+you\s+are/i, /captcha/i];

function defaults() {
  const home = homedir();
  const dshHome = process.env.DSH_HOME || join(home, '.dsh');
  return {
    profileDir: join(dshHome, '.browseruse', 'chrome-profile'),
    downloadsDir: join(home, 'Downloads'),
    maxSteps: 30,
    maxElements: 150,
    navTimeoutMs: 30000,
    textLimit: 8000,
  };
}

// ---------- 全局状态 ----------
const state = {
  context: null,
  launching: null,
  schedules: new Set(),
};

function activePage() {
  if (!state.context) return undefined;
  try {
    return state.context.pages().find((p) => !p.isClosed());
  } catch {
    return undefined;
  }
}

function getPage(tab) {
  if (!state.context) throw new Error('浏览器尚未启动，请先 browser_open 或 browser_task');
  const pages = state.context.pages();
  if (tab !== undefined && tab !== null) {
    const page = pages[Number(tab) - 1];
    if (!page || page.isClosed()) throw new Error(`标签页 ${tab} 不存在（当前 ${pages.length} 个标签）`);
    return page;
  }
  const page = pages.find((p) => !p.isClosed());
  if (!page) throw new Error('没有可用的标签页');
  return page;
}

async function ensureBrowser(cfg) {
  if (state.context) {
    try {
      if (activePage()) return state.context;
    } catch { /* 上下文可能已关闭 */ }
    state.context = null;
  }
  if (state.launching) return state.launching;
  state.launching = (async () => {
    mkdirSync(cfg.profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(cfg.profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      acceptDownloads: true,
      args: ['--disable-notifications'],
    });
    context.on('page', (page) => {
      page.on('download', (dl) => { state.lastDownload = dl; });
    });
    state.context = context;
    state.launching = null;
    return context;
  })().catch((error) => {
    state.launching = null;
    throw new Error('启动专用 Chrome 失败：' + (error && error.message ? error.message : String(error)));
  });
  return state.launching;
}

// ---------- DOM 快照（眼睛） ----------
async function captureSnapshot(page, cfg, withScreenshot, ctx, imageCapable) {
  const data = await page.evaluate(({ maxElements, textLimit }) => {
    const out = [];
    const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"]';
    for (const el of document.querySelectorAll(selector)) {
      if (out.length >= maxElements) break;
      const rect = el.getBoundingClientRect();
      if (rect.width < 3 || rect.height < 3) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
      const tag = el.tagName.toLowerCase();
      const text = ((el.innerText || '').trim() || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      el.setAttribute('data-bu-id', String(out.length));
      out.push({
        i: out.length,
        tag,
        text,
        type: el.getAttribute('type') || '',
        href: tag === 'a' ? (el.getAttribute('href') || '') : '',
        name: el.getAttribute('name') || '',
        role: el.getAttribute('role') || '',
      });
    }
    return {
      url: location.href,
      title: document.title,
      text: ((document.body && document.body.innerText) || '').replace(/\n{3,}/g, '\n\n').slice(0, textLimit),
      elements: out,
    };
  }, { maxElements: cfg.maxElements, textLimit: cfg.textLimit });
  const snapshot = { ...data, screenshot: undefined };
  if (withScreenshot && ctx && imageCapable) {
    const ref = await screenshotAttachment(ctx, page);
    if (ref) snapshot.screenshot = ref;
  }
  return snapshot;
}

async function screenshotAttachment(ctx, page) {
  const attachments = ctx.get('attachments');
  if (!attachments) return undefined;
  const limits = attachments.imageLimits || {};
  const maxBytes = Math.min(limits.maxImageBytes || 4e6, limits.maxMessageImageBytes || 4e6);
  const mediaTypes = limits.mediaTypes || ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  let buf;
  let mediaType = 'image/png';
  try {
    buf = await page.screenshot({ type: 'png', fullPage: false });
    if (buf.length > maxBytes && mediaTypes.includes('image/jpeg')) {
      buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
      mediaType = 'image/jpeg';
    }
    if (buf.length > maxBytes) {
      buf = await page.screenshot({ type: 'jpeg', quality: 35, fullPage: false });
      mediaType = 'image/jpeg';
    }
  } catch {
    return undefined;
  }
  try {
    const ref = await attachments.saveImage({
      data: new Uint8Array(buf),
      mediaType,
      name: `browser-${Date.now()}.${mediaType === 'image/png' ? 'png' : 'jpg'}`,
    });
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name ? { name: ref.name } : {}),
    };
  } catch {
    return undefined;
  }
}

function imageBlocks(screenshot) {
  if (!screenshot) return [];
  return [{ type: 'image', attachment: screenshot }];
}

// ---------- 交互动作（手） ----------
async function clickByIndex(page, index) {
  return page.evaluate((i) => {
    const el = document.querySelector(`[data-bu-id="${i}"]`);
    if (!el) return { ok: false, message: `找不到序号 ${i} 的元素（页面可能已变化，请重新 browser_snapshot）` };
    const text = ((el.innerText || '').trim() || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return { ok: true, message: `点击了 <${el.tagName.toLowerCase()}> "${text}"` };
  }, index);
}

async function clickByText(page, query) {
  return page.evaluate((q) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const nodes = [...document.querySelectorAll('a,button,input,[role="button"],[role="link"],[role="tab"]')];
    const matches = nodes.filter((el) => {
      const t = norm(el.innerText) || norm(el.value) || norm(el.getAttribute('aria-label')) || norm(el.getAttribute('placeholder'));
      return t && t.includes(q);
    });
    if (matches.length === 0) return { ok: false, message: `找不到包含 "${q}" 的可点击元素` };
    matches.sort((a, b) => norm(a.innerText).length - norm(b.innerText).length);
    const el = matches[0];
    const text = norm(el.innerText).slice(0, 80);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return { ok: true, message: `点击了 <${el.tagName.toLowerCase()}> "${text}"` };
  }, query);
}

async function settleAfterClick(page, cfg) {
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: Math.min(cfg.navTimeoutMs, 6000) }).catch(() => {}),
    page.waitForTimeout(900),
  ]);
}

async function typeInto(page, text, index, pressEnter) {
  return page.evaluate(({ i, t, enter }) => {
    let el;
    if (i !== undefined && i !== null) el = document.querySelector(`[data-bu-id="${i}"]`);
    if (!el) el = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : null;
    if (!el) return { ok: false, message: '没有可输入的目标：请先点击输入框，或给 index' };
    const tag = el.tagName.toLowerCase();
    el.focus();
    if (el.isContentEditable) {
      el.textContent = t;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else if (tag === 'input' || tag === 'textarea') {
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, t);
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.value = t;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    if (enter) {
      const form = el.closest('form');
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        return { ok: true, message: '已输入并提交表单' };
      }
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      return { ok: true, message: '已输入并按下回车' };
    }
    return { ok: true, message: `已在 <${tag}> 输入 ${t.length} 个字符` };
  }, { i: index, t: text, enter: !!pressEnter });
}

async function fillForm(page, fields, submit, submitText, cfg) {
  const results = [];
  for (const f of fields) {
    const value = String(f.value ?? '');
    const done = await page.evaluate(({ text, idx, val }) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      let el;
      if (idx !== undefined && idx !== null) el = document.querySelector(`[data-bu-id="${idx}"]`);
      if (!el && text) {
        for (const n of document.querySelectorAll('input,select,textarea')) {
          const label = n.labels && n.labels[0] ? norm(n.labels[0].innerText) : '';
          const hay = [norm(n.getAttribute('placeholder')), norm(n.getAttribute('name')), norm(n.getAttribute('aria-label')), label].join(' ');
          if (hay && hay.includes(text)) { el = n; break; }
        }
      }
      if (!el) return { ok: false, message: `找不到字段 "${text || ('#' + idx)}"` };
      const tag = el.tagName.toLowerCase();
      el.focus();
      if (tag === 'select') {
        const option = [...el.options].find((o) => norm(o.text).includes(val) || o.value === val);
        if (!option) return { ok: false, message: `下拉框无匹配选项 "${val}"` };
        el.value = option.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true, message: `已填写 <${tag}> "${text || ('#' + idx)}"` };
    }, { text: f.text, idx: f.index, val: value });
    if (!done.ok) return { ok: false, message: done.message, results };
    results.push(done.message);
  }
  if (submit) {
    let clicked = false;
    if (submitText) {
      const r = await clickByText(page, submitText);
      clicked = r.ok;
      results.push(r.ok ? `点击提交 "${submitText}"` : `提交按钮未找到：${r.message}`);
    } else {
      const r = await page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const words = ['提交', '确认', '登录', '注册', '搜索', '查询', '确定', '保存', 'submit', 'confirm'];
        const nodes = [...document.querySelectorAll('button,input[type=submit],input[type=button],[role=button]')];
        const el = nodes.find((n) => words.some((w) => norm(n.innerText || n.value).includes(w)));
        if (!el) return { ok: false, message: '未找到提交按钮，请指定 submitText' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return { ok: true, message: `点击提交按钮 "${norm(el.innerText || el.value).slice(0, 60)}"` };
      });
      clicked = r.ok;
      results.push(r.message);
    }
    if (clicked) await settleAfterClick(page, cfg);
  }
  return { ok: true, message: results.join('；'), results };
}

// ---------- 危险操作与验证码 ----------
function dangerDescriptionFor(action, elements) {
  if (!action) return undefined;
  const text = String(action.text ?? action.submitText ?? '');
  if (DANGER_TEXT_PATTERNS.some((re) => re.test(text))) return `操作文本命中敏感词："${text}"`;
  if (action.action === 'click' && action.index !== undefined && Array.isArray(elements)) {
    const el = elements.find((e) => e.i === action.index);
    if (el && DANGER_TEXT_PATTERNS.some((re) => re.test(el.text || ''))) {
      return `点击元素 <${el.tag}> "${el.text}"`;
    }
  }
  if (action.action === 'goto' && DANGER_URL_PATTERNS.some((re) => re.test(String(action.url || '')))) {
    return `跳转到疑似支付/订单页面 ${action.url}`;
  }
  if (action.action === 'fill' && action.submit) return '提交表单（可能下单/支付）';
  return undefined;
}

async function confirmDanger(ctx, exec, description) {
  const uq = ctx.get('userQuestions');
  if (!uq) return { allowed: false, reason: '当前没有用户问答通道，已阻止该操作' };
  try {
    const answer = await uq.ask({
      questions: [{
        id: 'browseruse-danger',
        header: '⚠️ 危险操作确认',
        question: `浏览器即将执行一个可能敏感的操作：\n${description}\n\n是否允许执行？`,
        options: [{ label: '允许执行' }, { label: '取消' }],
      }],
      agent: exec ? exec.agent : undefined,
      signal: exec ? exec.signal : undefined,
    });
    const selected = (answer && answer.answers && answer.answers[0] && answer.answers[0].selected) || [];
    return selected.includes('允许执行') ? { allowed: true } : { allowed: false, reason: '用户选择取消' };
  } catch (error) {
    return { allowed: false, reason: '无法询问用户（' + (error && error.message ? error.message : String(error)) + '），已阻止' };
  }
}

async function pauseCaptcha(ctx, exec, note) {
  const uq = ctx.get('userQuestions');
  if (!uq) return { resume: true, note: '发现疑似验证码，但当前没有用户问答通道，继续尝试' };
  try {
    const answer = await uq.ask({
      questions: [{
        id: 'browseruse-captcha',
        header: '验证码处理',
        question: `页面疑似出现验证码/人机验证（${note}）。\n请在专用 Chrome 窗口里亲自处理，完成后选择：`,
        options: [{ label: '已处理，继续' }, { label: '停止任务' }],
      }],
      agent: exec ? exec.agent : undefined,
      signal: exec ? exec.signal : undefined,
    });
    const selected = (answer && answer.answers && answer.answers[0] && answer.answers[0].selected) || [];
    if (selected.includes('停止任务')) return { resume: false };
    return { resume: true };
  } catch (error) {
    return { resume: true, note: '无法询问用户：' + (error && error.message ? error.message : String(error)) };
  }
}

function detectCaptcha(snap) {
  const hay = `${snap.title || ''}\n${(snap.text || '').slice(0, 4000)}`;
  for (const re of CAPTCHA_PATTERNS) if (re.test(hay)) return `页面文本命中特征 ${String(re)}`;
  return undefined;
}

// ---------- 模型调用 ----------
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

let messageCounter = 0;
function mkUser(blocks) {
  return deepFreeze({ id: `${PLUGIN_ID}-msg-${++messageCounter}`, role: 'user', content: blocks, source: { kind: 'plugin', plugin: PLUGIN_ID } });
}
function mkAssistant(env, text) {
  return deepFreeze({ id: `${PLUGIN_ID}-msg-${++messageCounter}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: env.provider, model: env.model } });
}

async function llmCall(ctx, env, system, messages, maxTokens, timeoutMs) {
  const controller = new AbortController();
  const outer = env.signal;
  const onOuterAbort = () => controller.abort(outer.reason);
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort('browser-use llm timeout'), timeoutMs);
  try {
    let text = '';
    let finish;
    for await (const chunk of ctx.llm.stream({
      provider: env.provider,
      model: env.model,
      messages,
      system,
      maxTokens,
      temperature: 0.2,
      signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      else if (chunk.type === 'finish') finish = chunk.reason;
    }
    if (!finish || finish.kind !== 'stop') {
      throw new Error('模型调用未正常结束：' + (finish ? finish.kind : 'no finish') + (finish && finish.failure ? ` (${finish.failure.code}: ${finish.failure.message})` : ''));
    }
    return { text: text.trim() };
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onOuterAbort);
  }
}

function parseAction(raw) {
  const s = String(raw).trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('输出中没有 JSON 对象');
  const parsed = JSON.parse(candidate.slice(start, end + 1));
  if (typeof parsed.action !== 'string') throw new Error('动作对象缺少 action 字段');
  return parsed;
}

// ---------- 自主任务循环 ----------
const TASK_SYSTEM_PROMPT = [
  '你是一个浏览器自动化智能体（browser-use 风格），负责用真实浏览器完成用户目标。',
  '规则：',
  '1. 每次只返回一个 JSON 动作对象，不要输出任何其他内容。',
  '2. 根据「可交互元素」列表选择动作；序号（index）来自该列表。',
  '3. 点击优先用 index；index 不可用时才用 text。',
  '4. 输入前先确认目标输入框的 index。',
  '5. 页面滚动或跳转后元素序号会变化，需要重新观察。',
  '6. 目标达成后立即返回 done 并给出 summary；连续失败时也返回 done 说明原因。',
  '7. 遇到验证码/人机验证时返回 captcha 动作。',
].join('\n');

const ACTION_SCHEMA_TEXT = [
  '{"action":"click","index":0}                    点击序号元素',
  '{"action":"click","text":"登录"}                按可见文字点击',
  '{"action":"type","index":1,"text":"内容","pressEnter":false}  向序号元素输入',
  '{"action":"scroll","direction":"down","amount":600}  滚动（direction: down|up，amount 像素）',
  '{"action":"goto","url":"https://..."}           打开网址',
  '{"action":"back"}                               返回上一页',
  '{"action":"captcha","reason":"..."}             页面出现验证码，需要用户亲自处理',
  '{"action":"done","summary":"任务完成说明"}       目标已达成，结束任务',
].join('\n');

function buildPrompt(goal, snap, step, maxSteps) {
  const elements = (snap.elements || []).map((e) => `${e.i}. <${e.tag}${e.type ? ' type=' + e.type : ''}> ${e.text}${e.href ? ' href=' + e.href.slice(0, 100) : ''}`).join('\n');
  return [
    `## 目标\n${goal}`,
    `## 当前进度\n第 ${step + 1} 步 / 上限 ${maxSteps} 步`,
    `## 页面信息\nURL: ${snap.url}\n标题: ${snap.title}`,
    `## 页面文本\n${(snap.text || '').slice(0, 6000)}`,
    `## 可交互元素\n${elements || '（无）'}`,
    `## 你的动作（只返回一个 JSON 对象，不要任何解释）\n${ACTION_SCHEMA_TEXT}`,
  ].join('\n\n');
}

async function executeLoopAction(page, action, cfg) {
  switch (action.action) {
    case 'click': {
      let r;
      if (action.index !== undefined && action.index !== null) r = await clickByIndex(page, Number(action.index));
      else if (action.text) r = await clickByText(page, String(action.text));
      else return { message: 'click 需要 index 或 text' };
      if (!r.ok) return { message: r.message };
      await settleAfterClick(page, cfg);
      return { message: r.message };
    }
    case 'type': {
      const r = await typeInto(page, String(action.text ?? ''), action.index, !!action.pressEnter);
      if (r.ok && action.pressEnter) await settleAfterClick(page, cfg);
      return { message: r.message };
    }
    case 'scroll': {
      const amount = (Math.abs(Number(action.amount)) || 600) * (action.direction === 'up' ? -1 : 1);
      await page.evaluate((a) => window.scrollBy(0, a), amount);
      await page.waitForTimeout(300);
      return { message: `页面已滚动 ${amount > 0 ? '↓' : '↑'} ${Math.abs(amount)}px` };
    }
    case 'goto': {
      const url = String(action.url || '');
      if (!url) return { message: 'goto 需要 url' };
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
        return { message: `已打开 ${url}` };
      } catch (e) {
        return { message: `打开 ${url} 超时/失败：${e && e.message ? e.message : e}` };
      }
    }
    case 'back': {
      try {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
        return { message: '已返回上一页' };
      } catch (e) {
        return { message: `返回失败：${e && e.message ? e.message : e}` };
      }
    }
    default:
      return { message: `不支持的动作 ${action.action}` };
  }
}

async function runTask(ctx, env, cfg, goal, startUrl, maxSteps, report) {
  await ensureBrowser(cfg);
  let page = activePage() || await state.context.newPage();
  if (startUrl) {
    try {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
    } catch (e) {
      report(`startUrl 打开警告: ${e && e.message ? e.message : e}`);
    }
  }
  const history = [];
  let steps = 0;
  let summary = '';
  while (steps < maxSteps) {
    if (env.signal && env.signal.aborted) throw new Error('任务被取消');
    const snap = await captureSnapshot(page, cfg, true, ctx, env.imageCapable);
    const captchaNote = detectCaptcha(snap);
    if (captchaNote) {
      const r = await pauseCaptcha(ctx, env.exec, captchaNote);
      if (!r.resume) return { status: 'stopped', summary: summary || '用户停止任务（验证码处理）', steps };
      history.push(mkAssistant(env, '用户已在浏览器中处理验证码，重新观察页面并继续。'));
      continue;
    }
    const blocks = [{ type: 'text', text: buildPrompt(goal, snap, steps, maxSteps) }];
    if (snap.screenshot && env.imageCapable) blocks.push({ type: 'image', attachment: snap.screenshot });
    history.push(mkUser(blocks));
    const reply = await llmCall(ctx, env, TASK_SYSTEM_PROMPT, history, 1600, 90000);
    let action;
    try {
      action = parseAction(reply.text);
    } catch (e) {
      report(`[step ${steps + 1}] 模型输出无法解析（${e.message}），重试`);
      history.push(mkAssistant(env, `输出无法解析：${reply.text.slice(0, 200)}\n请只返回一个 JSON 动作对象。`));
      steps++;
      continue;
    }
    if (action.action === 'done') {
      summary = String(action.summary || '任务完成');
      report(`完成：${summary}`);
      return { status: 'completed', summary, steps: steps + 1 };
    }
    if (action.action === 'captcha') {
      const r = await pauseCaptcha(ctx, env.exec, String(action.reason || '模型报告出现验证码'));
      if (!r.resume) return { status: 'stopped', summary: summary || '用户停止任务（验证码处理）', steps };
      history.push(mkAssistant(env, '用户已处理验证码，继续。'));
      continue;
    }
    const danger = dangerDescriptionFor(action, snap.elements);
    if (danger) {
      const ok = await confirmDanger(ctx, env.exec, danger);
      if (!ok.allowed) {
        report(`[step ${steps + 1}] 已阻止：${danger}（${ok.reason}）`);
        history.push(mkAssistant(env, `动作被阻止：${danger}（${ok.reason}）。请换一种方式，或返回 {"action":"done","summary":"..."} 结束任务。`));
        steps++;
        continue;
      }
      report(`[step ${steps + 1}] 用户已批准：${danger}`);
    }
    try {
      const r = await executeLoopAction(page, action, cfg);
      report(`[step ${steps + 1}] ${JSON.stringify(action)} → ${r.message}`);
      history.push(mkAssistant(env, `执行 ${JSON.stringify(action)}\n观察：${r.message}`));
    } catch (e) {
      report(`[step ${steps + 1}] 动作失败: ${e && e.message ? e.message : String(e)}`);
      history.push(mkAssistant(env, `动作失败：${e && e.message ? e.message : String(e)}`));
    }
    steps++;
    if (history.length > 12) history.splice(0, history.length - 10);
  }
  return { status: 'max-steps', summary: summary || '达到步数上限', steps };
}

// ---------- 后台任务 ----------
function startBrowserJob(ctx, env, cfg, goal, maxSteps, startUrl) {
  const jobs = ctx.get('jobs');
  const controller = new AbortController();
  let cancelled = false;
  const buffer = [];
  const report = (text) => { buffer.push(text + '\n'); };
  const donePromise = (async () => {
    try {
      const jobEnv = { ...env, signal: controller.signal, exec: env.agent ? { agent: env.agent, signal: undefined } : undefined };
      const result = await runTask(ctx, jobEnv, cfg, goal, startUrl, maxSteps, report);
      return { status: 'completed', detail: `${result.status} · ${result.steps} 步 · ${result.summary}` };
    } catch (error) {
      if (cancelled) return { status: 'killed', detail: String(controller.signal.reason || '已取消') };
      return { status: 'failed', detail: error && error.message ? error.message : String(error) };
    }
  })();
  const jobId = jobs.start({
    kind: 'browser',
    label: `browser_task: ${goal.slice(0, 80)}`,
    owner: env.agent,
    run: () => ({
      cancel: (reason) => { cancelled = true; controller.abort(reason); },
      done: donePromise,
      readOutput: () => { const d = buffer.splice(0).join(''); return d; },
    }),
  });
  return jobId;
}

// ---------- 定时 ----------
function parseAt(at) {
  const raw = String(at).trim();
  let t;
  if (/^\d{4}-\d{2}-\d{2}(T|\s)/.test(raw)) {
    t = new Date(raw).getTime();
  } else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
    const parts = raw.split(':').map(Number);
    const d = new Date();
    d.setHours(parts[0], parts[1], parts[2] || 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    t = d.getTime();
  } else if (/^\+?\d+$/.test(raw)) {
    t = Date.now() + Number(raw) * 1000;
  } else {
    throw new Error('at 格式不支持：请用 ISO 时间（如 2026-08-15T20:00:00）、"HH:MM"（当天，过了算明天）或秒数（如 300）');
  }
  if (!Number.isFinite(t)) throw new Error('at 无法解析为有效时间');
  if (t <= Date.now()) throw new Error('at 时间已过');
  if (t - Date.now() > 2147483647) throw new Error('定时超过上限（约 24.8 天）');
  return t;
}

// ---------- 环境解析 ----------
async function resolveEnv(ctx, exec) {
  const routed = exec && exec.agent && exec.agent.session ? exec.agent.session.requestHeader()?.config : undefined;
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  if (!provider || !model) throw new Error('无法确定当前会话的模型路由（provider/model）');
  let imageCapable = false;
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model, exec ? exec.signal : undefined);
    imageCapable = !!info.inputModalities && info.inputModalities.includes('image');
  } catch { /* 保守起见：不传截图 */ }
  return { agent: exec ? exec.agent : undefined, provider, model, imageCapable, exec, signal: exec ? exec.signal : undefined };
}

// ---------- 工具注册 ----------
function compileParams(spec) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    const { required: req, ...rest } = value;
    properties[key] = rest;
    if (req) required.push(key);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

function register(ctx, def) {
  const tool = {
    name: def.name,
    description: def.description,
    parameters: compileParams(def.parameters || {}),
    output: {
      schema: {},
      render: def.render || ((_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]),
    },
    async execute(args, exec) {
      return def.execute(args || {}, exec);
    },
  };
  return ctx.tools.register(tool);
}

function renderElements(value) {
  const lines = (value.elements || []).map((e) => `${e.i}. <${e.tag}${e.type ? ' type=' + e.type : ''}> ${e.text}${e.href ? ' href=' + e.href.slice(0, 100) : ''}`);
  return lines.slice(0, 120).join('\n');
}

function registerTools(ctx, cfg) {
  // 眼睛
  register(ctx, {
    name: 'browser_snapshot',
    description: '读取当前标签页快照：URL、标题、页面文本、可交互元素列表（含序号）与截图。这是"眼睛"，点击/输入都用这里的序号。',
    parameters: {
      includeScreenshot: { type: 'boolean', description: '是否附带截图（默认 true；当前模型不支持图片时自动省略）' },
      maxElements: { type: 'number', description: '最多收集多少个可交互元素（默认 150）' },
      tab: { type: 'number', description: '标签页序号（1 起始，默认当前激活标签）' },
    },
    async execute(args, exec) {
      await ensureBrowser(cfg);
      const page = getPage(args.tab);
      const env = await resolveEnv(ctx, exec);
      const maxElements = Math.min(Math.max(Number(args.maxElements) || cfg.maxElements, 5), 500);
      const snap = await captureSnapshot(page, { ...cfg, maxElements }, args.includeScreenshot !== false, ctx, env.imageCapable);
      const pages = state.context.pages();
      const tabs = [];
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].isClosed()) continue;
        tabs.push({ index: i + 1, url: pages[i].url(), title: await pages[i].title().catch(() => '') });
      }
      return {
        url: snap.url, title: snap.title, text: snap.text, elements: snap.elements,
        tabs, screenshot: snap.screenshot,
        note: env.imageCapable ? undefined : '当前模型不支持图片输入，截图已省略',
      };
    },
    render(_args, value) {
      const blocks = [{ type: 'text', text: [
        `URL: ${value.url}`,
        `标题: ${value.title}`,
        value.note ? `注意: ${value.note}` : '',
        `标签页: ${(value.tabs || []).map((t) => `${t.index}: ${t.title.slice(0, 40)} (${t.url.slice(0, 80)})`).join(' | ') || '（无）'}`,
        `可交互元素（序号用于 browser_click/browser_type）:`,
        renderElements(value),
        `页面文本:`,
        (value.text || '').slice(0, 4000),
      ].filter((l) => l !== '').join('\n') }];
      return blocks.concat(imageBlocks(value.screenshot));
    },
  });

  // 手
  register(ctx, {
    name: 'browser_open',
    description: '打开一个网址（自动启动专用 Chrome 实例）。newTab=true 时新开标签页，否则复用当前标签。',
    parameters: {
      url: { type: 'string', required: true, description: '要打开的完整网址（含 https://）' },
      newTab: { type: 'boolean', description: '是否在新标签页打开（默认 false）' },
    },
    async execute(args) {
      await ensureBrowser(cfg);
      const url = String(args.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('url 需要以 http:// 或 https:// 开头');
      let page;
      if (args.newTab === true || !activePage()) page = await state.context.newPage();
      else page = activePage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
      } catch (e) {
        return { url, title: '（打开超时/失败）', note: e && e.message ? e.message : String(e) };
      }
      return { url: page.url(), title: await page.title().catch(() => ''), tabs: state.context.pages().filter((p) => !p.isClosed()).length };
    },
    render(_a, v) {
      return [{ type: 'text', text: v.note ? `已尝试打开 ${v.url}，但：${v.note}` : `已打开 ${v.url}（标题：${v.title}，共 ${v.tabs} 个标签）` }];
    },
  });

  register(ctx, {
    name: 'browser_click',
    description: '点击页面元素：按快照序号（index）或可见文字（text）。命中支付/下单/删除等敏感元素会先征求用户同意。',
    parameters: {
      index: { type: 'number', description: 'browser_snapshot 给出的元素序号' },
      text: { type: 'string', description: '按可见文字点击（index 更精确，优先用 index）' },
      tab: { type: 'number', description: '标签页序号（默认当前激活标签）' },
    },
    async execute(args, exec) {
      await ensureBrowser(cfg);
      const page = getPage(args.tab);
      const snap = await captureSnapshot(page, cfg, false, ctx, false);
      const danger = dangerDescriptionFor({ action: 'click', index: args.index, text: args.text }, snap.elements);
      if (danger) {
        const ok = await confirmDanger(ctx, exec, danger);
        if (!ok.allowed) throw new Error(`操作被阻止：${danger}（${ok.reason}）`);
      }
      let r;
      if (args.index !== undefined && args.index !== null) r = await clickByIndex(page, Number(args.index));
      else if (args.text) r = await clickByText(page, String(args.text));
      else throw new Error('browser_click 需要 index 或 text 之一');
      if (!r.ok) throw new Error(r.message);
      await settleAfterClick(page, cfg);
      return { message: r.message, url: page.url(), title: await page.title().catch(() => '') };
    },
    render(_a, v) { return [{ type: 'text', text: `${v.message}（当前页：${v.url}）` }]; },
  });

  register(ctx, {
    name: 'browser_type',
    description: '向指定序号元素（或当前焦点）输入文字；pressEnter=true 时提交所在表单（等价按下回车）。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文字' },
      index: { type: 'number', description: '目标输入框的序号（来自 browser_snapshot；不填则输入到当前焦点元素）' },
      pressEnter: { type: 'boolean', description: '输入后是否按回车提交（默认 false）' },
      tab: { type: 'number', description: '标签页序号（默认当前激活标签）' },
    },
    async execute(args) {
      await ensureBrowser(cfg);
      const page = getPage(args.tab);
      const r = await typeInto(page, String(args.text ?? ''), args.index, !!args.pressEnter);
      if (!r.ok) throw new Error(r.message);
      if (args.pressEnter) await settleAfterClick(page, cfg);
      return { message: r.message, url: page.url() };
    },
    render(_a, v) { return [{ type: 'text', text: v.message }]; },
  });

  register(ctx, {
    name: 'browser_scroll',
    description: '滚动页面。direction: down|up；amount 为像素（默认 600）。滚动后元素序号会变，需重新 browser_snapshot。',
    parameters: {
      direction: { type: 'string', required: true, enum: ['down', 'up'], description: '滚动方向' },
      amount: { type: 'number', description: '滚动像素（默认 600）' },
      tab: { type: 'number', description: '标签页序号（默认当前激活标签）' },
    },
    async execute(args) {
      await ensureBrowser(cfg);
      const page = getPage(args.tab);
      const amount = (Math.abs(Number(args.amount)) || 600) * (args.direction === 'up' ? -1 : 1);
      await page.evaluate((a) => window.scrollBy(0, a), amount);
      await page.waitForTimeout(300);
      return { message: `页面已滚动 ${amount > 0 ? '↓' : '↑'} ${Math.abs(amount)}px` };
    },
    render(_a, v) { return [{ type: 'text', text: v.message }]; },
  });

  register(ctx, {
    name: 'browser_navigate',
    description: '浏览器导航：back 后退 / forward 前进 / reload 刷新。',
    parameters: {
      action: { type: 'string', required: true, enum: ['back', 'forward', 'reload'], description: '导航动作' },
      tab: { type: 'number', description: '标签页序号（默认当前激活标签）' },
    },
    async execute(args) {
      await ensureBrowser(cfg);
      const page = getPage(args.tab);
      try {
        if (args.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
        else if (args.action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
        else await page.reload({ waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
      } catch (e) {
        throw new Error(`${args.action} 失败：${e && e.message ? e.message : e}`);
      }
      return { message: `已执行 ${args.action}`, url: page.url() };
    },
    render(_a, v) { return [{ type: 'text', text: `${v.message}（当前：${v.url}）` }]; },
  });

  register(ctx, {
    name: 'browser_tabs',
    description: '标签页管理：list 列出所有标签 / switch 切换到序号标签 / close 关闭序号标签 / new 新建空白标签。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'switch', 'close', 'new'], description: '操作' },
      tab: { type: 'number', description: '目标标签页序号（switch/close 必填，1 起始）' },
    },
    async execute(args) {
      await ensureBrowser(cfg);
      if (args.action === 'new') {
        const page = await state.context.newPage();
        await page.bringToFront();
        const pages = state.context.pages();
        return { message: `已新建标签，共 ${pages.length} 个`, tabs: tabsSnapshot(pages) };
      }
      const pages = state.context.pages();
      if (args.action === 'list') return { message: `共 ${pages.length} 个标签`, tabs: tabsSnapshot(pages) };
      const idx = Number(args.tab);
      if (!idx || idx < 1 || idx > pages.length) throw new Error(`标签序号需在 1..${pages.length} 之间`);
      const page = pages[idx - 1];
      if (args.action === 'switch') {
        await page.bringToFront();
        return { message: `已切换到标签 ${idx}：${await page.title().catch(() => '')}`, url: page.url(), tabs: tabsSnapshot(pages) };
      }
      if (args.action === 'close') {
        await page.close();
        const left = state.context.pages().filter((p) => !p.isClosed());
        return { message: `已关闭标签 ${idx}，剩余 ${left.length} 个`, tabs: tabsSnapshot(left) };
      }
      throw new Error('未知 action');
    },
    render(_a, v) {
      const tabs = (v.tabs || []).map((t) => `${t.index}: ${t.title.slice(0, 40)} (${t.url.slice(0, 80)})`).join('\n');
      return [{ type: 'text', text: `${v.message}\n${tabs}` }];
    },
  });

  function tabsSnapshot(pages) {
    return pages.filter((p) => !p.isClosed()).map((p, i) => ({ index: i + 1, url: p.url(), title: '' }));
  }

  register(ctx, {
    name: 'browser_fill_form',
    description: '按字段批量填写表单（字段按 placeholder/name/aria-label/标签文字匹配，或给快照序号），可选提交。提交若疑似下单/支付会先征求用户同意。',
    parameters: {
      fields: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            text: { type: 'string', description: '匹配字段的文字（placeholder/name/标签文字）' },
            index: { type: 'number', description: '或直接给 browser_snapshot 的元素序号' },
            value: { type: 'string', description: '要填的值' },
          },
          required: ['value'],
        },
        description: '字段列表，例：[{"text":"用户名","value":"yao"},{"text":"密码","value":"..."}]',
      },
      submit: { type: 'boolean', description: '是否填写后提交（默认 false）' },
      submitText: { type: 'string', description: '提交按钮文字（不填则自动找 提交/登录/搜索 等）' },
      tab: { type: 'number', description: '标签页序号（默认当前激活标签）' },
    },
    async execute(args, exec) {
      await ensureBrowser(cfg);
      const page = getPage(args.tab);
      if (!Array.isArray(args.fields) || args.fields.length === 0) throw new Error('fields 至少需要一项');
      if (args.submit) {
        const snap = await captureSnapshot(page, cfg, false, ctx, false);
        const hay = `${(snap.text || '').slice(0, 4000)} ${String(args.submitText || '')}`;
        const hit = DANGER_TEXT_PATTERNS.find((re) => re.test(hay));
        if (hit) {
          const ok = await confirmDanger(ctx, exec, `提交表单（页面/按钮文本疑似敏感，命中 ${String(hit)}）`);
          if (!ok.allowed) throw new Error(`操作被阻止：提交表单（${ok.reason}）`);
        }
      }
      const r = await fillForm(page, args.fields, !!args.submit, args.submitText ? String(args.submitText) : undefined, cfg);
      if (!r.ok) throw new Error(r.message);
      return { message: r.message, url: page.url() };
    },
    render(_a, v) { return [{ type: 'text', text: v.message }]; },
  });

  register(ctx, {
    name: 'browser_download',
    description: '触发并保存下载：给 url 直接下载该地址；不给 url 则捕获当前页面接下来 20 秒内触发的下载。文件保存到 ~/Downloads。',
    parameters: {
      url: { type: 'string', description: '要下载的地址（可选）' },
      tab: { type: 'number', description: '标签页序号（默认当前激活标签）' },
    },
    async execute(args) {
      await ensureBrowser(cfg);
      const page = getPage(args.tab);
      const dlPromise = page.waitForEvent('download', { timeout: args.url ? cfg.navTimeoutMs : 20000 }).catch(() => null);
      if (args.url) {
        try {
          await page.goto(String(args.url), { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
        } catch { /* 直接下载型导航常以 ERR_ABORTED 结束，属正常 */ }
      }
      const dl = await dlPromise;
      if (!dl) throw new Error('没有捕获到下载（若需先点击下载链接，请先 browser_click 再调用本工具且不要给 url）');
      mkdirSync(cfg.downloadsDir, { recursive: true });
      const filename = dl.suggestedFilename();
      const target = join(cfg.downloadsDir, filename);
      await dl.saveAs(target);
      return { path: target, suggestedFilename: filename };
    },
    render(_a, v) { return [{ type: 'text', text: `已保存下载：${v.path}` }]; },
  });

  // 大脑 + 定时
  register(ctx, {
    name: 'browser_task',
    description: 'browser-use 式自主任务：给定自然语言目标，插件内部循环「看页面→调模型决策→操作」直到完成（默认上限 30 步，遇到危险操作会问你、遇到验证码会暂停）。在后台运行并返回 jobId，用 job_output(job_id, wait=true) 跟踪进度。',
    parameters: {
      goal: { type: 'string', required: true, description: '自然语言目标，如：打开百度搜索"苹果发布会"并总结前三条结果' },
      maxSteps: { type: 'number', description: '最大步数（默认 30，上限 100）' },
      startUrl: { type: 'string', description: '起始网址（可选，默认从当前标签页开始）' },
    },
    async execute(args, exec) {
      const goal = String(args.goal || '').trim();
      if (!goal) throw new Error('goal 必填');
      const maxSteps = Math.min(Math.max(Number(args.maxSteps) || cfg.maxSteps, 1), 100);
      const env = await resolveEnv(ctx, exec);
      const jobs = ctx.get('jobs');
      if (!jobs) {
        const buffer = [];
        const res = await runTask(ctx, env, cfg, goal, args.startUrl ? String(args.startUrl) : undefined, maxSteps, (t) => buffer.push(t));
        return { jobId: null, inline: true, ...res, log: buffer.join('\n') };
      }
      try {
        const jobId = startBrowserJob(ctx, env, cfg, goal, maxSteps, args.startUrl ? String(args.startUrl) : undefined);
        return { jobId, inline: false, note: '任务已在后台启动' };
      } catch (error) {
        const buffer = [];
        const res = await runTask(ctx, env, cfg, goal, args.startUrl ? String(args.startUrl) : undefined, maxSteps, (t) => buffer.push(t));
        return { jobId: null, inline: true, ...res, log: buffer.join('\n'), fallbackNote: `后台任务不可用（${error && error.message ? error.message : error}），已改为同步执行` };
      }
    },
    render(_a, v) {
      if (!v.inline) return [{ type: 'text', text: `✅ 已启动浏览器任务（jobId: ${v.jobId}）。\n用 job_output(job_id="${v.jobId}", wait=true) 跟踪进度；停止用 job_kill("${v.jobId}")。` }];
      return [{ type: 'text', text: [
        v.fallbackNote || `（同步执行完成）`,
        `结果状态: ${v.status}`,
        `步数: ${v.steps}`,
        `总结: ${v.summary}`,
        `执行日志:\n${v.log || '（无）'}`,
      ].filter((l) => l !== '').join('\n') }];
    },
  });

  register(ctx, {
    name: 'browser_schedule',
    description: '定时任务：到点自动启动一个 browser_task 后台任务（抢购/抢票场景）。本会话内有效；DSH 重启后需重新排程。',
    parameters: {
      goal: { type: 'string', required: true, description: '到点要执行的目标' },
      at: { type: 'string', required: true, description: '执行时间：ISO 时间（2026-08-15T20:00:00）、"HH:MM"（当天，过了算明天）或秒数（如 300）' },
      maxSteps: { type: 'number', description: '最大步数（默认 30，上限 100）' },
      startUrl: { type: 'string', description: '起始网址（可选）' },
    },
    async execute(args, exec) {
      const goal = String(args.goal || '').trim();
      if (!goal) throw new Error('goal 必填');
      const atMs = parseAt(args.at);
      const delay = atMs - Date.now();
      const maxSteps = Math.min(Math.max(Number(args.maxSteps) || cfg.maxSteps, 1), 100);
      const env = await resolveEnv(ctx, exec);
      const baseEnv = { ...env, signal: undefined, exec: env.agent ? { agent: env.agent, signal: undefined } : undefined };
      const timer = setTimeout(() => {
        state.schedules.delete(timer);
        try {
          startBrowserJob(ctx, baseEnv, cfg, goal, maxSteps, args.startUrl ? String(args.startUrl) : undefined);
        } catch (error) {
          console.error('[dsh-browseruse] 定时任务启动失败:', error);
        }
      }, delay);
      state.schedules.add(timer);
      return { runAt: new Date(atMs).toISOString(), delayMs: delay, pending: state.schedules.size };
    },
    render(_a, v) {
      return [{ type: 'text', text: `⏰ 已排程：${v.runAt}（${Math.round(v.delayMs / 1000)} 秒后自动开始）。到点后会出现在后台任务列表，可用 job_list 查看。当前待执行排程：${v.pending} 个。` }];
    },
  });

  // 状态
  register(ctx, {
    name: 'browser_status',
    description: '查看浏览器运行状态：是否已启动、标签页、资料目录、下载目录、待执行定时任务数。',
    parameters: {},
    async execute() {
      let tabs = [];
      if (state.context) {
        const pages = state.context.pages();
        for (let i = 0; i < pages.length; i++) {
          if (pages[i].isClosed()) continue;
          tabs.push({ index: i + 1, url: pages[i].url(), title: await pages[i].title().catch(() => '') });
        }
      }
      return {
        running: !!state.context,
        tabs,
        profileDir: cfg.profileDir,
        downloadsDir: cfg.downloadsDir,
        pendingSchedules: state.schedules.size,
        maxSteps: cfg.maxSteps,
      };
    },
    render(_a, v) {
      const tabs = v.tabs.map((t) => `  ${t.index}. ${t.title.slice(0, 40)} (${t.url.slice(0, 80)})`).join('\n');
      return [{ type: 'text', text: [
        `浏览器运行中: ${v.running ? '是' : '否（首次调用 browser_open/browser_task 时自动启动）'}`,
        `标签页:\n${tabs || '  （无）'}`,
        `资料目录(登录态): ${v.profileDir}`,
        `下载目录: ${v.downloadsDir}`,
        `待执行定时任务: ${v.pendingSchedules} 个`,
      ].join('\n') }];
    },
  });

  register(ctx, {
    name: 'browser_close',
    description: '关闭专用 Chrome 实例（登录态已存 profile，下次启动仍在）。',
    parameters: {},
    async execute() {
      if (state.context) {
        try { await state.context.close(); } catch { /* 已关闭 */ }
        state.context = null;
      }
      return { closed: true };
    },
    render() { return [{ type: 'text', text: '专用 Chrome 已关闭（cookie/登录态保留在 profile，下次启动仍有效）' }]; },
  });
}

// ---------- 插件入口 ----------
export function apply(ctx, config = {}) {
  const cfg = { ...defaults(), ...(config && typeof config === 'object' ? config : {}) };
  registerTools(ctx, cfg);
  ctx.effect(() => () => {
    for (const timer of state.schedules) clearTimeout(timer);
    state.schedules.clear();
    if (state.context) {
      const context = state.context;
      state.context = null;
      context.close().catch(() => {});
    }
  }, 'dsh-browseruse dispose');
}

export default { name, inject, apply };
