import multer from "multer";

// Multipart parsing for document uploads. Files are held in memory (they are
// small — 10 MB cap) so the document service can check the file type before
// anything is stored; it then writes them to DigitalOcean Spaces (see
// utils/storage.js) and owns naming and the database row. Multer's own errors
// have no .status, so they are translated here into ordinary 400s.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;

const parser = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
});

const MULTER_MESSAGES = {
    LIMIT_FILE_SIZE: `Each file must be 10 MB or smaller`,
    LIMIT_FILE_COUNT: `Upload at most ${MAX_FILES} files at a time`,
    LIMIT_UNEXPECTED_FILE: `Send files in the "files" field (or "file" for a single upload)`,
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
