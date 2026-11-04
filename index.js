require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, ActivityType, Events, REST, Routes, AttachmentBuilder,
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType,
} = require('discord.js');
const { E, applyEmojis } = require('./emojis');
const { createTranscript, startTranscriptServer } = require('./transcripts');

const PANELS = ['dashboard', 'affiliates', 'assistance', 'services', 'market', 'staffinfo'];
const SEP = { type: 14, spacing: 1, divider: true };
const BOTTOM_IMAGE = 'https://discord-webhook.com/uploads/3002d9037ea3566a731d9aff1b8dd7ce.png';
const SERVICES_CHANNEL_URL = 'https://discord.com/channels/1566143853541720086/1566213587662409749';

// colour of the line on the left of the reply panels (grey). For red use 0xed4245
const ACCENT = 0x4e5058;

// designer / developer payouts
const PAYOUT_PER_ORDER = Number(process.env.ORDER_PAYOUT) || 100;
const MAX_ORDERS_PER_PERIOD = Number(process.env.MAX_ORDERS_PER_PERIOD) || 10;
const PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // needed to read messages for transcripts
  ],
});

// ---------- Replies for dropdowns + buttons ----------
// key = button custom_id, or "dropdown_custom_id:value" for dropdown options
const responses = {
  'affiliates_menu:looking':
    '# {heart} Affiliates\nWe are currently looking for affiliates! The affiliate application is being set up and will be available very soon.',
};

// ---------- Shared helpers ----------
function emojiObj(key) {
  const m = E[key]?.match(/<a?:(\w+):(\d+)>/);
  return m ? { name: m[1], id: m[2] } : undefined;
}

// reads a field from a submitted pop-up form
function modalValue(i, id) {
  const field = i.fields.fields.get(id);
  return field?.values?.[0] ?? field?.value;
}

// puts a dropdown back to "nothing selected" so the same option can be picked again
async function resetSelect(i) {
  try {
    await i.message.edit({
      flags: MessageFlags.IsComponentsV2,
      components: i.message.components.map((c) => c.toJSON()),
    });
  } catch (err) {
    // not a big deal if this fails
  }
}

const quote = (text) => String(text).replace(/\n/g, '\n> ');
const isOwner = (id) => Boolean(process.env.OWNER_ID) && id === process.env.OWNER_ID;
const fmt = (n) => Number(n).toLocaleString('en-GB');

// data is remembered in the data folder so it survives restarts
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const COMPLETED_FILE = path.join(DATA_DIR, 'completed.json');
const PAYOUT_FILE = path.join(DATA_DIR, 'payout.json');
const GIVEAWAYS_FILE = path.join(DATA_DIR, 'giveaways.json');

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

const loadTickets = () => readJson(TICKETS_FILE);
const saveTickets = (t) => writeJson(TICKETS_FILE, t);
const loadOrders = () => readJson(ORDERS_FILE);
const saveOrders = (o) => writeJson(ORDERS_FILE, o);
const loadGiveaways = () => readJson(GIVEAWAYS_FILE);
const saveGiveaways = (g) => writeJson(GIVEAWAYS_FILE, g);
const loadCompleted = () => {
  const list = readJson(COMPLETED_FILE, []);
  return Array.isArray(list) ? list : [];
};

const VIEW_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

// ---------- Payout periods (14 days, reset by the owner) ----------
function getPeriodStart() {
  const data = readJson(PAYOUT_FILE);
  if (!data.periodStart) {
    data.periodStart = Date.now();
    writeJson(PAYOUT_FILE, data);
  }
  return data.periodStart;
}

// completed orders per designer / developer in the current period
function periodCounts() {
  const start = getPeriodStart();
  const counts = {};
  for (const r of loadCompleted()) {
    if (r.claimerId && r.closedAt >= start) counts[r.claimerId] = (counts[r.claimerId] || 0) + 1;
  }
  return { start, counts };
}

const earned = (n) => Math.min(n, MAX_ORDERS_PER_PERIOD) * PAYOUT_PER_ORDER;
const progressBar = (n) =>
  '▰'.repeat(Math.min(n, MAX_ORDERS_PER_PERIOD)) + '▱'.repeat(Math.max(MAX_ORDERS_PER_PERIOD - n, 0));

// ---------- Transcripts ----------
// builds the transcript page and posts it (as a link) in the transcript channel
async function logTranscript(guild, channel, { title, details }) {
  try {
    const pageRows = await Promise.all(
      details.map(async (d) => {
        if (!d.userId) return [d.label, d.text ?? '-'];
        const user = await client.users.fetch(d.userId).catch(() => null);
        return [d.label, user?.username ?? d.userId];
      })
    );
    const transcript = await createTranscript(channel, { title, rows: pageRows });

    const logChannel = process.env.TRANSCRIPT_CHANNEL_ID
      ? await guild.channels.fetch(process.env.TRANSCRIPT_CHANNEL_ID).catch(() => null)
      : null;

    if (logChannel) {
      const lines = details
        .map((d) => `**${d.label}:** ${d.userId ? `<@${d.userId}>` : d.text ?? '-'}`)
        .join('\n');
      const parts = [
        { type: 10, content: `# ${E.textmessage} Ticket Transcript\n${lines}\n**Messages:** ${transcript.count}` },
        SEP,
      ];
      if (transcript.url) {
        parts.push(
          {
            type: 1,
            components: [
              { type: 2, style: 5, label: 'View Transcript', url: transcript.url, emoji: emojiObj('textmessage') },
            ],
          },
          SEP
        );
      }
      parts.push({ type: 12, items: [{ media: { url: BOTTOM_IMAGE } }] }, SEP);

      await logChannel.send({
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
        components: [{ type: 17, components: parts }],
      });
      // no website set up yet: attach the page as a file instead
      if (!transcript.url) {
        await logChannel.send({
          files: [new AttachmentBuilder(Buffer.from(transcript.html, 'utf8'), { name: 'transcript.html' })],
        });
      }
    }
    return transcript;
  } catch (err) {
    console.error('Transcript failed:', err);
    return null;
  }
}

// ---------- Dashboard + marketplace replies ----------
const MARKET_TOP = 'https://discord-webhook.com/uploads/08292c87303495bee5d58e7db34ed552.png';

// Optional: add these to .env to make the channel names clickable
// SPOTLIGHT_CHANNEL_ID=...   DASHBOARD_CHANNEL_ID=...
const channelText = (id, name) => (id ? `<#${id}>` : `**#${name}**`);

// [button label, emoji name from emojis.js, Roblox game pass ID]
const marketLinks = {
  misc: [
    ['Paid Channel', 'unlock', '2060882972'],
    ['Instant Post', 'timer', '2062100650'],
    ['Priority Post', 'fire', '2061758505'],
  ],
  roles: [
    ['Custom Role', 'key', '2060769217'],
    ['VIP', 'confetti', '2057775900'],
    ['Echo+', 'unlimited', '2061734598'],
  ],
  pings: [
    ['Giveaway Ad', 'giveaway', '2063024059'],
    ['Everyone Ping', 'world', '133448903949274'],
    ['Here Ping', 'maparrow', '2062376169'],
  ],
};

function marketReply(text, links = []) {
  const parts = [
    { type: 12, items: [{ media: { url: MARKET_TOP } }] },
    SEP,
    { type: 10, content: applyEmojis(text) },
    SEP,
  ];
  if (links.length) {
    parts.push({
      type: 1,
      components: links.map(([label, emoji, id]) => ({
        type: 2,
        style: 5, // link button (always grey)
        label,
        url: `https://www.roblox.com/game-pass/${id}`,
        emoji: emojiObj(emoji),
      })),
    });
    parts.push(SEP);
  }
  parts.push({ type: 12, items: [{ media: { url: BOTTOM_IMAGE } }] });

  return {
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    components: [{ type: 17, components: parts }],
  };
}

// simple info panel, optional grey link buttons
function infoReply(text, links = []) {
  const parts = [{ type: 10, content: applyEmojis(text) }];
  if (links.length) {
    parts.push(SEP, {
      type: 1,
      components: links.map(([label, url]) => ({ type: 2, style: 5, label, url })),
    });
  }
  return {
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    components: [{ type: 17, accent_color: ACCENT, components: parts }],
  };
}

