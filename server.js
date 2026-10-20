import express from 'express';
import OpenAI from 'openai';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(await fs.readFile(path.join(root, 'catalog.json'), 'utf8'));
const deliveryPrices = JSON.parse(await fs.readFile(path.join(root, 'delivery-prices.json'), 'utf8'));
const app = express();
const port = Number(process.env.PORT || 10000);
const pageToken = process.env.PAGE_ACCESS_TOKEN;
const pageId = process.env.PAGE_ID;
const appSecret = process.env.META_APP_SECRET;
const verifyToken = process.env.VERIFY_TOKEN;
const graphVersion = process.env.GRAPH_API_VERSION || 'v23.0';
const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'missing' });
const pool = process.env.DATABASE_URL ? new pg.Pool({connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'require' ? {rejectUnauthorized:false} : undefined}) : null;
const pending = new Map();
const busy = new Set();
const MAX_HISTORY = 32;

app.get('/', (_req,res) => res.send('M A Store Bot running'));
app.use('/images', express.static(path.join(root, 'images'), {maxAge: '1h'}));
app.get('/webhook', (req,res) => {
  if (req.query['hub.mode'] === 'subscribe' && verifyToken && req.query['hub.verify_token'] === verifyToken)
    return res.status(200).send(req.query['hub.challenge']);
  return res.sendStatus(403);
});

app.post('/webhook', express.raw({type:'application/json', limit:'2mb'}), (req,res) => {
  if (!appSecret || !pageToken || !pageId || !process.env.OPENAI_API_KEY || !pool) return res.sendStatus(503);
  const signature = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256',appSecret).update(req.body).digest('hex');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.sendStatus(403);
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  res.sendStatus(200);
  if (payload.object !== 'page') return;
  for (const entry of payload.entry || []) {
    for (const ev of entry.messaging || []) {
      if (ev.message?.is_echo || !ev.sender?.id || String(ev.sender.id) === String(pageId)) continue;
      const mid = ev.message?.mid || `${ev.sender.id}:${ev.timestamp}`;
      const attachments = (ev.message?.attachments || []).filter(a => a.type === 'image' && a.payload?.url);
      if (!ev.message?.text && !attachments.length) continue;
      void receiveMessage(ev.sender.id, mid, ev.message.text || '', attachments.map(a => a.payload.url)).catch(console.error);
    }
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field !== 'feed' || v.item !== 'comment' || v.verb !== 'add' || !v.comment_id || !v.message || String(v.from?.id) === String(pageId)) continue;
      void receiveComment(v.comment_id,v.message).catch(console.error);
    }
  }
});

