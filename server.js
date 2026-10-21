
import express from "express";
import crypto from "node:crypto";

const app = express();

const PORT = process.env.PORT || 10000;
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const PAGE_ID = process.env.PAGE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v23.0";

const PUBLIC_REPLY = "تم رد على الخاص ✔️";

const PRIVATE_MESSAGE = `هلا وغلا بيك في متجر M A Store ❤️👟

💰 سعر الحذاء: 115 دينار

📏 المقاسات المتوفرة:
من 41 إلى 47

🎨 الألوان المتوفرة:
🤍 أبيض
💙 أزرق كحلي

💳 طرق الدفع:
💵 كاش
💳 بطاقة مصرفية
🏦 حوالة مصرفية

🚚 التوصيل متوفر، وتكلفته حسب المدينة والمنطقة.

📩 لو تبي تطلب، ابعتلنا المقاس واللون والمدينة، ونأكدولك التفاصيل.

نورتنا يا غالي ❤️`;

const processing = new Set();
const completed = new Set();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function graph(path, body) {
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAGE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!response.ok || data.error) {
    const error = data.error || {};
    log("META API ERROR:", {
      status: response.status,
      code: error.code,
      subcode: error.error_subcode,
      message: error.message
    });

    throw new Error(error.message || "Meta API request failed");
  }

  return data;
}

async function handleComment(commentId) {
  const id = String(commentId);

  if (completed.has(id) || processing.has(id)) {
    log("DUPLICATE COMMENT:", id);
    return;
  }

  processing.add(id);

  try {
    log("PRIVATE REPLY START:", id);

    await graph(
      `${encodeURIComponent(id)}/private_replies`,
      { message: PRIVATE_MESSAGE }
    );

    log("PRIVATE REPLY SUCCESS:", id);

    // منع تكرار إرسال الرسالة الخاصة أثناء تشغيل الخدمة
    completed.add(id);

    try {
      await graph(
        `${encodeURIComponent(id)}/comments`,
        { message: PUBLIC_REPLY }
      );

      log("PUBLIC REPLY SUCCESS:", id);
    } catch (error) {
      log("PUBLIC REPLY FAILED:", error.message);
    }
  } catch (error) {
    log("PRIVATE REPLY FAILED:", error.message);
  } finally {
    processing.delete(id);
  }
}

app.get("/", (_req, res) => {
  res.status(200).send("MA STORE BOT RUNNING");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    VERIFY_TOKEN &&
    token === VERIFY_TOKEN
  ) {
    log("WEBHOOK VERIFIED");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    log("META WEBHOOK POST RECEIVED");

    if (!APP_SECRET || !PAGE_TOKEN || !PAGE_ID) {
      log("ERROR: MISSING ENVIRONMENT VARIABLES");
      return res.sendStatus(503);
    }

    if (!Buffer.isBuffer(req.body)) {
      return res.sendStatus(400);
    }

    const signature = req.get("x-hub-signature-256");

    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", APP_SECRET)
        .update(req.body)
        .digest("hex");

    if (
      !signature ||
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
      )
    ) {
      log("INVALID META SIGNATURE");
      return res.sendStatus(403);
    }

    let payload;

    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.sendStatus(400);
    }

    res.sendStatus(200);

    if (payload.object !== "page") return;

    for (const entry of payload.entry || []) {
      log("PAGE EVENT:", entry.id);

      if (String(entry.id) !== String(PAGE_ID)) {
        log("IGNORED: DIFFERENT PAGE");
        continue;
      }

      // تجاهل Messenger
      if (entry.messaging?.length) {
        log("MESSENGER IGNORED");
      }

      for (const change of entry.changes || []) {
        log("CHANGE FIELD:", change.field);

        if (change.field !== "feed") continue;

        const v = change.value || {};

        log("FEED EVENT:", {
          item: v.item,
          verb: v.verb,
          post_id: v.post_id,
          comment_id: v.comment_id
        });

        if (v.item !== "comment") continue;
        if (v.verb !== "add") continue;
        if (!v.comment_id) continue;

        const authorId = String(
          v.from?.id || v.sender_id || ""
        );

        if (authorId && authorId === String(PAGE_ID)) {
          log("IGNORED: PAGE'S OWN COMMENT");
          continue;
        }

        log("NEW COMMENT:", v.comment_id);

        void handleComment(v.comment_id).catch(error => {
          log("UNEXPECTED ERROR:", error.message);
        });
      }
    }
  }
);

app.listen(PORT, () => {
  log("MA STORE BOT STARTED");
  log("PORT:", PORT);
  log("PAGE ID:", PAGE_ID);
  log("ALL POSTS: ENABLED");
  log("MESSENGER: DISABLED");
});
