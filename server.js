import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
const app=express();
const PORT=process.env.PORT||10000;
const PAGE_TOKEN=process.env.PAGE_ACCESS_TOKEN;
const PAGE_ID=process.env.PAGE_ID;
const VERIFY_TOKEN=process.env.VERIFY_TOKEN;
const APP_SECRET=process.env.META_APP_SECRET;
const OPENAI_API_KEY=process.env.OPENAI_API_KEY;
const OPENAI_MODEL=process.env.OPENAI_MODEL||'gpt-4.1-mini';
const GRAPH_VERSION=process.env.GRAPH_API_VERSION||'v23.0';
const seen=new Map();
function log(...a){console.log(new Date().toISOString(),...a)}
function once(id){const now=Date.now();for(const [k,v] of seen)if(now-v>3600000)seen.delete(k);if(seen.has(id))return false;seen.set(id,now);return true}
async function graph(path,body,method='POST'){
 const response=await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`,{method,headers:{Authorization:`Bearer ${PAGE_TOKEN}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();if(!response.ok||data.error)throw Error(`Meta ${data.error?.code||response.status}: ${data.error?.message||'API error'}`);return data;
}
async function jsonFile(file){try{return JSON.parse(await fs.readFile(new URL(file,import.meta.url),'utf8'))}catch(e){log('DATA FILE UNAVAILABLE:',file,e.message);return null}}
function flatten(v){return JSON.stringify(v??{},null,0).slice(0,14000)}
const system=`أنت مساعد خدمة عملاء متجر M A Store في ليبيا. اكتب عربية بسيطة مع تعبيرات ليبية خفيفة. كن ودودًا ومختصرًا جدًا، بلا حشو أو مبالغة أو إيموجي كثيرة. إذا كان السؤال يتضمن عدة استفسارات مستقلة، أجب على كل استفسار بجملة مستقلة في سطر مستقل. لا تبدأ محادثة من نفسك. لا تخترع الأسعار أو المقاسات أو الألوان أو المخزون أو رسوم التوصيل. اعتمد حصريًا على البيانات المرفقة، وإذا لم تتأكد قل: خليني نتأكد لك يا طيب. إذا سأل عن موقع المتجر: متجر إلكتروني والتوصيل فقط لجميع مناطق ليبيا. إذا سأل عن شركة التوصيل: شركة النورس. طرق الدفع: كاش وبطاقة مصرفية وحوالة؛ المندوب يصل للزبون. إذا أراد الحجز اطلب: الاسم، رقم الهاتف، المقاس، اللون، المدينة/العنوان. لا تؤكد الحجز النهائي آليًا؛ قل إن الطلب قيد التأكيد. رقم الهاتف الليبي المقبول يبدأ 091 أو 092 أو 093 ويتبعه سبعة أرقام؛ لا تذكر هذه القاعدة للزبون. إذا طلب مقاسين قل: تم ادلل، تو نبعتلك مقاسين، لكن لا تؤكد توفرهما إلا من الكتالوج. إذا قال السلام عليكم: وعليكم السلام ورحمة الله وبركاته، تفضل يا طيب كيف نقدر نساعدك. إذا سأل عن نوع الرد الآلي فكن صريحًا. لا تدّع أن إنسانًا يتحدث معه. لا تقل إن منتجًا متوفر دون وجوده في البيانات. عند الشك في الموديل اطلب صورته.`;
async function aiReply(message,context=''){
 const [catalog,delivery]=await Promise.all([jsonFile('./catalog.json'),jsonFile('./delivery-prices.json')]);
 if(!OPENAI_API_KEY)return 'خليني نتأكد لك يا طيب.';
 const response=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:OPENAI_MODEL,temperature:0.3,max_tokens:220,messages:[{role:'system',content:system},{role:'system',content:`بيانات الكتالوج: ${flatten(catalog)}\nأسعار التوصيل: ${flatten(delivery)}\nالسياق: ${context}`},{role:'user',content:message}]})});
 const data=await response.json();if(!response.ok)throw Error(`AI ${response.status}: ${data.error?.message||'request failed'}`);
 return data.choices?.[0]?.message?.content?.trim()||'خليني نتأكد لك يا طيب.';
}
async function sendMessage(recipientId,text){await graph('me/messages',{recipient:{id:recipientId},messaging_type:'RESPONSE',message:{text:text.slice(0,1900)}})}
async function handleMessage(event){
 const sender=String(event.sender?.id||'');if(!sender||sender===String(PAGE_ID)||event.message?.is_echo)return;
 const msg=event.message;if(!msg?.mid||!once(`msg:${msg.mid}`))return;
 if(!msg.text){await sendMessage(sender,'وصلتني رسالتك يا طيب، ممكن توضح استفسارك؟');return}
 try{const answer=await aiReply(msg.text);for(const line of answer.split(/\n+/).map(x=>x.trim()).filter(Boolean).slice(0,6))await sendMessage(sender,line)}catch(e){log('MESSAGE ERROR',e.message);try{await sendMessage(sender,'خليني نتأكد لك يا طيب.')}catch(x){log('SEND ERROR',x.message)}}
}
async function handleComment(v){
 const id=String(v.comment_id||'');if(!id||!once(`comment:${id}`))return;
 const author=String(v.from?.id||v.sender_id||'');if(author===String(PAGE_ID))return;
 try{
  const commentText=String(v.message||'');
  const answer=await aiReply(commentText||'الزبون علّق على المنتج',`تعليق على المنشور ${v.post_id||''}`);
  await graph(`${encodeURIComponent(id)}/private_replies`,{message:answer.slice(0,1800)});
  log('PRIVATE REPLY SUCCESS',id);
  // لا ننشر ردًا عامًا تلقائيًا كي لا نزعج الزبون أو نكرر الإجابة.
 }catch(e){log('COMMENT ERROR',id,e.message)}
}
app.get('/',(_req,res)=>res.status(200).send('MA STORE BOT RUNNING'));
app.get('/webhook',(req,res)=>req.query['hub.mode']==='subscribe'&&VERIFY_TOKEN&&req.query['hub.verify_token']===VERIFY_TOKEN?res.status(200).send(req.query['hub.challenge']):res.sendStatus(403));
app.post('/webhook',express.raw({type:'application/json'}),(req,res)=>{
 if(!APP_SECRET||!PAGE_TOKEN||!PAGE_ID)return res.sendStatus(503);
 if(!Buffer.isBuffer(req.body))return res.sendStatus(400);
 const signature=req.get('x-hub-signature-256')||'';
 const expected='sha256='+crypto.createHmac('sha256',APP_SECRET).update(req.body).digest('hex');
 if(signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return res.sendStatus(403);
 let payload;try{payload=JSON.parse(req.body.toString('utf8'))}catch{return res.sendStatus(400)}
 res.sendStatus(200);if(payload.object!=='page')return;
 for(const entry of payload.entry||[]){if(String(entry.id)!==String(PAGE_ID))continue;
  for(const event of entry.messaging||[])void handleMessage(event).catch(e=>log('MESSAGING ERROR',e.message));
  for(const change of entry.changes||[]){const v=change.value||{};if(change.field==='feed'&&v.item==='comment'&&v.verb==='add')void handleComment(v).catch(e=>log('FEED ERROR',e.message))}
 }
});
app.listen(PORT,()=>log('MA STORE BOT STARTED',PORT));
