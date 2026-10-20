const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// تحقق من الـ Webhook الخاص بفيسبوك
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ma_store_verify_token";
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// استقبال الرسائل من فيسبوك
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        for (const entry of body.entry) {
            if (entry.messaging && entry.messaging[0]) {
                const webhookEvent = entry.messaging[0];
                const senderPsid = webhookEvent.sender.id;

                if (webhookEvent.message && webhookEvent.message.text) {
                    const userMessage = webhookEvent.message.text;
                    console.log(`رسالة من ${senderPsid}: ${userMessage}`);

                    try {
                        // استدعاء نموذج gemini-2.5-flash مع توجيه ذكي للمتجر
                        const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: [
                                    {
                                        role: "user",
                                        parts: [{ text: `أنت مساعد مبيعات لمتجر M_A Store في قصر الأخيار - العلوص. سعر المنتج 115 دينار. أجب على سؤال الزبون باختصار وذكاء وبدون تكرار: ${userMessage}` }]
                                    }
                                ]
                            })
                        });

                        const data = await geminiResponse.json();
                        let botReply = data.candidates?.[0]?.content?.parts?.[0]?.text || "أهلاً بك في M_A Store، كيف يمكنني مساعدتك؟";
                        botReply = botReply.trim();

                        // إرسال الرد عبر الماسنجر
                        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
                            recipient: { id: senderPsid },
                            message: { text: botReply }
                        });

                    } catch (error) {
                        console.error('Error generating AI response:', error);
                    }
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
