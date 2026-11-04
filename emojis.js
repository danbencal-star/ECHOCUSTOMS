const E = {
  robux: '<:9748_robux:1566434123911012443>',
  timer: '<:41158timer:1566186626193948742>',
  block: '<:35075block:1566186624704847952>',
  wifioff: '<:988766wifioff:1566186621164986368>',
  unlimited: '<:97365unlimited:1566186582971523223>',
  maparrow: '<:962321maparrow:1566186617180389528>',
  github: '<:88867github:1566186581583335576>',
  gift: '<:81893gift:1566186580010471515>',
  toggle: '<:79938toggleonoroff:1566186578634604574>',
  economy: '<:74036economy:1566186573865689138>',
  roblox: '<:77489roblox:1566186575531085874>',
  world: '<:73138world:1566186560347705426>',
  chevron: '<:69554chevronrightlogo:1566186557508165793>',
  giveaway: '<:463819giveaway:1566186601640501368>',
  tick: '<:46073tickbox:1566186549735854080>',
  confetti: '<:474566confetti:1566186602869293247>',
  trainee: '<:52143trainee:1566186551161917440>',
  textmessage: '<:521557textmessage:1566186604232446074>',
  map: '<:56721map:1566186552512614571>',
  heart: '<:64211heartlogo:1566186553842208809>',
  trash: '<:66704trash:1566186555125669958>',
  unlock: '<:685116unlock:1566186614953345084>',
  fire: '<:437466fire:1566186599580958820>',
  checkbox: '<:43519checkboxoutline:1566186547735167126>',
  lock: '<:414779lock:1566186597290999910>',
  thumbsup: '<:396686thumbsup:1566186587329527908>',
  thumbsdown: '<:290483thumbsdown:1566186585714856077>',
  key: '<:28371key:1566186623396478976>',
  wifiproblem: '<:194610wifiproblem:1566186584125214730>',
};

function applyEmojis(text) {
  return text.replace(/\{(\w+)\}/g, (match, key) => E[key] ?? match);
}

module.exports = { E, applyEmojis };