// The public privacy notice of the optional Discord bot. No sign-in; the only stored value it shows is the operators' contact text.
import { esc, plainPage } from "./util.ts";

// Discord refuses app URLs that contain its name.
export const DISCORD_PRIVACY_PATH = "/privacy";

export function discordPrivacyPage(nonce: string, contact: string): string {
  return plainPage(nonce, "Discord bot privacy", discordPrivacyBody(nonce, contact));
}

/** The notice without the page around it; the contributor verification pages serve it under their own path too. */
export function discordPrivacyBody(nonce: string, contact: string): string {
  const who = contact.trim() ? esc(contact.trim()) : "the operators of this AutoCraft instance";
  return `<style nonce="${nonce}">main{max-width:38rem}h2{font-size:15px;margin:18px 0 4px}</style>
<h2>What the bot collects</h2>
<p>Messages in the channels its operators choose, the commands you send it, and, if you link your account, your Discord user ID and GitHub login. Verifying for the contributor role on this site signs you in with Discord and with GitHub to read your Discord user ID and GitHub login; both sign-ins are used once and not kept, and the two accounts are then linked, so the Verify button in Discord works directly next time. Such a link does not let you send commands; an account linked earlier with <code>/autocraft account action:link</code> keeps that link. A linked account that turns on alerts gets direct messages about decisions, and the IDs of those messages are kept to update them.</p>
<h2>How it is used</h2>
<p>To count references to GitHub issues and pull requests, to answer searches and commands, to file the issues you ask it to submit, to recognise linked accounts, and to give the contributor role to accounts whose GitHub login authored a merged pull request.</p>
<h2>What is kept</h2>
<p>References to GitHub issues and pull requests with the IDs of the messages that made them, the threads and replies the bot answers commands in with their items and the GitHub login that sent the command, account links, and a keyed hash of the Discord user ID of each person who opted out. For an issue the bot files for you, the repository and issue number with a keyed hash of your Discord user ID, for one day, to apply the daily limit. For a contributor verification on this site, your Discord user ID (encrypted, with a keyed hash of it) and GitHub login, for at most one day. Each Verify press and each verification on this site is recorded in the audit log with the GitHub login, the result and a keyed hash of your Discord user ID, and kept as long as the audit log. Message text is not kept.</p>
<h2>Sharing</h2>
<p>Search text, issue drafts and messages that mention an issue or pull request (to check whether they ask for attention) may be processed by an AI service provider. They are not stored or sold. An issue the bot files for you is public on GitHub and names you by your Discord name.</p>
<h2>Opting out</h2>
<p>Run <code>/autocraft account action:optout</code> and the bot stops recording your messages: it no longer counts them as references, checks them for requests for attention or reacts to them. The records of your earlier messages that the bot can tie to you are deleted. Commands and searches you send to the bot still work, because you asked for them. <code>/autocraft account action:optin</code> turns recording back on.</p>
<h2>Deletion</h2>
<p>Deleting a message removes its record. <code>/autocraft account action:unlink</code> removes your account link, your GitHub sign-in for filing, and your contributor verification records; the audit log entries stay. For other requests, contact ${who}.</p>`;
}
