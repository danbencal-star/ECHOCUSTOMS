const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Events, SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { E, applyEmojis } = require('./emojis');

const BOTTOM_IMAGE = 'https://discord-webhook.com/uploads/3002d9037ea3566a731d9aff1b8dd7ce.png';
const SEP = { type: 14, spacing: 1, divider: true };

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const APPS_FILE = path.join(DATA_DIR, 'applications.json');

// ---------- the 3 applications: questions + roles given when accepted ----------
// style 1 = short answer, style 2 = long answer
const APPLICATIONS = {
  staff: {
    name: 'Staff',
    roles: ['1566158779580686416', '1566154090155876512', '1566154090600468511'],
    questions: [
      { id: 'q1', label: 'Why do you want to join the staff team?', style: 2, max: 600, placeholder: 'Tell us why you would be a good fit' },
      { id: 'q2', label: 'Any previous moderation experience?', style: 2, max: 600, placeholder: 'Servers, roles and how long for' },
      { id: 'q3', label: 'How would you handle a rule-breaker?', style: 2, max: 600, placeholder: 'Explain what you would do step by step' },
      { id: 'q4', label: 'How active can you be each week?', style: 1, max: 150, placeholder: 'e.g. 10 hours a week' },
      { id: 'q5', label: 'Anything else we should know?', style: 2, max: 600, required: false, placeholder: 'Optional' },
    ],
  },
  designer: {
    name: 'Designer',
    roles: ['1566174979966640158', '1567277600076857404', '1566154085952917584'],
    questions: [
      { id: 'q1', label: 'Portfolio link', style: 1, max: 200, placeholder: 'https://your-portfolio-link.com' },
      { id: 'q2', label: 'What do you specialise in?', style: 1, max: 150, placeholder: 'Liveries, ELS, clothing, graphics, banners, maps...' },
      { id: 'q3', label: 'List your past work and experience', style: 2, max: 600, placeholder: 'Tell us about your previous work...' },
      { id: 'q4', label: 'Why do you want to join as a designer?', style: 2, max: 600, placeholder: 'Tell us why you would be a good fit' },
      { id: 'q5', label: 'How many hours can you give each week?', style: 1, max: 150, placeholder: 'e.g. 10 hours a week' },
    ],
  },
  developer: {
    name: 'Developer',
    roles: ['1566175075323871302', '1566158779580686416', '1566154085273575495'],
    questions: [
      { id: 'q1', label: 'Portfolio or GitHub link', style: 1, max: 200, placeholder: 'https://github.com/your-name' },
      { id: 'q2', label: 'Which languages do you use?', style: 1, max: 150, placeholder: 'e.g. JavaScript, Python, Lua' },
      { id: 'q3', label: 'List your past work and experience', style: 2, max: 600, placeholder: 'Tell us about your previous projects...' },
      { id: 'q4', label: 'Why do you want to join as a developer?', style: 2, max: 600, placeholder: 'Tell us why you would be a good fit' },
      { id: 'q5', label: 'How many hours can you give each week?', style: 1, max: 150, placeholder: 'e.g. 10 hours a week' },
    ],
  },
};

// which custom_id prefix belongs to which panel (used by /panel disable)
const PANEL_PREFIXES = {
  dashboard: 'dashboard_',
  affiliates: 'affiliates_',
  assistance: 'assistance_',
  services: 'services_',
  market: 'market_',
  staffinfo: 'staff_',
  applications: 'app_',
};

// ---------- helpers ----------
const loadApps = () => {
  try {
    return JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
  } catch {
    return {};
  }
};

const saveApps = (apps) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
};

const quote = (text) => String(text).replace(/\n/g, '\n> ');
const isOwner = (id) => Boolean(process.env.OWNER_ID) && id === process.env.OWNER_ID;

function emojiObj(key) {
  const m = E[key]?.match(/<a?:(\w+):(\d+)>/);
  return m ? { name: m[1], id: m[2] } : undefined;
}

// reads a field from a submitted pop-up form
function fieldValue(i, id) {
  const field = i.fields.fields.get(id);
  return field?.values?.[0] ?? field?.value;
}

// goes through every component (including ones inside containers and rows)
function walk(list, fn) {
  for (const c of list ?? []) {
    fn(c);
    if (c.components) walk(c.components, fn);
    if (c.accessory) walk([c.accessory], fn);
  }
}

async function dmUser(client, userId, payload) {
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch {
    return false;
  }
}

