import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
  [ipToInt('10.0.0.0'), ipToInt('10.255.255.255')],
  [ipToInt('172.16.0.0'), ipToInt('172.31.255.255')],
  [ipToInt('192.168.0.0'), ipToInt('192.168.255.255')],
  // Covers AWS/Azure metadata (169.254.169.254) and GCP's alternate
  // (169.254.170.2) in one range, per the SSRF assessment's issue #16.
  [ipToInt('169.254.0.0'), ipToInt('169.254.255.255')],
];

const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal']);

function ipToInt(ip: string): number {
  return ip
    .split('.')
    .reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipToInt(ip);
  return BLOCKED_IPV4_RANGES.some(([start, end]) => value >= start && value <= end);
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:169.254.169.254) and the IPv6 link-local block
  // (fe80::/10, the v6 analogue of 169.254.0.0/16) both reach the same
  // metadata/RFC1918 targets via a v6-only egress path.
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return isIP(mapped) === 4 && isBlockedIpv4(mapped);
  }
  return normalized.startsWith('fe80:') || normalized === '::1';
}

function isBlockedIp(ip: string): boolean {
  return isIP(ip) === 4 ? isBlockedIpv4(ip) : isBlockedIpv6(ip);
}

/**
 * Guards the outbound event-mirror fetch against SSRF: https-only, blocks
 * RFC1918 + cloud metadata ranges, and resolves DNS first so a hostname that
 * *resolves* to a blocked range (rebinding) is caught too, not just literal
 * IPs in the URL.
 */
export async function isSsrfSafeUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  if (BLOCKED_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    return false;
  }

  if (isIP(parsed.hostname)) {
    return !isBlockedIp(parsed.hostname);
  }

  try {
    const { address } = await lookup(parsed.hostname);
    return !isBlockedIp(address);
  } catch {
    // Unresolvable host — fail closed, same as an explicitly blocked target.
    return false;
  }
}
