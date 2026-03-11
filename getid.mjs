import https from "https";
import dotenv from "dotenv";
dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const url = "https://api.telegram.org/bot" + token + "/getUpdates";

https.get(url, (res) => {
  let data = "";
  res.on("data", d => data += d);
  res.on("end", () => {
    console.log(data);
  });
}).on("error", e => console.log("ERROR:", e.message));
