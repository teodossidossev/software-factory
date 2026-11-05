// The ChatGPT conversation that plans a ticket (SF-025, SF-028, SF-040): the first message the
// dashboard offers for a ticket, and the prefilled ChatGPT link that carries it. ChatGPT only
// plans: it reads the repository, discusses the ticket with the User and writes the Task file;
// the User starts the job on the dashboard.

// The message that opens the ChatGPT conversation of a ticket from the dashboard: the connector,
// guide, the User's own words (never written into the Task file), the investigation and the Task
// file written with write_task, then the hand-back to the User. attachments: the names of the
// ticket's images (SF-064); with any, how to read them and refer to them comes before the last
// sentence.
export function ticketConversation(workspace: string, ticket: string, request?: string, attachments: string[] = []): string {
  const words = request === undefined || request.trim() === '' ? '' : `Here is what I want, in my words:\n\n${request.trim()}\n\n`;
  const images = attachments.length === 0
    ? ''
    : `The ticket has images: ${attachments.join(', ')}. Read each with read_attachment (workspace "${workspace}", ticket "${ticket}", name). ` +
      `In the Task file, refer to the images the Task needs as ![what it shows](${ticket}/<name>). `;
  return (
    `Use the Software Factory connector. Call guide. This conversation is for ticket ${ticket} in workspace ${workspace}.\n\n` +
    words +
    'Investigate it: read the repository with read_file and search, ask me what is unclear, and discuss the solution with me. ' +
    `When we agree, write the Task file with write_task (workspace "${workspace}", ticket "${ticket}"), replacing the skeleton ` +
    `.software-factory/${ticket}.md, with a ## Review brief for the reviewers, and show me the plan. ` +
    'Then tell me the Task file is ready; I start the job on the dashboard. ' +
    images +
    'You only plan: you do not start, review or approve jobs.'
  );
}

// Above this length the prefilled link is not offered; the message is copied by hand instead.
export const MAX_CONVERSATION_URL = 7500;

// The ChatGPT composer prefilled with the message; sending it may still need Enter. static/app.js
// keeps the same prefix to check the URL it links to.
export const CHATGPT_PREFILL_URL = 'https://chatgpt.com/?q=';

export function conversationUrl(message: string): string {
  return `${CHATGPT_PREFILL_URL}${encodeURIComponent(message)}`;
}