const findPending = (userId, type) =>
  Object.values(loadApps()).find((a) => a.userId === userId && a.type === type && a.status === 'pending');

// ---------- the applications panel ----------
function applicationsPanel() {
  const text = applyEmojis(
    '# {trainee} Applications\n\n' +
      'Want to join the **Echo Customs** team? Pick the position you are applying for below and fill out the short form.\n\n' +
      '> **Staff** - Help keep the community safe and running smoothly.\n' +
      '> **Designer** - Create liveries, ELS, clothing, graphics and more.\n' +
      '> **Developer** - Build bots, systems and server development for our clients.\n\n' +
      '-# Applications are reviewed by management. You will get a DM once a decision is made, so keep your DMs open.'
  );

  return [
    {
      type: 17,
      components: [
        { type: 10, content: text },
        SEP,
        {
          type: 1,
          components: [
            { type: 2, style: 2, label: 'Staff', custom_id: 'app_apply:staff', emoji: emojiObj('trainee') },
            { type: 2, style: 2, label: 'Designer', custom_id: 'app_apply:designer', emoji: emojiObj('confetti') },
            { type: 2, style: 2, label: 'Developer', custom_id: 'app_apply:developer', emoji: emojiObj('github') },
          ],
        },
        SEP,
        { type: 12, items: [{ media: { url: BOTTOM_IMAGE } }] },
      ],
    },
  ];
}

// the pop-up form with 5 questions
function applicationModal(typeKey) {
  const type = APPLICATIONS[typeKey];
  return {
    custom_id: `app_modal:${typeKey}`,
    title: `${type.name} Application`,
    components: type.questions.map((q) => ({
      type: 18,
      label: q.label,
      component: {
        type: 4,
        custom_id: q.id,
        style: q.style,
        required: q.required !== false,
        max_length: q.max,
        placeholder: q.placeholder,
      },
    })),
  };
}

// the application as it arrives in the owner's DMs
function reviewPanel(app, decision) {
  const type = APPLICATIONS[app.type];
  const status = decision
    ? `${decision.accepted ? '✅ Accepted' : '❌ Denied'} by <@${decision.by}> <t:${Math.floor(decision.at / 1000)}:R>` +
      (decision.reason ? `\n**Reason:** ${decision.reason}` : '') +
      (decision.note ? `\n${decision.note}` : '')
    : '🟡 Pending review';

  const answers = app.answers.map((a) => `**${a.question}**\n> ${quote(a.answer)}`).join('\n\n');
  const text =
    `# ${E.trainee} New ${type.name} Application\n` +
    `**Applicant:** <@${app.userId}> (${app.username})\n` +
    `**Account Created:** ${new Date(app.accountCreated).toLocaleDateString('en-GB')}\n` +
    `**Applied:** <t:${Math.floor(app.createdAt / 1000)}:F>\n` +
    `**Status:** ${status}\n\n` +
    answers;

  return [
    {
      type: 17,
      accent_color: decision ? (decision.accepted ? 0x57f287 : 0xed4245) : 0xffbf00,
      components: [
        { type: 10, content: text },
        SEP,
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: 'Accept',
              custom_id: `app_review:accept:${app.id}`,
              disabled: Boolean(decision),
              emoji: emojiObj('tick'),
            },
            {
              type: 2,
              style: 4,
              label: 'Deny',
              custom_id: `app_review:deny:${app.id}`,
              disabled: Boolean(decision),
              emoji: emojiObj('thumbsdown'),
            },
          ],
        },
      ],
    },
  ];
}

// what the applicant gets in their DMs
function decisionPanel(app, accepted, { reason, rolesGiven } = {}) {
  const type = APPLICATIONS[app.type];
  const text = accepted
    ? `# ${E.tick} Application Accepted\nCongratulations! Your **${type.name}** application for **Echo Customs** has been accepted.` +
      (rolesGiven
        ? ' Your roles have been added in the server, welcome to the team!'
        : ' A member of management will sort out your roles shortly, welcome to the team!')
    : `# ${E.thumbsdown} Application Denied\nThank you for applying, but unfortunately your **${type.name}** application for **Echo Customs** was denied.` +
      (reason ? `\n\n**Reason:**\n> ${quote(reason)}` : '') +
      `\n\n-# You are welcome to apply again in the future.`;

  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [{ type: 17, accent_color: accepted ? 0x57f287 : 0xed4245, components: [{ type: 10, content: text }] }],
  };
}

