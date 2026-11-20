// The conversation that plans a ticket: the first message the dashboard offers for a ticket, and
// the prefilled ChatGPT link that carries it when ChatGPT plans. The Context owner only plans: it
// reads the repository, grills the User on the ticket and writes the Task file; the User starts
// the job on the dashboard. While a job waits for the User, the conversation about its result
// (resultConversation) and the ticket's planning chat link (planningChatUrl).
import { FactoryError } from './errors.js';

// Who plans a ticket, chosen in New ticket and switched on the ticket's page: ChatGPT through the
// connector, or Claude Code in the User's terminal through the local MCP server.
export const TICKET_OWNERS = ['chatgpt', 'claude_code'] as const;
export type TicketOwner = (typeof TICKET_OWNERS)[number];

// The owner kept in a ticket's .owner file: its text, or null without one; anything but a known
// owner (a missing file, other text) is chatgpt.
export function ownerOf(text: string | null): TicketOwner {
  return text?.trim() === 'claude_code' ? 'claude_code' : 'chatgpt';
}

// The first sentence of a conversation's message: how the Context owner reaches the factory.
const connection = (owner: TicketOwner): string => (owner === 'claude_code' ? 'Use the software-factory MCP server.' : 'Use the Software Factory connector.');

// The message that opens the planning conversation of a ticket from the dashboard: the connector
// (for claude_code, the software-factory MCP server), guide, the User's own words (never written
// into the Task file), the investigation and the Task file written with write_task, then the
// hand-back to the User. attachments: the names of the ticket's images; with any, how to read them
// and refer to them comes before the last sentence; for claude_code, so does the throwaway
// prototype it may build.
export function ticketConversation(workspace: string, ticket: string, request?: string, attachments: string[] = [], owner: TicketOwner = 'chatgpt'): string {
  const words = request === undefined || request.trim() === '' ? '' : `Here is what I want, in my words:\n\n${request.trim()}\n\n`;
  const images = attachments.length === 0
    ? ''
    : `The ticket has images: ${attachments.join(', ')}. Read each with read_attachment (workspace "${workspace}", ticket "${ticket}", name). ` +
      `In the Task file, refer to the images the Task needs as ![what it shows](${ticket}/<name>). `;
  const claude = owner === 'claude_code';
  const prototype = claude
    ? 'If a design question is best settled by seeing it, you may build a throwaway prototype (the prototype skill) outside the factory\'s worktrees; ' +
      'the Implementer cannot read it, so write what I chose into the Task file (structure, names, states). '
    : '';
  return (
    `${connection(owner)} Call guide. This conversation is for ticket ${ticket} in workspace ${workspace}.\n\n` +
    words +
    'Investigate it: read the repository with read_file and search, and grill me on it in rounds: number your questions, give your recommended answer to each, look facts up yourself, and write the Task file only after I confirm we agree. ' +
    `Write it with write_task (workspace "${workspace}", ticket "${ticket}"), replacing the skeleton ` +
    `.software-factory/${ticket}.md, with a ## Review brief for the reviewers, and show me the plan. ` +
    'Then tell me the Task file is ready; I start the job on the dashboard. ' +
    images +
    prototype +
    'You only plan: you do not start, review or approve jobs.'
  );
}

// Above this length the prefilled link is not offered; the message is copied by hand instead.
export const MAX_CONVERSATION_URL = 7500;

// The ChatGPT composer prefilled with the message; sending it may still need Enter. static/core.js
// keeps the same prefix to check the URL it links to.
export const CHATGPT_PREFILL_URL = 'https://chatgpt.com/?q=';

export function conversationUrl(message: string): string {
  return `${CHATGPT_PREFILL_URL}${encodeURIComponent(message)}`;
}

// The message that opens the conversation about a job's result while the job waits for the User:
// the connector (for claude_code, the software-factory MCP server), guide, the Task file with
// read_file, the latest Report and reviews with read_job, a short summary, the discussion, and the
// change proposed with suggest_changes, which the User sends or dismisses on the dashboard.
export function resultConversation(workspace: string, ticket: string, owner: TicketOwner = 'chatgpt'): string {
  return (
    `${connection(owner)} Call guide. ` +
    `This conversation is about the result of ticket ${ticket} in workspace ${workspace}: its job waits for me. ` +
    `Read the Task file with read_file (workspace "${workspace}", path ".software-factory/${ticket}.md"), ` +
    `then the job's latest Report and reviews with read_job (workspace "${workspace}", ticket "${ticket}"). ` +
    'Tell me in a few lines what was built, what the reviewers found and what is open, then discuss with me what should change. ' +
    `When we agree, propose the change with suggest_changes (workspace "${workspace}", ticket "${ticket}", note): ` +
    'one note to the Implementer, written as I would write it. I read it on the dashboard and send it or dismiss it. ' +
    'The Task file cannot be rewritten while the job is live. You do not start, review or approve jobs.'
  );
}

// The longest planning chat link a ticket keeps.
export const MAX_CHAT_LINK = 2048;

// A Claude planner session link exactly as the factory makes it (planner-session.ts, notify.ts):
// https://claude.ai/code/ and one session id, nothing before or after. web/core.ts
// PLANNING_CLAUDE_LINK is the same pattern.
const CLAUDE_SESSION_LINK = /^https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]{1,128}$/;

// A ticket's planning chat link as the User gave it, of at most MAX_CHAT_LINK characters as given:
// a https://chatgpt.com/ URL (no subdomain, no port, no credentials, its href at most
// MAX_CHAT_LINK characters too), returned as the href; or the trimmed text itself when it is a
// whole Claude planner session link (CLAUDE_SESSION_LINK, tested on the text, not a parsed URL);
// anything else is invalid_chat_link. The page checks a stored one again before it links it
// (web/core.ts planningChatHref).
export function planningChatUrl(text: string): string {
  const invalid = new FactoryError('invalid_chat_link', 'Only a https://chatgpt.com/ conversation link or a https://claude.ai/code/<session> link can be saved.');
  if (text.length > MAX_CHAT_LINK) {
    throw invalid;
  }
  const trimmed = text.trim();
  const url = URL.parse(trimmed);
  if (url !== null && url.protocol === 'https:' && url.hostname === 'chatgpt.com' && url.port === '' && url.username === '' && url.password === '' && url.href.length <= MAX_CHAT_LINK) {
    return url.href;
  }
  if (CLAUDE_SESSION_LINK.test(trimmed)) {
    return trimmed;
  }
  throw invalid;
}

// A stored planning chat link, or null when there is none or it no longer passes planningChatUrl.
export function storedChatUrl(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  try {
    return planningChatUrl(text);
  } catch { // a stored value that is no link: read as none
    return null;
  }
}