const marketReplies = {
  'market_menu:roles': () =>
    marketReply(
      '# {key} Roles\nCustom roles and perks to stand out in the community. Click a button below to purchase, then claim it via a **Management Ticket**.',
      marketLinks.roles
    ),
  'market_menu:misc': () =>
    marketReply(
      '# {gift} Miscellaneous\nPaid channels, priority posts and instant posts. Click a button below to purchase, then claim it via a **Management Ticket**.',
      marketLinks.misc
    ),
  'market_menu:pings': () =>
    marketReply(
      '# {giveaway} Giveaway / Paid Ad Pings\nSponsored giveaway ads and paid advertisement pings. Click a button below to purchase, then claim it via a **Management Ticket**.',
      marketLinks.pings
    ),
  market_info: () =>
    marketReply(
      '# {map} Additional Information\n\n' +
        '## Roles\n' +
        '**Echo+** - Gives you a 15% discount on your future orders.\n' +
        `**Spotlight Access** - Gives you access to type in ${channelText(process.env.SPOTLIGHT_CHANNEL_ID, 'spotlight')}.\n` +
        '**Paid Channels** - Paid channels are up for a month (30 days).\n\n' +
        `> -# If something isn't listed here, or you would like to know something, open a ticket via ${channelText(process.env.DASHBOARD_CHANNEL_ID, 'dashboard')}.`
    ),
};

const pricesText =
  '# {robux} Echo Customs | Price List\n' +
  'Here at **Echo Customs**, we offer a range of affordable services to bring your ideas to life.\n\n' +
  '### Development\n' +
  '> Custom Development – 1,000 {robux}\n' +
  '> Discord Development – 1,000 {robux}\n' +
  '> Discord Bot Orders – 3,000 {robux} per bot\n\n' +
  '### ERLC Services\n' +
  '> Map Making – 500 {robux}\n' +
  '> Liveries – 100 {robux} per livery\n' +
  '> ELS – 100 {robux}\n\n' +
  '### Design Services\n' +
  '> Banners – 50 {robux} per banner\n' +
  '> Clothing – 75 {robux} per item\n' +
  '> Graphics – 50 {robux} per graphic\n\n' +
  '-# Please note: Prices may vary depending on the complexity and requirements of your order.';

// edit these rules however you like
const termsText =
  '# {lock} Terms of Service\n' +
  'By placing an order with **Echo Customs** you agree to the terms below.\n\n' +
  '**1. No Refunds**\nWe do not offer refunds. Once an order has been paid for, all sales are final.\n\n' +
  '**2. Payment Before Delivery**\nEvery order must be paid for in full, using the game pass provided in your ticket, before the final product is delivered.\n\n' +
  '**3. Pricing**\nPrices are listed in our price list and may vary depending on the complexity of your order. The final price is confirmed before any work begins.\n\n' +
  '**4. Clear Requirements**\nGive us as much detail as you can when ordering. We cannot be held responsible for work that does not match details that were never provided.\n\n' +
  '**5. Delivery Times**\nTurnaround depends on the complexity of your order and our current workload. Please be patient and keep to the due date agreed in your ticket.\n\n' +
  '**6. Ownership & Resale**\nYour finished work is for your own use. You may not resell, redistribute or claim our designs as your own without permission.\n\n' +
  '**7. Respect & Conduct**\nBe respectful to every member of our team. Harassment, abuse or spam may lead to your order being cancelled and you being removed.\n\n' +
  '**8. Discord Rules**\nYou must follow the Discord Terms of Service and Community Guidelines at all times.';

const dashboardReplies = {
  dashboard_prices: () => infoReply(pricesText),
  'dashboard_menu:terms': () => infoReply(termsText),
  'dashboard_menu:regulations': () =>
    infoReply(
      "# {checkbox} Regulations\nEveryone in **Echo Customs** must follow Discord's own rules at all times. Please read them using the buttons below.",
      [
        ['Discord Terms of Service', 'https://discord.com/terms'],
        ['Community Guidelines', 'https://discord.com/guidelines'],
      ]
    ),
};

// =====================================================================
// ASSISTANCE TICKETS
// =====================================================================
const TICKET_TOP = 'https://discord-webhook.com/uploads/a44be3ce9cdceda2201576f697946b87.png';

// categoryEnv = the .env variable holding the category ID for that ticket type
// management: true = only the management role can see + handle it (confidential reports)
const TICKET_TYPES = {
  order: {
    name: 'Order Assistance',
    slug: 'order-assistance',
    categoryEnv: 'CUSTOM_SUPPORT_CATEGORY_ID',
    management: false,
  },
  staff: {
    name: 'Report a Staff Member',
    slug: 'report-staff-member',
    categoryEnv: 'STAFF_REPORT_CATEGORY_ID',
    management: true,
  },
  developer: {
    name: 'Report a Developer / Designer',
    slug: 'report-developer-designer',
    categoryEnv: 'DEV_REPORT_CATEGORY_ID',
    management: true,
  },
};

const URGENCY = {
  low: { label: 'Low', dot: '🟢', color: 0x57f287 },
  medium: { label: 'Medium', dot: '🟡', color: 0xffbf00 },
  urgent: { label: 'Urgent', dot: '🔴', color: 0xed4245 },
};

// the roles that can see + handle a ticket type
function handlerRoles(typeKey) {
  const roles = TICKET_TYPES[typeKey].management
    ? [process.env.MANAGEMENT_ROLE_ID]
    : [process.env.STAFF_ROLE_ID, process.env.MANAGEMENT_ROLE_ID];
  return roles.filter(Boolean);
}

// who can claim / close
function canManage(member, typeKey) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return handlerRoles(typeKey).some((id) => member.roles.cache.has(id));
}

// the pop-up form: reason + urgency
function ticketModal(typeKey) {
  return {
    custom_id: `assistance_modal:${typeKey}`,
    title: TICKET_TYPES[typeKey].name.slice(0, 45),
    components: [
      {
        type: 18,
        label: 'Reason for opening',
        component: {
          type: 4,
          custom_id: 'reason',
          style: 2,
          required: true,
          min_length: 5,
          max_length: 1000,
          placeholder: 'Briefly explain what you need help with',
        },
      },
      {
        type: 18,
        label: 'Urgency',
        component: {
          type: 3,
          custom_id: 'urgency',
          required: true,
          placeholder: 'How urgent is this?',
          options: [
            { label: 'Low', value: 'low', emoji: { name: '🟢' } },
            { label: 'Medium', value: 'medium', emoji: { name: '🟡' } },
            { label: 'Urgent', value: 'urgent', emoji: { name: '🔴' } },
          ],
        },
      },
    ],
  };
}

// the panel posted inside every ticket
function ticketPanel(data) {
  const type = TICKET_TYPES[data.type];
  const urgency = URGENCY[data.urgency];
  const claimed = Boolean(data.claimerId);

  const text = applyEmojis(
    `**{chevron} User:** <@${data.userId}>\n` +
      `**{chevron} Account Created:** ${new Date(data.accountCreated).toLocaleDateString('en-GB')}\n` +
      `**{chevron} Reason for Opening:**\n> ${quote(data.reason)}\n` +
      `**{chevron} Priority:** ${urgency.dot} ${urgency.label}\n` +
      `**{chevron} Ticket Category:** ${type.name}\n` +
      `**{chevron} Assigned Staff:** ${claimed ? `<@${data.claimerId}>` : 'Unassigned'}\n` +
      `**{chevron} Ticket Created:** <t:${Math.floor(data.createdAt / 1000)}:F>\n` +
      `**{chevron} Status:** ${claimed ? '🟢 Claimed' : '🔴 Open'}\n\n` +
      `**{textmessage} Issue Description:**\n> Please describe your issue in as much detail as you can below.`
  );

  return [
    {
      type: 17,
      accent_color: urgency.color,
      components: [
        { type: 12, items: [{ media: { url: TICKET_TOP } }] },
        SEP,
        { type: 10, content: text },
        SEP,
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: claimed ? 'Claimed' : 'Claim',
              custom_id: 'ticket_claim',
              disabled: claimed,
              emoji: emojiObj('tick'),
            },
            { type: 2, style: 2, label: 'Close Request', custom_id: 'ticket_close_request', emoji: emojiObj('timer') },
            { type: 2, style: 4, label: 'Close', custom_id: 'ticket_close', emoji: emojiObj('lock') },
          ],
        },
        SEP,
        { type: 12, items: [{ media: { url: BOTTOM_IMAGE } }] },
        SEP,
      ],
    },
  ];
}

