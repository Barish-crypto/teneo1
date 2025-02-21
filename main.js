const WebSocket = require("ws");
const fs = require("fs/promises");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const readline = require("readline");
const colors = require("colors");
const axios = require("axios");
const { config } = require("./config");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "vi,en-US;q=0.9,en;q=0.8",
    Referer: "https://dashboard.teneo.pro/",
    Origin: "https://dashboard.teneo.pro",
    "Sec-Ch-Ua": '"Not/A)Brand";v="99", "Google Chrome";v="115", "Chromium";v="115"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "x-api-key": config.X_API_KEY,
  };
}

function getProxyAgent(proxyUrl) {
  try {
    return proxyUrl.toLowerCase().startsWith("socks") ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
  } catch (error) {
    return null;
  }
}

async function readFile(filePath) {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return data.split("\n").map((line) => line.trim()).filter((line) => line);
  } catch (error) {
    return [];
  }
}

class WebSocketClient {
  constructor(token, proxy, accountIndex, proxyIP) {
    this.token = token;
    this.proxy = proxy;
    this.proxyIp = proxyIP;
    this.accountIndex = accountIndex;
    this.socket = null;
    this.pingInterval = null;
    this.reconnectAttempts = 0;
    this.wsUrl = "wss://secure.ws.teneo.pro";
    this.version = "v0.2";
  }

  log(msg, type = "info") {
    const colorsMap = { success: "green", custom: "magenta", error: "red", warning: "yellow", default: "blue" };
    console.log(`[*][Account ${this.accountIndex + 1}]${this.proxyIp ? `[${this.proxyIp}]` : ""} | ${msg}`[colorsMap[type] || "blue"]);
  }

  async connect() {
    const wsUrl = `${this.wsUrl}/websocket?accessToken=${encodeURIComponent(this.token)}&version=${encodeURIComponent(this.version)}`;
    const options = { headers: { host: "secure.ws.teneo.pro", origin: "chrome-extension://emcclcoaglgcpoognfiggmhnhgabppkm" } };
    if (this.proxy) options.agent = getProxyAgent(this.proxy);

    this.socket = new WebSocket(wsUrl, options);

    this.socket.onopen = () => {
      this.log("WebSocket connected", "success");
      this.reconnectAttempts = 0;
      this.startPinging();
    };

    this.socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.log(`Message: ${data?.message} | Points: ${data?.pointsTotal || 0} | Waiting 15 minutes to next ping...`, "success");
    };

    this.socket.onclose = () => {
      this.stopPinging();
      this.reconnect();
    };

    this.socket.onerror = (error) => {
    };
  }

  reconnect() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.log(`Reconnecting in ${delay / 1000} seconds...`, "warning");
    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
      this.stopPinging();
    }
  }

  startPinging() {
    this.stopPinging();
    this.pingInterval = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "PING" }));
      }
    }, 10000);
  }

  stopPinging() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

async function checkProxyIP(proxy) {
  try {
    const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: getProxyAgent(proxy), timeout: 10000 });
    return response.status === 200 ? response.data.ip : null;
  } catch (error) {
    return null;
  }
}

async function getRef(proxy, token) {
  try {
    const response = await axios.get("https://api.teneo.pro/api/users/referrals?page=1&limit=25", { headers: headers(token), httpsAgent: getProxyAgent(proxy) });
    return response.data;
  } catch (error) {
    return null;
  }
}

async function claimRef(proxy, ref, token) {
  try {
    const response = await axios.post("https://api.teneo.pro/api/users/referrals/claim", { referralId: ref.id, all: false }, { headers: headers(token), httpsAgent: getProxyAgent(proxy) });
    return response.data;
  } catch (error) {
    return null;
  }
}

async function handleRef(accountIndex, proxy, token) {
  const resInfo = await getRef(proxy, token);
  if (resInfo?.success) {
    const refClaims = resInfo.unfiltered.referrals.filter((r) => r.canClaim);
    for (const referral of refClaims) {
      await claimRef(proxy, referral, token);
    }
  }
}

async function main() {
  try {
    const tokens = await readFile("tokens.txt");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question("Do you want to use a proxy? (y/n): ".blue, async (useProxyAnswer) => {
      rl.close();
      const useProxy = useProxyAnswer.toLowerCase() === "y";
      if (tokens.length === 0) return console.log("No tokens found!".yellow);

      const wsClients = await Promise.all(tokens.map(async (token, i) => {
        const proxy = useProxy ? (await readFile("proxies.txt"))[i] || null : null;
        await handleRef(i, proxy, token);
        console.log(`Connecting WebSocket for account: ${i + 1} - Proxy: ${proxy || "None"}`.blue);
        const wsClient = new WebSocketClient(token, proxy, i, proxy || "Local");
        wsClient.connect();
        return wsClient;
      }));

      process.on("SIGINT", () => {
        wsClients.forEach(client => client?.disconnect());
        process.exit(0);
      });
    });
  } catch (error) {
    console.error("Error in main function:", error);
  }
}

main();
