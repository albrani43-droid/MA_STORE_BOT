# MA STORE BOT

Node.js Facebook Messenger + Page comments AI bot.

1. Upload `server.js` and `package.json` to the repository root (not inside a nested folder).
2. In Render > Environment set PAGE_ACCESS_TOKEN, VERIFY_TOKEN, META_APP_SECRET, PAGE_ID, OPENAI_API_KEY. Optionally OPENAI_MODEL and GRAPH_API_VERSION.
3. Render build: `npm install`; start: `npm start`.
4. Keep your existing Meta webhook callback URL: `https://YOUR-RENDER-SERVICE.onrender.com/webhook` and existing VERIFY_TOKEN.
5. Subscribe the Page to `messages` and `feed` webhook events, with required Meta permissions and app access. Ensure the Page access token belongs to that Page.
6. Test a message and a new comment from a separate account. Review Render logs for API errors.

Security: Never commit real secrets to GitHub. `.env.example` is placeholders only.

Limitations: Deduplication is in-memory and resets on restart; production deployments with multiple instances should use persistent event IDs and a job queue. Replies are processed asynchronously after HTTP acknowledgement. Meta Graph API version must be supported and permissions approved. AI usage incurs API charges. No live catalog is connected; bot does not know prices or stock.
