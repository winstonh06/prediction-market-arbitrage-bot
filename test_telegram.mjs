import https from "https";
import dotenv from "dotenv";
dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const text = encodeURIComponent("Test from Kalshi bot!");
const url = "https://api.telegram.org/bot" + token + "/sendMessage?chat_id=" + chatId + "&text=" + text;

https.get(url, (res) => {
  let data = "";
  res.on("data", d => data += d);
  res.on("end", () => console.log(data));
}).on("error", e => console.log("ERROR:", e.message));
