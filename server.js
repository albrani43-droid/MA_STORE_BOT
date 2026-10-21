
import express from "express";
import crypto from "node:crypto";

const app = express();

const PORT = process.env.PORT || 10000;
const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const PAGE_ID = process.env.PAGE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;
const TARGET_POST_ID = process.env.TARGET_POST_ID;

const GRAPH_VERSION =
  process.env.GRAPH_API_VERSION || "v23.0";

const PUBLIC_REPLY = "تم رد على الخاص ✔️";

const PRIVATE_MESSAGE = `هلا وغلا بيك في متجر M A Store ❤️👟

سعر الحذاء: 115 دينار 💰

📏 المقاسات المتوفرة:
من 41 إلى 47

🎨 الألوان المتوفرة:
🤍 أبيض
💙 أزرق كحلي

💳 طرق الدفع:
💵 كاش
💳 بطاقة مصرفية
🏦 حوالة مصرفية

🚚 التوصيل متوفر لجميع المناطق المتاحة، وتكلفته حسب المدينة والمنطقة.

📩 لو تبي تطلب، ابعتلنا المقاس واللون والمدينة، ونأكدولك تفاصيل الطلب.

نورتنا يا غالي ❤️`;

const completed = new Map();
const processing = new Set();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function normalizePostId(value) {
  return String(value || "").trim();
}

function matchesTarget(postId) {
  const incoming = normalizePostId(postId);
  const target = normalizePostId(TARGET_POST_ID);

  if (!incoming || !target) return false;

  return incoming === target;
}

function alreadyCompleted(id) {
  const now = Date.now();

  for (const [key, time] of completed) {
    if (now - time > 24 * 60 * 60 * 1000) {
      completed.delete(key);
    }
  }

  return completed.has(id);
}

async function graph(path, body) {
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PAGE_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    const error = data.error || {};

    log("META API ERROR:", {
      status: response.status,
      code: error.code,
      subcode: error.error_subcode,
      message: error.message
    });

    throw new Error(
      `Meta API failed: ${error.message || response.status}`
    );
  }

  return data;
}

async function handleComment(commentId) {
  const id = String(commentId);

  if (alreadyCompleted(id) || processing.has(id)) {
    log("COMMENT SKIPPED: duplicate", id);
    return;
  }

  processing.add(id);

  try {
    if (!PAGE_TOKEN) {
      throw new Error("PAGE_ACCESS_TOKEN missing");
    }

    log("PRIVATE REPLY START:", id);

    await graph(
      `${encodeURIComponent(id)}/private_replies`,
      { message: PRIVATE_MESSAGE }
    );

    log("PRIVATE REPLY SUCCESS:", id);

    // منع تكرار إرسال الخاص خلال تشغيل الخدمة
    completed.set(id, Date.now());

    try {
      await graph(
        `${encodeURIComponent(id)}/comments`,
        { message: PUBLIC_REPLY }
      );

      log("PUBLIC COMMENT SUCCESS:", id);
    } catch (error) {
      log("PUBLIC COMMENT FAILED:", error.message);
    }

  } catch (error) {
    log("COMMENT PROCESSING FAILED:", error.message);
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

  log("WEBHOOK VERIFICATION FAILED");
  return res.sendStatus(403);
});

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {

    log("META WEBHOOK POST received");

    if (!APP_SECRET || !PAGE_TOKEN || !PAGE_ID) {
      log("ERROR: Required environment variable missing");
      return res.sendStatus(503);
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
      log("ERROR: Invalid Meta signature");
      return res.sendStatus(403);
    }

    let payload;

    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      log("ERROR: Invalid JSON");
      return res.sendStatus(400);
    }

    res.sendStatus(200);

    log("WEBHOOK OBJECT:", payload.object);

    if (payload.object !== "page") {
      log("IGNORED: Not a page event");
      return;
    }

    for (const entry of payload.entry || []) {

      log("PAGE EVENT RECEIVED:", entry.id);

      // تجاهل رسائل Messenger بالكامل
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

        if (v.item !== "comment") {
          log("IGNORED: Not a comment");
          continue;
        }

        if (v.verb !== "add") {
          log("IGNORED: Not a new comment");
          continue;
        }

        if (!v.comment_id) {
          log("IGNORED: Missing comment ID");
          continue;
        }

        if (
          String(v.from?.id || v.sender_id) ===
          String(PAGE_ID)
        ) {
          log("IGNORED: Page's own comment");
          continue;
        }

        if (!TARGET_POST_ID) {
          log("ERROR: TARGET_POST_ID missing");
          continue;
        }

        if (!matchesTarget(v.post_id)) {
          log("POST ID DOES NOT MATCH:", {
            received: v.post_id,
            expected: TARGET_POST_ID
          });
          continue;
        }

        log("TARGET POST MATCHED:", v.comment_id);

        void handleComment(v.comment_id).catch(error => {
          log("UNEXPECTED ERROR:", error.message);
        });
      }
    }
  }
);

app.listen(PORT, () => {
  log("MA STORE COMMENT BOT STARTED");
  log("Listening on port:", PORT);
  log("Configured target post:", TARGET_POST_ID || "NOT SET");
  log("Messenger replies: DISABLED");
});