// does this person already have an open ticket?
function findOpenTicket(i) {
  const found = Object.entries(loadTickets()).find(
    ([channelId, data]) => data.userId === i.user.id && i.guild.channels.cache.has(channelId)
  );
  return found ? found[0] : null;
}

// step 1: they picked an option in the assistance dropdown -> show the pop-up form
async function handleAssistanceSelect(i) {
  const typeKey = i.values[0];
  if (!TICKET_TYPES[typeKey]) return;

  const existing = findOpenTicket(i);
  if (existing) {
    await i.reply({
      content: `${E.block} You already have an open ticket: <#${existing}>`,
      flags: MessageFlags.Ephemeral,
    });
  } else {
    await i.showModal(ticketModal(typeKey));
  }
  await resetSelect(i);
}

// step 2: they submitted the form -> create the ticket channel
async function handleTicketModal(i) {
  const typeKey = i.customId.split(':')[1];
  const type = TICKET_TYPES[typeKey];
  if (!type) return;

  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const reason = modalValue(i, 'reason') || 'No reason given';
  const urgencyValue = modalValue(i, 'urgency');
  const urgencyKey = URGENCY[urgencyValue] ? urgencyValue : 'low';

  const overwrites = [
    { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: i.user.id, allow: VIEW_PERMS },
    {
      id: client.user.id,
      allow: [...VIEW_PERMS, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages],
    },
    ...handlerRoles(typeKey).map((id) => ({ id, allow: VIEW_PERMS })),
  ];

  try {
    const channel = await i.guild.channels.create({
      name: `🔴-${type.slug}`,
      type: ChannelType.GuildText,
      parent: process.env[type.categoryEnv] || undefined,
      topic: `${type.name} - opened by ${i.user.tag}`,
      permissionOverwrites: overwrites,
    });

    const data = {
      type: typeKey,
      urgency: urgencyKey,
      userId: i.user.id,
      accountCreated: i.user.createdTimestamp,
      createdAt: Date.now(),
      reason,
      claimerId: null,
    };

    const tickets = loadTickets();
    tickets[channel.id] = data;
    saveTickets(tickets);

    // ping the team that handles this ticket + the person who opened it
    const pingRole = handlerRoles(typeKey)[0];
    await channel.send({
      content: `${pingRole ? `<@&${pingRole}> ` : ''}${i.user}`,
      allowedMentions: { roles: pingRole ? [pingRole] : [], users: [i.user.id] },
    });

    await channel.send({
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
      components: ticketPanel(data),
    });

    await i.editReply({ content: `${E.tick} Your ticket has been created: ${channel}` });
  } catch (err) {
    console.error(err);
    await i.editReply({
      content: `${E.wifiproblem} I couldn't create your ticket. Please let a member of staff know.`,
    });
  }
}

