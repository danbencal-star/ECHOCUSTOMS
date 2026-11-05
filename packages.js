const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, Events } = require('discord.js');

const ACCENT = 0x4e5058;
const SEP = { type: 14, spacing: 1, divider: true };

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'packages.json');

const load = () => {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
};
const save = (obj) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2));
};

// builds the package panel
function packagePanel(p) {
  const details = [
    `- **packer:** <@${p.packerId}>`,
    `- **price:** ${p.price}`,
    `- **field:** ${p.field}`,
    `- **tag:** ${p.tag}`,
    p.showcase ? `- **showcase:** [watch showcase video](${p.showcase})` : null,
  ].filter(Boolean);

  const contents = [
    `- **${p.requires}**`,
    p.modules ? `- Required Modules: **${p.modules}**` : null,
    p.usage ? `- Command Usage: **${p.usage}**` : null,
  ].filter(Boolean);

  const text =
    `# ${p.name}\n` +
    `**package details**\n${details.join('\n')}\n\n` +
    `**package contents:**\n${contents.join('\n')}`;

  const purchaseButton = p.gamepass
    ? { type: 2, style: 5, label: 'purchase', url: p.gamepass }
    : { type: 2, style: 2, label: 'purchase', custom_id: 'package_purchase' };

  return [
    {
      type: 17,
      accent_color: ACCENT,
      components: [
        { type: 10, content: text },
        SEP,
        {
          type: 1,
          components: [
            purchaseButton,
            { type: 2, style: 2, label: `${p.sales} sale${p.sales === 1 ? '' : 's'}`, custom_id: 'package_sales', disabled: true },
          ],
        },
      ],
    },
  ];
}

function setup(client, commands) {
  commands.push(
    new SlashCommandBuilder()
      .setName('package')
      .setDescription('Post a package listing')
      .addStringOption((o) => o.setName('name').setDescription('Name of the package').setRequired(true).setMaxLength(100))
      .addUserOption((o) => o.setName('packer').setDescription('Who made it').setRequired(true))
      .addStringOption((o) => o.setName('price').setDescription('e.g. 299R$').setRequired(true).setMaxLength(30))
      .addStringOption((o) => o.setName('field').setDescription('e.g. bot development').setRequired(true).setMaxLength(50))
      .addStringOption((o) => o.setName('tag').setDescription('e.g. misc').setRequired(true).setMaxLength(30))
      .addStringOption((o) => o.setName('showcase').setDescription('Link to the showcase video'))
      .addStringOption((o) => o.setName('requires').setDescription('Default: Requires a proper handler!').setMaxLength(100))
      .addStringOption((o) => o.setName('modules').setDescription('e.g. discord.js, axios, canvas').setMaxLength(200))
      .addStringOption((o) => o.setName('usage').setDescription('e.g. -verify').setMaxLength(100))
      .addStringOption((o) => o.setName('gamepass').setDescription('Game pass link (makes Purchase a link button)'))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('packagesold')
      .setDescription('Add +1 sale to a package (run in the same channel as the package)')
      .addStringOption((o) => o.setName('message_id').setDescription('ID of the package message').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .toJSON()
  );

  client.on(Events.InteractionCreate, async (i) => {
    try {
      // /package
      if (i.isChatInputCommand() && i.commandName === 'package') {
        const p = {
          name: i.options.getString('name'),
          packerId: i.options.getUser('packer').id,
          price: i.options.getString('price'),
          field: i.options.getString('field'),
          tag: i.options.getString('tag'),
          showcase: i.options.getString('showcase'),
          requires: i.options.getString('requires') || 'Requires a proper handler!',
          modules: i.options.getString('modules'),
          usage: i.options.getString('usage'),
          gamepass: i.options.getString('gamepass'),
          sales: 0,
        };

        const message = await i.channel.send({
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] },
          components: packagePanel(p),
        });

        const all = load();
        all[message.id] = p;
        save(all);

        return i.reply({ content: 'Package posted.', flags: MessageFlags.Ephemeral });
      }

      // /packagesold
      if (i.isChatInputCommand() && i.commandName === 'packagesold') {
        const id = i.options.getString('message_id').trim();
        const all = load();
        const p = all[id];
        if (!p) return i.reply({ content: "I can't find a package with that message ID.", flags: MessageFlags.Ephemeral });

        p.sales += 1;
        save(all);

        const message = await i.channel.messages.fetch(id).catch(() => null);
        if (!message) {
          return i.reply({ content: 'Saved, but I could not find that message in this channel to update it.', flags: MessageFlags.Ephemeral });
        }
        await message.edit({
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { parse: [] },
          components: packagePanel(p),
        });
        return i.reply({ content: `Updated. **${p.name}** now has ${p.sales} sale${p.sales === 1 ? '' : 's'}.`, flags: MessageFlags.Ephemeral });
      }

      // Purchase button (only used when no game pass link was given)
      if (i.isButton() && i.customId === 'package_purchase') {
        const p = load()[i.message.id];
        return i.reply({
          content: `To purchase **${p?.name ?? 'this package'}**${p ? ` for **${p.price}**` : ''}, open a ticket in the dashboard and mention this package.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (err) {
      console.error(err);
    }
  });
}

module.exports = { setup };