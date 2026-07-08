// ═══════════════════════════════════════════════════════════════
//  CLONE BOT — recreate a server layout, two ways:
//
//   1. DIRECT (free, exact):  !clone <serverId>
//      The bot must be a member of that server. It reads the real
//      channel list through Discord and copies it perfectly.
//
//   2. SCREENSHOT (free, uses Google Gemini's free vision tier):
//      !clone  →  upload screenshot(s) of a server's sidebar  →
//      the bot reads them with AI and rebuilds the structure.
//
//  .env keys:
//    BOT_TOKEN=your-discord-bot-token-here                (required)
//    GEMINI_API_KEY=your-gemini-key-here    (only needed for
//                                                 screenshot mode)
//    Get a free Gemini key at https://aistudio.google.com/apikey
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const {
  Client, GatewayIntentBits,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ComponentType, ChannelType,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const PREFIX = '!';
const cloning = new Set(); // guilds with a clone in progress

const sleep = ms => new Promise(r => setTimeout(r, ms));

const TYPE_MAP = {
  text:         ChannelType.GuildText,
  voice:        ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  stage:        ChannelType.GuildStageVoice,
  forum:        ChannelType.GuildForum,
};

// map a live discord channel type back to our simple string
function typeName(t) {
  switch (t) {
    case ChannelType.GuildVoice:        return 'voice';
    case ChannelType.GuildAnnouncement: return 'announcement';
    case ChannelType.GuildStageVoice:   return 'stage';
    case ChannelType.GuildForum:        return 'forum';
    default:                            return 'text';
  }
}

// Discord force-lowercases these channel types on creation, so plain ASCII
// capitals can't survive. Voice/stage channels and categories keep their case.
const LOWERCASED_TYPES = new Set(['text', 'announcement', 'forum']);

// For the lowercased types only, convert ASCII capital letters (A–Z) into
// fullwidth uppercase letters (Ａ–Ｚ). Those are different codepoints, so
// Discord leaves them alone and they display as caps. Lowercase letters and
// everything else are left untouched.
function keepCaps(name, type) {
  if (!name || !LOWERCASED_TYPES.has(type)) return name;
  return name.replace(/[A-Z]/g, c => String.fromCharCode(0xFF21 + c.charCodeAt(0) - 65));
}

// ─────────────────────────────────────────────
//  MODE 1 — DIRECT: read a real server's layout
// ─────────────────────────────────────────────
function readStructureFromGuild(sourceGuild) {
  const structure = { uncategorized: [], categories: [] };
  const all = [...sourceGuild.channels.cache.values()];

  // uncategorized non-category channels, in position order
  const uncategorized = all
    .filter(c => c.type !== ChannelType.GuildCategory && !c.parentId)
    .sort((a, b) => a.rawPosition - b.rawPosition);
  for (const c of uncategorized) structure.uncategorized.push({ name: c.name, type: typeName(c.type) });

  // categories, each with their children in order
  const categories = all
    .filter(c => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.rawPosition - b.rawPosition);
  for (const cat of categories) {
    const children = all
      .filter(c => c.parentId === cat.id)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map(c => ({ name: c.name, type: typeName(c.type) }));
    structure.categories.push({ name: cat.name, channels: children });
  }
  return structure;
}

// ─────────────────────────────────────────────
//  MODE 2 — SCREENSHOT: read images via Gemini
// ─────────────────────────────────────────────
async function readStructureFromImages(attachments) {
  const parts = [];
  for (const att of attachments) {
    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`Couldn't download image (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 6 * 1024 * 1024) throw new Error('An image is too large (max ~6MB each).');
    parts.push({
      inline_data: {
        mime_type: att.contentType?.split(';')[0] || 'image/png',
        data: buf.toString('base64'),
      },
    });
  }

  const prompt = `These are screenshot(s) of a Discord server's channel sidebar.
Extract the FULL channel structure you can see.

TRANSCRIBE NAMES EXACTLY, CHARACTER-FOR-CHARACTER — this is critical:
- Output the EXACT unicode codepoints you see. Do NOT convert special/fancy characters into their plain ASCII equivalents.
- In particular, if you see a fullwidth vertical bar "｜" (U+FF5C), output "｜" — do NOT replace it with the ASCII "|". Likewise keep fullwidth letters, styled/stylized letters, CJK characters (e.g. 位 炎 影 級 痛 送 零 機), brackets and emojis exactly as shown.
- Preserve spacing exactly. If letters are shown spaced out like "a n n o u n c e", keep those spaces.
- Preserve capitalization exactly. Never title-case or lowercase a name.
- Do NOT "clean up", simplify, or normalize names in any way. Copy the glyphs verbatim, as if transcribing symbols you don't understand.

IDENTIFY CHANNEL TYPE BY ITS ICON (left of the name):
- "text": a # (hashtag) icon.
- "voice": a speaker icon.
- "announcement": a # with a megaphone/loudspeaker.
- "stage": a person/microphone-in-circle icon.
- "forum": looks like a chat bubble / speech-bubble with lines, OR a numbered-list / posts icon. Discord forum channels do NOT use a # — if the icon is a bubble or list rather than a #, it is "forum", not "text". Only use "text" when you clearly see a # icon.
Look carefully at the icon before choosing the type. Do not default a forum to text.

Respond with ONLY raw JSON, no markdown fences, no explanation, in exactly this shape:
{
  "uncategorized": [{"name": "channel-name", "type": "text"}],
  "categories": [
    {"name": "CATEGORY NAME", "channels": [{"name": "channel-name", "type": "text"}]}
  ]
}

Valid "type" values: "text", "voice", "announcement", "stage", "forum".

ORDER MATTERS: list every category, and every channel inside each category, in the EXACT top-to-bottom order they appear in the screenshot. Do not sort, reorder, or group by type — keep the visual order exactly as shown. If multiple screenshots overlap, merge them in order without duplicates.`;

  parts.push({ text: prompt });

  const model = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Vision API error ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '';
  const clean = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);

  parsed.uncategorized = Array.isArray(parsed.uncategorized) ? parsed.uncategorized : [];
  parsed.categories    = Array.isArray(parsed.categories)    ? parsed.categories    : [];
  for (const cat of parsed.categories) cat.channels = Array.isArray(cat.channels) ? cat.channels : [];
  return parsed;
}

// ─────────────────────────────────────────────
//  BUILD the structure in the target guild
// ─────────────────────────────────────────────
async function buildStructure(guild, structure, progressCb) {
  let created = 0, failed = 0;
  const total = structure.uncategorized.length + structure.categories.length +
    structure.categories.reduce((n, c) => n + c.channels.length, 0);

  // A single running counter used as the explicit `position` for every
  // channel/category we create, so Discord keeps them in screenshot order
  // instead of re-sorting by creation time.
  let pos = 0;

  const makeChannel = async (opts) => {
    try { await guild.channels.create({ ...opts, position: pos++ }); created++; }
    catch (e) { console.error(`[clone] Failed "${opts.name}":`, e.message); failed++; }
    if ((created + failed) % 5 === 0) await progressCb(created + failed, total);
    await sleep(400);
  };

  for (const ch of structure.uncategorized) {
    const name = keepCaps(ch.name?.slice(0, 100) || 'channel', ch.type);
    await makeChannel({ name, type: TYPE_MAP[ch.type] ?? ChannelType.GuildText });
  }

  for (const cat of structure.categories) {
    let parent = null;
    try {
      parent = await guild.channels.create({ name: cat.name?.slice(0, 100) || 'category', type: ChannelType.GuildCategory, position: pos++ });
      created++;
      await sleep(400);
    } catch (e) { console.error(`[clone] Failed category "${cat.name}":`, e.message); failed++; }
    for (const ch of cat.channels) {
      const opts = { name: keepCaps(ch.name?.slice(0, 100) || 'channel', ch.type), type: TYPE_MAP[ch.type] ?? ChannelType.GuildText };
      if (parent) opts.parent = parent.id;
      await makeChannel(opts);
    }
  }
  return { created, failed };
}

function structurePreview(structure) {
  const icon = t => t === 'voice' ? '🔊' : t === 'announcement' ? '📢' : t === 'stage' ? '🎙️' : t === 'forum' ? '💬' : '#';
  const lines = [];
  for (const ch of structure.uncategorized) lines.push(`${icon(ch.type)} ${ch.name}`);
  for (const cat of structure.categories) {
    lines.push(`\n**📁 ${cat.name}**`);
    for (const ch of cat.channels) lines.push(`> ${icon(ch.type)} ${ch.name}`);
  }
  let out = lines.join('\n');
  if (out.length > 3800) out = out.slice(0, 3800) + '\n…*(preview truncated — everything will still be created)*';
  return out || '*Nothing detected*';
}

// ─────────────────────────────────────────────
//  Shared confirm + build flow
// ─────────────────────────────────────────────
async function confirmAndBuild(message, statusMsg, structure) {
  const totalCh = structure.uncategorized.length + structure.categories.reduce((n, c) => n + c.channels.length, 0);
  if (totalCh === 0)
    return statusMsg.edit('❌ No channels detected. Try again with clearer screenshots or a valid server ID.');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('clone_add').setLabel('➕ Add to my server').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('clone_replace').setLabel('⚠️ REPLACE everything').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('clone_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  await statusMsg.edit({
    content: '',
    embeds: [new EmbedBuilder().setColor(0x5865f2)
      .setTitle(`🖼️ Detected: ${structure.categories.length} categories, ${totalCh} channels`)
      .setDescription(structurePreview(structure))
      .setFooter({ text: '➕ Add = keeps current channels • ⚠️ REPLACE = deletes ALL current channels first (cannot be undone!)' })],
    components: [row],
  });

  let interaction;
  try {
    interaction = await statusMsg.awaitMessageComponent({
      filter: i => i.user.id === message.author.id,
      componentType: ComponentType.Button, time: 120000,
    });
  } catch {
    await statusMsg.edit({ components: [] }).catch(() => {});
    return message.channel.send('❌ Timed out — clone cancelled.');
  }

  if (interaction.customId === 'clone_cancel')
    return interaction.update({ content: '❌ Clone cancelled.', embeds: [], components: [] });

  const replace = interaction.customId === 'clone_replace';
  await interaction.update({ components: [] });

  cloning.add(message.guild.id);
  try {
    if (replace) {
      await message.channel.send('🗑️ **Replacing:** deleting all current channels (except this one)…');
      const toDelete = [...message.guild.channels.cache.values()].filter(c => c.id !== message.channel.id);
      for (const ch of toDelete) { await ch.delete('Server clone — replace').catch(() => {}); await sleep(300); }
    }
    const progress = await message.channel.send('🏗️ Building… 0 done');
    const { created, failed } = await buildStructure(message.guild, structure, (d, t) => progress.edit(`🏗️ Building… **${d}/${t}**`).catch(() => {}));
    await progress.edit(`✅ **Clone complete!** Created **${created}** channels/categories${failed ? `, **${failed}** failed (check my permissions)` : ''}.${replace ? '\nThis channel was kept so you could see this — delete it if you don\'t need it.' : ''}`);
  } catch (e) {
    console.error('[clone] build error:', e);
    message.channel.send(`❌ Something went wrong while building: ${e.message.slice(0, 200)}`);
  } finally {
    cloning.delete(message.guild.id);
  }
}

// ─────────────────────────────────────────────
//  READY + COMMAND
// ─────────────────────────────────────────────
client.once('ready', () => console.log(`✅ ${client.user.tag} online — Clone Bot ready`));

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd  = args.shift().toLowerCase();
  if (cmd !== 'clone') return;

  if (message.author.id !== message.guild.ownerId)
    return message.reply('❌ Only the **server owner** can use `!clone`.');
  if (cloning.has(message.guild.id))
    return message.reply('❌ A clone is already in progress in this server.');

  const arg = args[0];

  // ── MODE 1: direct clone by server ID (free, exact) ────────────
  if (arg && /^\d{15,21}$/.test(arg)) {
    const source = client.guilds.cache.get(arg);
    if (!source)
      return message.reply('❌ I\'m not in a server with that ID. Invite me to the source server first, then run this again.\n*(Or run `!clone` with no ID to clone from screenshots instead.)*');
    if (source.id === message.guild.id)
      return message.reply('❌ That\'s this same server.');

    const statusMsg = await message.channel.send(`🔍 Reading **${source.name}**\'s channels directly…`);
    const structure = readStructureFromGuild(source);
    return confirmAndBuild(message, statusMsg, structure);
  }

  // ── MODE 2: screenshot clone (free via Gemini) ─────────────────
  if (!process.env.GEMINI_API_KEY)
    return message.reply('❌ Screenshot mode needs a free `GEMINI_API_KEY` in the .env file (get one at https://aistudio.google.com/apikey).\n\n💡 **Or** invite me to the server you want to copy and run `!clone <serverId>` — that\'s free and needs no key.');

  await message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2)
    .setTitle('🖼️ Server Clone — Step 1')
    .setDescription('**Upload screenshot(s) of the server\'s channel sidebar** in your next message (up to 4 images).\n\nTip: scroll the sidebar and take multiple screenshots so every category is visible.\n\n💡 If the bot can join the source server, `!clone <serverId>` is more accurate and needs no screenshots.\n\n*You have 2 minutes. Type `cancel` to stop.*')] });

  const collected = await message.channel.awaitMessages({
    filter: m => m.author.id === message.author.id && (m.attachments.size > 0 || m.content.toLowerCase() === 'cancel'),
    max: 1, time: 120000,
  });
  const imgMsg = collected.first();
  if (!imgMsg || imgMsg.content.toLowerCase() === 'cancel')
    return message.channel.send('❌ Clone cancelled.');

  const attachments = [...imgMsg.attachments.values()].filter(a => a.contentType?.startsWith('image/')).slice(0, 4);
  if (!attachments.length)
    return message.channel.send('❌ No images found in that message. Run `!clone` again.');

  const statusMsg = await message.channel.send('🔍 Reading the screenshots… this takes ~10 seconds.');
  let structure;
  try {
    structure = await readStructureFromImages(attachments);
  } catch (e) {
    console.error('[clone] vision error:', e);
    return statusMsg.edit(`❌ Couldn't read the images: ${e.message.slice(0, 200)}`);
  }
  return confirmAndBuild(message, statusMsg, structure);
});

client.login(process.env.BOT_TOKEN);
