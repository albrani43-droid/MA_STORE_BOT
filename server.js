import express from 'express';
import OpenAI from 'openai';
import crypto from 'node:crypto';

const app = express();
const PORT = process.env.PORT || 10000;
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;
const PAGE_ID = process.env.PAGE_ID;
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v23.0';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const seen = new Map();

app.get('/', (_req, res) => res.status(200).send('MA STORE BOT running'));
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN && VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!APP_SECRET || !PAGE_TOKEN || !PAGE_ID || !process.env.OPENAI_API_KEY) return res.sendStatus(503);
  const signature = req.get('x-hub-signature-256');
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.body).digest('hex');
  if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.sendStatus(403);
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  res.sendStatus(200);
  if (payload.object !== 'page') return;
  for (const entry of payload.entry || []) {
    for (const event of entry.messaging || []) {
      if (event.message?.is_echo || !event.message?.text || !event.sender?.id || event.sender.id === PAGE_ID) continue;
      const id = 'msg:' + (event.message.mid || `${event.sender.id}:${event.timestamp}`);
      if (duplicate(id)) continue;
      void handleMessage(event.sender.id, event.message.text).catch(console.error);
    }
    for (const change of entry.changes || []) {
      if (change.field !== 'feed') continue;
      const v = change.value || {};
      if (v.item !== 'comment' || v.verb !== 'add' || !v.comment_id || !v.message || String(v.from?.id) === String(PAGE_ID)) continue;
      if (duplicate('comment:' + v.comment_id)) continue;
      void handleComment(v.comment_id, v.message).catch(console.error);
    }
  }
});

function duplicate(id) {
  const now = Date.now();
  for (const [key, time] of seen) if (now - time > 3600000) seen.delete(key);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

async function aiReply(text, channel) {
  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    instructions: `أنت مساعد خدمة عملاء صفحة MA STORE في ليبيا. رد باللهجة الليبية الطبيعية وباختصار واحترام. القناة: ${channel}. لا تخترع أسعار أو توفر أو مقاسات أو مواعيد توصيل أو سياسات. إذا المعلومات ناقصة اطلب تفاصيل أو قل بنأكدلك مع المسؤول. لا تطلب معلومات حساسة أو بيانات دفع. في التعليقات العامة لا تطلب رقم هاتف أو عنوان، ووجّه الزبون للخاص عند الحاجة. لا تعد بأنك أرسلت رسالة خاصة إذا لم تفعل.`,
    input: text.slice(0, 2000),
    max_output_tokens: 180
  });
  return response.output_text?.trim() || 'أهلاً بيك، شن نقدر نساعدك فيه؟';
}

async function graph(path, body) {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAGE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Meta API ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function handleMessage(psid, text) {
  const reply = await aiReply(text, 'Messenger');
  await graph('me/messages', { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text: reply } });
}
async function handleComment(commentId, text) {
  const reply = await aiReply(text, 'تعليق عام');
  await graph(`${encodeURIComponent(commentId)}/comments`, { message: reply });
}

app.listen(PORT, () => console.log(`MA STORE BOT listening on ${PORT}`));
