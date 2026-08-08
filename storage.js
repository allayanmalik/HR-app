import multer from "multer";
import multerS3 from "multer-s3";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const DEFAULT_BUCKET = "hr-app-docs-1892298022";
const DEFAULT_REGION = "eu-west-2";

export const AWS_REGION = process.env.AWS_REGION || DEFAULT_REGION;
export const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || DEFAULT_BUCKET;

export const s3Client = new S3Client({ region: AWS_REGION });

function sanitizeFileName(fileName = "document") {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

const ALLOWED_UPLOAD_EXTENSIONS = new Set(["pdf", "doc", "docx", "png", "jpg", "jpeg", "gif", "webp", "heic"]);

function isAllowedUploadFile(fileName = "") {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  return ALLOWED_UPLOAD_EXTENSIONS.has(ext);
}

export function getDocumentUploadMiddleware() {
  return multer({
    storage: multerS3({
      s3: s3Client,
      bucket: S3_BUCKET_NAME,
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key(req, file, callback) {
        const staffId = req.params.id || req.params.staffId || "uploads";
        const key = `staff/${staffId}/${Date.now()}-${sanitizeFileName(file.originalname)}`;
        callback(null, key);
      }
    }),
    fileFilter(req, file, callback) {
      if (!isAllowedUploadFile(file.originalname)) {
        return callback(new Error("Unsupported file type. Only PDF, Word documents (doc/docx), and images (png, jpg, gif, webp, heic) are allowed."));
      }
      callback(null, true);
    },
    limits: { fileSize: 25 * 1024 * 1024 }
  });
}

export async function uploadBufferToS3({ key, body, contentType }) {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  );
}

export async function getObjectFromS3(key) {
  return s3Client.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key
    })
  );
}

export async function deleteObjectFromS3(key) {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key
    })
  );
}