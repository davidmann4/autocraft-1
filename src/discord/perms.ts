// Whether the bot can view a channel, computed from the gateway payloads it already receives: the guild's roles and channel
// overwrites (GUILD_CREATE, CHANNEL_*, GUILD_ROLE_*) and its own member roles (GUILD_CREATE members, GUILD_MEMBER_UPDATE), and
// whether it holds other permissions there (has).
const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
export const READ_MESSAGE_HISTORY = 1n << 16n;
export const CREATE_PUBLIC_THREADS = 1n << 35n;
export const SEND_MESSAGES_IN_THREADS = 1n << 38n;

export type Overwrite = { id: string; type: number | string; allow?: string; deny?: string };
export type Role = { id: string; permissions?: string };

const big = (v: string | undefined): bigint => { try { return BigInt(v ?? "0"); } catch { return 0n; } };

/** Discord's permission order: guild roles, then the channel's @everyone overwrite, role overwrites, and the member overwrite. Administrator holds every permission. */
export function permsIn(guildId: string, botId: string, roles: ReadonlyMap<string, Role>, memberRoles: readonly string[], overwrites: readonly Overwrite[]): bigint {
  let perms = big(roles.get(guildId)?.permissions);
  for (const r of memberRoles) perms |= big(roles.get(r)?.permissions);
  if (perms & ADMINISTRATOR) return ~0n;
  const apply = (o: Overwrite | undefined) => { if (o) perms = (perms & ~big(o.deny)) | big(o.allow); };
  const role = (o: Overwrite) => Number(o.type) === 0;
  apply(overwrites.find((o) => role(o) && o.id === guildId));
  let deny = 0n, allow = 0n;
  for (const o of overwrites) if (role(o) && o.id !== guildId && memberRoles.includes(o.id)) { deny |= big(o.deny); allow |= big(o.allow); }
  perms = (perms & ~deny) | allow;
  apply(overwrites.find((o) => !role(o) && o.id === botId));
  return perms;
}

export const canView = (guildId: string, botId: string, roles: ReadonlyMap<string, Role>, memberRoles: readonly string[], overwrites: readonly Overwrite[]): boolean =>
  (permsIn(guildId, botId, roles, memberRoles, overwrites) & VIEW_CHANNEL) !== 0n;

type Guild = { roles: Map<string, Role>; botRoles: string[] | null; channels: Map<string, Overwrite[]> };

/** Per-process guild state. Without the bot's own member roles (not in the payload) every channel counts as viewable. */
export class GuildPerms {
  botId: string | null = null;
  #guilds = new Map<string, Guild>();
  #g(id: string): Guild {
    let g = this.#guilds.get(id);
    if (!g) this.#guilds.set(id, g = { roles: new Map(), botRoles: null, channels: new Map() });
    return g;
  }
  setGuild(id: string, roles: Role[], members: { user?: { id?: string }; roles?: string[] }[] | undefined, channels: { id: string; permission_overwrites?: Overwrite[] }[]): void {
    const g = this.#g(id);
    g.roles = new Map(roles.map((r) => [r.id, r]));
    const me = members?.find((m) => m.user?.id === this.botId);
    if (me) g.botRoles = me.roles ?? [];
    g.channels = new Map(channels.map((c) => [c.id, c.permission_overwrites ?? []]));
  }
  setChannel(guildId: string, id: string, overwrites: Overwrite[] | undefined): void { this.#g(guildId).channels.set(id, overwrites ?? []); }
  setRole(guildId: string, role: Role): void { this.#g(guildId).roles.set(role.id, role); }
  deleteRole(guildId: string, roleId: string): void { this.#g(guildId).roles.delete(roleId); }
  setBotRoles(guildId: string, roles: string[]): void { this.#g(guildId).botRoles = roles; }
  channelIds(guildId: string): string[] { return [...this.#g(guildId).channels.keys()]; }
  viewable(guildId: string, channelId: string): boolean {
    return this.has(guildId, channelId, VIEW_CHANNEL);
  }
  /** Whether the bot holds every permission of `bits` in the channel; true while its roles are unknown. */
  has(guildId: string, channelId: string, bits: bigint): boolean {
    const g = this.#g(guildId);
    if (!this.botId || !g.botRoles) return true;
    return (permsIn(guildId, this.botId, g.roles, g.botRoles, g.channels.get(channelId) ?? []) & bits) === bits;
  }
}

export const guildPerms = new GuildPerms();
