// @description Sends custom and animated emojis as links, and renders fake emojis, stickers, and GIFs as real ones
// @version 0.3.0
// @author mantikafasi

const { gateway } = phoenix;

const settings = phoenix.settings.define({
  emojiSize: {
    type: "select",
    title: "Emoji size",
    options: [
      { value: "48" },
      { value: "32" },
      { value: "64" },
      { value: "96" },
      { value: "128" },
      { value: "160" },
    ],
  },
  useHyperLinks: {
    type: "switch",
    title: "Hide links behind the name",
    description: "Send [name](link) instead of the bare link",
    default: true,
  },
  hyperLinkText: {
    type: "text",
    title: "Link text",
    description: "{{NAME}} is replaced with the emoji's name",
    default: "{{NAME}}",
  },
  renderFakeEmojis: {
    type: "switch",
    title: "Render fake emojis",
    description: "Display fake Nitro emoji links as real custom emojis",
    default: true,
  },
  renderFakeStickers: {
    type: "switch",
    title: "Render fake stickers",
    description: "Display fake Nitro sticker links as real stickers",
    default: true,
  },
  renderFakeGifs: {
    type: "switch",
    title: "Render fake GIFs",
    description: "Display hyperlinked GIFs as clean native GIF embeds",
    default: true,
  },
  renderOwnMessages: {
    type: "switch",
    title: "Include your own messages",
    description: "Also render fake emojis, stickers, and GIFs in your own messages",
    default: false,
  },
});

interface Emoji {
  id: string;
  name: string;
  animated: boolean;
  available: boolean;
  guild: string;
}

interface CachedSticker {
  id: string;
  name: string;
  format_type: number;
}

interface TransformedRecord {
  emojiIds: Set<string>;
  stickerIds: Set<string>;
}

const emojis = new Map<string, Emoji>();
const byName = new Map<string, Emoji[]>();
const stickers = new Map<string, CachedSticker>();
const channelGuild = new Map<string, string>();
// The emoji last picked for each name, which `:name:` in the message box means.
const picked = new Map<string, Emoji>();
// Messages we rewrote, so delayed embed-only MESSAGE_UPDATE frames drop their fake embeds.
const transformed = new Map<string, TransformedRecord>();
const TRANSFORMED_LIMIT = 2048;
// The real tier and user id, before any spoofing. Unknown until the app's first API request.
let premiumType = 0;
let currentUserId: string | null = null;

const addEmojis = (guild: string, list: Phoenix.Emoji[] | undefined) => {
  for (const e of list ?? []) {
    if (!e.id || !e.name || emojis.has(e.id)) continue;
    const emoji = { id: e.id, name: e.name, animated: !!e.animated, available: e.available !== false, guild };
    emojis.set(e.id, emoji);
    byName.set(e.name, [...(byName.get(e.name) ?? []), emoji]);
  }
};

const addStickers = (list: Phoenix.Sticker[] | undefined) => {
  for (const s of list ?? []) {
    if (!s.id || !s.name) continue;
    stickers.set(s.id, { id: s.id, name: s.name, format_type: s.format_type });
  }
};

// Phoenix loads guilds lazily and never hands READY to plugins: guilds and their
// emojis/stickers live in its cache. Ids in keys are zero-padded to 20 digits.
const unpad = (id: string) => id.replace(/^0+/, "");
const load = async () => {
  const guilds = await phoenix.stores.sql<{ g: string; e: string | null; s: string | null }>(
    "SELECT k AS g, json_extract(CAST(v AS TEXT), '$.emojis') AS e," +
      " json_extract(CAST(v AS TEXT), '$.stickers') AS s FROM guilds",
  );
  for (const { g, e, s } of guilds) {
    if (e) addEmojis(unpad(g), JSON.parse(e));
    if (s) addStickers(JSON.parse(s));
  }
  // One row per guild keeps this under the 10000-row limit.
  const channels = await phoenix.stores.sql<{ g: string; c: string }>(
    "SELECT substr(k, 1, 20) AS g, group_concat(substr(k, 22)) AS c FROM channel_stubs" +
      " WHERE k NOT LIKE '00000000000000000000:%' GROUP BY 1",
  );
  for (const { g, c } of channels) for (const id of c.split(",")) channelGuild.set(unpad(id), unpad(g));
  phoenix.log.info(
    `${emojis.size} emojis, ${stickers.size} stickers in ${guilds.length} servers, ${channelGuild.size} channels`,
  );
};
load().catch((err) => phoenix.log.warn(`reading the cache: ${err}`));