// step 3: buttons inside the ticket
async function handleTicketButton(i) {
  const tickets = loadTickets();
  const data = tickets[i.channelId];
  if (!data) {
    return i.reply({
      content: `${E.wifiproblem} I can't find this ticket in my records.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const type = TICKET_TYPES[data.type];
  const isStaff = canManage(i.member, data.type);
  const noPerms = () =>
    i.reply({ content: `${E.block} Only staff can use this button.`, flags: MessageFlags.Ephemeral });
  const ownerOrStaff = () =>
    i.reply({
      content: `${E.block} Only the ticket owner or staff can do this.`,
      flags: MessageFlags.Ephemeral,
    });

  // saves a transcript, then closes the ticket
  const closeTicket = async () => {
    delete tickets[i.channelId];
    saveTickets(tickets);
    await i.reply({ content: `${E.lock} This ticket is being closed and the transcript is being saved...` });
    await logTranscript(i.guild, i.channel, {
      title: type.name,
      details: [
        { label: 'Ticket', text: type.name },
        { label: 'Opened by', userId: data.userId },
        { label: 'Claimed by', userId: data.claimerId, text: 'Nobody' },
        { label: 'Closed by', userId: i.user.id },
      ],
    });
    setTimeout(() => {
      i.channel.delete(`Ticket closed by ${i.user.tag}`).catch(console.error);
    }, 3000);
  };

  switch (i.customId) {
    case 'ticket_claim': {
      if (!isStaff) return noPerms();
      if (data.claimerId) {
        return i.reply({
          content: `${E.block} This ticket has already been claimed by <@${data.claimerId}>.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }
      data.claimerId = i.user.id;
      saveTickets(tickets);

      await i.update({
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
        components: ticketPanel(data),
      });
      // name goes from red to green
      i.channel.setName(`🟢-${type.slug}`).catch(console.error);
      await i.channel.send({
        content: `${E.tick} This ticket has been claimed by ${i.user}.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    case 'ticket_close_request': {
      if (!isStaff) return noPerms();
      return i.reply({
        content: `${E.timer} <@${data.userId}>, ${i.user} has requested to close this ticket. Is your issue resolved?`,
        allowedMentions: { users: [data.userId] },
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: 'Close Ticket', custom_id: 'ticket_close_confirm', emoji: emojiObj('lock') },
              { type: 2, style: 2, label: 'Keep Open', custom_id: 'ticket_close_deny', emoji: emojiObj('unlock') },
            ],
          },
        ],
      });
    }

    case 'ticket_close_confirm': {
      if (i.user.id !== data.userId && !isStaff) return ownerOrStaff();
      return closeTicket();
    }

    case 'ticket_close_deny': {
      if (i.user.id !== data.userId && !isStaff) return ownerOrStaff();
      return i.update({
        content: `${E.tick} Close request cancelled. This ticket will stay open.`,
        components: [],
      });
    }

    case 'ticket_close': {
      if (!isStaff) return noPerms();
      return closeTicket();
    }
  }
}

// =====================================================================
// SERVICE ORDERS
// =====================================================================
const ORDER_TOP = 'https://discord-webhook.com/uploads/002f6e96d62b3691d34d03b25f2ca72d.png';

// which team handles which kind of order (role IDs come from .env)
const TEAMS = {
  design: { roleEnv: 'DESIGN_ORDER_ROLE_ID', label: 'Designer' },
  development: { roleEnv: 'DEVELOPMENT_ORDER_ROLE_ID', label: 'Developer' },
};

// key = the value of each option in the services dropdown, price = Robux per item (used to suggest a price)
const SERVICES = {
  liveries: { name: 'Liveries', slug: 'liveries-order', categoryEnv: 'LIVERIES_ORDER_CATEGORY_ID', team: 'design', price: 100 },
  els: { name: 'ELS', slug: 'els-order', categoryEnv: 'ELS_ORDER_CATEGORY_ID', team: 'design', price: 100 },
  clothing: { name: 'Clothing & Uniforms', slug: 'clothing-order', categoryEnv: 'CLOTHING_ORDER_CATEGORY_ID', team: 'design', price: 75 },
  graphics: { name: 'Banners & Graphics', slug: 'graphics-order', categoryEnv: 'GRAPHICS_ORDER_CATEGORY_ID', team: 'design', price: 50 },
  maps: { name: 'Map-Making', slug: 'map-making-order', categoryEnv: 'MAP_MAKING_ORDER_CATEGORY_ID', team: 'design', price: 500 },
  bots: { name: 'Discord Bots', slug: 'discord-bot-order', categoryEnv: 'DISCORD_BOT_ORDER_CATEGORY_ID', team: 'development', price: 3000 },
  server: { name: 'Server Development', slug: 'server-development-order', categoryEnv: 'CUSTOM_DEVELOPMENT_CATEGORY_ID', team: 'development', price: 1000 },
  systems: { name: 'Custom Systems', slug: 'custom-systems-order', categoryEnv: 'CUSTOM_DEVELOPMENT_CATEGORY_ID', team: 'development', price: 1000 },
};

const PAYMENT_DOT = { Unpaid: '🔴', 'Awaiting Payment': '🟡', Paid: '🟢' };
const MAX_OPEN_ORDERS = 3;

const teamRole = (serviceKey) => process.env[TEAMS[SERVICES[serviceKey].team].roleEnv];

// only staff in the team for that order (or admins) can use the controls
function canManageOrder(member, data) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const roleId = teamRole(data.service);
  return Boolean(roleId) && member.roles.cache.has(roleId);
}

// the pop-up form for a new order
function orderModal(serviceKey) {
  const field = (label, id, style, extra) => ({
    type: 18,
    label,
    component: { type: 4, custom_id: id, style, ...extra },
  });
  return {
    custom_id: `order_modal:${serviceKey}`,
    title: `${SERVICES[serviceKey].name} Order`.slice(0, 45),
    components: [
      field('Quantity', 'quantity', 1, { required: true, max_length: 20, placeholder: 'e.g. 1' }),
      field('Budget', 'budget', 1, { required: true, max_length: 50, placeholder: 'e.g. 2,000 Robux or £20' }),
      field('Due Date', 'duedate', 1, { required: true, max_length: 50, placeholder: 'DD/MM/YYYY or ASAP' }),
      field('Order Description', 'description', 2, {
        required: true,
        max_length: 1000,
        placeholder: 'Describe what you would like us to make',
      }),
      field('Additional Requirements', 'additional', 2, {
        required: false,
        max_length: 1000,
        placeholder: 'Anything else we should know? (optional)',
      }),
    ],
  };
}

// the panel posted inside every order ticket
function orderPanel(data) {
  const service = SERVICES[data.service];
  const label = TEAMS[service.team].label;
  const claimed = Boolean(data.claimerId);

  const text =
    `**Customer:** <@${data.userId}>\n` +
    `**Product/Service:** ${service.name}\n` +
    `**Quantity:** ${data.quantity}\n` +
    `**Budget:** ${data.budget}\n` +
    (data.price ? `**Price:** ${fmt(data.price)} ${E.robux}\n` : '') +
    `**Payment Status:** ${PAYMENT_DOT[data.paymentStatus]} ${data.paymentStatus}\n` +
    `**Due Date:** ${data.dueDate}\n` +
    `**Assigned ${label}:** ${claimed ? `<@${data.claimerId}>` : 'Unassigned'}\n` +
    `**Order Status:** ${claimed ? '🟢 In Progress' : '🟡 Pending'}\n\n` +
    `**Order Description:**\n> ${quote(data.description)}\n\n` +
    `**Additional Requirements:**\n> ${quote(data.additional)}\n\n` +
    `**Staff Notes:**\n> None yet`;

  return [
    {
      type: 17,
      components: [
        { type: 12, items: [{ media: { url: ORDER_TOP } }] },
        SEP,
        { type: 10, content: text },
        SEP,
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: claimed ? 'Claimed' : 'Claim',
              custom_id: 'order_claim',
              disabled: claimed,
              emoji: emojiObj('tick'),
            },
            {
              type: 2,
              style: 1,
              label: 'Request Game Pass',
              custom_id: 'order_request_pass',
              disabled: !claimed || Boolean(data.passRequested),
              emoji: emojiObj('robux'),
            },
            { type: 2, style: 2, label: 'Close Request', custom_id: 'order_close_request', emoji: emojiObj('timer') },
            { type: 2, style: 4, label: 'Close', custom_id: 'order_close', emoji: emojiObj('lock') },
          ],
        },
        SEP,
        { type: 12, items: [{ media: { url: BOTTOM_IMAGE } }] },
        SEP,
      ],
    },
  ];
}

// re-draws the order panel after something changed
async function refreshOrderPanel(channel, data) {
  if (!data.panelMessageId) return;
  const message = await channel.messages.fetch(data.panelMessageId).catch(() => null);
  await message
    ?.edit({
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
      components: orderPanel(data),
    })
    .catch(console.error);
}

// ----- game pass request (pings the owner) -----
function priceModal(data) {
  const service = SERVICES[data.service];
  const qty = parseInt(data.quantity, 10);
  const suggested = service.price * (qty > 0 ? qty : 1);
  return {
    custom_id: 'order_price_modal',
    title: 'Request Game Pass',
    components: [
      {
        type: 18,
        label: 'Price in Robux',
        description: 'Check the price before sending. The owner will be pinged.',
        component: {
          type: 4,
          custom_id: 'price',
          style: 1,
          required: true,
          max_length: 10,
          value: String(suggested),
          placeholder: 'e.g. 100',
        },
      },
    ],
  };
}

function linkModal() {
  return {
    custom_id: 'order_link_modal',
    title: 'Send Game Pass Link',
    components: [
      {
        type: 18,
        label: 'Game pass link',
        component: {
          type: 4,
          custom_id: 'link',
          style: 1,
          required: true,
          max_length: 300,
          placeholder: 'https://www.roblox.com/game-pass/...',
        },
      },
    ],
  };
}

// the message that pings the owner with all the order info
function requestPanel(data) {
  const service = SERVICES[data.service];
  const label = TEAMS[service.team].label;
  const done = Boolean(data.passUrl);
  const owner = process.env.OWNER_ID ? `<@${process.env.OWNER_ID}>` : 'Owner';

  const text =
    `# ${E.robux} Game Pass Request\n` +
    `${owner}, please create a game pass for this order.\n\n` +
    `**Customer:** <@${data.userId}>\n` +
    `**Product/Service:** ${service.name}\n` +
    `**Quantity:** ${data.quantity}\n` +
    `**Price:** ${fmt(data.price)} ${E.robux}\n` +
    `**Due Date:** ${data.dueDate}\n` +
    `**${label}:** <@${data.claimerId}>\n\n` +
    `**Order Description:**\n> ${quote(data.description)}\n\n` +
    `**Additional Requirements:**\n> ${quote(data.additional)}\n\n` +
    `-# Create the game pass at the price above, then press the button to send the link to the customer.`;

  return [
    {
      type: 17,
      accent_color: done ? 0x57f287 : 0xffbf00,
      components: [
        { type: 10, content: text },
        SEP,
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: done ? 'Link Sent' : 'Send Game Pass Link',
              custom_id: 'order_link',
              disabled: done,
              emoji: emojiObj('key'),
            },
          ],
        },
      ],
    },
  ];
}

// the message the customer uses to pay
function payPanel(data) {
  const service = SERVICES[data.service];
  const paid = data.paymentStatus === 'Paid';

  const text =
    `# ${E.robux} ${paid ? 'Payment Received' : 'Payment'}\n` +
    `<@${data.userId}>, ${
      paid
        ? 'we have received your payment. Thank you!'
        : 'your order is ready for payment. Please purchase the game pass below.'
    }\n\n` +
    `**Product/Service:** ${service.name}\n` +
    `**Price:** ${fmt(data.price)} ${E.robux}\n\n` +
    `-# Once you have purchased the game pass, our team will confirm your payment.`;

  return [
    {
      type: 17,
      accent_color: paid ? 0x57f287 : 0xffbf00,
      components: [
        { type: 10, content: text },
        SEP,
        {
          type: 1,
          components: [
            { type: 2, style: 5, label: 'Buy Game Pass', url: data.passUrl, emoji: emojiObj('robux') },
            {
              type: 2,
              style: 3,
              label: paid ? 'Paid' : 'Mark as Paid',
              custom_id: 'order_paid',
              disabled: paid,
              emoji: emojiObj('tick'),
            },
          ],
        },
      ],
    },
  ];
}

// ----- order log (bottom image only, no top image) -----
function orderLogPanel(data, wentThrough, closedById, transcriptUrl) {
  const service = SERVICES[data.service];
  const label = TEAMS[service.team].label;

  const text =
    `**Customer:** <@${data.userId}>\n` +
    `**Product/Service:** ${service.name}\n` +
    `**Quantity:** ${data.quantity}\n` +
    `**Budget:** ${data.budget}\n` +
    (data.price ? `**Price:** ${fmt(data.price)} ${E.robux}\n` : '') +
    `**Payment Status:** ${PAYMENT_DOT[data.paymentStatus]} ${data.paymentStatus}\n` +
    `**Due Date:** ${data.dueDate}\n` +
    `**Assigned ${label}:** ${data.claimerId ? `<@${data.claimerId}>` : 'Unassigned'}\n` +
    `**Order Status:** ${wentThrough ? '✅ Completed' : "❌ Didn't go through"}\n\n` +
    `**Order Opened:** <t:${Math.floor(data.createdAt / 1000)}:F>\n` +
    `**Order Closed:** <t:${Math.floor(Date.now() / 1000)}:F>\n` +
    `**Closed By:** <@${closedById}>\n\n` +
    `**Order Description:**\n> ${quote(data.description)}\n\n` +
    `**Additional Requirements:**\n> ${quote(data.additional)}`;

  const parts = [{ type: 10, content: text }, SEP];
  if (transcriptUrl) {
    parts.push(
      {
        type: 1,
        components: [{ type: 2, style: 5, label: 'View Transcript', url: transcriptUrl, emoji: emojiObj('textmessage') }],
      },
      SEP
    );
  }
  parts.push({ type: 12, items: [{ media: { url: BOTTOM_IMAGE } }] }, SEP);

  return [{ type: 17, accent_color: wentThrough ? 0x57f287 : 0xed4245, components: parts }];
}

// makes a new post in the order log forum
async function postOrderLog(guild, data, wentThrough, closedById, transcriptUrl) {
  if (!process.env.ORDER_LOG_FORUM_ID) throw new Error('ORDER_LOG_FORUM_ID is not set in .env');

  const forum = await guild.channels.fetch(process.env.ORDER_LOG_FORUM_ID);
  if (!forum || forum.type !== ChannelType.GuildForum) {
    throw new Error('ORDER_LOG_FORUM_ID is not a forum channel');
  }

  const service = SERVICES[data.service];
  const customer = await client.users.fetch(data.userId).catch(() => null);
  const name = `${wentThrough ? '✅' : '❌'} ${service.name} - ${customer?.username ?? data.userId}`.slice(0, 100);

  const thread = await forum.threads.create({
    name,
    message: {
      content: `# Order Log\n${wentThrough ? `${E.tick} This order went through.` : `${E.thumbsdown} This order did not go through.`}`,
      allowedMentions: { parse: [] },
    },
  });

  await thread.send({
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: orderLogPanel(data, wentThrough, closedById, transcriptUrl),
  });
}

// step 1: they picked a service in the dropdown -> show the order form
async function handleServiceSelect(i) {
  const serviceKey = i.values[0];
  if (!SERVICES[serviceKey]) return;

  const openOrders = Object.entries(loadOrders()).filter(
    ([channelId, data]) => data.userId === i.user.id && i.guild.channels.cache.has(channelId)
  );

  if (openOrders.length >= MAX_OPEN_ORDERS) {
    await i.reply({
      content: `${E.block} You already have ${MAX_OPEN_ORDERS} open orders. Please wait for them to be finished before placing another.`,
      flags: MessageFlags.Ephemeral,
    });
  } else {
    await i.showModal(orderModal(serviceKey));
  }
  await resetSelect(i);
}

// step 2: they submitted the order form -> create the order channel
async function handleOrderModal(i) {
  const serviceKey = i.customId.split(':')[1];
  const service = SERVICES[serviceKey];
  if (!service) return;

  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const data = {
    service: serviceKey,
    userId: i.user.id,
    quantity: modalValue(i, 'quantity') || '1',
    budget: modalValue(i, 'budget') || 'Not given',
    dueDate: modalValue(i, 'duedate') || 'Not given',
    description: modalValue(i, 'description') || 'No description given',
    additional: modalValue(i, 'additional') || 'None',
    paymentStatus: 'Unpaid',
    createdAt: Date.now(),
    claimerId: null,
    price: null,
    passRequested: false,
    passUrl: null,
    panelMessageId: null,
  };

  const roleId = teamRole(serviceKey);
  const overwrites = [
    { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: i.user.id, allow: VIEW_PERMS },
    {
      id: client.user.id,
      allow: [...VIEW_PERMS, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages],
    },
    ...(roleId ? [{ id: roleId, allow: VIEW_PERMS }] : []),
  ];

  try {
    const channel = await i.guild.channels.create({
      name: `🔴-${service.slug}`,
      type: ChannelType.GuildText,
      parent: process.env[service.categoryEnv] || undefined,
      topic: `${service.name} order - opened by ${i.user.tag}`,
      permissionOverwrites: overwrites,
    });

    // ping the right team + the customer
    await channel.send({
      content: `${roleId ? `<@&${roleId}> ` : ''}${i.user}`,
      allowedMentions: { roles: roleId ? [roleId] : [], users: [i.user.id] },
    });

    const panelMessage = await channel.send({
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
      components: orderPanel(data),
    });

    data.panelMessageId = panelMessage.id;
    const orders = loadOrders();
    orders[channel.id] = data;
    saveOrders(orders);

    await i.editReply({ content: `${E.tick} Your order has been created: ${channel}` });
  } catch (err) {
    console.error(err);
    await i.editReply({
      content: `${E.wifiproblem} I couldn't create your order. Please let a member of staff know.`,
    });
  }
}

// the claimer submitted a price -> ping the owner
async function handleOrderPriceModal(i) {
  const orders = loadOrders();
  const data = orders[i.channelId];
  if (!data) {
    return i.reply({ content: `${E.wifiproblem} I can't find this order.`, flags: MessageFlags.Ephemeral });
  }

  const price = parseInt((modalValue(i, 'price') || '').replace(/[^0-9]/g, ''), 10);
  if (!price || price < 1) {
    return i.reply({
      content: `${E.block} That isn't a valid price. Press **Request Game Pass** and try again.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  data.price = price;
  data.passRequested = true;
  saveOrders(orders);

  await i.reply({ content: `${E.tick} Game pass request sent to the owner.`, flags: MessageFlags.Ephemeral });
  await refreshOrderPanel(i.channel, data);
  await i.channel.send({
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { users: process.env.OWNER_ID ? [process.env.OWNER_ID] : [] },
    components: requestPanel(data),
  });
}

// the owner submitted the game pass link -> customer can pay
async function handleOrderLinkModal(i) {
  const orders = loadOrders();
  const data = orders[i.channelId];
  if (!data) {
    return i.reply({ content: `${E.wifiproblem} I can't find this order.`, flags: MessageFlags.Ephemeral });
  }
  if (!isOwner(i.user.id)) {
    return i.reply({ content: `${E.block} Only the owner can do this.`, flags: MessageFlags.Ephemeral });
  }

  let url = null;
  try {
    url = new URL((modalValue(i, 'link') || '').trim());
  } catch {
    // not a link
  }
  if (!url || url.protocol !== 'https:' || !/(^|\.)roblox\.com$/.test(url.hostname)) {
    return i.reply({
      content: `${E.block} That doesn't look like a Roblox link. Press **Send Game Pass Link** and try again.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  data.passUrl = url.href;
  data.paymentStatus = 'Awaiting Payment';
  saveOrders(orders);

  // grey out the owner's button
  if (i.isFromMessage()) {
    await i.update({
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
      components: requestPanel(data),
    });
  } else {
    await i.reply({ content: `${E.tick} Link saved.`, flags: MessageFlags.Ephemeral });
  }

  await refreshOrderPanel(i.channel, data);
  await i.channel.send({
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { users: [data.userId] },
    components: payPanel(data),
  });
}

// step 3: buttons inside the order ticket
async function handleOrderButton(i) {
  const orders = loadOrders();
  const data = orders[i.channelId];
  if (!data) {
    return i.reply({
      content: `${E.wifiproblem} I can't find this order in my records.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const service = SERVICES[data.service];
  const isAdmin = i.member.permissions.has(PermissionFlagsBits.Administrator);
  const isStaff = canManageOrder(i.member, data);
  const say = (content) => i.reply({ content: `${E.block} ${content}`, flags: MessageFlags.Ephemeral });
  const noPerms = () => say('Only staff assigned to this order category can use this.');
  const ownerOnly = () => say('Only the owner can do this.');

  // "did the order go through?" - only staff can answer
  const askOutcome = () =>
    i.reply({
      content: `${E.checkbox} **Did the order go through?**\nOnly staff assigned to this order category can answer.`,
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Yes, it went through', custom_id: 'order_outcome_yes', emoji: emojiObj('thumbsup') },
            { type: 2, style: 4, label: "No, it didn't", custom_id: 'order_outcome_no', emoji: emojiObj('thumbsdown') },
          ],
        },
      ],
    });

  switch (i.customId) {
    case 'order_claim': {
      if (!isStaff) return noPerms();
      if (data.claimerId) return say(`This order has already been claimed by <@${data.claimerId}>.`);

      data.claimerId = i.user.id;
      saveOrders(orders);

      await i.update({
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
        components: orderPanel(data),
      });
      // name goes from red to green
      i.channel.setName(`🟢-${service.slug}`).catch(console.error);
      await i.channel.send({
        content: `${E.tick} This order has been claimed by ${i.user}. Use **Request Game Pass** when the price is agreed.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    case 'order_request_pass': {
      if (!isStaff) return noPerms();
      if (!data.claimerId) return say('Claim this order first.');
      if (data.claimerId !== i.user.id && !isAdmin) return say('Only the person who claimed this order can request the game pass.');
      if (data.passRequested) return say('A game pass has already been requested for this order.');
      return i.showModal(priceModal(data));
    }

    case 'order_link': {
      if (!isOwner(i.user.id)) return ownerOnly();
      return i.showModal(linkModal());
    }

    case 'order_paid': {
      if (!isOwner(i.user.id)) return ownerOnly();
      data.paymentStatus = 'Paid';
      saveOrders(orders);
      await i.update({
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
        components: payPanel(data),
      });
      await refreshOrderPanel(i.channel, data);
      return;
    }

    case 'order_close_request': {
      if (!isStaff) return noPerms();
      return i.reply({
        content: `${E.timer} <@${data.userId}>, ${i.user} has requested to close this order. Is everything finished?`,
        allowedMentions: { users: [data.userId] },
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: 'Accept', custom_id: 'order_close_confirm', emoji: emojiObj('tick') },
              { type: 2, style: 2, label: 'Keep Open', custom_id: 'order_close_deny', emoji: emojiObj('unlock') },
            ],
          },
        ],
      });
    }

    case 'order_close_confirm': {
      if (i.user.id !== data.userId && !isStaff) return say('Only the customer or staff can do this.');
      return askOutcome();
    }

    case 'order_close_deny': {
      if (i.user.id !== data.userId && !isStaff) return say('Only the customer or staff can do this.');
      return i.update({
        content: `${E.tick} Close request cancelled. This order will stay open.`,
        components: [],
      });
    }

    case 'order_close': {
      if (!isStaff) return noPerms();
      return askOutcome();
    }

    case 'order_outcome_yes':
    case 'order_outcome_no': {
      if (!isStaff) return noPerms();
      const wentThrough = i.customId === 'order_outcome_yes';

      await i.update({
        content: `${E.timer} Saving the transcript, logging this order and closing the ticket...`,
        components: [],
      });

      const transcript = await logTranscript(i.guild, i.channel, {
        title: `${service.name} Order`,
        details: [
          { label: 'Service', text: service.name },
          { label: 'Customer', userId: data.userId },
          { label: TEAMS[service.team].label, userId: data.claimerId, text: 'Unassigned' },
          { label: 'Closed by', userId: i.user.id },
          { label: 'Outcome', text: wentThrough ? 'Completed' : "Didn't go through" },
        ],
      });

      try {
        await postOrderLog(i.guild, data, wentThrough, i.user.id, transcript?.url);
      } catch (err) {
        // keep the ticket open so nothing is lost
        console.error(err);
        return i.channel.send({
          content: `${E.wifiproblem} I couldn't post the order log, so this ticket will stay open. Check \`ORDER_LOG_FORUM_ID\` and my permissions in the forum, then press **Close** again.`,
        });
      }

      // only completed orders are counted for payouts and /orderlogs
      if (wentThrough) {
        const completed = loadCompleted();
        completed.push({
          service: data.service,
          serviceName: service.name,
          claimerId: data.claimerId,
          userId: data.userId,
          price: data.price,
          closedAt: Date.now(),
          closedBy: i.user.id,
        });
        writeJson(COMPLETED_FILE, completed);
      }

      delete orders[i.channelId];
      saveOrders(orders);
      await i.channel.send({ content: `${E.lock} Order logged. This ticket will be closed in a few seconds...` });
      setTimeout(() => {
        i.channel.delete(`Order closed by ${i.user.tag}`).catch(console.error);
      }, 3000);
      return;
    }
  }
}

// =====================================================================
// DEVELOPER / DESIGNER PAYOUT PANEL + /orderlogs
// =====================================================================
async function handleStaffButton(i) {
  const { start, counts } = periodCounts();
  const nextPayout = Math.floor((start + PERIOD_MS) / 1000);

  // anyone can see their own orders
  if (i.customId === 'staff_orders') {
    const mine = counts[i.user.id] || 0;
    const allTime = loadCompleted().filter((r) => r.claimerId === i.user.id).length;
    return i.reply(
      infoReply(
        `# {tick} Your Orders\n` +
          `**Completed this period:** ${mine} / ${MAX_ORDERS_PER_PERIOD}\n${progressBar(mine)}\n\n` +
          `**Robux earned:** ${fmt(earned(mine))} {robux} (max ${fmt(MAX_ORDERS_PER_PERIOD * PAYOUT_PER_ORDER)})\n` +
          `**Orders left this period:** ${Math.max(MAX_ORDERS_PER_PERIOD - mine, 0)}\n` +
          `**Next payout:** <t:${nextPayout}:D> (<t:${nextPayout}:R>)\n` +
          `**Completed all time:** ${allTime}` +
          (mine > MAX_ORDERS_PER_PERIOD
            ? `\n\n-# You've passed the limit for this period. Extra orders don't earn extra Robux.`
            : '')
      )
    );
  }

  // reset buttons: owner only
  if (i.customId === 'staff_reset' || i.customId === 'staff_reset_confirm') {
    if (!isOwner(i.user.id)) {
      return i.reply({ content: `${E.block} Only the owner can do this.`, flags: MessageFlags.Ephemeral });
    }

    const people = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = people.reduce((sum, [, n]) => sum + earned(n), 0);
    const lines = people.map(
      ([id, n]) => `<@${id}> - **${n}** order${n === 1 ? '' : 's'} (${fmt(earned(n))} {robux})`
    );

    // first press: show who is owed what, ask to confirm
    if (i.customId === 'staff_reset') {
      return i.reply({
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
        components: [
          {
            type: 17,
            accent_color: ACCENT,
            components: [
              {
                type: 10,
                content: applyEmojis(
                  `# {trash} Reset Orders?\nThis starts a new payout period and sets everyone back to 0.\n\n` +
                    `**Owed this period:** ${fmt(total)} {robux}\n` +
                    (lines.join('\n') || 'Nobody has completed an order this period.')
                ),
              },
              SEP,
              {
                type: 1,
                components: [
                  { type: 2, style: 4, label: 'Confirm Reset', custom_id: 'staff_reset_confirm', emoji: emojiObj('trash') },
                ],
              },
            ],
          },
        ],
      });
    }

    // confirmed: start a new period
    writeJson(PAYOUT_FILE, { periodStart: Date.now() });
    return i.update({
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
      components: [
        {
          type: 17,
          accent_color: 0x57f287,
          components: [
            {
              type: 10,
              content: applyEmojis(
                `# {tick} Orders Reset\nA new payout period has started and everyone is back to 0.\n\n` +
                  `**Last period total:** ${fmt(total)} {robux}\n` +
                  (lines.join('\n') || 'Nobody completed an order last period.')
              ),
            },
          ],
        },
      ],
    });
  }
}

// /orderlogs - owner only: completed orders and who did them
async function handleOrderLogs(i) {
  if (!isOwner(i.user.id)) {
    return i.reply({ content: `${E.block} Only the owner can use this command.`, flags: MessageFlags.Ephemeral });
  }

  const filterUser = i.options.getUser('user');
  const { counts: thisPeriod } = periodCounts();
  const records = loadCompleted().filter((r) => !filterUser || r.claimerId === filterUser.id);

  const allTime = {};
  for (const r of records) {
    const key = r.claimerId ?? 'unassigned';
    allTime[key] = (allTime[key] || 0) + 1;
  }

  const who = (id) => (id === 'unassigned' || !id ? 'Unassigned' : `<@${id}>`);
  const people = Object.keys(allTime)
    .sort((a, b) => allTime[b] - allTime[a])
    .slice(0, 25)
    .map((id) => {
      const p = thisPeriod[id] || 0;
      return `${who(id)} - **${allTime[id]}** completed - this period **${p}** (${fmt(earned(p))} ${E.robux})`;
    });
  const owed = Object.entries(thisPeriod)
    .filter(([id]) => !filterUser || id === filterUser.id)
    .reduce((sum, [, n]) => sum + earned(n), 0);
  const recent = records
    .slice(-10)
    .reverse()
    .map((r) => `${E.tick} ${r.serviceName} - ${who(r.claimerId)} - <t:${Math.floor(r.closedAt / 1000)}:d>`);

  const text =
    `# ${E.tick} Completed Orders${filterUser ? ` - ${filterUser.username}` : ''}\n` +
    `**Total completed (all time):** ${records.length}\n` +
    `**Owed this period:** ${fmt(owed)} ${E.robux}\n` +
    `-# ${fmt(PAYOUT_PER_ORDER)} Robux per completed order, max ${MAX_ORDERS_PER_PERIOD} orders (${fmt(MAX_ORDERS_PER_PERIOD * PAYOUT_PER_ORDER)} Robux) each per 14 days. Denied or cancelled orders are not counted.\n\n` +
    `### Who completed them\n${people.join('\n') || 'No completed orders yet.'}\n\n` +
    `### Latest completed\n${recent.join('\n') || 'None yet.'}`;

  return i.reply({
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [{ type: 17, accent_color: 0x57f287, components: [{ type: 10, content: text }] }],
  });
}

// =====================================================================
// GIVEAWAYS
// =====================================================================
// understands things like 30m, 2h, 1d, 2w or 1d12h
function parseDuration(text) {
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  const clean = text.toLowerCase().replace(/\s/g, '');
  let total = 0;
  let matched = '';
  for (const m of clean.matchAll(/(\d+)([smhdw])/g)) {
    total += Number(m[1]) * units[m[2]];
    matched += m[0];
  }
  return total && matched === clean ? total : null;
}

// the giveaway panel (updates live as people enter)
function giveawayPanel(g) {
  const ends = Math.floor(g.endsAt / 1000);
  const winnerLine = g.ended
    ? `\n\n${E.tick} **Winner${g.winnerIds.length === 1 ? '' : 's'}:** ${
        g.winnerIds.length ? g.winnerIds.map((id) => `<@${id}>`).join(', ') : 'No valid entries'
      }`
    : '';

  const text =
    `${E.gift} **Prize:** ${g.prize}\n` +
    `${E.confetti} **Winners:** ${g.winners}\n` +
    `${E.trainee} **Host:** <@${g.hostId}>\n` +
    `${E.timer} **${g.ended ? 'Ended' : 'Ends'}:** <t:${ends}:F> (<t:${ends}:R>)` +
    winnerLine;

  return [
    {
      type: 17,
      components: [
        { type: 10, content: text },
        SEP,
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: g.ended ? 'Giveaway Ended' : 'Enter Giveaway',
              custom_id: 'giveaway_enter',
              disabled: g.ended,
              emoji: emojiObj('giveaway'),
            },
            {
              type: 2,
              style: 2,
              label: String(g.entries.length),
              custom_id: 'giveaway_count',
              disabled: true,
              emoji: emojiObj('trainee'),
            },
          ],
        },
      ],
    },
  ];
}

