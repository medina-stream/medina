# Stream routing

A stream is one logical Medina dataset with explicit hosts, buckets, and users.

The default template creates one stream from environment variables. Custom deployments can write `medina.config.ts` directly:

```ts
import type { Stream } from "./lib/stream";

export const streams: Stream[] = [
  {
    host: "medina.example.com",
    buckets: {
      default: {
        url: "s3://medina-dev@127.0.0.1:3900/garage?use_ssl=false",
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        forcePathStyle: true,
      },
    },
    users: [
      {
        username: "default",
        profile_pic_url: "/default-profile.jpg",
        credentials: [],
        tokens: [{ label: "default", token: process.env.MEDINA_TOKEN! }],
      },
    ],
  },
];
```

Only explicitly configured hosts and aliases route. Unknown hosts return 404.

API requests are authorized after stream selection. Tokens can be sent as:

```http
Authorization: Bearer your-token
X-Medina-Token: your-token
```
