export async function readJson<T>(bucket: R2Bucket, key: string) {
  const object = await bucket.get(key);
  return object ? object.json<T>() : null;
}

export async function writeJson(bucket: R2Bucket, key: string, value: unknown) {
  await bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}
