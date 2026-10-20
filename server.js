const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ma_store_secret_2026';

// 1. رابط التحقق من الـ Webhook الخاص بـ Meta
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === VERIFY_TOKEN) {
        console.log('WEBHOOK_VERIFIED');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// 2. استقبال التعليقات والرسائل من صفحة M A STORE
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        body.entry.forEach(async (entry) => {

            // أ) التعليقات على المنشورات
            if (entry.changes) {
                entry.changes.forEach(async (change) => {
                    if (change.field === 'feed' && change.value.item === 'comment' && change.value.verb === 'add') {
                        const commentId = change.value.comment_id;
                        const userMessage = change.value.message || '';

                        console.log(`تعليق جديد: ${userMessage}`);
                        const replyData = getReplyByText(userMessage);

                        await replyToComment(commentId, replyData.publicReply);
                        await sendPrivateMessageFromComment(commentId, replyData.privateMessage);
                    }
                });
            }

            // ب) الرسائل المباشرة في الخاص (Messenger)
            if (entry.messaging) {
                entry.messaging.forEach(async (event) => {
                    if (event.message && !event.message.is_echo) {
                        const senderPsid = event.sender.id;
                        const userMessage = event.message.text || '';

                        console.log(`رسالة خاصة: ${userMessage}`);
                        const replyData = getReplyByText(userMessage);

                        await sendDirectMessage(senderPsid, replyData.privateMessage);
                    }
                });
            }
        });

        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

// شروط الرد المخصصة لمتجر M A STORE ودليل الشحن
function getReplyByText(text) {
    const cleanText = text.toLowerCase();

    // 1. الاستفسار عن السعر
    if (cleanText.includes('بكم') || cleanText.includes('سعر') || cleanText.includes('كم') || cleanText.includes('قداس')) {
        return {
            publicReply: "تم الرد في الخاص 📥",
            privateMessage: "أهلاً بك في M A STORE! 🛍️\nالسعر هو 115 دينار فقط ✨"
        };
    } 
    
    // 2. مناطق الشحن 20 د.ل (3 أيام)
    else if (cleanText.includes('طرابلس') || cleanText.includes('قماطه') || cleanText.includes('ابو عيسي') || cleanText.includes('أبو عيسى') || cleanText.includes('غوط الرمان') || cleanText.includes('جدائم') || cleanText.includes('القويعة') || cleanText.includes('الماية')) {
        return {
            publicReply: "تم الرد في الخاص 📥",
            privateMessage: "أهلاً بك في M A STORE! 🚗\nالتوصيل لـ (طرابلس والضواحي القريبة) بـ 20 دينار (خلال 3 أيام)."
        };
    }

    // 3. مناطق الشحن 25 د.ل (3 أيام)
    else if (cleanText.includes('وادي الربيع') || cleanText.includes('السلطان') || cleanText.includes('الزطارنة') || cleanText.includes('النشيع') || cleanText.includes('ورشفانة')) {
        return {
            publicReply: "تم الرد في الخاص 📥",
            privateMessage: "أهلاً بك في M A STORE! 📦\nالتوصيل لهذه المنطقة بـ 25 دينار (خلال 3 أيام)."
        };
    }

    // 4. مناطق الشحن 30 د.ل (3 أيام)
    else if (cleanText.includes('الزاوية') || cleanText.includes('المقرون') || cleanText.includes('قمينس') || cleanText.includes('دريانة') || cleanText.includes('مسة') || cleanText.includes('الهيشة') || cleanText.includes('الوشكة') || cleanText.includes('الهيرة') || cleanText.includes('تيكا') || cleanText.includes('الحليس') || cleanText.includes('الفعكات') || cleanText.includes('بودريسه') || cleanText.includes('ام مبروكة') || cleanText.includes('برسس')) {
        return {
            publicReply: "تم الرد في الخاص 📥",
            privateMessage: "أهلاً بك في M A STORE! 📦\nالتوصيل لهذه المنطقة بـ 30 دينار (خلال 3 أيام)."
        };
    }

    // 5. مناطق الشحن 35 د.ل (3 - 4 أيام)
    else if (cleanText.includes('الرابطة') || cleanText.includes('الجوش') || cleanText.includes('الشقيقة') || cleanText.includes('بئر الغنم') || cleanText.includes('مليته') || cleanText.includes('وادي عتبة') || cleanText.includes('بشر') || cleanText.includes('سوكنة') || cleanText.includes('هون') || cleanText.includes('براك الشاطي') || cleanText.includes('ادري') || cleanText.includes('تمسان') || cleanText.includes('برقن')) {
        return {
            publicReply: "تم الرد في الخاص 📥",
            privateMessage: "أهلاً بك في M A STORE! 🚚\nالتوصيل لهذه المنطقة بـ 35 دينار (خلال 3 إلى 4 أيام)."
        };
    }

    // 6. مناطق الشحن 40 د.ل
    else if (cleanText.includes('البلنج') || cleanText.includes('وردامة') || cleanText.includes('الجفرة') || cleanText.includes('رسم الحصان')) {
        return {
            publicReply: "تم الرد في الخاص 📥",
            privateMessage: "أهلاً بك في M A STORE! 🚚\nالتوصيل لهذه المنطقة بـ 40 دينار."
        };
    }

    // 7. مناطق الشحن 45 د.ل
    else if (cleanText.includes('الغريفة') || cleanText.includes('تازربو') || cleanText.includes('تمنهنت') || cleanText.includes('الوسيطة') || cleanText.includes('العربان')) {
        return {
            publicReply: "تم الرد في الخاص 📥",
            privateMessage: "أهلاً بك في M A STORE! 🚚\nالتوصيل لهذه المنطقة بـ 45 دينار (خلال 3 أيام)."
        };
    }

    // 8. مناطق الشحن 50 د.ل (الشرق والحدودية)
    else if (cleanText.includes('طبرق') || cleanText.includes('درنه') || cleanText.includes('درنة') || cleanText.includes('البيضاء') || cleanText.includes('شحات') || cleanText.includes('تاكنس') || cleanText.includes('عمر المختار') || cleanText.includes('القيقب') || cleanText.includes('مرتوبة') || cleanText.includes('البردي') || cleanText.includes('بئر الأشهب') || cleanText.includes('طلميثة')) {
        return {
            publicReply: "تم الرد في الخاص 📥",
            privateMessage: "أهلاً بك في M A STORE! 🚚\nالتوصيل لهذه المنطقة بـ 50 دينار (خلال 3 أيام)."
        };
    }

    // 9. الاستفسار العام عن التوصيل والشحن
    else if (cleanText.includes('توصيل') || cleanText.includes('شحن') || cleanText.includes('يوصل')) {
        return {
            publicReply: "تم الرد في الخاص 📥",
            privateMessage: "أهلاً بك في M A STORE! 📦\nالتوصيل متوفر لجميع المدن والمناطق الليبية. أرسل لنا اسم مدينتك لتزويدك بسعر التوصيل وموعد التسليم بالضبط ✨"
        };
    } 

    // 10. أي تعليق أو رسالة أخرى
    else {
        return {
            publicReply: "تم الرد في الخاص 📥",
            privateMessage: "مرحباً بك في M A STORE! 🌟\nسعر المنتج 115 دينار والتوصيل متوفر لجميع المدن الليبية.\nكيف يمكننا مساعدتك اليوم؟"
        };
    }
}

async function replyToComment(commentId, message) {
    try {
        await axios.post(`https://graph.facebook.com/v19.0/${commentId}/comments`, {
            message: message,
            access_token: PAGE_ACCESS_TOKEN
        });
    } catch (e) {}
}

async function sendPrivateMessageFromComment(commentId, message) {
    try {
        await axios.post(`https://graph.facebook.com/v19.0/${commentId}/messages`, {
            recipient: { comment_id: commentId },
            message: { text: message },
            access_token: PAGE_ACCESS_TOKEN
        });
    } catch (e) {}
}

async function sendDirectMessage(senderPsid, message) {
    try {
        await axios.post(`https://graph.facebook.com/v19.0/me/messages`, {
            recipient: { id: senderPsid },
            message: { text: message },
            access_token: PAGE_ACCESS_TOKEN
        });
    } catch (e) {}
}

app.listen(PORT, () => console.log(`M A STORE Bot running on port ${PORT}`));