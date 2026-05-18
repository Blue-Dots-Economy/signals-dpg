import { FastifyReply } from 'fastify';
import { apiConfig } from '@/config';
import { getNetworkConfigs } from '@/network_configs';

export function isServedDomainBinding(network: string, domain: string) {
  return apiConfig.served_domains.some(
    (binding) => binding.network === network && binding.domain === domain
  );
}

export async function getServedDomainSummary() {
  const bindings = apiConfig.served_domains.map((binding) => binding.key);
  const networks = [...new Set(apiConfig.served_domains.map((b) => b.network))];
  const domains = [...new Set(apiConfig.served_domains.map((b) => b.domain))];
  const networkConfigs = await getNetworkConfigs();
  const itemTypesByBinding = Object.fromEntries(
    apiConfig.served_domains.map((binding) => {
      const networkConfig = networkConfigs.find(
        (config) => config.name === binding.network
      );
      const domainConfig = networkConfig?.domains.find(
        (domain) => domain.name === binding.domain
      );

      return [binding.key, Object.keys(domainConfig?.item_schemas ?? {})];
    })
  );

  return {
    bindings,
    networks,
    domains,
    item_types_by_binding: itemTypesByBinding,
  };
}

export async function replyForUnservedDomain(
  reply: FastifyReply,
  network: string,
  domain: string
) {
  const allowed = await getServedDomainSummary();

  return reply.code(403).send({
    error: 'UNSERVED_DOMAIN_BINDING',
    message: `This API instance does not serve "${network}/${domain}".`,
    requested: {
      network,
      domain,
      key: `${network}/${domain}`,
    },
    allowed_bindings: allowed.bindings,
    allowed_networks: allowed.networks,
    allowed_domains: allowed.domains,
    allowed_item_types_by_binding: allowed.item_types_by_binding,
  });
}
