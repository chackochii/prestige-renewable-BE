// Cleaning what people type before it is stored.
//
// Control characters and invisible format characters (zero-width spaces,
// bidi overrides, the BOM) never belong in a name, a note or a message —
// they survive copy-paste from email and chat and then break layouts and
// searches. Newlines are kept only where a longer text is expected.

/** One line of text: every whitespace run collapsed to a space, capped at `max`. */
export const oneLine = (value, max) =>
    String(value ?? "")
        .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u2029\u202A-\u202E\u2060\uFEFF]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max);

/** A longer text: line breaks normalised to \n and kept, the rest cleaned, capped at `max`. */
export const multiLine = (value, max) =>
    String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u2029\u202A-\u202E\u2060\uFEFF]/g, "")
        .trim()
        .slice(0, max);