async function initDB() {
  if (!pool) throw new Error('DATABASE_URL missing. Add a persistent PostgreSQL database in Render.');
  await pool.query(`CREATE TABLE IF NOT EXISTS conversations (psid TEXT PRIMARY KEY, history JSONB NOT NULL DEFAULT '[]', details JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (id BIGSERIAL PRIMARY KEY, psid TEXT NOT NULL, details JSONB NOT NULL, total NUMERIC, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS processed_events (event_id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}
async function once(id) {
  const r = await pool.query('INSERT INTO processed_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id',[id]);
  return r.rowCount > 0;
}
async function graph(pathname, body) {
  const r = await fetch(`https://graph.facebook.com/${graphVersion}/${pathname}`, {
    method:'POST', headers:{Authorization:`Bearer ${pageToken}`,'Content-Type':'application/json'},body:JSON.stringify(body)
  });
  const result = await r.json();
  if (!r.ok) throw new Error(`Meta ${r.status}: ${JSON.stringify(result)}`);
  return result;
}
async function sendText(psid,text) {
  if (!text?.trim()) return;
  await graph('me/messages',{recipient:{id:psid},messaging_type:'RESPONSE',message:{text:text.slice(0,1900)}});
}
async function sendImage(psid, filename) {
  if (!baseUrl) {console.warn('PUBLIC_BASE_URL missing: cannot send product images');return;}
  const url = `${baseUrl}/images/${encodeURIComponent(filename)}`;
  await graph('me/messages',{recipient:{id:psid},messaging_type:'RESPONSE',message:{attachment:{type:'image',payload:{url,is_reusable:true}}}});
}
async function imageData(url) {
  const r = await fetch(url, {headers: {Authorization:`Bearer ${pageToken}`}, signal:AbortSignal.timeout(12000)});
  if (!r.ok) throw new Error(`Could not fetch Messenger image: ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > 5_000_000) throw new Error('Image too large');
  const ct = r.headers.get('content-type') || 'image/jpeg';
  if (!ct.startsWith('image/')) throw new Error('Attachment is not an image');
  return `data:${ct};base64,${bytes.toString('base64')}`;
}
async function recognizeProduct(imageUrl) {
  const parts = [{type:'input_text',text:'طابق صورة الزبون مع إحدى الصور المرجعية. أرجع JSON فقط: {"product_id":"winter-01" أو "sport-02" أو null,"color":"أسود" أو "بيج" أو "كحلي" أو "أبيض" أو null}. لو مش متأكد أرجع null. الصور المرجعية بالترتيب: الشتوي أسود، الشتوي بيج، السبورت كحلي، السبورت أبيض.'}];
  try {
    parts.push({type:'input_image',image_url:await imageData(imageUrl),detail:'low'});
    for (const [id,filename] of [['winter-01','winter-black.jpg'],['winter-01','winter-beige.jpg'],['sport-02','sport-navy.jpg'],['sport-02','sport-white.jpg']]) {
      const b = await fs.readFile(path.join(root,'images',filename));
      parts.push({type:'input_text',text:`مرجع ${id} ${filename}`},{type:'input_image',image_url:`data:image/jpeg;base64,${b.toString('base64')}`,detail:'low'});
    }
    const r = await ai.responses.create({model:process.env.OPENAI_MODEL || 'gpt-4.1-mini',input:[{role:'user',content:parts}],max_output_tokens:100});
    const obj = JSON.parse((r.output_text || '').replace(/^```(?:json)?\s*|\s*```$/g,''));
    const product = catalog.find(p=>p.id === obj.product_id);
    if (!product || !Object.hasOwn(product.colors,obj.color)) return null;
    return {productId:product.id,color:obj.color};
  } catch(e) {console.error('Vision:',e.message);return null;}
}
async function receiveMessage(psid,mid,text,images) {
  if (!await once(`msg:${mid}`)) return;
  const item = pending.get(psid) || {texts:[],images:[],timer:null};
  if (text.trim()) item.texts.push(text.trim().slice(0,2000));
  item.images.push(...images.slice(0,2));
  if (item.timer) clearTimeout(item.timer);
  const wait = 10000 + Math.floor(Math.random()*10001);
  item.timer = setTimeout(()=>{void processQueue(psid).catch(console.error);},wait);
  pending.set(psid,item);
}
async function processQueue(psid) {
  if (busy.has(psid)) return;
  busy.add(psid);
  try {
    while (pending.has(psid)) {
      const batch = pending.get(psid);
      pending.delete(psid);
      clearTimeout(batch.timer);
      await handleBatch(psid,batch);
    }
  } finally {busy.delete(psid);}
}
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g,'');
  if (/^0[0-9]{9}$/.test(digits)) return digits;
  if (/^218[0-9]{9}$/.test(digits)) return '0'+digits.slice(3);
  return null;
}
const reservationPrompt = `لتأكيد الحجز معنا في متجر\n"M A Store"\n\nنرجو التكرم بإرسال البيانات التالية 📩:\n\nالاسم:\nرقم الهاتف:\nمقاس الحذاء:\nالمدينة / العنوان:`;
const instructions = `أنت موظف مبيعات M A Store بلهجة ليبية طبيعية ومختصرة. تقرأ سجل المحادثة وبياناتها قبل الرد. لا تكرر أي سؤال تمت إجابته. لا تكرر كلمة تمام في كل سطر. لا تبحث في الإنترنت ولا تخترع أسعار أو توفر أو رسوم توصيل. لو كلام غير واضح تجاهل الجزء غير الواضح ولا تطلب تفسيراً له. لا تذكر أسماء مناطق من عندك؛ لو قال طرابلس فقط اسأل "تمام، وين عنوانك بالضبط في طرابلس؟". الاسم اختياري ولا تسأل عليه لو ناقص. الهاتف المحلي لازم 10 أرقام؛ لا تحفظه كصحيح إلا بعد التحقق. عند طلب حجز ابدأ برسالة الحجز المحددة أو اطلب المعلومات الناقصة فقط إن سبق توفير بعضها. المقاس والعنوان والمنتج والكمية والهاتف أساسيين. لا تعرض مقاسين إلا لو الزبون طلب أو قال محتار في المقاس؛ وقتها لو لم يذكر المقاس اسأله عنه. لا تختار مقاس ثاني من عندك. استخدم "قطعة" لا "زوج". لا تعلن "تم الحجز" إلا بعد موافقة الزبون الصريحة وحفظ الطلب. قبل التأكيد اعرض ملخص الطلب والسعر النهائي فقط إن رسوم التوصيل معروفة، وإلا وضح أن التوصيل لم يُحدد بعد. عند سؤال الألوان اذكر ألوان نفس المنتج فقط، وعند سؤال السعر اذكر السعر والمقاسات. لا تدعي إرسال صورة إن لم ترسل فعلاً. استخرج معلومات الزبون حتى لو جاءت في رسائل منفصلة. أرجع JSON فقط بالشكل: {"reply":"رد مختصر أو فارغ", "details":{"productId":null,"color":null,"size":null,"sizesToTry":[],"quantity":null,"name":null,"phone":null,"city":null,"address":null},"wantsBooking":false,"confirmBooking":false,"showOtherColors":false}. استخدم null للمعلومات التي لم يذكرها الزبون، ولا تمسح بيانات سابقة. confirmBooking لا تكون true إلا بموافقة صريحة على ملخص الحجز.`;
function deliveryCost(city,address) {
  const key = `${city || ''}|${address || ''}`.trim();
  if (Object.hasOwn(deliveryPrices,key)) return Number(deliveryPrices[key]);
  if (Object.hasOwn(deliveryPrices,city || '')) return Number(deliveryPrices[city]);
  return null;
}
function sufficientAddress(d) {
  return Boolean(d.city && d.address && d.address.trim().length >= 5 && d.address.trim() !== d.city.trim());
}
function orderSummary(d,p,fee) {
  const price = p.price * d.quantity;
  return `المنتج: ${p.name}${d.color ? ` (${d.color})`:''}\nالمقاس: ${d.sizesToTry?.length ? d.sizesToTry.join(' و ') + ' للتجربة' : d.size}\nالكمية: ${d.quantity} ${d.quantity === 1 ? 'قطعة' : 'قطع'}\nالهاتف: ${d.phone}\nالعنوان: ${d.city}، ${d.address}\nسعر المنتجات: ${price} دينار\n${fee === null ? 'التوصيل: لم يتم تحديد سعره بعد' : `التوصيل: ${fee} دينار\nالإجمالي شامل التوصيل: ${price + fee} دينار`}`;
}
async function handleBatch(psid,batch) {
  const old = await pool.query('SELECT history,details FROM conversations WHERE psid=$1',[psid]);
  const history = old.rows[0]?.history || [];
  const details = old.rows[0]?.details || {};
  let matched = null;
  if (batch.images.length) matched = await recognizeProduct(batch.images.at(-1));
  const incoming = batch.texts.join('\n') + (batch.images.length ? '\n[الزبون أرسل صورة]' : '');
  if (matched) {details.productId = matched.productId;details.color = matched.color;}
  const product = catalog.find(p=>p.id === details.productId);
  const prompt = `كتالوج المتجر: ${JSON.stringify(catalog.map(p=>({id:p.id,name:p.name,price:p.price,sizes:p.sizes,colors:Object.keys(p.colors)})))}\nالبيانات السابقة: ${JSON.stringify(details)}\nالمنتج المعروف من الصورة: ${JSON.stringify(matched)}\nسجل المحادثة: ${JSON.stringify(history.slice(-MAX_HISTORY))}\nرسالة الزبون الجديدة: ${incoming}\nإن كان الزبون يسأل عن الألوان لصورة منتج، اجعل showOtherColors=true.`;
  const r = await ai.responses.create({model:process.env.OPENAI_MODEL || 'gpt-4.1-mini',instructions,input:prompt,max_output_tokens:500});
  let parsed;
  try {parsed = JSON.parse((r.output_text || '').replace(/^```(?:json)?\s*|\s*```$/g,''));}
  catch {parsed = {reply:'',details:{}};}
  const d = parsed.details || {};
  for (const k of ['productId','color','size','quantity','name','city','address']) {
    if (d[k] !== null && d[k] !== undefined && d[k] !== '') details[k] = d[k];
  }
  if (Array.isArray(d.sizesToTry) && d.sizesToTry.length) details.sizesToTry = d.sizesToTry;
  if (d.phone) {
    const phone = normalizePhone(d.phone);
    if (phone) details.phone = phone;
    else parsed.reply = 'رقم الهاتف لازم يكون 10 أرقام يا طيب ❤️';
  }
  const p = catalog.find(x=>x.id === details.productId);
  if (p && details.size && !p.sizes.includes(Number(details.size))) {
    delete details.size;
    parsed.reply = `المقاس هذا مش ضمن المقاسات المسجلة للموديل. المتوفر من ${p.sizes[0]} إلى ${p.sizes.at(-1)}.`;
  }
  if (p && details.color && !Object.hasOwn(p.colors,details.color)) delete details.color;
  if (details.quantity) details.quantity = Math.max(1,Math.min(50,Number(details.quantity) || 1));
  const fee = deliveryCost(details.city,details.address);
  const complete = Boolean(p && (details.size || details.sizesToTry?.length) && details.phone && sufficientAddress(details) && details.quantity);
  let reply = String(parsed.reply || '').trim();
  if (parsed.wantsBooking && !complete) {
    if (!details.phone && !details.size && !details.city) reply = reservationPrompt;
    else {
      const missing = [];
      if (!p) missing.push('المنتج');
      if (!details.size && !details.sizesToTry?.length) missing.push('مقاس الحذاء');
      if (!details.phone) missing.push('رقم الهاتف (10 أرقام)');
      if (!sufficientAddress(details)) missing.push('المدينة والعنوان بالتحديد');
      if (!details.quantity) missing.push('الكمية');
      reply = `تمام، نحتاج منك بس: ${missing.join('، ')}.`;
    }
  }
  if (complete && parsed.wantsBooking && !parsed.confirmBooking) {
    reply = `تمام، هذي تفاصيل الحجز:\n${orderSummary(details,p,fee)}\n${fee === null ? 'نأكدولك تكلفة التوصيل قبل اعتماد الحجز.':'تأكد الحجز على هالتفاصيل؟'}`;
    details.awaitingConfirmation = fee !== null;
  }
  if (parsed.confirmBooking && complete && details.awaitingConfirmation && fee !== null) {
    const total = p.price * details.quantity + fee;
    const inserted = await pool.query('INSERT INTO orders(psid,details,total) VALUES($1,$2,$3) RETURNING id',[psid,JSON.stringify(details),total]);
    reply = `تمام، تم الحجز ❤️\nرقم الحجز: ${inserted.rows[0].id}\nالإجمالي شامل التوصيل: ${total} دينار`;
    details.awaitingConfirmation = false;
  } else if (parsed.confirmBooking && fee === null) {
    reply = 'تمام، سعر التوصيل للعنوان هذا مازال مش محدد عندنا، ما نقدرش نعطيك إجمالي صحيح توا.';
  }
  if (/تم الحجز/.test(reply) && !(parsed.confirmBooking && complete && fee !== null && details.awaitingConfirmation === false)) reply = 'تمام، نكملوا بيانات الحجز الأول يا طيب.';
  const imgs = [];
  if (parsed.showOtherColors && p && details.color) {
    for (const [color,filename] of Object.entries(p.colors)) if (color !== details.color) imgs.push(filename);
  }
  const nextHistory = [...history,{role:'customer',text:incoming},{role:'assistant',text:reply}].slice(-MAX_HISTORY);
  await pool.query(`INSERT INTO conversations(psid,history,details) VALUES($1,$2,$3)
    ON CONFLICT(psid) DO UPDATE SET history=EXCLUDED.history,details=EXCLUDED.details,updated_at=NOW()`,[psid,JSON.stringify(nextHistory),JSON.stringify(details)]);
  if (reply) await sendText(psid,reply);
  for (const filename of imgs) await sendImage(psid,filename);
}
async function receiveComment(commentId,text) {
  if (!await once(`comment:${commentId}`)) return;
  const r = await ai.responses.create({model:process.env.OPENAI_MODEL || 'gpt-4.1-mini',instructions:'أنت مساعد M A Store. رد على تعليق فيسبوك باللهجة الليبية وباختصار. لا تطلب رقم هاتف أو عنوان علناً. لا تخترع أسعاراً. الكتالوج: '+JSON.stringify(catalog.map(p=>({name:p.name,price:p.price,sizes:p.sizes}))),input:text.slice(0,1000),max_output_tokens:150});
  if (r.output_text?.trim()) await graph(`${encodeURIComponent(commentId)}/comments`,{message:r.output_text.trim()});
}
initDB().then(()=>app.listen(port,()=>console.log(`M A Store listening on ${port}`))).catch(e=>{console.error('Startup failed:',e);process.exit(1);});
