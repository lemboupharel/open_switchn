export async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new Error("Response exceeded 2 MB");
      }
      chunks.push(item.value);
    }
  }
  if (response.status === 204 && size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"), (_key, value: unknown) => {
    if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      throw new Error("Unsafe JSON number");
    }
    return value;
  }) as unknown;
}
