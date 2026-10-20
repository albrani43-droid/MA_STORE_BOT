const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

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

app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        for (const entry of body.entry) {
            if (entry.messaging && entry.messaging[0]) {
                const webhookEvent = entry.messaging[0];
                const senderPsid = webhookEvent.sender.id;

                if (webhookEvent.message && webhookEvent.message.text) {
                    const userMessage = webhookEvent.message.text;
                    console.log(`رسالة من الزبون: ${userMessage}`);

                    try {
                        const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: [
                                    {
                                        role: "user",
                                        parts: [{ text: `أنت مساعد مبيعات لمتجر M_A Store. سعر المنتج 115 دينار وموقعنا في قصر الأخيار - العلوص. أجب على هذا السؤال باختصار: ${userMessage}` }]
                                    }
                                ]
                            })
                        });

                        const data = await geminiResponse.json();
                        
                        // طباعة الرد كاملاً في لوحة تحكم Render لنرى هل هناك خطأ من جوجل
                        console.log("Google AI Response:", JSON.stringify(data, null, 2));

                        let botReply = "أهلاً بك في M_A Store، سعر المنتج 115 دينار وموقعنا في قصر الأخيار.";
                        
                        if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts[0].text) {
                            botReply = data.candidates[0].content.parts[0].text.trim();
                        }

                        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
                            recipient: { id: senderPsid },
                            message: { text: botReply }
                        });

                    } catch (error) {
                        console.error('Error in AI processing:', error);
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