if (gateway.guildCreate) {
  phoenix.on(gateway.guildCreate, (guild) => {
    addEmojis(guild.id, guild.emojis);
    addStickers((guild as Phoenix.GatewayGuild & { stickers?: Phoenix.Sticker[] }).stickers);
    for (const channel of guild.channels ?? []) channelGuild.set(channel.id, guild.id);
  });
}
if (gateway.guildEmojisUpdate) {
  phoenix.on(gateway.guildEmojisUpdate, (update) => addEmojis(update.guild_id, update.emojis));
}
if (gateway.guildStickersUpdate) {
  phoenix.on(gateway.guildStickersUpdate, (update) => {
    const payload = update as { stickers?: Phoenix.Sticker[] };
    addStickers(payload.stickers);
  });
}

const readTier = () =>
  phoenix.discord
    .me()
    .then((user) => {
      premiumType = user?.premium_type ?? 0;
      currentUserId = user?.id ?? null;
    })
    .catch((err) => phoenix.log.warn(`reading the account: ${err}`));
readTier();
if (gateway.readySupplemental) phoenix.on(gateway.readySupplemental, readTier);

// What Discord lets a non-Nitro user send: the server's own static emojis.
// With Nitro, anything (external emoji permission is not checked).
const usable = (emoji: Emoji, guild: string | undefined) =>
  emoji.available && (premiumType > 0 || (!emoji.animated && emoji.guild === guild));

const link = (emoji: Emoji) => {
  const size = settings.emojiSize;
  const name = encodeURIComponent(emoji.name);
  const url = `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "webp"}?size=${size}&name=${name}&lossless=true`;
  if (!settings.useHyperLinks) return url;
  return `[${settings.hyperLinkText.replaceAll("{{NAME}}", emoji.name)}](${url})`;
};

// Links need whitespace around them to embed.
const spaced = (text: string, offset: number, length: number, replacement: string) => {
  const before = offset > 0 && !/\s/.test(text[offset - 1]) ? " " : "";
  const after = offset + length < text.length && !/\s/.test(text[offset + length]) ? " " : "";
  return before + replacement + after;
};

// Rewrites `<a:name:id>` tokens and `:name:` shortcodes the sender can't use.
// ponytail: a `:name:` shared by several servers picks the first one we saw
// when none of them is usable here.
const rewrite = (text: string, guild: string | undefined) =>
  text.replace(/(?<!\\)<a?:(\w+):(\d+)>|(?<![\\<]):(\w+):(?!\d)/g, (match, _n, id, name, offset, whole) => {
    let emoji: Emoji | undefined;
    if (id) {
      emoji = emojis.get(id);
    } else if (picked.has(name)) {
      emoji = picked.get(name);
    } else {
      const found = byName.get(name);
      if (!found || found.some((e) => usable(e, guild))) return match;
      emoji = found.find((e) => e.available);
    }
    if (!emoji || usable(emoji, guild)) return match;
    return spaced(whole, offset, match.length, link(emoji));
  });

const guildOf = (ctx: Phoenix.UiContext) => (ctx.channelId ? channelGuild.get(ctx.channelId) : undefined);

// Phoenix answers a press on a locked emoji with a Nitro ad. Put `:name:` in
// the message box instead, like an unlocked pick, and remember which emoji it
// was, since several servers can have one by that name.
phoenix.messages.onEmojiPick((id, ctx) => {
  const emoji = emojis.get(id);
  if (!emoji || usable(emoji, guildOf(ctx))) return;
  picked.set(emoji.name, emoji);
  return `:${emoji.name}: `;
});

phoenix.messages.onSend((text, ctx) => {
  if (!text.includes(":")) return;
  const result = rewrite(text, guildOf(ctx));
  return result === text ? undefined : result;
});

// --- Incoming rendering: turn fake Nitro emojis, stickers, and GIFs into real ones ---