// /giveaway duration prize host winners
async function handleGiveawayCommand(i) {
  const duration = parseDuration(i.options.getString('duration'));
  if (!duration || duration < 10000 || duration > 365 * 86400000) {
    return i.reply({
      content: `${E.block} That duration doesn't work. Try something like \`30m\`, \`2h\`, \`1d\` or \`2w\` (up to 1 year).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const giveaway = {
    channelId: i.channelId,
    prize: i.options.getString('prize'),
    winners: i.options.getInteger('winners'),
    hostId: i.options.getUser('host').id,
    endsAt: Date.now() + duration,
    entries: [],
    ended: false,
    winnerIds: [],
  };

  const message = await i.channel.send({
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: giveawayPanel(giveaway),
  });

  const all = loadGiveaways();
  all[message.id] = giveaway;
  saveGiveaways(all);

  return i.reply({ content: `${E.tick} Giveaway started in ${i.channel}.`, flags: MessageFlags.Ephemeral });
}

// the Enter Giveaway button (press again to leave)
async function handleGiveawayEnter(i) {
  const all = loadGiveaways();
  const giveaway = all[i.message.id];
  if (!giveaway || giveaway.ended) {
    return i.reply({ content: `${E.block} This giveaway has ended.`, flags: MessageFlags.Ephemeral });
  }

  const index = giveaway.entries.indexOf(i.user.id);
  const joined = index === -1;
  if (joined) giveaway.entries.push(i.user.id);
  else giveaway.entries.splice(index, 1);
  saveGiveaways(all);

  await i.update({
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: giveawayPanel(giveaway),
  });
  await i.followUp({
    content: joined
      ? `${E.tick} You've entered the giveaway. Good luck!`
      : `${E.block} You've left the giveaway. Press the button again to re-enter.`,
    flags: MessageFlags.Ephemeral,
  });
}

// picks the winners and announces them
async function endGiveaway(messageId, giveaway) {
  const pool = [...giveaway.entries];
  for (let n = pool.length - 1; n > 0; n--) {
    const j = Math.floor(Math.random() * (n + 1));
    [pool[n], pool[j]] = [pool[j], pool[n]];
  }
  giveaway.winnerIds = pool.slice(0, giveaway.winners);
  giveaway.ended = true;

  const all = loadGiveaways();
  all[messageId] = giveaway;
  saveGiveaways(all);

  const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(messageId).catch(() => null);

  if (message) {
    await message
      .edit({
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] },
        components: giveawayPanel(giveaway),
      })
      .catch(console.error);
  }

  const announcement = {
    content: giveaway.winnerIds.length
      ? `${E.confetti} Congratulations ${giveaway.winnerIds.map((id) => `<@${id}>`).join(', ')}! You won **${giveaway.prize}**!`
      : `${E.block} Nobody entered the giveaway for **${giveaway.prize}**, so there are no winners.`,
    allowedMentions: { users: giveaway.winnerIds },
  };
  if (message) await message.reply(announcement).catch(console.error);
  else await channel.send(announcement).catch(console.error);
}

