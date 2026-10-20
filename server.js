const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// إعداد الذكاء الاصطناعي
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. التحقق من الـ Webhook
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// 2. استقبال الرسائل والتعليقات والرد عليها عبر الذكاء الاصطناعي
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        body.entry.forEach(async (entry) => {
            
            // أ) رسائل الماسنجر الخاصة (رد ذكي بـ Gemini)
            if (entry.messaging) {
                entry.messaging.forEach(async (event) => {
                    if (event.message && event.message.text) {
                        const senderPsid = event.sender.id;
                        const messageText = event.message.text;
                        console.log(`رسالة خاصة من ${senderPsid}: ${messageText}`);

                        const aiReply = await getGeminiResponse(messageText);
                        await sendMessengerMessage(senderPsid, aiReply);
                    }
                });
            }

            // ب) تعليقات المنشورات (رد تلقائي بتعليق)
            if (entry.changes) {
                entry.changes.forEach(async (change) => {
                    if (change.field === 'feed' && change.value.item === 'comment' && change.value.verb === 'add') {
                        const commentId = change.value.comment_id;
                        const commenterName = change.value.from.name;
                        const message = change.value.message;
                        
                        console.log(`تعليق جديد من ${commenterName}: ${message}`);
                        await replyToComment(commentId, `أهلاً بك يا ${commenterName}، تم الرد على الخاص 📩✨`);
                    }
                });
            }
        });

        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// دالة توليد الرد من Gemini
async function getGeminiResponse(userPrompt) {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: userPrompt,
            config: {
                systemInstruction: "أنت مساعد مبيعات ذكي وودود لمتجر M_A Store في ليبيا. سعر المنتج الأساسي 115 دينار، والتوصيل لطرابلس بـ 20 دينار وباقي المدن حسب الاتفاق. أجب بأسلوب ودي وبسيط.",
            }
        });
        return response.text || "أهلاً بك في M_A Store! كيف يمكنني مساعدتك؟";
    } catch (error) {
        console.error("خطأ في الذكاء الاصطناعي:", error);
        return "أهلاً بك في M_A Store! سعر المنتج 115 دينار.";
    }
}

// دالة إرسال رسالة ماسنجر
async function sendMessengerMessage(recipientPsid, responseText) {
    try {
        await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: recipientPsid },
            message: { text: responseText }
        });
    } catch (error) {
        console.error("خطأ في الماسنجر:", error.response?.data || error.message);
    }
}

// دالة الرد على التعليق
async function replyToComment(commentId, responseText) {
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${commentId}/comments?access_token=${PAGE_ACCESS_TOKEN}`, {
            message: responseText
        });
    } catch (error) {
        console.error("خطأ في التعليق:", error.response?.data || error.message);
    }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`M A STORE Bot running on port ${PORT}`);
});