const CODE_SPLIT = /(```[\s\S]*?```|`[^`\n]+`)/g;
const EMOJI_LINK_RE =
  /\[([^\]\n]*)\]\((https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/emojis\/(\d{15,22})\.(png|jpe?g|webp|gif)(?:[?#][^\s)<>]*)?)\)|(?<![<(\[])(https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/emojis\/(\d{15,22})\.(png|jpe?g|webp|gif)(?:[?#][^\s)<>]*)?)/gi;
const STICKER_LINK_RE =
  /\[([^\]\n]*)\]\((https?:\/\/(?:media\.discordapp\.net|cdn\.discordapp\.com)\/stickers\/(\d{15,22})\.(png|webp|gif|apng|json)(?:[?#][^\s)<>]*)?)\)|(?<![<(\[])(https?:\/\/(?:media\.discordapp\.net|cdn\.discordapp\.com)\/stickers\/(\d{15,22})\.(png|webp|gif|apng|json)(?:[?#][^\s)<>]*)?)/gi;
const GIF_HYPERLINK_RE = /\[([^\]\n]*)\]\((https?:\/\/[^\s)<>]+)\)/g;
const GIF_URL_RE =
  /^https?:\/\/(?:(?:www\.)?(?:tenor\.com\/view\/|giphy\.com\/gifs\/|klipy\.com\/gifs\/)|(?:media\d*|c|i)\.tenor\.com\/|(?:media\d*|i)\.giphy\.com\/|static\.klipy\.com\/|[^\s?#]+\.gif(?:[?#]|$))/i;
const EMOJI_EMBED_RE =
  /https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/emojis\/(\d{15,22})\./i;
const STICKER_EMBED_RE =
  /https?:\/\/(?:media\.discordapp\.net|cdn\.discordapp\.com)\/stickers\/(\d{15,22})\./i;
const INVISIBLE_LABEL_RE = /^[\s\u200B-\u200F\u2060\u2800\uFEFF._-]*$/;

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s.replaceAll("+", " "));
  } catch {
    return s;
  }
};

// QuickJS has no URLSearchParams.
const parseQuery = (url: string) => {
  const out = new Map<string, string>();
  const q = url.indexOf("?");
  if (q === -1) return out;
  const hash = url.indexOf("#", q);
  const raw = url.slice(q + 1, hash === -1 ? url.length : hash);
  for (const part of raw.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) {
      out.set(safeDecode(part).toLowerCase(), "");
    } else {
      out.set(safeDecode(part.slice(0, eq)).toLowerCase(), safeDecode(part.slice(eq + 1)));
    }
  }
  return out;
};

const sanitizeEmojiName = (raw: string | undefined) => {
  if (!raw) return "";
  const cleaned = raw.replace(/^:+|:+$/g, "").replace(/[^a-zA-Z0-9_]/g, "");
  return cleaned.length >= 2 ? cleaned.slice(0, 32) : "";
};

const cleanStickerName = (raw: string | undefined) => {
  if (!raw) return "";
  return raw.replace(/[\u200B-\u200F\u2060\u2800\uFEFF]/g, "").trim().slice(0, 32);
};

const stickerFormat = (id: string, ext: string, params: Map<string, string>) => {
  const cached = stickers.get(id);
  if (cached) return cached.format_type;
  const lower = ext.toLowerCase();
  if (lower === "gif") return 4;
  if (lower === "json") return 3;
  if (lower === "apng" || params.get("animated")?.toLowerCase() === "true") return 2;
  return 1;
};

const rememberTransformed = (id: string, record: TransformedRecord) => {
  transformed.set(id, record);
  if (transformed.size > TRANSFORMED_LIMIT) {
    const oldest = transformed.keys().next().value;
    if (oldest !== undefined) transformed.delete(oldest);
  }
};

const embedMatchesIds = (embed: Phoenix.Embed, re: RegExp, ids: Set<string>) => {
  if (!ids.size) return false;
  const candidates = [embed.url, embed.image?.url, embed.thumbnail?.url];
  for (const u of candidates) {
    if (!u) continue;
    const m = re.exec(u);
    if (m && ids.has(m[1])) return true;
  }
  return false;
};

const stripFakeEmbeds = (embeds: Phoenix.Embed[] | undefined, record: TransformedRecord) => {
  if (!embeds?.length || (!record.emojiIds.size && !record.stickerIds.size)) return false;
  const kept = embeds.filter(
    (embed) =>
      !embedMatchesIds(embed, EMOJI_EMBED_RE, record.emojiIds) &&
      !embedMatchesIds(embed, STICKER_EMBED_RE, record.stickerIds),
  );
  if (kept.length === embeds.length) return false;
  embeds.splice(0, embeds.length, ...kept);
  return true;
};

type TransformableMessage = {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  author?: { id?: string };
  content?: string;
  embeds?: Phoenix.Embed[];
  sticker_items?: Phoenix.StickerItem[];
  referenced_message?: TransformableMessage | null;
  message_snapshots?: { message?: TransformableMessage }[];
};

// Phoenix's edit-restore guard records `shown -> original` whenever a gateway
// `before` hook changes `content`. Rewriting a non-empty message to `""` there
// would map `"" -> original`, causing every composer clear to refill the input.
// Defer empty-content rewrites to `after` via `phoenix.enqueue` to bypass it.
const deferredEmpty = new Map<string, Partial<Phoenix.GatewayMessage>>();

const transformSingle = (message: TransformableMessage, allowEmptyContent: boolean): boolean => {
  if (!settings.renderFakeEmojis && !settings.renderFakeStickers && !settings.renderFakeGifs) {
    return false;
  }
  if (!settings.renderOwnMessages && currentUserId && message.author?.id === currentUserId) {
    return false;
  }

  // Embed-only MESSAGE_UPDATE frames carry no `content`; strip fake embeds we already converted.
  if (typeof message.content !== "string") {
    if (!message.id || !message.embeds?.length) return false;
    const prev = transformed.get(message.id);
    if (!prev) return false;
    return stripFakeEmbeds(message.embeds, prev);
  }

  if (!message.content.includes("http")) return false;

  const emojiIds = new Set<string>();
  const stickerIds = new Set<string>();
  const foundStickers: Phoenix.StickerItem[] = [];
  let contentChanged = false;

  const parts = message.content.split(CODE_SPLIT);
  for (let i = 0; i < parts.length; i += 2) {
    let seg = parts[i];
    if (!seg.includes("http")) continue;

    if (settings.renderFakeEmojis && seg.includes("/emojis/")) {
      const next = seg.replace(
        EMOJI_LINK_RE,
        (_m, label: string | undefined, mdUrl: string | undefined, mdId: string | undefined, mdExt: string | undefined, bareUrl: string | undefined, bareId: string | undefined, bareExt: string | undefined) => {
          const url = mdUrl ?? bareUrl!;
          const id = mdId ?? bareId!;
          const ext = (mdExt ?? bareExt!).toLowerCase();
          const params = parseQuery(url);
          const cached = emojis.get(id);
          const animatedParam = params.get("animated")?.toLowerCase();
          const animated =
            ext === "gif" ||
            animatedParam === "true" ||
            animatedParam === "1" ||
            (animatedParam !== "false" && cached?.animated === true);
          const name =
            sanitizeEmojiName(params.get("name")) ||
            cached?.name ||
            sanitizeEmojiName(label) ||
            "emoji";
          emojiIds.add(id);
          return `<${animated ? "a" : ""}:${name}:${id}>`;
        },
      );
      if (next !== seg) {
        seg = next;
        contentChanged = true;
      }
    }

    if (settings.renderFakeStickers && seg.includes("/stickers/")) {
      const next = seg.replace(
        STICKER_LINK_RE,
        (_m, label: string | undefined, mdUrl: string | undefined, mdId: string | undefined, mdExt: string | undefined, bareUrl: string | undefined, bareId: string | undefined, bareExt: string | undefined) => {
          const url = mdUrl ?? bareUrl!;
          const id = mdId ?? bareId!;
          const ext = mdExt ?? bareExt!;
          const params = parseQuery(url);
          const name =
            stickers.get(id)?.name ||
            cleanStickerName(params.get("name")) ||
            cleanStickerName(label) ||
            "Sticker";
          const format_type = stickerFormat(id, ext, params);
          stickerIds.add(id);
          if (!foundStickers.some((s) => s.id === id)) {
            foundStickers.push({ id, name, format_type });
          }
          return "";
        },
      );
      if (next !== seg) {
        seg = next;
        contentChanged = true;
      }
    }

    parts[i] = seg;
  }

  let nextContent = parts.join("");

  if (stickerIds.size) {
    nextContent = nextContent.replace(/[ \t]{2,}/g, " ").trim();
  }

  if (settings.renderFakeGifs && nextContent.includes("](")) {
    const trimmed = nextContent.trim();
    const standalone = /^\[([^\]\n]*)\]\((https?:\/\/[^\s)<>]+)\)$/.exec(trimmed);
    if (standalone && GIF_URL_RE.test(standalone[2])) {
      // Unwrap standalone hyperlinked GIF to its bare URL so Discord hides the URL and renders a native GIF.
      nextContent = standalone[2];
      contentChanged = true;
    } else {
      const gifParts = nextContent.split(CODE_SPLIT);
      let gifChanged = false;
      for (let i = 0; i < gifParts.length; i += 2) {
        const seg = gifParts[i];
        if (!seg.includes("](")) continue;
        const replaced = seg.replace(GIF_HYPERLINK_RE, (match, label: string, url: string) => {
          if (!GIF_URL_RE.test(url)) return match;
          // Drop invisible-label GIF hyperlinks next to text so only the text and GIF embed show.
          if (INVISIBLE_LABEL_RE.test(label)) return "";
          return match;
        });
        if (replaced !== seg) {
          gifParts[i] = replaced;
          gifChanged = true;
        }
      }
      if (gifChanged) {
        nextContent = gifParts.join("").replace(/[ \t]{2,}/g, " ").trim();
        contentChanged = true;
      }
    }
  }

  let changed = false;
  const deferEmpty = !allowEmptyContent && contentChanged && nextContent === "" && message.content !== "";

  if (contentChanged && nextContent !== message.content && !deferEmpty) {
    message.content = nextContent;
    changed = true;
  }

  if (foundStickers.length) {
    const existing = message.sticker_items ?? [];
    const added = foundStickers.filter((s) => !existing.some((e) => e.id === s.id));
    if (added.length) {
      message.sticker_items = [...existing, ...added];
      changed = true;
    }
  }

  if (emojiIds.size || stickerIds.size) {
    const record: TransformedRecord = { emojiIds, stickerIds };
    if (message.id) rememberTransformed(message.id, record);
    if (stripFakeEmbeds(message.embeds, record)) changed = true;
  }

  if (deferEmpty && message.id && message.channel_id) {
    deferredEmpty.set(message.id, {
      id: message.id,
      channel_id: message.channel_id,
      ...(message.guild_id ? { guild_id: message.guild_id } : {}),
      content: "",
      ...(message.embeds ? { embeds: message.embeds } : {}),
      ...(message.sticker_items ? { sticker_items: message.sticker_items } : {}),
    });
  }

  return changed;
};

const transformMessage = (
  message: TransformableMessage | null | undefined,
  allowEmptyContent = true,
): boolean => {
  if (!message || typeof message !== "object") return false;
  let changed = transformSingle(message, allowEmptyContent);
  if (message.referenced_message && transformMessage(message.referenced_message, true)) {
    changed = true;
  }
  if (Array.isArray(message.message_snapshots)) {
    for (const snap of message.message_snapshots) {
      if (snap?.message && transformMessage(snap.message, true)) changed = true;
    }
  }
  return changed;
};

const flushDeferred = (message: Phoenix.GatewayMessage) => {
  const pending = deferredEmpty.get(message.id);
  if (!pending) return;
  deferredEmpty.delete(message.id);
  phoenix.enqueue(gateway.messageUpdate, pending);
};

phoenix.hook(gateway.messageCreate, {
  before(message) {
    transformMessage(message, false);
  },
  after: flushDeferred,
});

phoenix.hook(gateway.messageUpdate, {
  before(message) {
    transformMessage(message, false);
  },
  after: flushDeferred,
});

const transformMessageListResponse = (res: Phoenix.InterceptedResponse) => {
  if (res.status < 200 || res.status >= 300) return;
  const data = res.json<unknown>();
  if (!data) return;
  let changed = false;
  if (Array.isArray(data)) {
    for (const item of data) {
      if (transformMessage(item as TransformableMessage)) changed = true;
    }
  } else if (typeof data === "object" && "items" in data && Array.isArray((data as { items: unknown[] }).items)) {
    for (const entry of (data as { items: { message?: TransformableMessage }[] }).items) {
      if (transformMessage(entry?.message)) changed = true;
    }
  }
  return changed ? { body: data as object } : undefined;
};

phoenix.discord.onResponse(
  { method: "GET", pathPrefix: "/channels/", pathSuffix: "/messages" },
  transformMessageListResponse,
);

phoenix.discord.onResponse(
  { method: "GET", pathPrefix: "/channels/", pathSuffix: "/pins" },
  transformMessageListResponse,
);

const transformSearchResponse = (res: Phoenix.InterceptedResponse) => {
  if (res.status < 200 || res.status >= 300) return;
  const data = res.json<{ messages?: TransformableMessage[][] }>();
  if (!data || !Array.isArray(data.messages)) return;
  let changed = false;
  for (const group of data.messages) {
    if (!Array.isArray(group)) continue;
    for (const msg of group) {
      if (transformMessage(msg)) changed = true;
    }
  }
  return changed ? { body: data } : undefined;
};

phoenix.discord.onResponse(
  { method: "GET", pathPrefix: "/guilds/", pathSuffix: "/messages/search" },
  transformSearchResponse,
);

phoenix.discord.onResponse(
  { method: "GET", pathPrefix: "/channels/", pathSuffix: "/messages/search" },
  transformSearchResponse,
);
