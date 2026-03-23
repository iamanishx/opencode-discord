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
  info: { id: string; role?: string; finish?: string };
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

async function reply(msgid: string, timeout = 180_000): Promise<string> {
  log("INFO", "waiting for response", { parentID: msgid });
  const start = Date.now();
  let poll = 0;

  while (Date.now() - start < timeout) {
    await Bun.sleep(2000);
    poll++;

    const msgs = await latest();
    const msg = msgs.find(
      (m) =>
        m.info.role === "assistant" &&
        (m.info as { parentID?: string }).parentID === msgid &&
        m.info.finish,
    );

    if (msg) {
      const text = msg.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      log("INFO", "got response", {
        id: msg.info.id,
        length: text.length,
        polls: poll,
      });
      return text || "(empty response)";
    }

    if (poll % 10 === 0) {
      const roles = msgs.map(
        (m) =>
          `${m.info.role}:${m.info.id.slice(-8)}:parent=${((m.info as { parentID?: string }).parentID ?? "-").slice(-8)}:finish=${m.info.finish ?? "-"}`,
      );
      log("INFO", "still waiting", {
        polls: poll,
        elapsed: Date.now() - start,
        msgs: roles,
      });
    }
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
  await msg.channel.sendTyping();

  try {
    const msgid = await prompt(text);
    const answer = await reply(msgid);
    const chunks = answer.match(/[\s\S]{1,2000}/g) ?? ["(empty)"];
    log("INFO", "replying", { chunks: chunks.length, length: answer.length });
    for (const chunk of chunks) await msg.reply(chunk);
    log("INFO", "sent", { user: msg.author.tag });
  } catch (err) {
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