// checks every 15 seconds for giveaways that have run out of time
function checkGiveaways() {
  const all = loadGiveaways();
  for (const [messageId, giveaway] of Object.entries(all)) {
    if (!giveaway.ended && giveaway.endsAt <= Date.now()) {
      endGiveaway(messageId, giveaway).catch(console.error);
    }
  }
}

// =====================================================================
// PANELS, REVIEWS, COMMANDS
// =====================================================================
function loadPanel(name) {
  const raw = fs.readFileSync(path.join(__dirname, 'panels', `${name}.json`), 'utf8');
  const data = JSON.parse(applyEmojis(raw));
  return Array.isArray(data) ? data : data.components;
}

function buildReview({ designer, clientUser, service, rating, feedback }) {
  // makes user text safe to drop inside JSON
  const esc = (s) => JSON.stringify(String(s)).slice(1, -1);
  const fields = {
    '{designer}': `<@${designer.id}>`,
    '{client}': `<@${clientUser.id}>`,
    '{service}': service,
    '{rating}': '⭐'.repeat(rating),
    '{feedback}': feedback.replace(/\n/g, '\n> '),
  };
  let raw = applyEmojis(fs.readFileSync(path.join(__dirname, 'panels', 'review.json'), 'utf8'));
  for (const [key, value] of Object.entries(fields)) {
    raw = raw.split(key).join(esc(value));
  }
  return JSON.parse(raw).components;
}

