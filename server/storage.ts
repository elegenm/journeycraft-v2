import fs from "node:fs";
import path from "node:path";
import { Client as MinioClient } from "minio";

const uploadsDir = path.resolve(".uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const bucketName = process.env.MINIO_BUCKET ?? "journeycraft";
const minioEnabled = Boolean(process.env.MINIO_ENDPOINT && process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY);

const minioClient = minioEnabled
  ? new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT!,
      port: process.env.MINIO_PORT ? Number(process.env.MINIO_PORT) : 9000,
      useSSL: process.env.MINIO_USE_SSL === "true",
      accessKey: process.env.MINIO_ACCESS_KEY!,
      secretKey: process.env.MINIO_SECRET_KEY!
    })
  : null;

export async function ensureStorage() {
  if (!minioClient) {
    return;
  }
  const exists = await minioClient.bucketExists(bucketName).catch(() => false);
  if (!exists) {
    await minioClient.makeBucket(bucketName, process.env.MINIO_REGION ?? "us-east-1");
  }
}

export async function uploadObject(file: Express.Multer.File, kind: "image" | "video") {
  const ext = path.extname(file.originalname) || (kind === "image" ? ".png" : ".mp4");
  const objectName = `${kind}/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;

  if (minioClient) {
    await ensureStorage();
    await minioClient.putObject(bucketName, objectName, file.buffer, file.size, {
      "Content-Type": file.mimetype
    });
    const baseUrl =
      process.env.MINIO_PUBLIC_BASE_URL ??
      `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT ?? "9000"}/${bucketName}`;
    return `${baseUrl}/${objectName}`;
  }

  const localPath = path.join(uploadsDir, objectName);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, file.buffer);
  return `/uploads/${objectName}`;
}

export function uploadsStaticPath() {
  return uploadsDir;
}
