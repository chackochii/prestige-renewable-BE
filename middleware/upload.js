import multer from "multer";

// Multipart parsing for document uploads. Files are held in memory (they are
// small — 10 MB cap) so the document service can check the file type before
// anything is stored; it then writes them to DigitalOcean Spaces (see
// utils/storage.js) and owns naming and the database row. Multer's own errors
// have no .status, so they are translated here into ordinary 400s.
//
// The text fields are capped as tightly as the files. Left to busboy's
// defaults, a request may carry any number of text fields of up to 1 MB each,
// all held in memory — one multipart body could buffer gigabytes, and the
// public site-visit upload takes multipart from anyone. The forms send at most
// a category, a document key, a type, a stage and a label, each a few bytes.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_FIELDS = 10;
const MAX_FIELD_BYTES = 2 * 1024;

const parser = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_FILE_BYTES,
        files: MAX_FILES,
        fields: MAX_FIELDS,
        fieldSize: MAX_FIELD_BYTES,
        fieldNameSize: 100,
        parts: MAX_FILES + MAX_FIELDS,
    },
});

const MULTER_MESSAGES = {
    LIMIT_FILE_SIZE: `Each file must be 10 MB or smaller`,
    LIMIT_FILE_COUNT: `Upload at most ${MAX_FILES} files at a time`,
    LIMIT_UNEXPECTED_FILE: `Send files in the "files" field (or "file" for a single upload)`,
    LIMIT_FIELD_COUNT: `Send at most ${MAX_FIELDS} form fields with an upload`,
    LIMIT_FIELD_VALUE: "A form field sent with the upload is too long",
    LIMIT_FIELD_KEY: "A form field name sent with the upload is too long",
    LIMIT_PART_COUNT: "The upload has too many parts",
};

const translate = (next) => (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError)
        return next(Object.assign(new Error(MULTER_MESSAGES[err.code] || err.message), { status: 400 }));
    return next(err);
};

/** Accepts up to 10 files in the multipart field "files". */
export const uploadFiles = (req, res, next) => parser.array("files", MAX_FILES)(req, res, translate(next));

/** Accepts one file in the multipart field "file" (req.file). */
export const uploadSingleFile = (req, res, next) => parser.single("file")(req, res, translate(next));

export default uploadFiles;
