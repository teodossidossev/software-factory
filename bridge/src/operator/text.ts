// Job-derived text made inert for the operator's terminal: C0/C1 controls (except
// newline and tab), DEL and bidirectional format characters become visible
// escapes, so instruction text, ids and messages cannot set the title, move the
// cursor, clear the screen or reorder what the operator reads.
export function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, (char) => {
    const code = char.codePointAt(0)!;
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

// One inert line: newlines shown as \n as well.
export const inertLine = (value: string): string => printable(value).replace(/\n/g, '\\n');
