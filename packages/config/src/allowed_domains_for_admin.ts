export const admin_domains = (process.env.ADMIN_DOMAINS ?? '')
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean);
