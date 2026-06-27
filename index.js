/**
 * lili 飞书情感咨询机器人
 * 
 * 架构：
 * 飞书消息 → Webhook → DeepSeek API（lili 人格） → 飞书回复
 * 
 * 跑在 Railway 上，24×7 在线
 */

require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.raw({ type: 'application/json' }));

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  feishu: {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY,
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: 'deepseek-chat',
  },
  port: process.env.PORT || 3000,
};

// 会话历史目录
const STORAGE_DIR = path.join(__dirname, 'storage');
// 每个用户最多保留的对话轮数
const MAX_HISTORY_ROUNDS = 30;

// ============================================================
// DeepSeek 客户端
// ============================================================

const deepseek = new OpenAI({
  apiKey: CONFIG.deepseek.apiKey,
  baseURL: 'https://api.deepseek.com',
});

// ============================================================
// 飞书加密/解密
// ============================================================

function decryptFeishu(encryptKey, encryptedData) {
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const iv = key.subarray(0, 16);
  const buffer = Buffer.from(encryptedData, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(buffer);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

// ============================================================
// 飞书 Token 管理
// ============================================================

let tenantToken = null;
let tokenExpireAt = 0;

async function getTenantToken() {
  if (tenantToken && Date.now() < tokenExpireAt - 60000) {
    return tenantToken;
  }

  const res = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      app_id: CONFIG.feishu.appId,
      app_secret: CONFIG.feishu.appSecret,
    }
  );

  tenantToken = res.data.tenant_access_token;
  tokenExpireAt = Date.now() + res.data.expire * 1000;
  return tenantToken;
}

// ============================================================
// 飞书消息发送
// ============================================================

async function sendFeishuMessage(openId, text) {
  const token = await getTenantToken();

  // 文本消息内容需要 JSON 编码
  const content = JSON.stringify({ text });

  await axios.post(
    'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
    {
      receive_id: openId,
      msg_type: 'text',
      content,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// ============================================================
// 会话历史管理
// ============================================================

function getHistoryPath(openId) {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
  return path.join(STORAGE_DIR, `${openId}.json`);
}

function loadHistory(openId) {
  const filePath = getHistoryPath(openId);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data.messages || [];
  } catch {
    return [];
  }
}

function saveHistory(openId, messages) {
  const filePath = getHistoryPath(openId);
  // 只保留最近 N * 2 条（user + assistant 各算一条）
  const trimmed = messages.slice(-MAX_HISTORY_ROUNDS * 2);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ messages: trimmed, updatedAt: new Date().toISOString() }, null, 2)
  );
}

// ============================================================
// lili 人格 prompt（从外部文件加载）
// ============================================================

function loadLiliPrompt() {
  const promptFile = path.join(__dirname, 'lili-prompt.txt');
  if (fs.existsSync(promptFile)) {
    return fs.readFileSync(promptFile, 'utf8');
  }
  // 后备精简版
  return `
你是lili（Luckylili），95后成都情感咨询师/陪跑教练。自己是创业者，有00后男友。

## 回复铁律
1. 一次只说一件事，每条消息一个核心意思
2. 以问句结尾：「你觉得呢？」「他现在回你了吗？」
3. 单条不超过两句话，短句分行，一段不超3行
4. 先接情绪再给分析
5. 禁止编号列表、分隔线、标题、表格
6. 涉及创业男/自媒体/条件好女生时，用自己创业者身份做背书

## 语气
- 称呼：妹宝/宝宝/宝
- 口头禅：妈呀、我讲实话、百分之三百、包是XX的
- 风格：短句分行、波浪号~、哈哈哈哈缓冲
- 口语：搁这儿、咋、啥、嘛、噻

## 策略
- 内耗型 → 推
- 卑微型 → 收
- 持续冷落 → 后撤到底
- 不尊重 → 拿态度

## 核心
- 不找你，就是不想。只看行动
- 不要把任何一个男的神话
- 谁痛苦谁改变
- 你可以是任何人的真爱
`.trim();
}

