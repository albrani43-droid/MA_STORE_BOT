import express from 'express';
import crypto from 'node:crypto';

const app = express();
const PORT = Number(process.env.PORT || 10000);
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;
const PAGE_ID = process.env.PAGE_ID;
const TARGET_POST_ID = process.env.TARGET_POST_ID;
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v23.0';

const PUBLIC_REPLY = 'تم رد على الخاص ✔️';
const PRIVATE_REPLY = `هلا وغلا بيك في متجر M A Store ❤️👟

سعر الحذاء: 115 دينار 💰
المقاسات: من 41 إلى 47 📏
الألوان المتوفرة: أبيض 🤍 وأزرق كحلي 💙

طرق الدفع: كاش، بطاقة مصرفية أو حوالة 💳
🚚 التوصيل متوفر، والتكلفة حسب المدينة والمنطقة.

للحجز ابعتلنا المقاس واللون والعنوان ورقم الهاتف 📩
نورتنا يا غالي ❤️`;

// Temporary de-duplication while the process is running.
const processed = new Set();
const pending = new Set();

app.get('/', (_req, res) => res.status(200).send('M A Store comment-only bot running'));
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

async function graph(path, body) {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAGE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Meta ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function handleComment(commentId) {
  if (processed.has(commentId) || pending.has(commentId)) return;
  pending.add(commentId);
  try {
    // Meta Private Reply: message to the person who wrote this comment.
    // Meta limits private replies (generally one per comment, within 7 days).
    await graph('me/messages', {
      recipient: { comment_id: commentId },
      message: { text: PRIVATE_REPLY }
    });
    processed.add(commentId);
    console.log('Private reply sent for comment', commentId);
  } catch (error) {
    console.error('Private reply failed; no public success claim:', commentId, error.message);
    return;
  } finally {
    pending.delete(commentId);
  }

  try {
    await graph(`${encodeURIComponent(commentId)}/comments`, { message: PUBLIC_REPLY });
    console.log('Public reply sent for comment', commentId);
  } catch (error) {
    console.error('Private reply succeeded, public reply failed:', commentId, error.message);
  }
}

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!APP_SECRET || !PAGE_TOKEN || !VERIFY_TOKEN || !PAGE_ID || !TARGET_POST_ID) {
    return res.sendStatus(503);
  }
  const signature = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.body).digest('hex');
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.sendStatus(403);
  }
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); }
  catch { return res.sendStatus(400); }
  res.sendStatus(200);
  if (payload.object !== 'page') return;
  for (const entry of payload.entry || []) {
    // Intentionally ignore entry.messaging: no automatic Messenger responses.
    for (const change of entry.changes || []) {
      if (change.field !== 'feed') continue;
      const v = change.value || {};
      if (v.item !== 'comment' || v.verb !== 'add' || !v.comment_id) continue;
      if (String(v.post_id || '') !== String(TARGET_POST_ID)) continue;
      if (String(v.from?.id || '') === String(PAGE_ID)) continue;
      void handleComment(String(v.comment_id)).catch(console.error);
    }
  }
});

app.listen(PORT, () => console.log(`M A Store comment-only bot listening on ${PORT}`));
