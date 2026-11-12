// The conversation that plans a ticket: the first message the dashboard offers for a ticket, and
// the prefilled ChatGPT link that carries it when ChatGPT plans. The Context owner only plans: it
// reads the repository, grills the User on the ticket and writes the Task file; the User starts
// the job on the dashboard.

// Who plans a ticket, chosen in New ticket and switched on the ticket's page: ChatGPT through the
// connector, or Claude Code in the User's terminal through the local MCP server.
export const TICKET_OWNERS = ['chatgpt', 'claude_code'] as const;
export type TicketOwner = (typeof TICKET_OWNERS)[number];

// The owner kept in a ticket's .owner file: its text, or null without one; anything but a known
// owner (a missing file, other text) is chatgpt.
export function ownerOf(text: string | null): TicketOwner {
  return text?.trim() === 'claude_code' ? 'claude_code' : 'chatgpt';
}

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
    `${claude ? 'Use the software-factory MCP server.' : 'Use the Software Factory connector.'} Call guide. This conversation is for ticket ${ticket} in workspace ${workspace}.\n\n` +
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