const LILI_SYSTEM_PROMPT = loadLiliPrompt();

// ============================================================
// 核心：处理消息 + 生成回复
// ============================================================

async function handleMessage(openId, userMessage) {
  // 加载历史
  const history = loadHistory(openId);

  // 构建消息列表
  const messages = [
    { role: 'system', content: `${LILI_SYSTEM_PROMPT}\n\n飞书上的用户就是你的客户，用lili的方式聊天。只回复对话内容，不要加任何前缀说明。` },
    ...history,
    { role: 'user', content: userMessage },
  ];

  // 调用 DeepSeek
  const completion = await deepseek.chat.completions.create({
    model: CONFIG.deepseek.model,
    messages,
    temperature: 0.85,
    max_tokens: 800,
  });

  const reply = completion.choices[0].message.content.trim();

  // 保存历史
  history.push({ role: 'user', content: userMessage });
  history.push({ role: 'assistant', content: reply });
  saveHistory(openId, history);

  return reply;
}

// ============================================================
// 飞书事件类型处理
// ============================================================

async function handleEvent(event) {
  const { type } = event.header || {};
  const { message, sender } = event.event || {};

  // 只处理接收消息事件
  if (type !== 'im.message.receive_v1') return;

  const messageType = message?.message_type;
  const openId = sender?.sender_id?.open_id;

  if (!openId) return;

  // 只处理文本消息
  if (messageType !== 'text') return;

  // 解析消息内容
  let userText = '';
  try {
    const content = JSON.parse(message.content);
    userText = content.text || '';
  } catch {
    userText = message.content || '';
  }

  // 去掉 @机器人 的部分
  userText = userText.replace(/@_user_\d+/g, '').replace(/@\S+/g, '').trim();

  if (!userText) return;

  console.log(`[消息] ${openId}: ${userText}`);

  // 先回一个"正在输入"的感觉 —— 实际就是异步处理
  try {
    const reply = await handleMessage(openId, userText);
    await sendFeishuMessage(openId, reply);
    console.log(`[回复] ${openId}: ${reply.slice(0, 50)}...`);
  } catch (err) {
    console.error(`[错误] 处理消息失败:`, err.message);
    try {
      await sendFeishuMessage(openId, '妹宝稍等一下哦，姐这边有点卡～再发一遍试试？');
    } catch {}
  }
}

// ============================================================
// Webhook 端点
// ============================================================

app.get('/webhook', (req, res) => {
  // URL 验证：飞书会发送 challenge，原样返回
  const { challenge } = req.query;
  if (challenge) {
    console.log('[验证] URL 验证成功');
    return res.json({ challenge });
  }
  res.send('lili bot is running');
});

app.post('/webhook', async (req, res) => {
  // 立即返回 200，不阻塞飞书的回调超时
  res.json({ code: 0 });

  try {
    let body;
    try {
      body = JSON.parse(req.body.toString());
    } catch {
      console.error('[错误] 无法解析请求体');
      return;
    }

    // 解密
    if (body.encrypt) {
      const decrypted = decryptFeishu(CONFIG.feishu.encryptKey, body.encrypt);

      // URL 验证事件
      if (decrypted.type === 'url_verification') {
        console.log('[验证] URL 验证');
        return;
      }

      // 业务事件
      await handleEvent(decrypted);
    }
  } catch (err) {
    console.error('[错误] Webhook 处理异常:', err.message);
  }
});

// 健康检查
app.get('/', (req, res) => {
  res.send('lili-feishu-bot is running ✅');
});

// ============================================================
// 启动
// ============================================================

app.listen(CONFIG.port, () => {
  console.log(`lili 飞书机器人已启动 → http://0.0.0.0:${CONFIG.port}`);
  console.log(`Webhook 地址: http://<你的域名>/webhook`);
  console.log(`会话存储: ${STORAGE_DIR}`);
});
