
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

// غيّر نص الرد حسب المنشور
const PUBLIC_REPLY =
  process.env.PUBLIC_REPLY ||
  "هلا وغلا بيك ❤️ سعر الحذاء 115 دينار، والمقاسات من 41 إلى 47، والألوان أبيض وكحلي 👟";

const processed = new Set();
const processing = new Set();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function matchesPost(incoming) {
  if (!TARGET_POST_ID) return false;

  const received = String(incoming || "").trim();
  const target = String(TARGET_POST_ID).trim();

  if (!received) return false;

  return received === target;
}

async function replyToComment(commentId) {
  const id = String(commentId);

  if (processed.has(id) || processing.has(id)) {
    log("SKIPPED DUPLICATE:", id);
    return;
  }

  processing.add(id);

  try {
    log("REPLY START:", id);

    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(id)}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAGE_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: PUBLIC_REPLY
        })
      }
    );

    const data = await response.json();

    if (!response.ok || data.error) {
      log("META REPLY ERROR:", {
        status: response.status,
        code: data.error?.code,
        message: data.error?.message
      });
      return;
    }

    processed.add(id);
    log("REPLY SUCCESS:", data.id);
  } catch (error) {
    log("REPLY FAILED:", error.message);
  } finally {
    processing.delete(id);
  }
}

app.get("/", (_req, res) => {
  res.status(200).send("MA STORE COMMENT BOT RUNNING");
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
    log("WEBHOOK POST RECEIVED");

    if (!APP_SECRET || !PAGE_TOKEN || !PAGE_ID) {
      log("MISSING ENVIRONMENT VARIABLES");
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
      log("INVALID META SIGNATURE");
      return res.sendStatus(403);
    }

    let payload;

    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      log("INVALID JSON");
      return res.sendStatus(400);
    }

    res.sendStatus(200);

    log("WEBHOOK OBJECT:", payload.object);

    if (payload.object !== "page") return;

    for (const entry of payload.entry || []) {
      log("PAGE ENTRY:", entry.id);

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

        if (v.item !== "comment" || v.verb !== "add") {
          continue;
        }

        if (!v.comment_id) {
          log("MISSING COMMENT ID");
          continue;
        }

        if (
          String(v.from?.id || v.sender_id) ===
          String(PAGE_ID)
        ) {
          log("IGNORED PAGE COMMENT");
          continue;
        }

        if (!TARGET_POST_ID) {
          log("TARGET_POST_ID NOT CONFIGURED");
          continue;
        }

        if (!matchesPost(v.post_id)) {
          log("POST ID MISMATCH:", {
            received: v.post_id,
            expected: TARGET_POST_ID
          });
          continue;
        }

        log("TARGET POST MATCHED");

        void replyToComment(v.comment_id);
      }
    }
  }
);

app.listen(PORT, () => {
  log("MA STORE COMMENT BOT STARTED");
  log("PORT:", PORT);
  log("TARGET POST:", TARGET_POST_ID || "NOT SET");
  log("MESSENGER: DISABLED");
  log("PRIVATE REPLIES: DISABLED");
});