// ---------- step 1: someone pressed Staff / Designer / Developer ----------
async function handleApply(i) {
  const typeKey = i.customId.split(':')[1];
  if (!APPLICATIONS[typeKey]) return;

  if (findPending(i.user.id, typeKey)) {
    return i.reply({
      content: `${E.block} You already have a pending **${APPLICATIONS[typeKey].name}** application. Please wait for a decision.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  return i.showModal(applicationModal(typeKey));
}

// ---------- step 2: they submitted the form -> send it to the owner's DMs ----------
async function handleSubmit(i, client) {
  const typeKey = i.customId.split(':')[1];
  const type = APPLICATIONS[typeKey];
  if (!type) return;

  await i.deferReply({ flags: MessageFlags.Ephemeral });

  if (findPending(i.user.id, typeKey)) {
    return i.editReply({ content: `${E.block} You already have a pending **${type.name}** application.` });
  }

  const app = {
    id: crypto.randomBytes(4).toString('hex'),
    type: typeKey,
    userId: i.user.id,
    username: i.user.username,
    guildId: i.guildId,
    accountCreated: i.user.createdTimestamp,
    createdAt: Date.now(),
    status: 'pending',
    answers: type.questions.map((q) => ({
      question: q.label,
      answer: (fieldValue(i, q.id) || '').trim() || 'No answer given',
    })),
  };

  const sent = await dmUser(client, process.env.OWNER_ID, {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: reviewPanel(app),
  });

  if (!sent) {
    return i.editReply({
      content: `${E.wifiproblem} I couldn't send your application to management right now. Please try again later or let a member of staff know.`,
    });
  }

  const apps = loadApps();
  apps[app.id] = app;
  saveApps(apps);

  return i.editReply({
    content: `${E.tick} Your **${type.name}** application has been submitted! You will get a DM once management has made a decision.`,
  });
}

// ---------- step 3: the owner pressed Accept / Deny in their DMs ----------
async function handleReview(i, client) {
  const [, action, id] = i.customId.split(':');

  if (!isOwner(i.user.id)) {
    return i.reply({ content: `${E.block} Only the owner can review applications.`, flags: MessageFlags.Ephemeral });
  }

  const apps = loadApps();
  const app = apps[id];
  if (!app) {
    return i.reply({ content: `${E.wifiproblem} I can't find this application.`, flags: MessageFlags.Ephemeral });
  }
  if (app.status !== 'pending') {
    return i.reply({
      content: `${E.block} This application has already been ${app.status}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // deny: ask for an optional reason first
  if (action === 'deny') {
    return i.showModal({
      custom_id: `app_deny_modal:${id}`,
      title: 'Deny Application',
      components: [
        {
          type: 18,
          label: 'Reason (optional)',
          component: {
            type: 4,
            custom_id: 'reason',
            style: 2,
            required: false,
            max_length: 500,
            placeholder: 'Tell the applicant why (optional)',
          },
        },
      ],
    });
  }

  // accept: give the roles, DM the applicant
  await i.deferUpdate();

  let rolesGiven = false;
  let note = '';
  const guild = client.guilds.cache.get(app.guildId);
  const member = guild ? await guild.members.fetch(app.userId).catch(() => null) : null;

  if (!member) {
    note = '⚠️ They are no longer in the server, so no roles were given.';
  } else {
    try {
      await member.roles.add(APPLICATIONS[app.type].roles, 'Application accepted');
      rolesGiven = true;
      note = '✅ Roles given.';
    } catch (err) {
      console.error(err);
      note = "⚠️ I couldn't give the roles. Check I have Manage Roles and that my role is above theirs.";
    }
  }

  app.status = 'accepted';
  app.reviewedBy = i.user.id;
  saveApps(apps);

  const dmSent = await dmUser(client, app.userId, decisionPanel(app, true, { rolesGiven }));
  if (!dmSent) note += " ⚠️ I couldn't DM the applicant.";

  const decision = { accepted: true, by: i.user.id, at: Date.now(), note };
  await i.message.edit({
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: reviewPanel(app, decision),
  });
}

// the deny pop-up was submitted
async function handleDeny(i, client) {
  const id = i.customId.split(':')[1];

  if (!isOwner(i.user.id)) {
    return i.reply({ content: `${E.block} Only the owner can review applications.`, flags: MessageFlags.Ephemeral });
  }

  const apps = loadApps();
  const app = apps[id];
  if (!app || app.status !== 'pending') {
    return i.reply({ content: `${E.block} This application has already been handled.`, flags: MessageFlags.Ephemeral });
  }

  if (i.isFromMessage()) await i.deferUpdate();
  else await i.deferReply({ flags: MessageFlags.Ephemeral });

  const reason = (fieldValue(i, 'reason') || '').trim();
  app.status = 'denied';
  app.reviewedBy = i.user.id;
  saveApps(apps);

  const dmSent = await dmUser(client, app.userId, decisionPanel(app, false, { reason }));
  const decision = {
    accepted: false,
    by: i.user.id,
    at: Date.now(),
    reason,
    note: dmSent ? '' : "⚠️ I couldn't DM the applicant.",
  };

  if (i.isFromMessage()) {
    await i.message.edit({
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
      components: reviewPanel(app, decision),
    });
  } else {
    await i.editReply({ content: `${E.tick} Application denied.` });
  }
}

// ---------- /panel disable ----------
async function handlePanelDisable(i, client) {
  const name = i.options.getString('panel');
  const prefix = PANEL_PREFIXES[name];
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const messages = await i.channel.messages.fetch({ limit: 100 });
  let target = null;
  let components = null;

  // newest copy of that panel in this channel
  for (const message of messages.values()) {
    if (message.author.id !== client.user.id) continue;
    const json = message.components.map((c) => c.toJSON());
    let found = false;
    walk(json, (c) => {
      if (typeof c.custom_id === 'string' && c.custom_id.startsWith(prefix)) found = true;
    });
    if (found) {
      target = message;
      components = json;
      break;
    }
  }

  if (!target) {
    return i.editReply({
      content: `${E.block} I couldn't find a **${name}** panel in the last 100 messages of this channel. Run the command in the channel the panel is in.`,
    });
  }

  // buttons (2) and every kind of dropdown (3, 5, 6, 7, 8)
  walk(components, (c) => {
    if ([2, 3, 5, 6, 7, 8].includes(c.type)) c.disabled = true;
  });

  try {
    await target.edit({ flags: MessageFlags.IsComponentsV2, components });
    return i.editReply({ content: `${E.tick} Disabled the **${name}** panel: ${target.url}` });
  } catch (err) {
    console.error(err);
    return i.editReply({ content: `${E.wifiproblem} I couldn't edit that panel. Check the console for the error.` });
  }
}

