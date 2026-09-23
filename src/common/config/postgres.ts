export const createPostgresSslOptions = (enabled?: boolean | string, ca?: string) => {
  if (enabled === undefined || enabled === false || enabled === "false") return undefined;
  if (enabled !== true && enabled !== "true") throw new Error("POSTGRES_SSL_INVALID");

  const normalizedCa = ca?.trim().replaceAll("\\n", "\n");
  return { rejectUnauthorized: true, ...(normalizedCa ? { ca: normalizedCa } : {}) };
};