// small ephemeral panel used for dropdown/button replies
function panelReply(text) {
  return {
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    components: [
      { type: 17, accent_color: ACCENT, components: [{ type: 10, content: applyEmojis(text) }] },
    ],
  };
}

const commands = [
  new SlashCommandBuilder()
    .setName('setuppanel')
    .setDescription('Send a panel to this channel')
    .addStringOption((o) =>
      o.setName('panel').setDescription('Which panel').setRequired(true)
        .addChoices(...PANELS.map((p) => ({ name: p, value: p })))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Make the bot say something')
    .addStringOption((o) => o.setName('message').setDescription('What to say').setRequired(true))
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Where to send it (default: here)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('review')
    .setDescription('Leave a review for your designer / developer')
    .addUserOption((o) => o.setName('designer').setDescription('Who worked on your order').setRequired(true))
    .addStringOption((o) => o.setName('service').setDescription('What service you ordered').setRequired(true).setMaxLength(100))
    .addIntegerOption((o) =>
      o.setName('rating').setDescription('Rating out of 5').setRequired(true).setMinValue(1).setMaxValue(5)
    )
    .addStringOption((o) => o.setName('feedback').setDescription('Your feedback').setRequired(true).setMaxLength(1000)),

  new SlashCommandBuilder()
    .setName('membercount')
    .setDescription('Shows how many members are in the server'),

  new SlashCommandBuilder()
    .setName('orderlogs')
    .setDescription('Owner only: completed orders and who did them')
    .addUserOption((o) => o.setName('user').setDescription('Only show this designer / developer'))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Start a giveaway')
    .addStringOption((o) =>
      o.setName('duration').setDescription('How long it runs, e.g. 30m, 2h, 1d, 2w').setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('prize').setDescription('What is being given away').setRequired(true).setMaxLength(200)
    )
    .addUserOption((o) => o.setName('host').setDescription('Who is hosting it').setRequired(true))
    .addIntegerOption((o) =>
      o.setName('winners').setDescription('How many winners').setRequired(true).setMinValue(1).setMaxValue(20)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

// ---------- Status ----------
function updateStatus() {
  const members = client.guilds.cache.reduce((total, g) => total + g.memberCount, 0);
  client.user.setPresence({
    status: 'dnd',
    activities: [{ name: `over ${members} members`, type: ActivityType.Watching }],
  });
}

// ---------- Ready ----------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  updateStatus();
  setInterval(updateStatus, 5 * 60 * 1000);
  startTranscriptServer();
  checkGiveaways();
  setInterval(checkGiveaways, 15 * 1000);

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  try {
    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
      : Routes.applicationCommands(process.env.CLIENT_ID);
    await rest.put(route, { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Command registration failed:', err);
  }
});

// ---------- Welcome message ----------
client.on(Events.GuildMemberAdd, async (member) => {
  const channel = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (channel) {
    // "dashboard" becomes a clickable link when DASHBOARD_CHANNEL_ID is set in .env
    const dashboard = process.env.DASHBOARD_CHANNEL_ID
      ? `[dashboard](https://discord.com/channels/${member.guild.id}/${process.env.DASHBOARD_CHANNEL_ID})`
      : '**dashboard**';

    await channel
      .send({
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { users: [member.id] },
        components: [
          {
            type: 17,
            components: [
              {
                type: 10,
                content:
                  `# ${E.confetti} Welcome, ${member}\n` +
                  `> We welcome you to **Echo Customs**, we are glad you have joined us. A couple tips, ensure to read our ${dashboard} for our goals and guidelines.`,
              },
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    style: 2,
                    label: fmt(member.guild.memberCount),
                    custom_id: 'welcome_count',
                    disabled: true,
                    emoji: emojiObj('trainee'),
                  },
                  { type: 2, style: 5, label: 'Services', url: SERVICES_CHANNEL_URL },
                ],
              },
              { type: 12, items: [{ media: { url: BOTTOM_IMAGE } }] },
            ],
          },
        ],
      })
      .catch(console.error);
  }
  updateStatus();
});