// ---------- routing ----------
// returns true when it handled the interaction
async function handle(i, client) {
  if (i.isChatInputCommand()) {
    if (i.commandName === 'applications') {
      await i.channel.send({ flags: MessageFlags.IsComponentsV2, components: applicationsPanel() });
      await i.reply({ content: `${E.tick} Sent the applications panel.`, flags: MessageFlags.Ephemeral });
      return true;
    }
    if (i.commandName === 'panel') {
      await handlePanelDisable(i, client);
      return true;
    }
    return false;
  }

  if (i.isButton() && i.customId.startsWith('app_apply:')) return (await handleApply(i), true);
  if (i.isModalSubmit() && i.customId.startsWith('app_modal:')) return (await handleSubmit(i, client), true);
  if (i.isButton() && i.customId.startsWith('app_review:')) return (await handleReview(i, client), true);
  if (i.isModalSubmit() && i.customId.startsWith('app_deny_modal:')) return (await handleDeny(i, client), true);

  return false;
}

const builders = [
  new SlashCommandBuilder()
    .setName('applications')
    .setDescription('Post the applications panel (Staff, Designer, Developer)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Manage panels')
    .addSubcommand((s) =>
      s
        .setName('disable')
        .setDescription('Disable all the buttons and dropdowns on a panel')
        .addStringOption((o) =>
          o
            .setName('panel')
            .setDescription('Which panel (run this in the channel the panel is in)')
            .setRequired(true)
            .addChoices(...Object.keys(PANEL_PREFIXES).map((p) => ({ name: p, value: p })))
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// plugs everything into the bot (called from index.js)
function setup(client, commands) {
  commands.push(...builders.map((b) => b.toJSON()));

  // put our handler in front of the existing one
  const original = client.listeners(Events.InteractionCreate);
  client.removeAllListeners(Events.InteractionCreate);
  client.on(Events.InteractionCreate, async (i) => {
    try {
      if (await handle(i, client)) return;
    } catch (err) {
      console.error('Applications error:', err);
      return;
    }
    for (const listener of original) listener(i);
  });
}

module.exports = { setup };