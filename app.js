require("dotenv").config();
const { App } = require("@slack/bolt");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Echo back any message (DMs and channels), ignoring bot messages
app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;
  await say({ text: `Echo: ${message.text}`, thread_ts: message.ts });
});

(async () => {
  await app.start();
  console.log("⚡ Slack bot is running in Socket Mode");
})();
