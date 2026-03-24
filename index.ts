import { Client, GatewayIntentBits, ActivityType } from "discord.js";

const OPENCODE_URL = process.env.OPENCODE_URL ?? "";
const OPENCODE_SESSION = process.env.OPENCODE_SESSION ?? "";
const OPENCODE_DIR = process.env.OPENCODE_DIR ?? "";
const OPENCODE_USER = process.env.OPENCODE_USER ?? "";
const OPENCODE_PASS = process.env.OPENCODE_PASS ?? "";
const OPENCODE_MODEL_ID = process.env.OPENCODE_MODEL_ID ?? "minimax-m2.5-free";
const OPENCODE_PROVIDER_ID = process.env.OPENCODE_PROVIDER_ID ?? "opencode";
const OPENCODE_AGENT = process.env.OPENCODE_AGENT ?? "build";

const auth = `Basic ${btoa(`${OPENCODE_USER}:${OPENCODE_PASS}`)}`;
const headers = {
  authorization: auth,
  "x-opencode-directory": OPENCODE_DIR,
  "content-type": "application/json",
};

type Msg = {
  info: {
    id: string;
    role?: string;
    finish?: string;
    parentID?: string;
    time?: { created?: number };
  };
  parts: Array<{ type: string; text?: string }>;
};

function ts() {
  return new Date().toISOString();
}

function log(level: string, msg: string, data?: Record<string, unknown>) {
  const base = `[${ts()}] [${level}] ${msg}`;
  if (data) console.log(base, data);
  else console.log(base);
}

function mid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

async function status(): Promise<string> {
  const res = await fetch(`${OPENCODE_URL}/session/status`, { headers });
  if (!res.ok) return "unknown";
  const data = (await res.json()) as Record<string, { type: string }>;
  return data[OPENCODE_SESSION]?.type ?? "idle";
}

async function latest(): Promise<Msg[]> {
  const res = await fetch(
    `${OPENCODE_URL}/session/${OPENCODE_SESSION}/message?limit=4`,
    { headers },
  );
  if (!res.ok) return [];
  return (await res.json()) as Msg[];
}

async function abort() {
  await fetch(`${OPENCODE_URL}/session/${OPENCODE_SESSION}/abort`, {
    method: "POST",
    headers,
  }).catch(() => {});
}

async function prompt(text: string): Promise<string> {
  await abort();
  await Bun.sleep(500);
  const msgid = mid("msg");
  log("INFO", "sending prompt", { messageID: msgid, length: text.length });

  const res = await fetch(
    `${OPENCODE_URL}/session/${OPENCODE_SESSION}/prompt_async`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent: OPENCODE_AGENT,
        messageID: msgid,
        model: { modelID: OPENCODE_MODEL_ID, providerID: OPENCODE_PROVIDER_ID },
        parts: [{ id: mid("prt"), type: "text", text }],
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    log("ERROR", "prompt failed", { status: res.status, body });
    throw new Error(`prompt failed: ${res.status}`);
  }

  log("INFO", "prompt accepted", { status: res.status });
  return msgid;
}

async function reply(timeout = 300_000): Promise<string> {
  log("INFO", "waiting for session to finish");
  const start = Date.now();
  let poll = 0;
  let saw = false;

  while (Date.now() - start < timeout) {
    await Bun.sleep(2000);
    poll++;

    const s = await status();

    if (s === "busy") {
      saw = true;
      if (poll % 15 === 0)
        log("INFO", "session busy", {
          polls: poll,
          elapsed: Date.now() - start,
        });
      continue;
    }

    if (s === "idle" && saw) {
      log("INFO", "session idle, fetching final response", { polls: poll });
      const msgs = await latest();
      const last = msgs.find(
        (m) => m.info.role === "assistant" && m.info.finish === "stop",
      );

      if (!last) {
        log("WARN", "no finished assistant message found", {
          msgs: msgs.map((m) => `${m.info.role}:${m.info.finish ?? "-"}`),
        });
        return "(no response)";
      }

      const text = last.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      log("INFO", "got response", {
        id: last.info.id,
        length: text.length,
        polls: poll,
      });
      return text || "(no text in response)";
    }

    if (s === "idle" && !saw) {
      if (poll <= 3) continue;
      log("WARN", "session never became busy", { polls: poll });
      return "(session did not process the message)";
    }

    if (poll % 15 === 0)
      log("INFO", "waiting", {
        status: s,
        polls: poll,
        elapsed: Date.now() - start,
      });
  }

  log("WARN", "timed out", { timeout, polls: poll });
  throw new Error("timeout");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", (c) => {
  log("INFO", `online as ${c.user.tag}`, {
    id: c.user.id,
    guilds: c.guilds.cache.size,
  });
  c.user.setPresence({
    status: "online",
    activities: [{ name: "opencode", type: ActivityType.Watching }],
  });
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!msg.mentions.has(client.user!.id)) return;

  const text = msg.content.replace(/<@!?\d+>/g, "").trim();
  if (!text) return;

  log("INFO", "mention", {
    user: msg.author.tag,
    channel: msg.channelId,
    text: text.slice(0, 100),
  });

  const typing = setInterval(
    () => msg.channel.sendTyping().catch(() => {}),
    8000,
  );
  await msg.channel.sendTyping();

  try {
    await prompt(text);
    const answer = await reply();
    clearInterval(typing);
    const chunks = answer.match(/[\s\S]{1,2000}/g) ?? ["(empty)"];
    log("INFO", "replying", { chunks: chunks.length, length: answer.length });
    for (const chunk of chunks) await msg.reply(chunk);
    log("INFO", "sent", { user: msg.author.tag });
  } catch (err) {
    clearInterval(typing);
    log("ERROR", "failed", { error: String(err), user: msg.author.tag });
    await msg.reply(`Error: ${err}`);
  }
});

client.on("error", (err) =>
  log("ERROR", "discord error", { error: String(err) }),
);
client.on("warn", (m) => log("WARN", "discord warning", { message: m }));
client.on("shardDisconnect", (evt, id) =>
  log("WARN", "shard disconnected", { code: evt.code, shard: id }),
);
client.on("shardReconnecting", (id) =>
  log("INFO", "shard reconnecting", { shard: id }),
);
client.on("shardResume", (id, count) =>
  log("INFO", "shard resumed", { shard: id, replayed: count }),
);

log("INFO", "starting bot", {
  opencode: OPENCODE_URL,
  session: OPENCODE_SESSION,
});

client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
  log("ERROR", "login failed", { error: String(err) });
  process.exit(1);
});
