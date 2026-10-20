const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(bodyParser.json());

// إعداد Gemini API باستخدام المفتاح الموجود في المتغيرات البيئية
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// تحقق من الـ Webhook الخاص بفيسبوك
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = "ma_store_verify_token"; // استبدله بالرمز الخاص بك إذا كنت تستخدم رمزاً محدداً
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
            const webhookEvent = entry.messaging[0];
            const senderPsid = webhookEvent.sender.id;

            if (webhookEvent.message && webhookEvent.message.text) {
                const userMessage = webhookEvent.message.text;
                console.log(`رسالة خاصة من ${senderPsid}: ${userMessage}`);

                try {
                    // توليد الرد باستخدام نموذج Gemini
                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: userMessage,
                    });

                    const botReply = response.text || "أهلاً بك، كيف يمكنني مساعدتك اليوم؟";

                    // إرسال الرد عبر Messenger API
                    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
                        recipient: { id: senderPsid },
                        message: { text: botReply }
                    });

                } catch (error) {
                    console.error('Error generating AI response or sending message:', error);
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// الـ Port المطلوب لكي تعمل الخدمة بنجاح على Render بدون مشاكل
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running and listening on port ${PORT}`);
});