client.on(Events.GuildMemberRemove, () => updateStatus());

// ---------- Interactions ----------
client.on(Events.InteractionCreate, async (i) => {
  try {
    // ----- Slash commands -----
    if (i.isChatInputCommand()) {
      if (i.commandName === 'setuppanel') {
        const name = i.options.getString('panel');
        let components;
        try {
          components = loadPanel(name);
        } catch (err) {
          console.error(err);
          return i.reply({
            content: `${E.wifiproblem} Couldn't load \`panels/${name}.json\`. Check the file exists and is valid JSON.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        await i.channel.send({ flags: MessageFlags.IsComponentsV2, components });
        return i.reply({ content: `${E.tick} Sent the **${name}** panel.`, flags: MessageFlags.Ephemeral });
      }

      if (i.commandName === 'say') {
        const message = i.options.getString('message');
        const channel = i.options.getChannel('channel') ?? i.channel;
        await channel.send({ content: message, allowedMentions: { parse: [] } });
        return i.reply({ content: `${E.tick} Sent in ${channel}.`, flags: MessageFlags.Ephemeral });
      }

      if (i.commandName === 'review') {
        const components = buildReview({
          designer: i.options.getUser('designer'),
          clientUser: i.user,
          service: i.options.getString('service'),
          rating: i.options.getInteger('rating'),
          feedback: i.options.getString('feedback'),
        });
        const target =
          (process.env.REVIEW_CHANNEL_ID && i.guild.channels.cache.get(process.env.REVIEW_CHANNEL_ID)) ||
          i.channel;
        await target.send({
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] },
          components,
        });
        return i.reply({ content: `${E.thumbsup} Thanks, your review has been posted in ${target}.`, flags: MessageFlags.Ephemeral });
      }

      if (i.commandName === 'membercount') {
        return i.reply({
          flags: MessageFlags.IsComponentsV2,
          components: [
            {
              type: 17,
              accent_color: ACCENT,
              components: [
                {
                  type: 10,
                  content: `${E.world} **Members**\n# ${fmt(i.guild.memberCount)}\n-# ${i.guild.name}`,
                },
              ],
            },
          ],
        });
      }

      if (i.commandName === 'orderlogs') return handleOrderLogs(i);
      if (i.commandName === 'giveaway') return handleGiveawayCommand(i);
    }

    // ----- Giveaways -----
    if (i.isButton() && i.customId === 'giveaway_enter') return handleGiveawayEnter(i);

    // ----- Assistance tickets -----
    if (i.isStringSelectMenu() && i.customId === 'assistance_menu') return handleAssistanceSelect(i);
    if (i.isModalSubmit() && i.customId.startsWith('assistance_modal:')) return handleTicketModal(i);
    if (i.isButton() && i.customId.startsWith('ticket_')) return handleTicketButton(i);

    // ----- Service orders -----
    if (i.isStringSelectMenu() && i.customId === 'services_menu') return handleServiceSelect(i);
    if (i.isModalSubmit() && i.customId.startsWith('order_modal:')) return handleOrderModal(i);
    if (i.isModalSubmit() && i.customId === 'order_price_modal') return handleOrderPriceModal(i);
    if (i.isModalSubmit() && i.customId === 'order_link_modal') return handleOrderLinkModal(i);
    if (i.isButton() && i.customId.startsWith('order_')) return handleOrderButton(i);

    // ----- Developer / designer payout panel -----
    if (i.isButton() && i.customId.startsWith('staff_')) return handleStaffButton(i);

    // ----- Other buttons + dropdowns -----
    if (i.isButton() || i.isStringSelectMenu()) {
      const key = i.isStringSelectMenu() ? `${i.customId}:${i.values[0]}` : i.customId;
      const build = marketReplies[key] ?? dashboardReplies[key];

      if (build) {
        await i.reply(build());
      } else {
        await i.reply(panelReply(responses[key] ?? '{wifiproblem} This isn\'t set up yet.'));
      }

      if (i.isStringSelectMenu()) await resetSelect(i);
    }
  } catch (err) {
    console.error(err);
  }
});

// plugs in applications.js (/applications, /panel disable) - keep this line above client.login
require('./applications').setup(client, commands);

client.login(process.env.TOKEN);