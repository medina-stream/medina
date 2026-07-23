import type { Stream } from "./lib/stream";

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export const streams: Stream[] = [
  {
    host: "alice.example.com",
    buckets: { default: { url: requireEnv("ALICE_BUCKET_URL"), accessKeyId: process.env.ALICE_S3_ACCESS_KEY_ID, secretAccessKey: process.env.ALICE_S3_SECRET_ACCESS_KEY } },
    users: [{ username: "alice", profile_pic_url: "/default-profile.jpg", credentials: [], tokens: [{ label: "default", token: requireEnv("ALICE_MEDINA_TOKEN") }] }],
  },
  {
    host: "bob.example.com",
    buckets: { default: { url: requireEnv("BOB_BUCKET_URL"), accessKeyId: process.env.BOB_S3_ACCESS_KEY_ID, secretAccessKey: process.env.BOB_S3_SECRET_ACCESS_KEY } },
    users: [{ username: "bob", profile_pic_url: "/default-profile.jpg", credentials: [], tokens: [{ label: "default", token: requireEnv("BOB_MEDINA_TOKEN") }] }],
  },
];
