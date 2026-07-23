import type { Stream } from "./lib/stream";

export const streams: Stream[] = [
  {
    host: "medina.example.com",
    buckets: {
      default: {
        url: `s3://${process.env.S3_BUCKET}@${process.env.S3_ENDPOINT?.replace(/^https?:\/\//, "")}/${process.env.S3_REGION ?? "auto"}`,
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true" || undefined,
      },
    },
    users: [{ username: "default", profile_pic_url: "/default-profile.jpg", credentials: [], tokens: [{ label: "default", token: process.env.MEDINA_TOKEN! }] }],
  },
];
